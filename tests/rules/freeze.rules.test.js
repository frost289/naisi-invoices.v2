// EMULATOR-ONLY (not executed in the authoring sandbox): the MAINTENANCE FREEZE rules file (rules/maintenance-freeze.rules).
// Acceptance: EVERY write by EVERY role is denied; managers can read; everyone else cannot. A setup error must FAIL the run, never count as a denial.
import { describe, it, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, updateDoc, deleteDoc, addDoc, collection, writeBatch, serverTimestamp } from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = process.env.NAISI_FREEZE_RULES_PATH || path.resolve(here, '../../rules/maintenance-freeze.rules');
let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'naisi-freeze-test', firestore: { rules: readFileSync(rulesPath, 'utf8') } });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config', 'roles'), { managers: ['mgr@example.com'], submitters: ['rep1@example.com'], deliverers: ['deliv@example.com'] });
    await setDoc(doc(db, 'orders', 'o1'), { status: 'Approved', items: [], createdBy: 'rep1' });
    await setDoc(doc(db, 'products', 'p1'), { stockOnHand: 10 });
  });
});
afterAll(async () => { await env?.cleanup(); });
const as = { mgr: () => env.authenticatedContext('mgr', { email: 'mgr@example.com' }).firestore(), rep1: () => env.authenticatedContext('rep1', { email: 'rep1@example.com' }).firestore(),
  deliv: () => env.authenticatedContext('deliv', { email: 'deliv@example.com' }).firestore(), stranger: () => env.authenticatedContext('stranger', { email: 'stranger@example.com' }).firestore(), anon: () => env.unauthenticatedContext().firestore() };

describe('maintenance freeze: nobody can write', () => {
  for (const who of Object.keys(as)) {
    it(`${who}: create, update, delete, batch and counter writes are all denied`, async () => {
      const db = as[who]();
      await assertFails(addDoc(collection(db, 'expenses'), { amount: 1, date: '2026-10-19', category: 'Fuel', createdBy: who, createdAt: serverTimestamp() }));
      await assertFails(updateDoc(doc(db, 'orders', 'o1'), { status: 'Cancelled' }));
      await assertFails(updateDoc(doc(db, 'products', 'p1'), { stockOnHand: 0 }));
      await assertFails(deleteDoc(doc(db, 'orders', 'o1')));
      await assertFails(setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 1 }));
      const b = writeBatch(db); b.set(doc(db, 'visits', 'v1'), { repId: who }); b.update(doc(db, 'products', 'p1'), { stockOnHand: 1 });
      await assertFails(b.commit());
    });
  }
});
describe('maintenance freeze: reads', () => {
  it('a manager can read orders, products and the roles document', async () => {
    const db = as.mgr();
    await assertSucceeds(getDoc(doc(db, 'orders', 'o1'))); await assertSucceeds(getDoc(doc(db, 'products', 'p1'))); await assertSucceeds(getDoc(doc(db, 'config', 'roles')));
  });
  it('a rep, deliverer, stranger and anonymous user cannot read', async () => {
    for (const who of ['rep1', 'deliv', 'stranger', 'anon']) await assertFails(getDoc(doc(as[who](), 'orders', 'o1')));
  });
  it('nothing was changed by the denied writes', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const o = (await getDoc(doc(ctx.firestore(), 'orders', 'o1'))).data(); const p = (await getDoc(doc(ctx.firestore(), 'products', 'p1'))).data();
      if (o.status !== 'Approved' || p.stockOnHand !== 10) throw new Error('a frozen write got through');
    });
  });
});
