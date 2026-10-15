// Firestore EMULATOR tests against the REAL rules file. NOT RUN in the environment that produced
// this patch (the emulator could not be downloaded there). They must be run by someone who has
// the deployed rules:
//
//   cd tests && npm install
//   NAISI_RULES_PATH=/absolute/path/to/firestore.rules npm run test:rules
//
// 1. Adapt seedUsers() to however YOUR rules decide who is a manager (custom claim, users/{uid}
//    document, email list...). Until adapted, tests that need a manager are skipped.
// 2. The assertions describe the behaviour that rules/invoicing.rules.fragment is meant to give.
//    Where your current rules are looser they will FAIL - that is the point: each failure is a gap.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const rulesPath = process.env.NAISI_RULES_PATH;
const d = rulesPath ? describe : describe.skip;

let env;
async function seedUsers(ctx) {
  // ADAPT: create whatever your rules read to recognise a manager, e.g.
  //   await setDoc(doc(ctx.firestore(), 'users', 'mgr'), { role: 'manager' });
}
const managerCtx = () => env.authenticatedContext('mgr', { email: 'mgr@example.com' /*, role: 'manager' */ });

d('invoicing rules (emulator, real rules file)', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'naisi-rules-test', firestore: { rules: readFileSync(rulesPath, 'utf8') } });
  });
  afterAll(async () => { await env?.cleanup(); });
  beforeEach(async () => {
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await seedUsers(ctx);
      await setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 370 });
      await setDoc(doc(db, 'orders', 'o1'), { orderNo: 'ORD-1', status: 'Approved', items: [], customerName: 'Shop', invoiceId: null });
    });
  });

  const lock = (db) => setDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 't1', invoicingLeaseStartedAt: serverTimestamp() }, { merge: true });
  const newInvoice = { orderId: 'o1', invoiceNo: 'NF-INV-0370', items: [], createdBy: 'mgr', grandTotal: 0 };

  it('new client: lock, then one atomic batch (counter + ord_ invoice + order Invoiced) succeeds', async () => {
    const db = managerCtx().firestore();
    await assertSucceeds(lock(db));
    const b = writeBatch(db);
    b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 });
    b.set(doc(db, 'invoices', 'ord_o1'), { ...newInvoice, createdAt: serverTimestamp() });
    b.update(doc(db, 'orders', 'o1'), { status: 'Invoiced', invoiceId: 'ord_o1', invoiceNo: 'NF-INV-0370', invoicingAttempt: null, invoicingLeaseStartedAt: null });
    await assertSucceeds(b.commit());
  });
  it('OLD client path: invoice with an automatic id and no orderId field is refused', async () => {
    const db = managerCtx().firestore();
    await assertFails(setDoc(doc(db, 'invoices', 'autoId123'), { invoiceNo: 'NF-INV-0370', items: [], createdBy: 'mgr' }));
  });
  it('OLD client path: order marked Invoiced with a non-ord_ invoiceId is refused', async () => {
    const db = managerCtx().firestore();
    await assertSucceeds(lock(db));
    await assertFails(setDoc(doc(db, 'orders', 'o1'), { status: 'Invoiced', invoiceId: 'autoId123', invoiceNo: 'X' }, { merge: true }));
  });
  it('a second invoice for the same order (ord_o1 already exists) is refused', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'invoices', 'ord_o1'), { ...newInvoice }); });
    const db = managerCtx().firestore();
    await assertFails(setDoc(doc(db, 'invoices', 'ord_o1'), { ...newInvoice, invoiceNo: 'NF-INV-0371' }));
  });
  it('invoice for an order that is not Invoicing / not marked Invoiced in the same commit is refused', async () => {
    const db = managerCtx().firestore();
    await assertFails(setDoc(doc(db, 'invoices', 'ord_o1'), { ...newInvoice }));   // order still Approved, no batch
  });
  it('resume within the lease is refused; after the lease it is allowed', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 'old', invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() - 60_000) }, { merge: true });
    });
    const db = managerCtx().firestore();
    await assertFails(setDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 'new', invoicingLeaseStartedAt: serverTimestamp() }, { merge: true }));
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'orders', 'o1'), { invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() - 3_600_000) }, { merge: true });
    });
    await assertSucceeds(setDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 'new', invoicingLeaseStartedAt: serverTimestamp() }, { merge: true }));
  });
  it('a client-supplied lease timestamp (not request.time) is refused', async () => {
    const db = managerCtx().firestore();
    await assertFails(setDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 't1', invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() + 99_999_999) }, { merge: true }));
  });
  it('products: unitsPerCase accepted as a positive integer or null (cleared), refused as 0/1.5/string', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'products', 'p1'), { productName: 'A', packLabel: 'S', stockOnHand: 0 }); });
    const db = managerCtx().firestore();
    await assertSucceeds(setDoc(doc(db, 'products', 'p1'), { unitsPerCase: 14 }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, 'products', 'p1'), { unitsPerCase: null }, { merge: true }));
    for (const bad of [0, 1.5, '14']) await assertFails(setDoc(doc(db, 'products', 'p1'), { unitsPerCase: bad }, { merge: true }));
  });
  it('non-managers cannot read or write orders/invoices (sanity check of the existing rules)', async () => {
    const db = env.authenticatedContext('stranger').firestore();
    await assertFails(getDoc(doc(db, 'invoices', 'ord_o1')));
    await assertFails(setDoc(doc(db, 'invoices', 'ord_o1'), { ...newInvoice }));
  });
});
