// Firestore EMULATOR tests against the REAL rules file. NOT RUN in the environment that produced
// this patch (the emulator could not be downloaded there). They must be run by someone who has
// the deployed rules:
//
//   cd tests && npm install
//   NAISI_RULES_PATH=/absolute/path/to/firestore.rules npm run test:rules
//
// 1. The real rules (supplied 2026-10-16) decide roles from email lists in the document config/roles
//    ({ managers: [...], submitters: [...], deliverers: [...] }, lower-case emails); seedUsers() below
//    writes that document.
// 1b. NAISI_RULES_STAGE says which version of the rules is under test: '0' = the file as supplied
//     (default), '1' = with rules/proposed/stage1-required.diff, '2' = stages 1 and 2 applied.
// 2. The assertions describe the behaviour that rules/invoicing.rules.fragment is meant to give.
//    Where your current rules are looser they will FAIL - that is the point: each failure is a gap.
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, query, where, runTransaction, writeBatch, serverTimestamp, Timestamp } from 'firebase/firestore';

const rulesPath = process.env.NAISI_RULES_PATH;
const d = rulesPath ? describe : describe.skip;

let env;
async function seedUsers(ctx) {
  await setDoc(doc(ctx.firestore(), 'config', 'roles'), {
    managers: ['mgr@example.com'], submitters: ['rep1@example.com', 'rep2@example.com'], deliverers: [],
  });
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

// ---------------------------------------------------------------------------------------------
// Daily-visits rule checks (see rules/invoicing.rules.fragment, "DAILY VISITS"). NOT RUN here.
// They need a rep user in the rules' own terms (adapt seedUsers/repCtx) and the REAL rules file.
// ---------------------------------------------------------------------------------------------
const STAGE = Number(process.env.NAISI_RULES_STAGE ?? '0');
const atLeast = (n) => (STAGE >= n ? it : it.skip);
const only = (n) => (STAGE === n ? it : it.skip);

d(`daily visits rules (emulator, real rules file, stage ${STAGE}) - NOT RUN in the authoring environment`, () => {
  const repCtx = (uid = 'rep1') => env.authenticatedContext(uid, { email: `${uid}@example.com` });
  const REQ = 'req-aaaaaaaa-1111';
  const visitPath = ['visits', `v_rep1_${REQ}`], orderPath = ['orders', `o_rep1_${REQ}`];
  const visit = (over = {}) => ({ schemaVersion: 2, requestId: REQ, customerId: 'c1', customerName: 'Shop', repId: 'rep1', repEmail: 'rep1@example.com',
    date: '2026-10-15', scheduledDay: 'Thu', wasScheduled: true, outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '', orderId: null, orderNo: null, orderValue: null, createdAt: serverTimestamp(), ...over });
  const orderDoc = (over = {}) => ({ orderNo: 'ORD-2026-0041', status: 'Submitted', createdBy: 'rep1', createdByEmail: 'rep1@example.com', customerId: 'c1', customerName: 'Shop',
    customerLat: -13.9, customerLng: 33.7, items: [], grandTotal: 0, visitId: visitPath[1], ...over });
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'customers', 'c1'), { name: 'Shop', active: true, assignedDay: 'Thu', lat: -13.9, lng: 33.7 });
      await setDoc(doc(ctx.firestore(), 'orderCounters', 'naisiOrder'), { counter: 41 });
    });
  });
  // The exact reads and writes the app's order save performs, in one transaction.
  const appOrderTransaction = (db, { visitOver = {}, orderOver = {} } = {}) => runTransaction(db, async (tx) => {
    await tx.get(doc(db, ...visitPath));
    await tx.get(doc(db, 'customers', 'c1'));
    const counter = await tx.get(doc(db, 'orderCounters', 'naisiOrder'));
    await tx.get(doc(db, ...orderPath));
    tx.set(doc(db, 'orderCounters', 'naisiOrder'), { counter: counter.data().counter + 1 });
    tx.set(doc(db, ...orderPath), orderDoc(orderOver));
    tx.set(doc(db, ...visitPath), visit({ outcome: 'Order Placed', reasonNoOrder: null, orderId: orderPath[1], orderNo: 'ORD-2026-0041', orderValue: 0, ...visitOver }));
  });
  const appNoOrderTransaction = (db, over = {}) => runTransaction(db, async (tx) => {
    await tx.get(doc(db, ...visitPath));
    await tx.get(doc(db, 'customers', 'c1'));
    tx.set(doc(db, ...visitPath), visit(over));
  });

  // ---- the gap found by reading the supplied rules (visits.get / orders.get use resource.data on a missing doc) ----
  only(0)('AS SUPPLIED: a rep reading a visit that does not exist yet is DENIED, so the app\'s order and no-order saves fail', async () => {
    const db = repCtx().firestore();
    await assertFails(getDoc(doc(db, ...visitPath)));
    await assertFails(appNoOrderTransaction(db));
    await assertFails(appOrderTransaction(db));
  });
  atLeast(1)('STAGE 1: a rep can read their own not-yet-existing visit and order ids', async () => {
    const db = repCtx().firestore();
    await assertSucceeds(getDoc(doc(db, ...visitPath)));
    await assertSucceeds(getDoc(doc(db, ...orderPath)));
  });
  atLeast(1)('STAGE 1: but not another rep\'s ids, and not another rep\'s existing documents', async () => {
    const db = repCtx().firestore();
    await assertFails(getDoc(doc(db, 'visits', `v_rep2_${REQ}`)));
    await assertFails(getDoc(doc(db, 'orders', `o_rep2_${REQ}`)));
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'visits', 'v_rep2_x'), visit({ repId: 'rep2' })); });
    await assertFails(getDoc(doc(db, 'visits', 'v_rep2_x')));
  });
  atLeast(1)('STAGE 1: the app\'s no-order transaction and order+visit+counter transaction both succeed, then a retry only reads', async () => {
    const db = repCtx().firestore();
    await assertSucceeds(appNoOrderTransaction(db));
    await env.clearFirestore();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await seedUsers(ctx);
      await setDoc(doc(ctx.firestore(), 'customers', 'c1'), { name: 'Shop', active: true, assignedDay: 'Thu', lat: -13.9, lng: 33.7 });
      await setDoc(doc(ctx.firestore(), 'orderCounters', 'naisiOrder'), { counter: 41 });
    });
    await assertSucceeds(appOrderTransaction(db));
    await assertSucceeds(getDoc(doc(db, ...visitPath)));     // the retry path reads the saved visit
    await assertSucceeds(getDoc(doc(db, ...orderPath)));     // and the saved order
  });

  // ---- behaviour that is the same in every stage ----
  it('rep can create a valid no-order visit directly; cannot create one for another rep', async () => {
    const db = repCtx().firestore();
    await assertSucceeds(setDoc(doc(db, ...visitPath), visit()));
    await assertFails(setDoc(doc(db, 'visits', `v_rep1_${REQ}2`), visit({ repId: 'rep2' })));
  });
  it('visits cannot be edited or deleted', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), ...visitPath), visit({ createdAt: Timestamp.now() })); });
    await assertFails(setDoc(doc(repCtx().firestore(), ...visitPath), visit({ reasonNotes: 'changed' })));
  });
  it('a rep can query their own visits by repId + date; a query without repId is refused', async () => {
    const db = repCtx().firestore();
    await assertSucceeds(getDocs(query(collection(db, 'visits'), where('repId', '==', 'rep1'), where('date', '==', '2026-10-15'))));
    await assertFails(getDocs(query(collection(db, 'visits'), where('date', '==', '2026-10-15'))));
  });
  it('a manager can read visits by date range and read the roles list', async () => {
    const db = env.authenticatedContext('mgr', { email: 'mgr@example.com' }).firestore();
    await assertSucceeds(getDocs(query(collection(db, 'visits'), where('date', '>=', '2026-10-01'), where('date', '<=', '2026-10-31'))));
    await assertSucceeds(getDoc(doc(db, 'config', 'roles')));
  });
  it('a manager can set a customer\'s visit day and the change time', async () => {
    const db = env.authenticatedContext('mgr', { email: 'mgr@example.com' }).firestore();
    await assertSucceeds(setDoc(doc(db, 'customers', 'c1'), { assignedDay: 'Fri', assignedDayChangedAt: serverTimestamp() }, { merge: true }));
  });
  it('the order number counter can only go up by one (the app\'s increment)', async () => {
    const db = repCtx().firestore();
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 45 }));
    await assertSucceeds(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42 }));
  });
  only(1)('STAGE 1 ONLY (known gap): a rep can still change a customer\'s visit day, and can still save a visit with a made-up reason', async () => {
    const db = repCtx().firestore();
    await assertSucceeds(setDoc(doc(db, 'customers', 'c1'), { assignedDay: 'Fri' }, { merge: true }));
    await assertSucceeds(setDoc(doc(db, ...visitPath), visit({ reasonNoOrder: 'Because' })));
  });

  // ---- stage 2 hardening ----
  atLeast(2)('STAGE 2: made-up reason, "Other" without an explanation, wrong id, wrong email, client-set time are refused', async () => {
    const db = repCtx().firestore();
    await assertFails(appNoOrderTransaction(db, { reasonNoOrder: 'Because' }));
    await assertFails(appNoOrderTransaction(db, { reasonNoOrder: 'Other', reasonNotes: '  ' }));
    await assertFails(setDoc(doc(db, 'visits', 'auto-id-not-allowed'), visit()));
    await assertFails(setDoc(doc(db, ...visitPath), visit({ repEmail: 'someone@else.com' })));
    await assertFails(setDoc(doc(db, ...visitPath), visit({ createdAt: Timestamp.fromMillis(1000) })));
    await assertSucceeds(appNoOrderTransaction(db, { reasonNoOrder: 'Other', reasonNotes: 'Owner at a funeral' }));
  });
  atLeast(2)('STAGE 2: an "Order Placed" visit without its order in the same commit is refused; with it, accepted', async () => {
    const db = repCtx().firestore();
    await assertFails(setDoc(doc(db, ...visitPath), visit({ outcome: 'Order Placed', reasonNoOrder: null, orderId: orderPath[1], orderNo: 'X', orderValue: 0 })));
    await assertSucceeds(appOrderTransaction(db));
  });
  atLeast(2)('STAGE 2: only a manager may change a customer\'s visit day; a rep can still edit other customer fields', async () => {
    const rep = repCtx().firestore();
    await assertFails(setDoc(doc(rep, 'customers', 'c1'), { assignedDay: 'Fri' }, { merge: true }));
    await assertSucceeds(setDoc(doc(rep, 'customers', 'c1'), { phone: '0999' }, { merge: true }));
    const mgr = env.authenticatedContext('mgr', { email: 'mgr@example.com' }).firestore();
    await assertSucceeds(setDoc(doc(mgr, 'customers', 'c1'), { assignedDay: 'Fri', assignedDayChangedAt: serverTimestamp() }, { merge: true }));
  });
});
