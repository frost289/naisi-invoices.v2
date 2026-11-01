// Phase 1, Stage 2 — float periods and money issued.
//
// MODEL
//   floatSettings/{uid}.openPeriodId   pointer to the ONE open period for that person (null when none). Opening a
//                                      period sets it, closing clears it, both in the same transaction as the period
//                                      write, and the rules check the pairing. This is what enforces "at most one
//                                      open period per person" (a deterministic id alone cannot, across days).
//   floatPeriods/{fp_<uid>_<YYYYMMDD>_<req>}   the period ledger summary: openingBalance, floatTarget (snapshot),
//                                      totalIssued, totalApproved (Stage 3), lastMovementId, status open|closed.
//   moneyIssued/{mi_<uid>_<req>}       one append-only record per issue (kind 'issue').
//   moneyIssued/{mr_<originalId>}      a reversal (kind 'reversal'). The original gets reversedById; nothing is deleted.
//
// Every change to totalIssued is made in the same commit as the moneyIssued record that explains it (rules check
// lastMovementId and the amount), so the running total can always be re-derived from the records (verifyPeriodTotals).

import { db } from './firebase.js';
import {
  doc, collection, getDoc, getDocs, query, where, serverTimestamp,
} from 'firebase/firestore';
import { runTransactionWithRetry } from './contention.js';
import { malawiDate } from './malawiTime.js';
import {
  periodId as makePeriodId, issueId as makeIssueId, reversalId as makeReversalId,
  requireIssueAmount, requireOpeningBalance, closingBalance, proposedTopUp, netIssued, round2,
} from './floatMath.js';

const settingsRef = (uid) => doc(db, 'floatSettings', uid);
const periodRef = (id) => doc(db, 'floatPeriods', id);
const issuedRef = (id) => doc(db, 'moneyIssued', id);
const byTime = (field) => (a, b) => (b[field]?.toMillis?.() || 0) - (a[field]?.toMillis?.() || 0);

// ---------- reads ----------

// The open period for a person, or null. Works for the manager and for the person themself (rules: own get).
export async function fetchOpenPeriod(staffUid) {
  const s = await getDoc(settingsRef(staffUid));
  const id = s.exists() ? s.data().openPeriodId : null;
  if (!id) return null;
  const p = await getDoc(periodRef(id));
  return p.exists() ? { id: p.id, ...p.data() } : null;
}

