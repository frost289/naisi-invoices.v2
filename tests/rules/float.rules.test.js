// Firestore EMULATOR tests — Phase 1 Stage 2: float settings, float periods, money issued.
// Runs the REAL app modules (src/floatAccounts.js, src/floatPeriods.js) against the real rules file, plus direct
// tampering attempts that the rules must refuse. Run: cd tests && npm run test:rules
import { describe, it, beforeAll, afterAll, beforeEach, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp } from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = process.env.NAISI_RULES_PATH || path.resolve(here, '../../rules/firestore.rules');

const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../src/firebase.js', () => ({ get db() { return holder.db; }, auth: {}, googleProvider: {} }));

import { setFloatSettings, fetchFloatSettings } from '../../src/floatAccounts.js';
import {
  openPeriod, issueMoney, reverseIssue, closePeriod, fetchOpenPeriod, fetchMovementsForPeriod, verifyPeriodTotals,
} from '../../src/floatPeriods.js';

let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'naisi-float-test', firestore: { rules: readFileSync(rulesPath, 'utf8') } });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config', 'roles'), {
      managers: ['mgr@example.com'], submitters: ['rep1@example.com', 'rep2@example.com'], deliverers: ['deliv@example.com'],
    });
  });
});

const ctx = {
  mgr: () => env.authenticatedContext('mgr', { email: 'mgr@example.com' }),
  rep1: () => env.authenticatedContext('rep1', { email: 'rep1@example.com' }),
  rep2: () => env.authenticatedContext('rep2', { email: 'rep2@example.com' }),
  deliv: () => env.authenticatedContext('deliv', { email: 'deliv@example.com' }),
};
const as = (who) => { holder.db = ctx[who]().firestore(); return holder.db; };
const raw = async (fn) => env.withSecurityRulesDisabled(async (c) => fn(c.firestore()));

async function setupRep1({ target = 20000, opening = 2000 } = {}) {
  as('mgr');
  await setFloatSettings({ staffUid: 'rep1', staffEmail: 'rep1@example.com', floatTarget: target, allowedCategories: ['Transport', 'Meals'], managerUid: 'mgr' });
  const { id } = await openPeriod({ staffUid: 'rep1', staffEmail: 'rep1@example.com', openingBalance: opening, requestId: 'open1', managerUid: 'mgr' });
  return id;
}

describe('float settings', () => {
  it('manager sets; owner reads own; another rep cannot read; owner cannot write', async () => {
    as('mgr');
    await assertSucceeds(setFloatSettings({ staffUid: 'rep1', staffEmail: 'rep1@example.com', floatTarget: 15000, allowedCategories: ['Meals'], managerUid: 'mgr' }));
    as('rep1');
    expect((await fetchFloatSettings('rep1')).floatTarget).toBe(15000);
    await assertFails(getDoc(doc(as('rep2'), 'floatSettings', 'rep1')));
    await assertFails(updateDoc(doc(as('rep1'), 'floatSettings', 'rep1'), { floatTarget: 999999, updatedBy: 'rep1' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'floatSettings', 'rep1')));
  });

  it('editing settings during an open period keeps the period pointer', async () => {
    const pid = await setupRep1();
    as('mgr');
    await setFloatSettings({ staffUid: 'rep1', staffEmail: 'rep1@example.com', floatTarget: 25000, allowedCategories: [], managerUid: 'mgr' });
    expect((await fetchFloatSettings('rep1')).openPeriodId).toBe(pid);
  });

  it('a manager cannot clear or move the pointer without closing / opening the period', async () => {
    const pid = await setupRep1();
    await assertFails(updateDoc(doc(as('mgr'), 'floatSettings', 'rep1'), { openPeriodId: null, updatedBy: 'mgr' }));
    await assertFails(updateDoc(doc(as('mgr'), 'floatSettings', 'rep1'), { openPeriodId: pid + 'x', updatedBy: 'mgr' }));
  });
});

