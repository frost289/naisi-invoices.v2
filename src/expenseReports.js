// Phase 1, Stage 3 — expense reports (claims against a cash float).
//
// MODEL
//   expenseReports/{er_<ownerUid>_<req>}  owner (rep or deliverer), status draft -> submitted -> reviewed
//                                         (a manager may send an undecided submitted report back to draft).
//     lineCount / lastLineChange   kept in step with the lines while drafting (rules check each add/remove)
//     decidedCount, approvedTotal, rejectedTotal, lastDecisionLineId   kept in step with each manager decision
//   expenseLines/{el_<ownerUid>_<req>}    one claimed expense; lineStatus pending -> approved | rejected.
//     ownerUid is denormalised so the owner's reads and writes need no extra lookup.
//
// MONEY: approving a line adds its amount to the owner's CURRENT open float period (totalApproved) in the same
// commit, stamped approvedInPeriodId; rules check the amount. A rejected line never touches the float.
// Every decision is its own small transaction (report + line + period), so a long report never exceeds the rules'
// per-request document-access limit, and each decision is atomic and safe to retry.

import { db } from './firebase.js';
import {
  doc, collection, getDoc, getDocs, query, where, serverTimestamp,
} from 'firebase/firestore';
import { runTransactionWithRetry } from './contention.js';
import { round2 } from './floatMath.js';
import { isDateString } from './malawiTime.js';
import { CLAIM_CATEGORIES } from './expenseCategories.js';

export const MAX_REPORT_LINES = 30;
export const MAX_LINE_AMOUNT = 10000000;   // MWK 10 million per line

