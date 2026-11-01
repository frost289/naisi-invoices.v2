// Firestore EMULATOR tests — Phase 1 Stage 3: expense reports, lines, approvals feeding the float.
// Runs the REAL app modules against the real rules file, plus tampering attempts. Run: cd tests && npm run test:rules
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, updateDoc, deleteDoc, setDoc, writeBatch, serverTimestamp } from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = process.env.NAISI_RULES_PATH || path.resolve(here, '../../rules/firestore.rules');
const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../src/firebase.js', () => ({ get db() { return holder.db; }, auth: {}, googleProvider: {} }));

import { setFloatSettings } from '../../src/floatAccounts.js';
import { openPeriod, issueMoney, fetchOpenPeriod } from '../../src/floatPeriods.js';
import {
  createReport, addLine, updateLine, removeLine, submitReport, decideLine, returnReport, fetchLines, fetchReport, discardEmptyReport,
} from '../../src/expenseReports.js';

let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'naisi-claims-test', firestore: { rules: readFileSync(rulesPath, 'utf8') } });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => setDoc(doc(c.firestore(), 'config', 'roles'), {
    managers: ['mgr@example.com'], submitters: ['rep1@example.com', 'rep2@example.com'], deliverers: ['deliv@example.com'],
  }));
});
const ctx = {
  mgr: () => env.authenticatedContext('mgr', { email: 'mgr@example.com' }),
  rep1: () => env.authenticatedContext('rep1', { email: 'rep1@example.com' }),
  rep2: () => env.authenticatedContext('rep2', { email: 'rep2@example.com' }),
  deliv: () => env.authenticatedContext('deliv', { email: 'deliv@example.com' }),
};
const as = (who) => { holder.db = ctx[who]().firestore(); return holder.db; };
const L = (over = {}) => ({ date: '2026-10-30', category: 'Transport', amount: 1500, notes: 'Minibus', ...over });

async function floatFor(uid, email, { allowed = [] } = {}) {
  as('mgr');
  await setFloatSettings({ staffUid: uid, staffEmail: email, floatTarget: 20000, allowedCategories: allowed, managerUid: 'mgr' });
  await openPeriod({ staffUid: uid, staffEmail: email, openingBalance: 0, requestId: 'o' + uid, managerUid: 'mgr' });
  await issueMoney({ recipientUid: uid, amount: 20000, requestId: 'i' + uid, managerUid: 'mgr' });
}
async function submittedReport(lines = [L(), L({ category: 'Meals', amount: 800, notes: 'Lunch' })]) {
  await floatFor('rep1', 'rep1@example.com');
  as('rep1');
  const { id } = await createReport({ uid: 'rep1', email: 'rep1@example.com', role: 'rep', title: 'Week 44', requestId: 'r1' });
  const ids = [];
  for (let i = 0; i < lines.length; i++) ids.push((await addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: lines[i], requestId: 'l' + i })).id);
  await submitReport({ reportIdValue: id, uid: 'rep1' });
  return { id, ids };
}