describe('float periods', () => {
  it('opens one period; a second open is refused by the app and by the rules', async () => {
    const pid = await setupRep1();
    as('mgr');
    await expect(openPeriod({ staffUid: 'rep1', openingBalance: 0, requestId: 'open2', managerUid: 'mgr' })).rejects.toThrow(/already has an open period/);
    // Direct attempt: create a second open period and repoint
    const b = writeBatch(as('mgr'));
    const other = 'fp_rep1_20261031_zzz';
    b.set(doc(holder.db, 'floatPeriods', other), { staffUid: 'rep1', staffEmail: '', status: 'open', openingBalance: 0, floatTarget: 1, totalIssued: 0, totalApproved: 0, lastMovementId: null, startDate: '2026-10-31', openedBy: 'mgr', openedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.update(doc(holder.db, 'floatSettings', 'rep1'), { openPeriodId: other, updatedBy: 'mgr' });
    await assertFails(b.commit());
    expect((await fetchFloatSettings('rep1')).openPeriodId).toBe(pid);
  });

  it('retrying the same open request is idempotent', async () => {
    const pid = await setupRep1();
    as('mgr');
    const again = await openPeriod({ staffUid: 'rep1', openingBalance: 2000, requestId: 'open1', managerUid: 'mgr' });
    expect(again).toEqual({ id: pid, already: true });
  });

  it('cannot open without float settings', async () => {
    as('mgr');
    await expect(openPeriod({ staffUid: 'rep2', openingBalance: 0, requestId: 'x', managerUid: 'mgr' })).rejects.toThrow(/Float Settings first/);
  });

  it('a rep cannot open a period for themself', async () => {
    await raw(async (db) => setDoc(doc(db, 'floatSettings', 'rep1'), { staffUid: 'rep1', staffEmail: 'rep1@example.com', floatTarget: 1, allowedCategories: [], updatedBy: 'mgr' }));
    as('rep1');
    await expect(openPeriod({ staffUid: 'rep1', openingBalance: 0, requestId: 'self', managerUid: 'rep1' })).rejects.toThrow();
  });
});

describe('money issued', () => {
  it('issue updates the running total; a retry does not double it', async () => {
    const pid = await setupRep1();
    as('mgr');
    await issueMoney({ recipientUid: 'rep1', amount: 5000, method: 'cash', requestId: 'iss1', managerUid: 'mgr' });
    const again = await issueMoney({ recipientUid: 'rep1', amount: 5000, method: 'cash', requestId: 'iss1', managerUid: 'mgr' });
    expect(again.already).toBe(true);
    const p = await fetchOpenPeriod('rep1');
    expect(p.totalIssued).toBe(5000);
    expect((await verifyPeriodTotals(p)).ok).toBe(true);
    expect(p.id).toBe(pid);
  });

  it('rules refuse a total change without a matching record, and a record without the total', async () => {
    const pid = await setupRep1();
    await assertFails(updateDoc(doc(as('mgr'), 'floatPeriods', pid), { totalIssued: 1000, updatedAt: serverTimestamp() }));
    await assertFails(setDoc(doc(as('mgr'), 'moneyIssued', 'mi_rep1_lonely'), {
      kind: 'issue', recipientUid: 'rep1', recipientEmail: '', amount: 1000, method: 'cash', reference: '', notes: '',
      floatPeriodId: pid, issuedBy: 'mgr', issuedByEmail: '', issuedAt: serverTimestamp(), reversedById: null }));
    // record says 1000, total moves 6000
    const b = writeBatch(as('mgr'));
    b.set(doc(holder.db, 'moneyIssued', 'mi_rep1_mismatch'), {
      kind: 'issue', recipientUid: 'rep1', recipientEmail: '', amount: 1000, method: 'cash', reference: '', notes: '',
      floatPeriodId: pid, issuedBy: 'mgr', issuedByEmail: '', issuedAt: serverTimestamp(), reversedById: null });
    b.update(doc(holder.db, 'floatPeriods', pid), { totalIssued: 6000, lastMovementId: 'mi_rep1_mismatch', updatedAt: serverTimestamp() });
    await assertFails(b.commit());
  });

  it('a rep cannot issue money to themself', async () => {
    await setupRep1();
    as('rep1');
    await expect(issueMoney({ recipientUid: 'rep1', amount: 100000, requestId: 'self', managerUid: 'rep1' })).rejects.toThrow();
  });

  it('a rep sees own period and movements; another rep cannot', async () => {
    const pid = await setupRep1();
    as('mgr');
    await issueMoney({ recipientUid: 'rep1', amount: 3000, requestId: 'iss1', managerUid: 'mgr' });
    as('rep1');
    expect((await fetchOpenPeriod('rep1')).totalIssued).toBe(3000);
    expect((await fetchMovementsForPeriod(pid, 'rep1')).length).toBe(1);
    as('rep2');
    await expect(fetchMovementsForPeriod(pid, 'rep1')).rejects.toThrow();
    await assertFails(getDoc(doc(holder.db, 'floatPeriods', pid)));
  });

  it('reversal: once only, total restored, records kept', async () => {
    await setupRep1();
    as('mgr');
    const { id } = await issueMoney({ recipientUid: 'rep1', amount: 4000, requestId: 'iss1', managerUid: 'mgr' });
    await reverseIssue({ issuedId: id, reason: 'wrong person', managerUid: 'mgr' });
    await expect(reverseIssue({ issuedId: id + 'x', reason: 'x', managerUid: 'mgr' })).rejects.toThrow();
    const again = await reverseIssue({ issuedId: id, reason: 'again', managerUid: 'mgr' });
    expect(again.already).toBe(true);
    const p = await fetchOpenPeriod('rep1');
    expect(p.totalIssued).toBe(0);
    expect((await verifyPeriodTotals(p))).toMatchObject({ ok: true, count: 2 });
    await assertFails(deleteDoc(doc(holder.db, 'moneyIssued', id)));
    await assertFails(updateDoc(doc(holder.db, 'moneyIssued', id), { amount: 1 }));
  });
});

describe('closing', () => {
  it('closes with the formula, clears the pointer, and the period is then frozen', async () => {
    const pid = await setupRep1({ target: 20000, opening: 2000 });
    as('mgr');
    await issueMoney({ recipientUid: 'rep1', amount: 5000, requestId: 'iss1', managerUid: 'mgr' });
    const res = await closePeriod({ periodIdValue: pid, notes: 'week 44', managerUid: 'mgr' });
    expect(res).toMatchObject({ closingBalance: 7000, proposedTopUp: 13000 });
    const s = await fetchFloatSettings('rep1');
    expect(s.openPeriodId).toBeNull();
    expect(s.lastClosingBalance).toBe(7000);
    await expect(issueMoney({ recipientUid: 'rep1', amount: 1, requestId: 'late', managerUid: 'mgr' })).rejects.toThrow(/No open float period/);
    await assertFails(updateDoc(doc(holder.db, 'floatPeriods', pid), { notes: 'edited later' }));
    // the next period can open
    await assertSucceeds(openPeriod({ staffUid: 'rep1', openingBalance: 7000, requestId: 'open2', managerUid: 'mgr' }));
  });

  it('rules refuse a close with a wrong closing balance or top-up', async () => {
    const pid = await setupRep1({ target: 20000, opening: 2000 });
    const b = writeBatch(as('mgr'));
    b.update(doc(holder.db, 'floatPeriods', pid), { status: 'closed', closingBalance: 9999, proposedTopUp: 10001, notes: '', closedBy: 'mgr', closedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b.update(doc(holder.db, 'floatSettings', 'rep1'), { openPeriodId: null, updatedBy: 'mgr' });
    await assertFails(b.commit());
    const b2 = writeBatch(as('mgr'));
    b2.update(doc(holder.db, 'floatPeriods', pid), { status: 'closed', closingBalance: 2000, proposedTopUp: 0, notes: '', closedBy: 'mgr', closedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    b2.update(doc(holder.db, 'floatSettings', 'rep1'), { openPeriodId: null, updatedBy: 'mgr' });
    await assertFails(b2.commit());
  });

  it('negative balance (person owes the business) gives the full target plus the debt as top-up', async () => {
    const pid = await setupRep1({ target: 10000, opening: -3000 });
    as('mgr');
    const res = await closePeriod({ periodIdValue: pid, managerUid: 'mgr' });
    expect(res).toMatchObject({ closingBalance: -3000, proposedTopUp: 13000 });
  });
});