const reportRef = (id) => doc(db, 'expenseReports', id);
const lineRef = (id) => doc(db, 'expenseLines', id);
const settingsRef = (uid) => doc(db, 'floatSettings', uid);
const periodRef = (id) => doc(db, 'floatPeriods', id);
const clean = (r) => String(r || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
export const reportId = (uid, req) => `er_${uid}_${clean(req)}`;
export const lineId = (uid, req) => `el_${uid}_${clean(req)}`;
const byTime = (f) => (a, b) => (b[f]?.toMillis?.() || 0) - (a[f]?.toMillis?.() || 0);

// ---------- validation (pure; unit-tested) ----------
export function validateLine(line, role) {
  const errs = [];
  if (!isDateString(line.date)) errs.push('Enter the date of the expense.');
  if (!(CLAIM_CATEGORIES[role] || []).includes(line.category)) errs.push('Choose a category.');
  const amt = Number(line.amount);
  if (!Number.isFinite(amt) || amt <= 0) errs.push('Enter an amount greater than zero.');
  else if (amt > MAX_LINE_AMOUNT) errs.push('Amount is too large for one line.');
  if (!String(line.notes || '').trim()) errs.push('Say what it was for.');
  if (String(line.notes || '').length > 300) errs.push('Description is too long (300 characters max).');
  return errs;
}

export function lineFields(line) {
  return {
    date: line.date,
    category: line.category,
    subcategory: line.subcategory || '',
    amount: round2(line.amount),
    notes: String(line.notes || '').trim(),
    payee: String(line.payee || '').trim(),
    receiptRef: String(line.receiptRef || '').trim(),
    vehicleId: line.vehicleId || null,
  };
}

// Totals of a report's lines, by status.
export function summarizeLines(lines) {
  const s = { claimed: 0, approved: 0, rejected: 0, pending: 0, count: lines.length };
  for (const l of lines) {
    const a = Number(l.amount || 0);
    s.claimed += a;
    if (l.lineStatus === 'approved') s.approved += a;
    else if (l.lineStatus === 'rejected') s.rejected += a;
    else s.pending += a;
  }
  for (const k of ['claimed', 'approved', 'rejected', 'pending']) s[k] = round2(s[k]);
  return s;
}

// ---------- reads ----------
export async function fetchReport(id) {
  const s = await getDoc(reportRef(id));
  return s.exists() ? { id: s.id, ...s.data() } : null;
}
export async function fetchMyReports(uid) {
  const snap = await getDocs(query(collection(db, 'expenseReports'), where('ownerUid', '==', uid)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byTime('createdAt'));
}
export async function fetchLines(reportIdValue, ownerUid) {
  const snap = await getDocs(query(collection(db, 'expenseLines'),
    where('ownerUid', '==', ownerUid), where('reportId', '==', reportIdValue)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
}
// Manager: every submitted report, oldest first (first in, first reviewed).
export async function fetchSubmittedReports() {
  const snap = await getDocs(query(collection(db, 'expenseReports'), where('status', '==', 'submitted')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => -byTime('submittedAt')(a, b));
}
// Manager: a person's reports awaiting review (blocks closing their period).
export async function fetchPendingReportsFor(ownerUid) {
  const snap = await getDocs(query(collection(db, 'expenseReports'),
    where('ownerUid', '==', ownerUid), where('status', '==', 'submitted')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ---------- owner writes ----------
export async function createReport({ uid, email, role, title, requestId }) {
  if (!CLAIM_CATEGORIES[role]) throw new Error('Only sales reps and drivers submit expense reports.');
  const id = reportId(uid, requestId);
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(id));
    if (r.exists()) return { id, already: true };
    const s = await tx.get(settingsRef(uid));
    if (!s.exists()) throw new Error('No cash float has been set up for you yet. Ask your manager.');
    tx.set(reportRef(id), {
      ownerUid: uid, ownerEmail: email || '', ownerRole: role,
      title: String(title || '').trim().slice(0, 80),
      status: 'draft',
      lineCount: 0, lastLineChange: null,
      decidedCount: 0, approvedTotal: 0, rejectedTotal: 0, lastDecisionLineId: null,
      returnNote: '',
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), submittedAt: null,
    });
    return { id, already: false };
  });
}

export async function addLine({ reportIdValue, uid, role, line, requestId }) {
  const errs = validateLine(line, role);
  if (errs.length) throw new Error(errs.join(' '));
  const id = lineId(uid, requestId);
  return runTransactionWithRetry(db, async (tx) => {
    const l = await tx.get(lineRef(id));
    if (l.exists()) return { id, already: true };
    const r = await tx.get(reportRef(reportIdValue));
    if (!r.exists() || r.data().ownerUid !== uid) throw new Error('Report not found.');
    if (r.data().status !== 'draft') throw new Error('This report has been submitted and can no longer be changed.');
    if (r.data().lineCount >= MAX_REPORT_LINES) throw new Error(`A report holds at most ${MAX_REPORT_LINES} lines. Submit it and start a new one.`);
    tx.set(lineRef(id), {
      ...lineFields(line),
      ownerUid: uid, reportId: reportIdValue,
      lineStatus: 'pending', decidedBy: null, decisionNote: '', approvedInPeriodId: null,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    tx.update(reportRef(reportIdValue), { lineCount: r.data().lineCount + 1, lastLineChange: id, updatedAt: serverTimestamp() });
    return { id, already: false };
  }, { watch: [reportRef(reportIdValue)] });
}

export async function updateLine({ lineIdValue, reportIdValue, uid, role, line }) {
  const errs = validateLine(line, role);
  if (errs.length) throw new Error(errs.join(' '));
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    if (!r.exists() || r.data().ownerUid !== uid || r.data().status !== 'draft') throw new Error('This report can no longer be changed.');
    tx.update(lineRef(lineIdValue), { ...lineFields(line), updatedAt: serverTimestamp() });
  });
}

export async function removeLine({ lineIdValue, reportIdValue, uid }) {
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    const l = await tx.get(lineRef(lineIdValue));
    if (!l.exists()) return { already: true };
    if (!r.exists() || r.data().ownerUid !== uid || r.data().status !== 'draft') throw new Error('This report can no longer be changed.');
    tx.delete(lineRef(lineIdValue));
    tx.update(reportRef(reportIdValue), { lineCount: r.data().lineCount - 1, lastLineChange: lineIdValue, updatedAt: serverTimestamp() });
    return { already: false };
  }, { watch: [reportRef(reportIdValue)] });
}

export async function submitReport({ reportIdValue, uid }) {
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    if (!r.exists() || r.data().ownerUid !== uid) throw new Error('Report not found.');
    if (r.data().status === 'submitted') return { already: true };
    if (r.data().status !== 'draft') throw new Error('This report has already been reviewed.');
    if (r.data().lineCount < 1) throw new Error('Add at least one expense before submitting.');
    tx.update(reportRef(reportIdValue), { status: 'submitted', submittedAt: serverTimestamp(), returnNote: '', updatedAt: serverTimestamp() });
    return { already: false };
  });
}