describe('drafting', () => {
  it('a rep drafts, edits, removes and submits; counts stay in step', async () => {
    await floatFor('rep1', 'rep1@example.com');
    as('rep1');
    const { id } = await createReport({ uid: 'rep1', email: 'rep1@example.com', role: 'rep', title: 'W44', requestId: 'r1' });
    const a = await addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L(), requestId: 'a' });
    const b = await addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L({ amount: 99 }), requestId: 'b' });
    expect((await addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L(), requestId: 'a' })).already).toBe(true);
    await updateLine({ lineIdValue: a.id, reportIdValue: id, uid: 'rep1', role: 'rep', line: L({ amount: 1600 }) });
    await removeLine({ lineIdValue: b.id, reportIdValue: id, uid: 'rep1' });
    expect((await fetchReport(id)).lineCount).toBe(1);
    expect((await fetchLines(id, 'rep1')).map(l => l.amount)).toEqual([1600]);
    await submitReport({ reportIdValue: id, uid: 'rep1' });
    await expect(addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L(), requestId: 'late' })).rejects.toThrow(/submitted/);
    await assertFails(updateDoc(doc(holder.db, 'expenseLines', a.id), { amount: 1 }));
    await assertFails(deleteDoc(doc(holder.db, 'expenseLines', a.id)));
  });

  it('rules refuse a line without the report count, a wrong count, and categories outside the role or the manager list', async () => {
    await floatFor('rep1', 'rep1@example.com', { allowed: ['Transport'] });
    as('rep1');
    const { id } = await createReport({ uid: 'rep1', email: 'rep1@example.com', role: 'rep', title: '', requestId: 'r1' });
    const base = { ...L(), subcategory: '', payee: '', receiptRef: '', vehicleId: null, ownerUid: 'rep1', reportId: id,
      lineStatus: 'pending', decidedBy: null, decisionNote: '', approvedInPeriodId: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    await assertFails(setDoc(doc(holder.db, 'expenseLines', 'el_rep1_lonely'), base));
    const b = writeBatch(holder.db);
    b.set(doc(holder.db, 'expenseLines', 'el_rep1_two'), base);
    b.update(doc(holder.db, 'expenseReports', id), { lineCount: 2, lastLineChange: 'el_rep1_two' });
    await assertFails(b.commit());
    await expect(addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L({ category: 'Meals' }), requestId: 'm' })).rejects.toThrow();
    const b2 = writeBatch(holder.db);   // Fuel claimed directly
    b2.set(doc(holder.db, 'expenseLines', 'el_rep1_fuel'), { ...base, category: 'Fuel' });
    b2.update(doc(holder.db, 'expenseReports', id), { lineCount: 1, lastLineChange: 'el_rep1_fuel' });
    await assertFails(b2.commit());
    await assertSucceeds(addLine({ reportIdValue: id, uid: 'rep1', role: 'rep', line: L(), requestId: 't' }));
  });

  it('another rep cannot read or add to my report; a stranger to the float cannot start a report', async () => {
    const { id } = await submittedReport();
    as('rep2');
    await assertFails(getDoc(doc(holder.db, 'expenseReports', id)));
    await expect(fetchLines(id, 'rep1')).rejects.toThrow();
    await expect(createReport({ uid: 'rep2', email: 'rep2@example.com', role: 'rep', requestId: 'x' })).rejects.toThrow(/float/);
  });

  it('a rep cannot approve their own lines or mark the report reviewed', async () => {
    const { id, ids } = await submittedReport();
    as('rep1');
    await expect(decideLine({ reportIdValue: id, lineIdValue: ids[0], decision: 'approved', managerUid: 'rep1' })).rejects.toThrow();
    await assertFails(updateDoc(doc(holder.db, 'expenseReports', id), { status: 'reviewed' }));
  });

  it('an empty draft can be discarded; one with lines cannot be deleted', async () => {
    await floatFor('rep1', 'rep1@example.com');
    as('rep1');
    const { id } = await createReport({ uid: 'rep1', email: 'rep1@example.com', role: 'rep', requestId: 'e' });
    await assertSucceeds(discardEmptyReport({ reportIdValue: id, uid: 'rep1' }));
    const { id: id2 } = await createReport({ uid: 'rep1', email: 'rep1@example.com', role: 'rep', requestId: 'f' });
    await addLine({ reportIdValue: id2, uid: 'rep1', role: 'rep', line: L(), requestId: 'z' });
    await assertFails(deleteDoc(doc(holder.db, 'expenseReports', id2)));
  });
});