// Manager: every open period.
export async function fetchOpenPeriods() {
  const snap = await getDocs(query(collection(db, 'floatPeriods'), where('status', '==', 'open')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Manager: a person's periods, newest first.
export async function fetchPeriodsForStaff(staffUid) {
  const snap = await getDocs(query(collection(db, 'floatPeriods'), where('staffUid', '==', staffUid)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byTime('openedAt'));
}

// Money records of one period (manager, or the recipient for their own). Newest first.
export async function fetchMovementsForPeriod(periodIdValue, recipientUid) {
  const snap = await getDocs(query(collection(db, 'moneyIssued'),
    where('recipientUid', '==', recipientUid), where('floatPeriodId', '==', periodIdValue)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byTime('issuedAt'));
}

// Re-derive totalIssued from the records and compare with the running total. Returns { ok, recorded, derived }.
export async function verifyPeriodTotals(period) {
  const records = await fetchMovementsForPeriod(period.id, period.staffUid);
  const derived = netIssued(records);
  const recorded = round2(period.totalIssued || 0);
  return { ok: Math.abs(derived - recorded) <= 0.01, recorded, derived, count: records.length };
}

// ---------- writes (manager) ----------

// Open a new period. Opening balance defaults (in the UI) to the person's last closing balance.
export async function openPeriod({ staffUid, staffEmail, openingBalance, requestId, managerUid }) {
  const opening = requireOpeningBalance(openingBalance);
  const id = makePeriodId(staffUid, malawiDate().replace(/-/g, ''), requestId);
  return runTransactionWithRetry(db, async (tx) => {
    const s = await tx.get(settingsRef(staffUid));
    const p = await tx.get(periodRef(id));
    if (p.exists()) return { id, already: true };                       // same request retried: done
    if (!s.exists()) throw new Error('Set this person\'s float target in Float Settings first.');
    if (s.data().openPeriodId) throw new Error('This person already has an open period. Close it first.');
    tx.set(periodRef(id), {
      staffUid, staffEmail: staffEmail || s.data().staffEmail || '',
      status: 'open',
      openingBalance: opening,
      floatTarget: Number(s.data().floatTarget || 0),
      totalIssued: 0, totalApproved: 0,
      lastMovementId: null,
      startDate: malawiDate(),
      openedBy: managerUid, openedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    tx.update(settingsRef(staffUid), { openPeriodId: id, updatedBy: managerUid, updatedAt: serverTimestamp() });
    return { id, already: false };
  }, { watch: [settingsRef(staffUid)] });
}

// Issue money into a person's open period.
export async function issueMoney({ recipientUid, recipientEmail, amount, method, reference, notes, requestId, managerUid, managerEmail }) {
  const amt = requireIssueAmount(amount);
  const id = makeIssueId(recipientUid, requestId);
  return runTransactionWithRetry(db, async (tx) => {
    const existing = await tx.get(issuedRef(id));
    if (existing.exists()) return { id, already: true };
    const s = await tx.get(settingsRef(recipientUid));
    const pid = s.exists() ? s.data().openPeriodId : null;
    if (!pid) throw new Error('No open float period for this person. Open one in Float Periods first.');
    const p = await tx.get(periodRef(pid));
    if (!p.exists() || p.data().status !== 'open') throw new Error('The float period is not open.');
    tx.set(issuedRef(id), {
      kind: 'issue',
      recipientUid, recipientEmail: recipientEmail || p.data().staffEmail || '',
      amount: amt,
      method: method || 'cash',
      reference: (reference || '').trim(),
      notes: (notes || '').trim(),
      floatPeriodId: pid,
      issuedBy: managerUid, issuedByEmail: managerEmail || '',
      issuedAt: serverTimestamp(),
      reversedById: null,
    });
    tx.update(periodRef(pid), {
      totalIssued: round2(Number(p.data().totalIssued || 0) + amt),
      lastMovementId: id,
      updatedAt: serverTimestamp(),
    });
    return { id, already: false };
  }, { watch: [settingsRef(recipientUid)] });
}

// Reverse an issue (wrong amount, wrong person). Only while its period is open. Creates mr_<id>; never deletes.
export async function reverseIssue({ issuedId, reason, managerUid, managerEmail }) {
  if (!reason || !reason.trim()) throw new Error('Give a reason for the reversal.');
  const rid = makeReversalId(issuedId);
  return runTransactionWithRetry(db, async (tx) => {
    const r = await tx.get(issuedRef(rid));
    if (r.exists()) return { id: rid, already: true };
    const o = await tx.get(issuedRef(issuedId));
    if (!o.exists() || o.data().kind !== 'issue') throw new Error('Record not found.');
    if (o.data().reversedById) throw new Error('This issue has already been reversed.');
    const p = await tx.get(periodRef(o.data().floatPeriodId));
    if (!p.exists() || p.data().status !== 'open') throw new Error('Its float period is closed; record a correction in the next period instead.');
    const amt = Number(o.data().amount);
    tx.set(issuedRef(rid), {
      kind: 'reversal',
      reversesId: issuedId,
      recipientUid: o.data().recipientUid, recipientEmail: o.data().recipientEmail || '',
      amount: amt,
      method: o.data().method || 'cash',
      reference: '',
      notes: reason.trim(),
      floatPeriodId: o.data().floatPeriodId,
      issuedBy: managerUid, issuedByEmail: managerEmail || '',
      issuedAt: serverTimestamp(),
      reversedById: null,
    });
    tx.update(issuedRef(issuedId), { reversedById: rid, reversedAt: serverTimestamp() });
    tx.update(periodRef(o.data().floatPeriodId), {
      totalIssued: round2(Number(p.data().totalIssued || 0) - amt),
      lastMovementId: rid,
      updatedAt: serverTimestamp(),
    });
    return { id: rid, already: false };
  }, { watch: [issuedRef(issuedId)] });
}

// Close a period: freeze the closing balance and proposed top-up, clear the pointer.
export async function closePeriod({ periodIdValue, notes, managerUid }) {
  return runTransactionWithRetry(db, async (tx) => {
    const p = await tx.get(periodRef(periodIdValue));
    if (!p.exists()) throw new Error('Period not found.');
    const d = p.data();
    if (d.status === 'closed') return { id: periodIdValue, already: true, closingBalance: d.closingBalance, proposedTopUp: d.proposedTopUp };
    const s = await tx.get(settingsRef(d.staffUid));
    const closing = closingBalance(d.openingBalance, d.totalIssued, d.totalApproved);
    const topUp = proposedTopUp(d.floatTarget, closing);
    tx.update(periodRef(periodIdValue), {
      status: 'closed',
      closingBalance: closing,
      proposedTopUp: topUp,
      notes: (notes || '').trim(),
      closedBy: managerUid, closedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    if (s.exists() && s.data().openPeriodId === periodIdValue) {
      tx.update(settingsRef(d.staffUid), {
        openPeriodId: null, lastClosingBalance: closing, lastClosedPeriodId: periodIdValue,
        updatedBy: managerUid, updatedAt: serverTimestamp(),
      });
    }
    return { id: periodIdValue, already: false, closingBalance: closing, proposedTopUp: topUp };
  }, { watch: [periodRef(periodIdValue)] });
}