// An empty draft can be thrown away (rules allow delete only for the owner's draft with no lines).
export async function discardEmptyReport({ reportIdValue, uid }) {
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    if (!r.exists()) return;
    if (r.data().ownerUid !== uid || r.data().status !== 'draft' || r.data().lineCount !== 0) throw new Error('Only an empty draft can be discarded.');
    tx.delete(reportRef(reportIdValue));
  });
}

// ---------- manager writes ----------
// Approve or reject one line. Approval needs the owner to have an open float period.
export async function decideLine({ reportIdValue, lineIdValue, decision, note, managerUid }) {
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('Unknown decision.');
  if (decision === 'rejected' && !String(note || '').trim()) throw new Error('Give a reason for rejecting.');
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    const l = await tx.get(lineRef(lineIdValue));
    if (!r.exists() || !l.exists() || l.data().reportId !== reportIdValue) throw new Error('Line not found.');
    if (l.data().lineStatus !== 'pending') return { already: true, lineStatus: l.data().lineStatus };
    if (r.data().status !== 'submitted') throw new Error('This report is not waiting for review.');
    const amt = Number(l.data().amount);
    let pid = null, p = null;
    if (decision === 'approved') {
      const s = await tx.get(settingsRef(r.data().ownerUid));
      pid = s.exists() ? s.data().openPeriodId : null;
      if (!pid) throw new Error('This person has no open float period. Open one in Float Periods before approving.');
      p = await tx.get(periodRef(pid));
      if (!p.exists() || p.data().status !== 'open') throw new Error('The float period is not open.');
    }
    const d = r.data();
    const decided = d.decidedCount + 1;
    const complete = decided >= d.lineCount;
    tx.update(lineRef(lineIdValue), {
      lineStatus: decision, decidedBy: managerUid, decidedAt: serverTimestamp(),
      decisionNote: String(note || '').trim(), approvedInPeriodId: pid, updatedAt: serverTimestamp(),
    });
    tx.update(reportRef(reportIdValue), {
      decidedCount: decided,
      approvedTotal: round2(d.approvedTotal + (decision === 'approved' ? amt : 0)),
      rejectedTotal: round2(d.rejectedTotal + (decision === 'rejected' ? amt : 0)),
      lastDecisionLineId: lineIdValue,
      status: complete ? 'reviewed' : 'submitted',
      ...(complete ? { reviewedBy: managerUid, reviewedAt: serverTimestamp() } : {}),
      updatedAt: serverTimestamp(),
    });
    if (decision === 'approved') {
      tx.update(periodRef(pid), {
        totalApproved: round2(Number(p.data().totalApproved || 0) + amt),
        lastApprovalLineId: lineIdValue,
        updatedAt: serverTimestamp(),
      });
    }
    return { already: false, lineStatus: decision, complete };
  }, { watch: [reportRef(reportIdValue)] });
}

// Send a submitted report back to the owner for correction (only before any line is decided).
export async function returnReport({ reportIdValue, note }) {
  if (!String(note || '').trim()) throw new Error('Say what needs correcting.');
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(reportRef(reportIdValue));
    if (!r.exists() || r.data().status !== 'submitted') throw new Error('This report is not waiting for review.');
    if (r.data().decidedCount > 0) throw new Error('Some lines are already decided; reject the wrong lines instead.');
    tx.update(reportRef(reportIdValue), { status: 'draft', returnNote: String(note).trim(), updatedAt: serverTimestamp() });
  });
}