describe('approvals and the float', () => {
  it('approve one, reject one: float balance falls only by the approved amount; report becomes reviewed', async () => {
    const { id, ids } = await submittedReport();
    as('mgr');
    await decideLine({ reportIdValue: id, lineIdValue: ids[0], decision: 'approved', managerUid: 'mgr' });
    expect((await decideLine({ reportIdValue: id, lineIdValue: ids[0], decision: 'approved', managerUid: 'mgr' })).already).toBe(true);
    const res = await decideLine({ reportIdValue: id, lineIdValue: ids[1], decision: 'rejected', note: 'No receipt', managerUid: 'mgr' });
    expect(res.complete).toBe(true);
    const r = await fetchReport(id);
    expect(r).toMatchObject({ status: 'reviewed', decidedCount: 2, approvedTotal: 1500, rejectedTotal: 800 });
    const p = await fetchOpenPeriod('rep1');
    expect(p.totalApproved).toBe(1500);
  });

  it('rules refuse moving totalApproved without an approved line, or by a different amount', async () => {
    const { id, ids } = await submittedReport();
    const p = await (as('mgr'), fetchOpenPeriod('rep1'));
    await assertFails(updateDoc(doc(holder.db, 'floatPeriods', p.id), { totalApproved: 5000, lastApprovalLineId: ids[0] }));
    const b = writeBatch(holder.db);
    b.update(doc(holder.db, 'expenseLines', ids[0]), { lineStatus: 'approved', decidedBy: 'mgr', decidedAt: serverTimestamp(), decisionNote: '', approvedInPeriodId: p.id, updatedAt: serverTimestamp() });
    b.update(doc(holder.db, 'expenseReports', id), { decidedCount: 1, approvedTotal: 1500, rejectedTotal: 0, lastDecisionLineId: ids[0], updatedAt: serverTimestamp() });
    b.update(doc(holder.db, 'floatPeriods', p.id), { totalApproved: 9999, lastApprovalLineId: ids[0], updatedAt: serverTimestamp() });
    await assertFails(b.commit());
  });

  it('a rejection may not touch the float, and needs a reason', async () => {
    const { id, ids } = await submittedReport();
    as('mgr');
    await expect(decideLine({ reportIdValue: id, lineIdValue: ids[0], decision: 'rejected', managerUid: 'mgr' })).rejects.toThrow(/reason/);
    const b = writeBatch(holder.db);
    b.update(doc(holder.db, 'expenseLines', ids[0]), { lineStatus: 'rejected', decidedBy: 'mgr', decidedAt: serverTimestamp(), decisionNote: '', approvedInPeriodId: null, updatedAt: serverTimestamp() });
    b.update(doc(holder.db, 'expenseReports', id), { decidedCount: 1, approvedTotal: 0, rejectedTotal: 1500, lastDecisionLineId: ids[0], updatedAt: serverTimestamp() });
    await assertFails(b.commit());   // empty decision note
  });

  it('approval needs an open period; send-back only before any decision', async () => {
    const { id, ids } = await submittedReport();
    as('mgr');
    await returnReport({ reportIdValue: id, note: 'Add receipt numbers' });
    as('rep1');
    expect((await fetchReport(id)).status).toBe('draft');
    await submitReport({ reportIdValue: id, uid: 'rep1' });
    as('mgr');
    await decideLine({ reportIdValue: id, lineIdValue: ids[0], decision: 'rejected', note: 'dup', managerUid: 'mgr' });
    await expect(returnReport({ reportIdValue: id, note: 'x' })).rejects.toThrow(/already decided/);
  });

  it('drivers claim Vehicle/Maintenance with a vehicle; reps cannot', async () => {
    await floatFor('deliv', 'deliv@example.com');
    as('deliv');
    const { id } = await createReport({ uid: 'deliv', email: 'deliv@example.com', role: 'deliverer', requestId: 'd' });
    await assertSucceeds(addLine({ reportIdValue: id, uid: 'deliv', role: 'deliverer', line: L({ category: 'VehicleMaintenance', subcategory: 'Tyre Repair', vehicleId: 'v1' }), requestId: 'v' }));
  });
});
