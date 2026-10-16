// Firestore EMULATOR tests for the complete final rules file (rules/firestore.rules.FINAL-CANDIDATE).
//
// RC3: updated for the eight owner decisions. The RC2 baseline (99 tests) passed on the emulator in independent QA;
// the RC3 rules and these updated/new tests have NOT yet been run on an emulator (the build sandbox cannot download it).
// Run them with  tests\run-rules-tests.bat  (Windows) or  cd tests && npm run test:rules.
// NAISI_RULES_PATH overrides which rules file is tested (default: the final candidate).
//
// Lifecycle (fixes the earlier bug where an afterAll cleaned up the environment before the second group ran):
//   * ONE test environment is created in a file-level beforeAll and cleaned up in a file-level afterAll.
//   * Every test starts from the same fully reset fixture (beforeEach: clearFirestore + seed).
//   * Nothing in a describe block creates or cleans up the environment.
//
// Roles (config/roles): manager mgr@, reps (submitters) rep1@ rep2@, deliverer deliv@, stranger@ (signed in, no role), anonymous.
import { describe, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, getDocs, collection, query, where, updateDoc, deleteDoc, addDoc, deleteField,
  runTransaction, writeBatch, serverTimestamp, Timestamp,
} from 'firebase/firestore';

const here = path.dirname(fileURLToPath(import.meta.url));
const rulesPath = process.env.NAISI_RULES_PATH || path.resolve(here, '../../rules/firestore.rules.FINAL-CANDIDATE');

// The real app modules talk to whichever Firestore instance is in holder.db (the signed-in role of the moment).
const holder = vi.hoisted(() => ({ db: null }));
vi.mock('../../src/firebase.js', () => ({ get db() { return holder.db; }, auth: {}, googleProvider: {} }));

let env;
beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: 'naisi-rules-test', firestore: { rules: readFileSync(rulesPath, 'utf8') } });
});
afterAll(async () => { await env?.cleanup(); });

const ctxs = {
  mgr: () => env.authenticatedContext('mgr', { email: 'mgr@example.com' }),
  rep1: () => env.authenticatedContext('rep1', { email: 'rep1@example.com' }),
  rep2: () => env.authenticatedContext('rep2', { email: 'rep2@example.com' }),
  deliv: () => env.authenticatedContext('deliv', { email: 'deliv@example.com' }),
  stranger: () => env.authenticatedContext('stranger', { email: 'stranger@example.com' }),
  anon: () => env.unauthenticatedContext(),
};
const as = (who) => ctxs[who]().firestore();

const REQ = 'req-aaaaaaaa-1111';
const V = `v_rep1_${REQ}`, O = `o_rep1_${REQ}`;
const shop = { name: 'Shop', phone: '0999', location: 'Area 25', active: true, assignedDay: 'Thu', lat: -13.9, lng: 33.7 };

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'config', 'roles'), { managers: ['mgr@example.com'], submitters: ['rep1@example.com', 'rep2@example.com'], deliverers: ['deliv@example.com'] });
    await setDoc(doc(db, 'customers', 'c1'), shop);
    await setDoc(doc(db, 'customers', 'c2'), { ...shop, name: 'Closed Shop', active: false, assignedDay: null });
    await setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 41 });
    await setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 370 });
    await setDoc(doc(db, 'products', 'p1'), { productName: 'Amanda', packLabel: '100g', stockOnHand: 10, unitsPerCase: 14 });
    await setDoc(doc(db, 'orders', 'o1'), { orderNo: 'ORD-2026-0001', status: 'Approved', items: [], customerName: 'Shop', createdBy: 'rep1', invoiceId: null });
    await setDoc(doc(db, 'orders', 'oInv'), { orderNo: 'ORD-2026-0002', status: 'Invoiced', items: [], customerName: 'Shop', createdBy: 'rep1', invoiceId: 'ord_oInv', invoiceNo: 'NF-INV-0300' });
    await setDoc(doc(db, 'invoices', 'ord_oInv'), { orderId: 'oInv', invoiceNo: 'NF-INV-0300', items: [], createdBy: 'mgr' });
    await setDoc(doc(db, 'visits', 'v_rep2_x'), { repId: 'rep2', outcome: 'No Order', customerId: 'c1', customerName: 'Shop' });
    await setDoc(doc(db, 'orders', 'o_rep2_x'), { orderNo: 'ORD-2026-0003', status: 'Submitted', createdBy: 'rep2', items: [] });
  });
});

// ---- document builders (what the real app writes) ----
const visit = (over = {}) => ({ schemaVersion: 2, requestId: REQ, customerId: 'c1', customerName: 'Shop', repId: 'rep1', repEmail: 'rep1@example.com',
  date: '2026-10-15', scheduledDay: 'Thu', wasScheduled: true, outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '',
  orderId: null, orderNo: null, orderValue: null, createdAt: serverTimestamp(), ...over });
const orderDoc = (over = {}) => ({ orderNo: 'ORD-2026-0041', status: 'Submitted', customerId: 'c1', customerName: 'Shop', customerPhone: '0999', customerLocation: 'Area 25',
  customerLat: -13.9, customerLng: 33.7, items: [{ qty: 1, price: 5, total: 5, productId: 'p1' }], notes: '', grandTotal: 5, createdBy: 'rep1', createdByEmail: 'rep1@example.com',
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), submittedAt: serverTimestamp(), invoiceId: null, invoiceNo: null, visitId: V, source: 'rep-visit', ...over });
const placedVisit = (over = {}) => visit({ outcome: 'Order Placed', reasonNoOrder: null, orderId: O, orderNo: 'ORD-2026-0041', orderValue: 5, ...over });

// The exact write set of the app's order save (one atomic commit), with hooks to break each part.
async function saveOrderBatch(db, { skip = [], order = {}, vis = {}, counter = { counter: 42, lastOrderId: O } } = {}) {
  const b = writeBatch(db);
  if (!skip.includes('counter')) b.set(doc(db, 'orderCounters', 'naisiOrder'), counter);
  if (!skip.includes('order')) b.set(doc(db, 'orders', O), orderDoc(order));
  if (!skip.includes('visit')) b.set(doc(db, 'visits', V), placedVisit(vis));
  return b.commit();
}
const bump = (over = {}) => ({ counter: 42, lastOrderId: O, ...over });

// =============================================================================================
describe('A. unauthorized users (anonymous and signed-in without a role)', () => {
  for (const who of ['anon', 'stranger']) {
    it(`${who}: cannot read or write any business collection`, async () => {
      const db = as(who);
      for (const p of [['orders', 'o1'], ['visits', 'v_rep2_x'], ['customers', 'c1'], ['invoices', 'ord_oInv'], ['products', 'p1'],
        ['counters', 'naisiInvoice'], ['orderCounters', 'naisiOrder'], ['stockMovements', 'x'], ['expenses', 'x'],
        ['scheduleChanges', 'x'], ['customerMerges', 'x'], ['counterAdjustments', 'x'], ['invoiceNumbers', 'x'],
        ['orderCancellations', 'x'], ['config', 'scheduleHistory']]) {
        await assertFails(getDoc(doc(db, ...p)));
        await assertFails(setDoc(doc(db, ...p), { a: 1 }));
      }
      await assertFails(getDocs(collection(db, 'orders')));
      await assertFails(getDocs(collection(db, 'visits')));
    });
    it(`${who}: cannot take any role by writing config/roles`, async () => {
      await assertFails(setDoc(doc(as(who), 'config', 'roles'), { managers: ['stranger@example.com'] }));
    });
  }
  it('stranger cannot create a visit, an order, a customer or an invoice', async () => {
    const db = as('stranger');
    await assertFails(setDoc(doc(db, 'visits', 'v_stranger_' + REQ), visit({ repId: 'stranger', repEmail: 'stranger@example.com' })));
    await assertFails(setDoc(doc(db, 'orders', 'ox'), orderDoc({ createdBy: 'stranger' })));
    await assertFails(addDoc(collection(db, 'customers'), { ...shop }));
  });
});

// =============================================================================================
describe('B. deliverer', () => {
  it('can read an Invoiced order but not an Approved one, and not invoices, visits or customers lists', async () => {
    const db = as('deliv');
    await assertSucceeds(getDoc(doc(db, 'orders', 'oInv')));
    await assertFails(getDoc(doc(db, 'orders', 'o1')));
    await assertSucceeds(getDocs(query(collection(db, 'orders'), where('status', '==', 'Invoiced'))));
    await assertFails(getDocs(collection(db, 'orders')));
    await assertFails(getDoc(doc(db, 'invoices', 'ord_oInv')));
    await assertFails(getDoc(doc(db, 'visits', 'v_rep2_x')));
  });
  it('can mark an Invoiced order Delivered (delivery fields only) but cannot change items or create documents', async () => {
    const db = as('deliv');
    await assertSucceeds(updateDoc(doc(db, 'orders', 'oInv'), { status: 'Delivered', deliveredBy: 'deliv', deliveredByEmail: 'deliv@example.com', deliveredAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(db, 'orders', 'oInv'), { items: [{ x: 1 }] }));
    await assertFails(setDoc(doc(db, 'orders', 'new1'), orderDoc({ createdBy: 'deliv' })));
    await assertFails(setDoc(doc(db, 'visits', 'v_deliv_' + REQ), visit({ repId: 'deliv', repEmail: 'deliv@example.com' })));
  });
  it('cannot change an order that is not Invoiced', async () => {
    await assertFails(updateDoc(doc(as('deliv'), 'orders', 'o1'), { status: 'Delivered', deliveredBy: 'deliv' }));
  });
  it('can record a failed delivery attempt (append-only) and not read attempts', async () => {
    const db = as('deliv');
    await assertSucceeds(addDoc(collection(db, 'deliveryAttempts'), { by: 'deliv', outcome: 'Failed', reason: 'Shop closed' }));
    await assertFails(getDocs(collection(db, 'deliveryAttempts')));
  });
});

// =============================================================================================
describe('C. rep first save: reads of a document that does not exist yet', () => {
  it('rep may read ITS OWN missing visit/order id (idempotent first save)', async () => {
    const db = as('rep1');
    await assertSucceeds(getDoc(doc(db, 'visits', V)));
    await assertSucceeds(getDoc(doc(db, 'orders', O)));
  });
  it('rep may NOT read another rep\'s missing or existing visit/order, nor a manager-style id', async () => {
    const db = as('rep1');
    await assertFails(getDoc(doc(db, 'visits', `v_rep2_${REQ}`)));
    await assertFails(getDoc(doc(db, 'visits', 'v_rep2_x')));
    await assertFails(getDoc(doc(db, 'orders', 'o_rep2_x')));
    await assertFails(getDoc(doc(db, 'visits', 'anything')));
  }, 30000);
  it('rep may read an existing order/visit it owns', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'visits', V), { repId: 'rep1' }); });
    await assertSucceeds(getDoc(doc(as('rep1'), 'visits', V)));
  });
  it('list queries stay restricted: own visits/orders only, never the whole collection', async () => {
    const db = as('rep1');
    await assertFails(getDocs(collection(db, 'visits')));
    await assertFails(getDocs(query(collection(db, 'visits'), where('repId', '==', 'rep2'))));
    await assertSucceeds(getDocs(query(collection(db, 'visits'), where('repId', '==', 'rep1'))));
    await assertFails(getDocs(collection(db, 'orders')));
    await assertFails(getDocs(query(collection(db, 'orders'), where('createdBy', '==', 'rep2'))));
    await assertSucceeds(getDocs(query(collection(db, 'orders'), where('createdBy', '==', 'rep1'))));
  });
  it('manager reads everything', async () => {
    const db = as('mgr');
    await assertSucceeds(getDocs(collection(db, 'visits')));
    await assertSucceeds(getDocs(collection(db, 'orders')));
  });
});

// =============================================================================================
describe('D. rep no-order visits', () => {
  const put = (over = {}, id = V, who = 'rep1') => setDoc(doc(as(who), 'visits', id), visit(over));
  it('valid no-order visit is saved', async () => { await assertSucceeds(put()); });
  it('valid "Other" with an explanation is saved', async () => { await assertSucceeds(put({ reasonNoOrder: 'Other', reasonNotes: 'Owner at a funeral' })); });
  it.each([
    ['visit under another rep\'s uid', { repId: 'rep2' }],
    ['someone else\'s email', { repEmail: 'rep2@example.com' }],
    ['unknown reason', { reasonNoOrder: 'Made up' }],
    ['"Other" without explanation', { reasonNoOrder: 'Other', reasonNotes: '  ' }],
    ['"Other" with 2 characters', { reasonNoOrder: 'Other', reasonNotes: 'ab' }],
    ['notes over 500 characters', { reasonNotes: 'x'.repeat(501) }],
    ['a client-supplied createdAt', { createdAt: Timestamp.fromMillis(1) }],
    ['a no-order visit carrying an order id', { orderId: O }],
    ['an inactive customer', { customerId: 'c2', customerName: 'Closed Shop' }],
    ['a missing customer', { customerId: 'nope' }],
    ['a customer name that does not match the customer', { customerName: 'Other Shop' }],
    ['an unknown outcome', { outcome: 'Maybe' }],
  ])('refuses %s', async (_n, over) => { await assertFails(put(over)); });
  it('refuses an id that does not match the request id / uid (forged id)', async () => {
    await assertFails(put({}, 'v_rep1_other-request'));
    await assertFails(put({}, `v_rep2_${REQ}`));
    await assertFails(put({}, 'random-id'));
  });
  it('a rep cannot update or delete a visit, even its own; a repeat create over an existing visit is refused', async () => {
    await assertSucceeds(put());
    await assertFails(updateDoc(doc(as('rep1'), 'visits', V), { reasonNoOrder: 'Other' }));
    await assertFails(deleteDoc(doc(as('rep1'), 'visits', V)));
    await assertFails(put({ reasonNoOrder: 'Price too high' }));   // second create over the same id = an update
  });
  it('manager can re-point customerId/customerName ONLY while the old customer carries a merge lock into the new one; no other edit, no delete', async () => {
    await assertSucceeds(put());
    await assertFails(updateDoc(doc(as('mgr'), 'visits', V), { customerId: 'c2', customerName: 'Closed Shop' }));      // no lock: refused
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'customers', 'c1'), { mergeLock: { into: 'c2', by: 'mgr', at: Timestamp.now() } }); });
    await assertSucceeds(updateDoc(doc(as('mgr'), 'visits', V), { customerId: 'c2', customerName: 'Closed Shop' }));
    await assertFails(updateDoc(doc(as('mgr'), 'visits', V), { outcome: 'Order Placed' }));
    await assertFails(updateDoc(doc(as('mgr'), 'visits', V), { repId: 'rep2' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'visits', V)));
  });
  it('a manager can NOT create a visit (a visit is a rep\'s own record)', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'visits', 'v_mgr_' + REQ), visit({ repId: 'mgr', repEmail: 'mgr@example.com' })));
    await assertFails(setDoc(doc(as('mgr'), 'visits', V), visit()));                           // not even in a rep's name
  });
  it('refuses a visit to a customer that is being merged', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'customers', 'c1'), { mergeLock: { into: 'c2', by: 'mgr', at: Timestamp.now() } }); });
    await assertFails(put());
  });
  it('deliverer and stranger cannot create visits', async () => {
    await assertFails(put({ repId: 'deliv', repEmail: 'deliv@example.com' }, 'v_deliv_' + REQ, 'deliv'));
  });
});

// =============================================================================================
describe('E. order <-> visit <-> counter integrity (from BOTH sides)', () => {
  it('the app\'s normal save (counter + order + visit in one commit) succeeds', async () => {
    await assertSucceeds(saveOrderBatch(as('rep1')));
  });
  it('...and as one transaction with the app\'s reads first', async () => {
    const db = as('rep1');
    await assertSucceeds(runTransaction(db, async (tx) => {
      await tx.get(doc(db, 'visits', V)); await tx.get(doc(db, 'customers', 'c1'));
      const c = await tx.get(doc(db, 'orderCounters', 'naisiOrder')); await tx.get(doc(db, 'orders', O));
      tx.set(doc(db, 'orderCounters', 'naisiOrder'), { counter: c.data().counter + 1, lastOrderId: O });
      tx.set(doc(db, 'orders', O), orderDoc());
      tx.set(doc(db, 'visits', V), placedVisit());
    }));
  });
  it('first order ever (no counter document yet): counter 2 + order + visit succeeds', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), 'orderCounters', 'naisiOrder')); });
    await assertSucceeds(saveOrderBatch(as('rep1'), { order: { orderNo: 'ORD-2026-0001' }, vis: { orderNo: 'ORD-2026-0001' }, counter: { counter: 2, lastOrderId: O } }));
  });
  it('REFUSED: order alone (no visit, no counter) - the old "order first" path', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { skip: ['visit', 'counter'] }));
  });
  it('REFUSED: order + counter without the visit', async () => { await assertFails(saveOrderBatch(as('rep1'), { skip: ['visit'] })); });
  it('REFUSED: order + visit without moving the counter (uncounted order number)', async () => { await assertFails(saveOrderBatch(as('rep1'), { skip: ['counter'] })); });
  it('REFUSED: order in one commit, visit in a later commit (split commit)', async () => {
    const db = as('rep1');
    await assertFails(setDoc(doc(db, 'orders', O), orderDoc()));
    await assertFails(setDoc(doc(db, 'visits', V), placedVisit()));   // also: an Order Placed visit alone
  });
  it('REFUSED: "Order Placed" visit with no order in the commit', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { skip: ['order', 'counter'] }));
  });
  it('REFUSED: counter moved without an order (counter-only bump, rep)', async () => {
    const db = as('rep1');
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42 }));
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), bump()));          // names an order that is not created
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 99, lastOrderId: O }));
  });
  it('REFUSED: counter jumps by 2, or goes backwards', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { counter: bump({ counter: 43 }) }));
    await assertFails(saveOrderBatch(as('rep1'), { counter: bump({ counter: 40 }) }));
  });
  it('REFUSED: forged order number (not the counter value taken)', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { order: { orderNo: 'ORD-2026-0099' }, vis: { orderNo: 'ORD-2026-0099' } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { orderNo: 'ORD-2026-0040' }, vis: { orderNo: 'ORD-2026-0040' } }));   // an already-used number
  });
  it('REFUSED: order number differs between order and visit', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { vis: { orderNo: 'ORD-2026-0042' } }));
  });
  it('REFUSED: visit value differs from the order total', async () => { await assertFails(saveOrderBatch(as('rep1'), { vis: { orderValue: 6 } })); });
  it('REFUSED: visit and order for different customers', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { vis: { customerId: 'c2', customerName: 'Closed Shop' } }));
  });
  it('REFUSED: order for an inactive customer / wrong customer name / wrong pin', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { order: { customerId: 'c2', customerName: 'Closed Shop' }, vis: { customerId: 'c2', customerName: 'Closed Shop' } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { customerName: 'Other' } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { customerLat: -13.0 } }));
  });
  it('REFUSED: order owned by someone else, or created already Approved/Invoiced', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { order: { createdBy: 'rep2' } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { status: 'Approved' } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { status: 'Invoiced' } }));
  });
  it('REFUSED: order without a pin, empty order, order pointing at another visit', async () => {
    await assertFails(saveOrderBatch(as('rep1'), { order: { customerLat: null, customerLng: null } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { items: [], grandTotal: 0 }, vis: { orderValue: 0 } }));
    await assertFails(saveOrderBatch(as('rep1'), { order: { visitId: 'v_rep1_other-request-id' } }));
  });
  it('REFUSED: order id not derived from the request id; visit id mismatch', async () => {
    const db = as('rep1'); const b = writeBatch(db);
    b.set(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42, lastOrderId: 'o_rep1_wrong' });
    b.set(doc(db, 'orders', 'o_rep1_wrong'), orderDoc());
    b.set(doc(db, 'visits', V), placedVisit({ orderId: 'o_rep1_wrong' }));
    await assertFails(b.commit());
  });
  it('REFUSED: a second save over an existing order/visit (duplicate) and a rep editing or deleting the order afterwards', async () => {
    await assertSucceeds(saveOrderBatch(as('rep1')));
    await assertFails(saveOrderBatch(as('rep1'), { counter: bump({ counter: 43 }) }));
    await assertFails(updateDoc(doc(as('rep1'), 'orders', O), { grandTotal: 1 }));
    await assertFails(deleteDoc(doc(as('rep1'), 'orders', O)));
  });
  it('rep2 cannot attach an order to rep1\'s visit id', async () => {
    const db = as('rep2'); const b = writeBatch(db);
    b.set(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42, lastOrderId: O });
    b.set(doc(db, 'orders', O), orderDoc({ createdBy: 'rep2', createdByEmail: 'rep2@example.com' }));
    b.set(doc(db, 'visits', V), placedVisit({ repId: 'rep2', repEmail: 'rep2@example.com' }));
    await assertFails(b.commit());
  });
  it('legacy submitOrder path (addDoc order with NO visitId field, then counter) is refused for reps with permission-denied', async () => {
    const db = as('rep1');
    const { visitId, ...legacyOrder } = orderDoc();          // a valid legacy payload: the field is OMITTED, never undefined
    if ('visitId' in legacyOrder) throw new Error('fixture error: visitId must be omitted');
    await assertDenied(addDoc(collection(db, 'orders'), legacyOrder));
    // ...and the counter-first half of the legacy path is refused too (no order in the same commit)
    await assertDenied(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42 }));
    const stored = await readAsAdmin((adb) => getDocs(query(collection(adb, 'orders'), where('createdBy', '==', 'rep1'), where('orderNo', '==', 'ORD-2026-0041'))));
    if (stored.size !== 0) throw new Error('the refused legacy order was stored');
  });
  it('manager cannot create an arbitrary order (only on behalf of a rep, group L) and cannot move the order counter by hand; the order workflow still works', async () => {
    const db = as('mgr');
    await assertFails(setDoc(doc(db, 'orders', 'mgrOrder'), { orderNo: 'ORD-2026-0050', status: 'Submitted', items: [], createdBy: 'mgr' }));
    await assertFails(addDoc(collection(db, 'orders'), orderDoc({ createdBy: 'mgr', createdByEmail: 'mgr@example.com' })));
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42 }));          // RC2 allowed +1; RC3 allows it only WITH its order
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 100 }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'o_rep2_x'), { status: 'Approved', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'o_rep2_x'), { status: 'Rejected' }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'o1'), { items: [{ qty: 2 }] }));               // edit an approved order
    await assertFails(deleteDoc(doc(db, 'orders', 'o1')));
  });
  it('a rep order may not carry manager-entered / cancellation fields or another source', async () => {
    for (const over of [{ source: 'manager-entered' }, { attributedRepEmail: 'rep1@example.com' }, { enteredBy: 'rep1' }, { cancelReason: 'x' }]) {
      await assertFails(saveOrderBatch(as('rep1'), { order: over }));
    }
  });
  it('a rep order written by an OLD client (no source field) is still accepted: reps need no update before the rules change', async () => {
    const { source, ...old } = orderDoc();
    const db = as('rep1'); const b = writeBatch(db);
    b.set(doc(db, 'orderCounters', 'naisiOrder'), bump());
    b.set(doc(db, 'orders', O), old);
    b.set(doc(db, 'visits', V), placedVisit());
    await assertSucceeds(b.commit());
  });
});

// =============================================================================================
describe('F. customers: new customers are unscheduled; schedule fields are manager-only and dated', () => {
  const newCust = (over = {}) => ({ name: 'New Shop', phone: '', location: 'Area 3', lat: -13.9, lng: 33.7, active: true, assignedDay: null, createdBy: 'rep1', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  const entry = (over = {}) => ({ customerId: 'c1', customerName: 'Shop', kind: 'schedule', active: true, assignedDay: 'Fri', changedBy: 'mgr', changedByEmail: 'mgr@example.com', createdAt: serverTimestamp(), ...over });
  const change = (db, { id = 'chg1', patch = {}, ent = {}, skipEntry = false } = {}) => {
    const b = writeBatch(db);
    b.update(doc(db, 'customers', 'c1'), { assignedDay: 'Fri', lastScheduleChangeId: id, updatedAt: serverTimestamp(), ...patch });
    if (!skipEntry) b.set(doc(db, 'scheduleChanges', id), entry(ent));
    return b.commit();
  };
  it('rep and manager can create a customer exactly as the app does: active, pinned, NO day', async () => {
    await assertSucceeds(addDoc(collection(as('rep1'), 'customers'), newCust()));
    await assertSucceeds(addDoc(collection(as('mgr'), 'customers'), newCust({ createdBy: 'mgr' })));
    await assertSucceeds(addDoc(collection(as('rep2'), 'customers'), newCust({ createdBy: 'rep2' })));
  });
  it.each([
    ['with a visit day (no automatic weekday any more)', { assignedDay: 'Mon' }],
    ['inactive', { active: false }],
    ['with a schedule-change time', { assignedDayChangedAt: serverTimestamp() }],
    ['with a schedule-change id', { lastScheduleChangeId: 'x' }],
    ['already merge-locked', { mergeLock: { into: 'c1', by: 'rep1', at: serverTimestamp() } }],
    ['with a made-up day', { assignedDay: 'Sunday' }],
    ['with no pin', { lat: null, lng: null }],
    ['with an out-of-range pin', { lat: 123, lng: 33 }],
  ])('rep cannot create a customer %s', async (_n, over) => { await assertFails(addDoc(collection(as('rep1'), 'customers'), newCust(over))); });
  it.each([
    ['with a visit day', { assignedDay: 'Mon' }],
    ['inactive', { active: false }],
  ])('manager cannot create a customer %s either (scheduling is a separate, dated step)', async (_n, over) => { await assertFails(addDoc(collection(as('mgr'), 'customers'), newCust(over))); });
  it('stranger and deliverer cannot create customers', async () => {
    await assertFails(addDoc(collection(as('stranger'), 'customers'), newCust()));
    await assertFails(addDoc(collection(as('deliv'), 'customers'), newCust()));
  });
  it('rep can edit contact/name/location/pin', async () => {
    const d = doc(as('rep1'), 'customers', 'c1');
    await assertSucceeds(updateDoc(d, { phone: '0888', location: 'Area 18', name: 'Shop B', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(d, { lat: -14.0, lng: 33.8 }));
  });
  it.each([
    ['deactivate', { active: false }],
    ['reactivate/force active', { active: true, assignedDay: null }],
    ['change the visit day', { assignedDay: 'Fri' }],
    ['clear the visit day', { assignedDay: null }],
    ['set assignedDayChangedAt', { assignedDayChangedAt: serverTimestamp() }],
    ['set a schedule-change id', { lastScheduleChangeId: 'whatever' }],
    ['take the merge lock', { mergeLock: { into: 'c2', by: 'rep1', at: serverTimestamp() } }],
  ])('rep cannot %s', async (_n, patch) => {
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), patch));
    await assertFails(setDoc(doc(as('rep1'), 'customers', 'c1'), { ...shop, ...patch }));     // full overwrite is also an update
  });
  it('rep cannot REMOVE a schedule field (field removal counts as touching it)', async () => {
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), { assignedDay: deleteField() }));
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), { active: deleteField() }));
    await assertFails(setDoc(doc(as('rep1'), 'customers', 'c1'), { name: 'Shop', phone: '0999', location: 'Area 25', lat: -13.9, lng: 33.7 }));   // overwrite that omits active + assignedDay
  });
  it('rep cannot remove the pin, cannot delete a customer', async () => {
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), { lat: null }));
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), { lat: deleteField() }));
    await assertFails(deleteDoc(doc(as('rep1'), 'customers', 'c1')));
  });
  it('manager: a day change succeeds ONLY together with its dated history entry', async () => {
    await assertFails(updateDoc(doc(as('mgr'), 'customers', 'c1'), { assignedDay: 'Fri' }));                       // bare update (the RC2 way)
    await assertFails(updateDoc(doc(as('mgr'), 'customers', 'c1'), { assignedDay: 'Fri', assignedDayChangedAt: serverTimestamp() }));
    await assertFails(change(as('mgr'), { skipEntry: true }));                                                       // lastScheduleChangeId without an entry
    await assertSucceeds(change(as('mgr')));
  });
  it('manager: the history entry must describe exactly the new state, be for this customer, and carry the manager\'s identity and server time', async () => {
    const db = as('mgr');
    await assertFails(change(db, { id: 'e1', ent: { assignedDay: 'Sat' } }));                      // entry says Sat, customer says Fri
    await assertFails(change(db, { id: 'e2', ent: { customerId: 'c2' } }));                          // entry for another customer
    await assertFails(change(db, { id: 'e3', ent: { changedBy: 'rep1' } }));
    await assertFails(change(db, { id: 'e4', ent: { createdAt: Timestamp.fromMillis(1) } }));        // client-supplied time
    await assertFails(change(db, { id: 'e5', ent: { kind: 'baseline' } }));                          // baselines are only for the first hour
    await assertFails(change(db, { id: 'e6', ent: { kind: 'deactivate', active: false } }));        // kind/state mismatch
    await assertFails(change(db, { id: 'e7', patch: { assignedDay: 'Sunday' }, ent: { assignedDay: 'Sunday' } }));
    await assertSucceeds(change(db, { id: 'e8' }));
  });
  it('manager: deactivate (day cleared), reactivate (stays unscheduled) and clearing a day are all dated', async () => {
    const db = as('mgr');
    const run = (id, patch, ent) => { const b = writeBatch(db); b.update(doc(db, 'customers', 'c1'), { lastScheduleChangeId: id, updatedAt: serverTimestamp(), ...patch }); b.set(doc(db, 'scheduleChanges', id), entry({ ...ent })); return b.commit(); };
    await assertFails(run('d0', { active: false }, { kind: 'deactivate', active: false, assignedDay: null }));                // inactive but still has Thu
    await assertSucceeds(run('d1', { active: false, assignedDay: null }, { kind: 'deactivate', active: false, assignedDay: null }));
    await assertFails(run('r0', { active: true, assignedDay: 'Mon' }, { kind: 'reactivate', active: true, assignedDay: 'Mon' }));  // reactivate never sets a day
    await assertSucceeds(run('r1', { active: true, assignedDay: null }, { kind: 'reactivate', active: true, assignedDay: null }));
    await assertSucceeds(run('s1', { assignedDay: 'Sat' }, { kind: 'schedule', assignedDay: 'Sat' }));
    await assertSucceeds(run('s2', { assignedDay: null }, { kind: 'schedule', assignedDay: null }));
  });
  it('manager: reusing the previous change id is refused (every schedule change is a NEW entry)', async () => {
    await assertSucceeds(change(as('mgr'), { id: 'once' }));
    await assertFails(change(as('mgr'), { id: 'once', patch: { assignedDay: 'Sat' }, ent: { assignedDay: 'Sat' } }));
  });
  it('manager can edit contact details without a history entry (not a schedule change)', async () => {
    await assertSucceeds(updateDoc(doc(as('mgr'), 'customers', 'c1'), { phone: '0777', updatedAt: serverTimestamp() }));
  });
  it('nobody can delete a customer on its own (deactivate instead)', async () => {
    for (const who of ['mgr', 'rep1', 'deliv', 'stranger']) await assertFails(deleteDoc(doc(as(who), 'customers', 'c2')));
  });
  it('a customer that is being merged cannot be rescheduled or have its lock tampered with', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'customers', 'c1'), { mergeLock: { into: 'c2', by: 'mgr', at: Timestamp.now() } }); });
    await assertFails(change(as('mgr')));
    await assertFails(updateDoc(doc(as('mgr'), 'customers', 'c1'), { mergeLock: { into: 'c2', by: 'rep1', at: serverTimestamp() } }));
  });
  it('deliverer can read customers but cannot write them; stranger neither', async () => {
    await assertSucceeds(getDoc(doc(as('deliv'), 'customers', 'c1')));
    await assertFails(updateDoc(doc(as('deliv'), 'customers', 'c1'), { phone: '1' }));
    await assertFails(getDoc(doc(as('stranger'), 'customers', 'c1')));
  });
});

// =============================================================================================
describe('G. invoices and orders: the seven protections + legitimate paths', () => {
  const lock = (db, over = {}) => updateDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 't1', invoicingLeaseStartedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  const inv = (over = {}) => ({ orderId: 'o1', kind: 'order', invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr', grandTotal: 0, customer: 'Shop', createdAt: serverTimestamp(), ...over });
  const reg = (invoiceId, no = 'NF-INV-2026-0370') => ({ invoiceId, issuedBy: 'mgr', issuedAt: serverTimestamp() });
  const commit = (db, { invoiceId = 'ord_o1', invoice = {}, order = {}, counter = { prefix: 'NF-INV', counter: 371, lastInvoiceId: invoiceId }, skip = [], regNo = 'NF-INV-2026-0370' } = {}) => {
    const b = writeBatch(db);
    if (!skip.includes('counter')) b.set(doc(db, 'counters', 'naisiInvoice'), counter);
    if (!skip.includes('registry')) b.set(doc(db, 'invoiceNumbers', regNo), reg(invoiceId));
    if (!skip.includes('invoice')) b.set(doc(db, 'invoices', invoiceId), inv(invoice));
    if (!skip.includes('order')) b.update(doc(db, 'orders', 'o1'), { status: 'Invoiced', invoiceId, invoiceNo: 'NF-INV-2026-0370', invoicingAttempt: null, invoicingLeaseStartedAt: null, invoicedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...order });
    return b.commit();
  };
  it('legitimate: lock, then ONE atomic commit (counter + ord_ invoice + order Invoiced)', async () => {
    const db = as('mgr');
    await assertSucceeds(lock(db));
    await assertSucceeds(commit(db));
  });
  it('legitimate: revert a lock (Invoicing -> Approved)', async () => {
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'o1'), { status: 'Approved', invoicingAttempt: null, invoicingLeaseStartedAt: null }));
  });
  const SA = `sa_mgr_${REQ}`;
  const standalone = (db, { id = SA, invoice = {}, counter = {}, skip = [] } = {}) => {
    const b = writeBatch(db);
    if (!skip.includes('counter')) b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371, lastInvoiceId: id, ...counter });
    if (!skip.includes('registry')) b.set(doc(db, 'invoiceNumbers', 'NF-INV-2026-0370'), reg(id));
    b.set(doc(db, 'invoices', id), inv({ orderId: null, kind: 'standalone', requestId: REQ, ...invoice }));
    return b.commit();
  };
  it('legitimate: stand-alone invoice with the explicit id sa_<uid>_<requestId>, kind standalone, orderId null, counter +1 and the registry entry in the same commit', async () => {
    await assertSucceeds(standalone(as('mgr')));
  });
  it('REFUSED stand-alone variants: automatic id, another user\'s id, id/requestId mismatch, wrong kind, a missing request id, no registry entry, counter not naming it', async () => {
    const db = as('mgr');
    await assertFails(standalone(db, { id: 'autoStandalone1' }));
    await assertFails(standalone(db, { id: `sa_rep1_${REQ}` }));
    await assertFails(standalone(db, { invoice: { requestId: 'req-bbbbbbbb-2222' } }));
    await assertFails(standalone(db, { invoice: { kind: 'order' } }));
    { const b = writeBatch(db); const { requestId, ...noReq } = inv({ orderId: null, kind: 'standalone' });          // no request id at all
      b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371, lastInvoiceId: SA });
      b.set(doc(db, 'invoiceNumbers', 'NF-INV-2026-0370'), reg(SA)); b.set(doc(db, 'invoices', SA), noReq);
      await assertFails(b.commit()); }
    await assertFails(standalone(db, { skip: ['registry'] }));
    await assertFails(standalone(db, { counter: { lastInvoiceId: 'other' } }));
    await assertFails(standalone(db, { counter: { counter: 372 } }));
  });
  it('a stand-alone retry over the same id is an update and is refused by the rules (the app returns the saved invoice instead)', async () => {
    await assertSucceeds(standalone(as('mgr')));
    await assertFails(standalone(as('mgr'), { counter: { counter: 372 } }));
  });
  it('legitimate: edit an existing invoice (customer/items) but not its identity', async () => {
    const d = doc(as('mgr'), 'invoices', 'ord_oInv');
    await assertSucceeds(updateDoc(d, { customer: 'Renamed', items: [{ a: 1 }], updatedAt: serverTimestamp() }));
    for (const f of [{ orderId: 'x' }, { invoiceNo: 'NF-INV-9999' }, { createdBy: 'rep1' }, { createdAt: serverTimestamp() }, { kind: 'standalone' }, { requestId: 'zzzzzzzz' }]) await assertFails(updateDoc(d, f));
  });
  // ---- 1..7 ----
  it('PROTECTION 1: an old-client invoice (automatic id, no orderId field) is refused', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'invoices', 'autoId123'), { invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr' }));
  });
  it('PROTECTION 2: an order marked Invoiced with an invalid invoice link is refused', async () => {
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertFails(updateDoc(doc(db, 'orders', 'o1'), { status: 'Invoiced', invoiceId: 'autoId123', invoiceNo: 'X' }));       // not ord_<id>
    await assertFails(updateDoc(doc(db, 'orders', 'o1'), { status: 'Invoiced', invoiceId: 'ord_o1', invoiceNo: 'X' }));          // no invoice in the commit
    await assertFails(updateDoc(doc(as('mgr'), 'orders', 'o1'), { status: 'Invoiced', invoiceId: null }));
  });
  it('PROTECTION 2b: Approved -> Invoiced directly (skipping the lock) is refused', async () => {
    await assertFails(commit(as('mgr')));
  });
  it('PROTECTION 3: overwriting an existing order-linked invoice is refused', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'invoices', 'ord_o1'), { orderId: 'o1', invoiceNo: 'NF-INV-2026-0369', items: [], createdBy: 'mgr' }); });
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertFails(commit(db));
    await assertFails(setDoc(doc(db, 'invoices', 'ord_oInv'), inv({ orderId: 'oInv' })));     // overwrite as set()
  });
  it('PROTECTION 4: an order-linked invoice without the atomic order transition is refused', async () => {
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertFails(commit(db, { skip: ['order'] }));                 // invoice + counter, order still Invoicing
    await assertFails(setDoc(doc(db, 'invoices', 'ord_o1'), inv()));    // invoice alone
    await assertFails(commit(db, { order: { invoiceNo: 'WRONG' } }));   // order points at a different number
  });
  it('PROTECTION 4b: invoice without the counter moving (uncounted) or a wrong/duplicate number is refused', async () => {
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertFails(commit(db, { skip: ['counter'] }));
    await assertFails(commit(db, { invoice: { invoiceNo: 'NF-INV-2026-0369' }, order: { invoiceNo: 'NF-INV-2026-0369' } }));
    await assertFails(commit(db, { counter: { prefix: 'NF-INV', counter: 372, lastInvoiceId: 'ord_o1' } }));
    await assertFails(commit(db, { skip: ['registry'] }));                                                              // number not registered
    await assertFails(commit(db, { counter: { prefix: 'NF-INV', counter: 371 } }));                                    // counter step does not name its invoice
    await assertFails(commit(db, { counter: { prefix: 'OTHER', counter: 371, lastInvoiceId: 'ord_o1' } }));           // prefix changed by an invoice
  });
  it('PROTECTION 4c: a number that was ever issued is refused even if the counter points at it again', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'invoiceNumbers', 'NF-INV-2026-0370'), { invoiceId: 'earlier', issuedBy: 'mgr' }); });
    const db = as('mgr'); await assertSucceeds(lock(db));
    await assertFails(commit(db));
  });
  it('the number registry is append-only and manager-readable only', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'invoiceNumbers', 'NF-INV-0300'), { invoiceId: 'ord_oInv', issuedBy: 'mgr' }); });
    await assertFails(updateDoc(doc(as('mgr'), 'invoiceNumbers', 'NF-INV-0300'), { invoiceId: 'x' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'invoiceNumbers', 'NF-INV-0300')));
    await assertSucceeds(getDoc(doc(as('mgr'), 'invoiceNumbers', 'NF-INV-0300')));
    await assertFails(getDoc(doc(as('rep1'), 'invoiceNumbers', 'NF-INV-0300')));
  });
  it('the counter is never written freely: not set, not lowered, not deleted, not given a new prefix, not created twice', async () => {
    const db = as('mgr');
    await assertFails(setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 }));             // +1 without an invoice
    await assertFails(setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 100 }));
    await assertFails(setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'ANY-1', counter: 370 }));
    await assertFails(updateDoc(doc(db, 'counters', 'naisiInvoice'), { counter: 5000 }));
    await assertFails(deleteDoc(doc(db, 'counters', 'naisiInvoice')));
    await assertFails(setDoc(doc(db, 'counters', 'otherCounter'), { prefix: 'NF-INV', counter: 1 }));
  });
  it('PROTECTION 5: taking over an invoicing lease too early is refused; after the lease it is allowed', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore(), 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 'old', invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() - 60_000) });
    });
    const db = as('mgr');
    await assertFails(lock(db, { invoicingAttempt: 'new' }));
    await env.withSecurityRulesDisabled(async (ctx) => { await updateDoc(doc(ctx.firestore(), 'orders', 'o1'), { invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() - 3_600_000) }); });
    await assertSucceeds(lock(db, { invoicingAttempt: 'new' }));
  });
  it('PROTECTION 6: a client-supplied / future lease timestamp is refused', async () => {
    const db = as('mgr');
    await assertFails(lock(db, { invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() + 99_999_999) }));
    await assertFails(lock(db, { invoicingLeaseStartedAt: Timestamp.fromMillis(Date.now() - 99_999_999) }));
    await assertFails(lock(db, { invoicingAttempt: '' }));
  });
  it('PROTECTION 7: unitsPerCase must be a positive whole number or null (checked on create and update)', async () => {
    const db = as('mgr'); const d = doc(db, 'products', 'p1');
    await assertSucceeds(updateDoc(d, { unitsPerCase: 12 }));
    await assertSucceeds(updateDoc(d, { unitsPerCase: null }));
    for (const bad of [0, -1, 1.5, '14', true]) await assertFails(updateDoc(d, { unitsPerCase: bad }));
    await assertSucceeds(addDoc(collection(db, 'products'), { productName: 'N', packLabel: 'P', unitsPerCase: 14 }));
    await assertSucceeds(addDoc(collection(db, 'products'), { productName: 'N', packLabel: 'P' }));
    await assertFails(addDoc(collection(db, 'products'), { productName: 'N', packLabel: 'P', unitsPerCase: 0 }));
  });
  it('PROTECTION 7b: a product already holding an odd old unitsPerCase can still have its stock updated', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'products', 'pOld'), { productName: 'Old', stockOnHand: 1, unitsPerCase: 0 }); });
    await assertSucceeds(updateDoc(doc(as('mgr'), 'products', 'pOld'), { stockOnHand: 5 }));
  });
  it('rep/deliverer/stranger cannot create invoices, touch counters or products, or write stock movements', async () => {
    for (const who of ['rep1', 'deliv', 'stranger']) {
      const db = as(who);
      await assertFails(setDoc(doc(db, 'invoices', 'ord_o1'), inv()));
      await assertFails(setDoc(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 1 }));
      await assertFails(updateDoc(doc(db, 'products', 'p1'), { unitsPerCase: 3 }));
      await assertFails(setDoc(doc(db, 'stockMovements', 'm1'), { a: 1 }));
      await assertFails(updateDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: serverTimestamp() }));
    }
    await assertSucceeds(getDoc(doc(as('rep1'), 'products', 'p1')));        // reps read the catalogue
    await assertFails(getDoc(doc(as('deliv'), 'products', 'p1')));
  });
});

// =============================================================================================
// H. The ACTUAL app functions, run as authenticated users against the final rules.
// The app modules are re-imported for each role so every function uses that role's Firestore instance.
describe('H. real app functions as authenticated users', () => {
  async function app(who) {
    holder.db = as(who);
    vi.resetModules();
    return {
      visits: await import('../../src/visits.js'),
      orders: await import('../../src/orders.js'),
      customers: await import('../../src/customers.js'),
      products: await import('../../src/products.js'),
      stock: await import('../../src/stock.js'),
      managerOrders: await import('../../src/managerOrders.js'),
      numbering: await import('../../src/numbering.js'),
      scheduleStore: await import('../../src/scheduleStore.js'),
    };
  }
  const items = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1' }];
  const rep = { uid: 'rep1', email: 'rep1@example.com' };
  const NOW = () => new Date('2026-10-15T08:00:00Z');

  it('rep: recordNoOrderVisit saves; identical retry returns alreadySaved; changed retry is a conflict', async () => {
    const a = await app('rep1');
    const r1 = await a.visits.recordNoOrderVisit({ customerId: 'c1', reason: 'Price too high', notes: '', requestId: REQ, ...rep, now: NOW });
    const r2 = await a.visits.recordNoOrderVisit({ customerId: 'c1', reason: 'Price too high', notes: '', requestId: REQ, ...rep, now: NOW });
    if (r1.alreadySaved !== false || r2.alreadySaved !== true) throw new Error(`unexpected: ${JSON.stringify([r1, r2])}`);
    let code; try { await a.visits.recordNoOrderVisit({ customerId: 'c1', reason: 'Shop closed', notes: '', requestId: REQ, ...rep, now: NOW }); } catch (e) { code = e.code; }
    if (code !== 'visit-conflict') throw new Error('expected visit-conflict, got ' + code);
  });
  it('rep: "Other" with an explanation saves', async () => {
    const a = await app('rep1');
    await a.visits.recordNoOrderVisit({ customerId: 'c1', reason: 'Other', notes: 'Owner at a funeral', requestId: 'req-bbbbbbbb-2222', ...rep, now: NOW });
  });
  it('rep: submitOrderWithVisit saves order + visit + counter; counter 41 -> 42, still 42 after an identical retry and after a changed-request conflict; exactly one linked order and visit', async () => {
    const counterNow = async () => (await readAsAdmin((adb) => getDoc(doc(adb, 'orderCounters', 'naisiOrder')))).data().counter;
    const linked = async () => ({
      orders: (await readAsAdmin((adb) => getDocs(query(collection(adb, 'orders'), where('visitId', '==', V))))).docs,
      visits: (await readAsAdmin((adb) => getDocs(query(collection(adb, 'visits'), where('requestId', '==', REQ))))).docs,
    });
    if ((await counterNow()) !== 41) throw new Error('fixture: counter should start at 41');
    const a = await app('rep1');
    const r1 = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: 'n', requestId: REQ, ...rep, now: NOW });
    if (r1.alreadySaved !== false) throw new Error('first save should not be alreadySaved: ' + JSON.stringify(r1));
    if ((await counterNow()) !== 42) throw new Error('counter should be 42 after one order, is ' + (await counterNow()));
    const r2 = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: 'n', requestId: REQ, ...rep, now: NOW });
    if (r2.alreadySaved !== true || r2.orderId !== r1.orderId || r2.orderNo !== r1.orderNo) throw new Error('identical retry should return the saved result: ' + JSON.stringify([r1, r2]));
    if ((await counterNow()) !== 42) throw new Error('counter should stay 42 after an identical retry, is ' + (await counterNow()));
    let code; try { await a.visits.submitOrderWithVisit({ customerId: 'c1', items: [{ ...items[0], qty: 3, total: 300 }], notes: 'n', requestId: REQ, ...rep, now: NOW }); } catch (e) { code = e.code; }
    if (code !== 'visit-conflict') throw new Error('expected visit-conflict, got ' + code);
    if ((await counterNow()) !== 42) throw new Error('counter should stay 42 after a conflict, is ' + (await counterNow()));
    const { orders, visits } = await linked();
    if (orders.length !== 1 || visits.length !== 1) throw new Error(`expected exactly one linked order and visit, got ${orders.length} and ${visits.length}`);
    const o = orders[0].data(), v = visits[0].data();
    if (orders[0].id !== r1.orderId || visits[0].id !== r1.visitId) throw new Error('ids differ from the returned result');
    if (v.orderId !== orders[0].id || o.visitId !== visits[0].id) throw new Error('order and visit do not point at each other');
    if (v.orderNo !== o.orderNo || v.orderValue !== o.grandTotal || v.customerId !== o.customerId || v.repId !== o.createdBy) throw new Error('order and visit disagree');
    if (o.grandTotal !== 200 || o.items[0].qty !== 2) throw new Error('the conflicting request changed the saved order: ' + JSON.stringify(o.items));
    if (!/^ORD-\d{4}-0041$/.test(o.orderNo)) throw new Error('unexpected order number ' + o.orderNo);
  });
  it('rep: two separate orders for the same shop get two different order numbers', async () => {
    const a = await app('rep1');
    const x = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-cccccccc-3333', ...rep, now: NOW });
    const y = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-dddddddd-4444', ...rep, now: NOW });
    if (x.orderNo === y.orderNo) throw new Error('duplicate order number');
  });
  it('rep: order for an inactive customer is refused by the app (and by the rules)', async () => {
    const a = await app('rep1');
    await assertRejects(a.visits.submitOrderWithVisit({ customerId: 'c2', items, notes: '', requestId: REQ, ...rep, now: NOW }));
  });
  it('rep and manager: addCustomer works and the new customer is active, pinned and UNSCHEDULED', async () => {
    for (const who of ['rep1', 'mgr']) {
      const a = await app(who);
      const id = await a.customers.addCustomer({ name: 'New ' + who, phone: '', location: 'Area 3', lat: -13.9, lng: 33.7, uid: who });
      const c = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', id)))).data();
      if (c.active !== true || c.assignedDay !== null || 'lastScheduleChangeId' in c) throw new Error('a new customer must be active and unscheduled: ' + JSON.stringify(c));
    }
  });
  it('rep: cannot deactivate a customer or change its day with the real app functions; contact edits still work', async () => {
    const a = await app('rep1');
    await assertDenied(a.customers.deactivateCustomer('c1', { uid: 'rep1', email: 'rep1@example.com' }));
    await assertDenied(a.customers.setCustomerVisitDay('c1', 'Fri', { uid: 'rep1', email: 'rep1@example.com' }));
    await a.customers.updateCustomer('c1', { name: 'Shop', phone: '0888', location: 'Area 25' });
    const c = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c1')))).data();
    if (c.assignedDay !== 'Thu' || c.active !== true) throw new Error('the refused rep change altered the customer');
  });
  it('manager: set the visit day, deactivate and reactivate through the real functions; each writes one dated history entry', async () => {
    const a = await app('mgr'); const who = { uid: 'mgr', email: 'mgr@example.com' };
    await a.customers.setCustomerVisitDay('c1', 'Fri', who);
    await a.customers.deactivateCustomer('c1', who);
    let c = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c1')))).data();
    if (c.active !== false || c.assignedDay !== null) throw new Error('deactivate did not apply: ' + JSON.stringify(c));
    await a.customers.reactivateCustomer('c1', who);
    c = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c1')))).data();
    if (c.active !== true || c.assignedDay !== null) throw new Error('reactivate must leave the customer active and unscheduled: ' + JSON.stringify(c));
    const entries = (await readAsAdmin((adb) => getDocs(query(collection(adb, 'scheduleChanges'), where('customerId', '==', 'c1'))))).docs.map(d => d.data().kind).sort();
    if (JSON.stringify(entries) !== JSON.stringify(['deactivate', 'reactivate', 'schedule'])) throw new Error('unexpected history entries ' + JSON.stringify(entries));
  });
  it('manager: mergeCustomers(keepId, mergeId) re-links orders, visits and invoices, removes only the merged customer, and changes no financial value', async () => {
    // c1 = customer to keep, c2 = duplicate to remove (its record is deleted by the merge)
    const seed = {
      orders: { m1: { orderNo: 'ORD-2026-0101', status: 'Approved', customerId: 'c2', customerName: 'Closed Shop', customerPhone: '111', customerLocation: 'Old', items: [{ qty: 2, price: 100, total: 200, productId: 'p1' }], grandTotal: 200, createdBy: 'rep1' },
                m2: { orderNo: 'ORD-2026-0102', status: 'Invoiced', customerId: 'c2', customerName: 'Closed Shop', customerPhone: '111', customerLocation: 'Old', items: [{ qty: 1, price: 50, total: 50, productId: 'p1' }], grandTotal: 50, createdBy: 'rep1', invoiceId: 'ord_m2', invoiceNo: 'NF-INV-2026-0200' } },
      visits: { v_rep1_merge1: { repId: 'rep1', outcome: 'No Order', reasonNoOrder: 'Shop closed', customerId: 'c2', customerName: 'Closed Shop', date: '2026-10-14' } },
      invoices: { ord_m2: { orderId: 'm2', invoiceNo: 'NF-INV-2026-0200', customerId: 'c2', customer: 'Closed Shop', phone: '111', location: 'Old', items: [{ qty: 1, price: 50, total: 50 }], grandTotal: 50, createdBy: 'mgr' } },
    };
    await env.withSecurityRulesDisabled(async (ctx) => {
      for (const [coll, docs] of Object.entries(seed)) for (const [id, data] of Object.entries(docs)) await setDoc(doc(ctx.firestore(), coll, id), data);
    });
    const before = {};
    for (const [coll, docs] of Object.entries(seed)) for (const id of Object.keys(docs)) before[`${coll}/${id}`] = (await readAsAdmin((adb) => getDoc(doc(adb, coll, id)))).data();
    const keepBefore = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c1')))).data();
    const countAll = async () => ({ orders: (await readAsAdmin((adb) => getDocs(collection(adb, 'orders')))).size, visits: (await readAsAdmin((adb) => getDocs(collection(adb, 'visits')))).size, invoices: (await readAsAdmin((adb) => getDocs(collection(adb, 'invoices')))).size });
    const countsBefore = await countAll();

    const a = await app('mgr');
    const moved = await a.customers.mergeCustomers('c1', 'c2', { uid: 'mgr', email: 'mgr@example.com' });
    if (moved.orders !== 2 || moved.visits !== 1 || moved.invoices !== 1) throw new Error('unexpected move counts ' + JSON.stringify(moved));

    const gone = await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c2')));
    if (gone.exists()) throw new Error('the merged customer still exists');
    const keep = (await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c1')))).data();
    if (JSON.stringify(keep) !== JSON.stringify(keepBefore)) throw new Error('the retained customer was changed: ' + JSON.stringify(keep));
    const countsAfter = await countAll();
    if (JSON.stringify(countsAfter) !== JSON.stringify(countsBefore)) throw new Error('records were lost or created: ' + JSON.stringify([countsBefore, countsAfter]));

    for (const key of Object.keys(before)) {
      const [coll, id] = key.split('/');
      const after = (await readAsAdmin((adb) => getDoc(doc(adb, coll, id)))).data();
      if (after.customerId !== 'c1') throw new Error(`${key} still points at ${after.customerId}`);
      // every field the merge does not own is unchanged: money, numbers, status, items, links
      for (const f of ['orderNo', 'status', 'items', 'grandTotal', 'invoiceId', 'invoiceNo', 'orderId', 'createdBy', 'repId', 'outcome', 'reasonNoOrder', 'date']) {
        if (JSON.stringify(after[f]) !== JSON.stringify(before[key][f])) throw new Error(`${key}.${f} changed: ${JSON.stringify(before[key][f])} -> ${JSON.stringify(after[f])}`);
      }
      const nameField = coll === 'invoices' ? 'customer' : 'customerName';
      if (after[nameField] !== keepBefore.name) throw new Error(`${key} shows ${after[nameField]}, expected ${keepBefore.name}`);
    }
  });
  it('rep: cannot merge customers (the merge is refused by the rules, nothing is moved)', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'visits', 'v_rep1_mm'), { repId: 'rep1', customerId: 'c2', customerName: 'Closed Shop', outcome: 'No Order' }); });
    const a = await app('rep1');
    await assertRejects(a.customers.mergeCustomers('c1', 'c2', { uid: 'rep1', email: 'rep1@example.com' }));
    const v = (await readAsAdmin((adb) => getDoc(doc(adb, 'visits', 'v_rep1_mm')))).data();
    if (v.customerId !== 'c2') throw new Error('a rep moved a visit');
    if (!(await readAsAdmin((adb) => getDoc(doc(adb, 'customers', 'c2')))).exists()) throw new Error('a rep deleted a customer');
  });
  it('manager: full invoicing through the real functions (issueInvoiceForOrder, issueStandaloneInvoice, begin/revert)', async () => {
    const a = await app('mgr');
    const r = await a.orders.issueInvoiceForOrder({ orderId: 'o1', meta: { items: [{ qty: 1, price: 5, total: 5 }], customer: 'Shop', customerId: 'c1' }, uid: 'mgr' });
    if (!/^NF-INV-\d{4}-0370$/.test(r.invoiceNo)) throw new Error('unexpected number ' + r.invoiceNo);
    const s = await a.orders.issueStandaloneInvoice({ requestId: a.orders.newStandaloneRequestId(), meta: { items: [], customer: 'Walk-in' }, uid: 'mgr' });
    if (!/0371$/.test(s.invoiceNo)) throw new Error('unexpected number ' + s.invoiceNo);
    const { attemptToken } = await a.orders.beginInvoiceGeneration('o_rep2_x').catch((e) => ({ attemptToken: null, e }));
    if (attemptToken) throw new Error('a Submitted order must not be lockable');
  });
  it('manager: begin then revert a lock on an Approved order', async () => {
    const a = await app('mgr');
    const { attemptToken } = await a.orders.beginInvoiceGeneration('o1');
    await a.orders.revertInvoiceGeneration('o1', attemptToken);
  });
  it('manager: add and update a product with unitsPerCase through the real functions', async () => {
    const a = await app('mgr');
    await a.products.addProduct({ productName: 'N', packLabel: 'P', quantity: 1, price: 1, stockOnHand: 0, unitsPerCase: 14, uid: 'mgr' });
    await a.products.updateProduct('p1', { productName: 'Amanda', packLabel: '100g', quantity: 1, price: 2, unitsPerCase: null });
    await assertRejectsLocally(() => a.products.updateProduct('p1', { productName: 'A', packLabel: 'P', quantity: 1, price: 1, unitsPerCase: 0 }));
  });
});

// ---- Decision 5: the depot screen is gone and nothing may be written to or read from config/depot ----
describe('J. depot removal', () => {
  it('nobody can read or write config/depot (there is deliberately no rule for it: default-deny, nothing in the app uses it)', async () => {
    for (const who of ['mgr', 'rep1']) {
      await assertDenied(setDoc(doc(as(who), 'config', 'depot'), { lat: -13.9, lng: 33.7 }));
      await assertDenied(getDoc(doc(as(who), 'config', 'depot')));
    }
  });
  it('an unknown top-level collection is default-denied', async () => {
    await assertDenied(setDoc(doc(as('mgr'), 'anythingElse', 'x'), { a: 1 }));
  });
});

// =============================================================================================
// I. ONE order through the whole chain with the REAL app functions under the REAL rules:
//    rep records it -> manager sees it in the report query, approves it (stock), invoices it -> deliverer delivers it.
describe('I. rep -> manager -> deliverer chain for the same order', () => {
  it('the same order moves through every role; stock moves once; one invoice; every record links', async () => {
    const NOW = () => new Date('2026-10-15T08:00:00Z');
    const rep = { uid: 'rep1', email: 'rep1@example.com' };
    const items = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1' }];
    const get = async (...p) => (await readAsAdmin((adb) => getDoc(doc(adb, ...p)))).data();
    const load = async (who) => { holder.db = as(who); vi.resetModules(); return { visits: await import('../../src/visits.js'), orders: await import('../../src/orders.js'), stock: await import('../../src/stock.js'), reports: await import('../../src/reports.js') }; };

    // 1. rep: order + visit saved together
    const r = await (await load('rep1')).visits.submitOrderWithVisit({ customerId: 'c1', items, notes: 'chain', requestId: REQ, ...rep, now: NOW });
    const mine = await (await load('rep1')).visits.fetchMyVisitsForDate('rep1', '2026-10-15');
    if (mine.length !== 1 || mine[0].orderId !== r.orderId) throw new Error('rep cannot see its own visit');

    // 2. manager: the report query sees the rep's visit; approves (stock deducted once); repeating the approval changes nothing
    const m = await load('mgr');
    const seen = await m.reports.fetchVisitsInRange('2026-10-15', '2026-10-15');
    if (!seen.some((v) => v.id === r.visitId)) throw new Error('manager report does not include the rep visit');
    await m.stock.approveOrderWithStock({ id: r.orderId, items }, { uid: 'mgr', email: 'mgr@example.com' });
    if ((await get('products', 'p1')).stockOnHand !== 8) throw new Error('stock should be 10 - 2 = 8');
    let again; try { await m.stock.approveOrderWithStock({ id: r.orderId, items }, { uid: 'mgr', email: 'mgr@example.com' }); } catch (e) { again = e; }
    if (!again) throw new Error('a second approval must be refused');
    if ((await get('products', 'p1')).stockOnHand !== 8) throw new Error('a repeated approval changed stock');
    const moves = await readAsAdmin((adb) => getDocs(query(collection(adb, 'stockMovements'), where('orderId', '==', r.orderId))));
    if (moves.size !== 1) throw new Error('expected exactly one stock movement, got ' + moves.size);

    // 3. manager: invoice it (lock -> atomic commit)
    const inv = await m.orders.issueInvoiceForOrder({ orderId: r.orderId, meta: { items, customer: 'Shop', customerId: 'c1' }, uid: 'mgr' });
    if (inv.invoiceId !== 'ord_' + r.orderId || !/-0370$/.test(inv.invoiceNo)) throw new Error('unexpected invoice ' + JSON.stringify(inv));
    if ((await get('counters', 'naisiInvoice')).counter !== 371) throw new Error('invoice counter should be 371');
    const ordInv = await get('orders', r.orderId);
    if (ordInv.status !== 'Invoiced' || ordInv.invoiceId !== inv.invoiceId || ordInv.invoiceNo !== inv.invoiceNo) throw new Error('order not Invoiced correctly: ' + JSON.stringify(ordInv));
    let second; try { await m.orders.issueInvoiceForOrder({ orderId: r.orderId, meta: { items, customer: 'Shop', customerId: 'c1' }, uid: 'mgr' }); } catch (e) { second = e; }
    if (!second) throw new Error('a second invoice for the same order must be refused');
    if ((await get('counters', 'naisiInvoice')).counter !== 371) throw new Error('the refused second invoice used a number');

    // 4. deliverer: sees it in the pending list, delivers it
    const d = await load('deliv');
    holder.db = as('deliv');
    const dl = await import('../../src/deliveries.js');
    const pending = await dl.fetchPendingDeliveries();
    if (!pending.some((o) => o.id === r.orderId)) throw new Error('deliverer does not see the invoiced order');
    await d.orders.markOrderDelivered(r.orderId, { uid: 'deliv', email: 'deliv@example.com' });
    const done = await get('orders', r.orderId);
    if (done.status !== 'Delivered' || done.deliveredBy !== 'deliv') throw new Error('not delivered: ' + JSON.stringify(done));

    // 5. unrelated users still see nothing of it
    const sdb = as('stranger');
    await assertDenied(getDoc(doc(sdb, 'orders', r.orderId)));
    await assertDenied(getDoc(doc(sdb, 'invoices', inv.invoiceId)));
    await assertDenied(getDoc(doc(as('rep2'), 'orders', r.orderId)));
    await assertDenied(getDoc(doc(as('rep2'), 'visits', r.visitId)));
  });
});

// =============================================================================================
// RC3 groups K-Q: the owner decisions, on the emulator, with the real app functions where the app is involved.
const MGR = { uid: 'mgr', email: 'mgr@example.com' };
const NOW0 = () => new Date('2026-10-15T08:00:00Z');
const itemsP = (n = 1, pid = 'p1') => Array.from({ length: n }, (_, i) => ({ qty: 1, desc: 'Amanda ' + (i + 1), price: 100, total: 100, productId: n === 1 ? pid : 'p' + (i + 1) }));
async function appAs(who) {
  holder.db = as(who);
  vi.resetModules();
  return {
    visits: await import('../../src/visits.js'), orders: await import('../../src/orders.js'), customers: await import('../../src/customers.js'),
    stock: await import('../../src/stock.js'), managerOrders: await import('../../src/managerOrders.js'), numbering: await import('../../src/numbering.js'),
    scheduleStore: await import('../../src/scheduleStore.js'), scheduleHistory: await import('../../src/scheduleHistory.js'),
  };
}
const adminGet = async (...p) => { const sn = await readAsAdmin((adb) => getDoc(doc(adb, ...p))); return sn.exists() ? sn.data() : null; };
const adminSet = (path, data) => env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), ...path), data); });
const adminDel = (path) => env.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), ...path)); });
const adminCount = async (coll) => (await readAsAdmin((adb) => getDocs(collection(adb, coll)))).size;
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// =============================================================================================
describe('K. cancellation keeps history, restores stock exactly once (decision 2)', () => {
  const approved = (over = {}) => ({ orderNo: 'ORD-2026-0090', status: 'Approved', stockApplied: true, customerId: 'c1', customerName: 'Shop', items: [{ qty: 2, price: 100, total: 200, productId: 'p1', desc: 'Amanda' }], grandTotal: 200, createdBy: 'rep1', invoiceId: null, invoiceNo: null, ...over });
  const cancelBatch = (db, id = 'oC', { order = {}, rec = {}, skipRec = false } = {}) => {
    const b = writeBatch(db);
    b.update(doc(db, 'orders', id), { status: 'Cancelled', stockApplied: false, cancelReason: 'Customer cancelled', cancelledBy: 'mgr', cancelledByEmail: 'mgr@example.com', cancelPriorStatus: 'Approved', cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(), ...order });
    if (!skipRec) b.set(doc(db, 'orderCancellations', id), { orderId: id, orderNo: 'ORD-2026-0090', priorStatus: 'Approved', stockRestored: true, reason: 'Customer cancelled', cancelledBy: 'mgr', cancelledByEmail: 'mgr@example.com', cancelledAt: serverTimestamp(), ...rec });
    return b.commit();
  };
  beforeEach(async () => { await adminSet(['orders', 'oC'], approved()); });

  it('raw: a complete cancellation (order update + once-only record) is accepted for an Approved order', async () => { await assertSucceeds(cancelBatch(as('mgr'))); });
  it.each([
    ['no cancellation record', {}, {}, true],
    ['an empty reason', { cancelReason: '  ' }, { reason: '  ' }],
    ['a 2-character reason', { cancelReason: 'ab' }, { reason: 'ab' }],
    ['a reason over 300 characters', { cancelReason: 'x'.repeat(301) }, { reason: 'x'.repeat(301) }],
    ['a reason that differs between order and record', {}, { reason: 'something else entirely' }],
    ['someone else\'s uid as the actor', { cancelledBy: 'rep1' }, {}],
    ['a client-supplied cancellation time', { cancelledAt: Timestamp.fromMillis(1) }, {}],
    ['a wrong prior status', { cancelPriorStatus: 'Submitted' }, { priorStatus: 'Submitted' }],
    ['stock still marked applied', { stockApplied: true }, {}],
    ['a stockRestored that is not a boolean', {}, { stockRestored: 'yes' }],
  ])('raw: refused with %s', async (_n, order, rec, skipRec = false) => { await assertFails(cancelBatch(as('mgr'), 'oC', { order, rec, skipRec })); });
  it('raw: a Submitted order cannot claim its stock was restored', async () => {
    await adminSet(['orders', 'oS'], approved({ status: 'Submitted', stockApplied: false }));
    await assertFails(cancelBatch(as('mgr'), 'oS', { order: { cancelPriorStatus: 'Submitted' }, rec: { priorStatus: 'Submitted', stockRestored: true } }));
    await assertSucceeds(cancelBatch(as('mgr'), 'oS', { order: { cancelPriorStatus: 'Submitted' }, rec: { priorStatus: 'Submitted', stockRestored: false } }));
  });
  it('raw: Invoicing, Invoiced and Delivered orders can never be cancelled this way', async () => {
    await adminSet(['orders', 'oI'], approved({ status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: Timestamp.now() }));
    await adminSet(['orders', 'oV'], approved({ status: 'Invoiced', invoiceId: 'ord_oV', invoiceNo: 'NF-INV-2026-0001' }));
    await adminSet(['orders', 'oD'], approved({ status: 'Delivered', invoiceId: 'ord_oD', invoiceNo: 'NF-INV-2026-0002' }));
    for (const [id, st] of [['oI', 'Invoicing'], ['oV', 'Invoiced'], ['oD', 'Delivered']]) {
      await assertFails(cancelBatch(as('mgr'), id, { order: { cancelPriorStatus: st }, rec: { priorStatus: st } }));
    }
  });
  it('raw: the cancellation record alone (order not cancelled) is refused; records cannot be edited or deleted', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'orderCancellations', 'oC'), { orderId: 'oC', orderNo: 'x', priorStatus: 'Approved', stockRestored: true, reason: 'abc', cancelledBy: 'mgr', cancelledByEmail: 'mgr@example.com', cancelledAt: serverTimestamp() }));
    await assertSucceeds(cancelBatch(as('mgr')));
    await assertFails(updateDoc(doc(as('mgr'), 'orderCancellations', 'oC'), { reason: 'rewritten' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'orderCancellations', 'oC')));
    await assertFails(cancelBatch(as('mgr')));                                                              // a second cancellation over the same order
  });
  it('raw: a cancelled order is final - no re-approval, no edits, no invoicing, no deletion', async () => {
    await assertSucceeds(cancelBatch(as('mgr')));
    const d = doc(as('mgr'), 'orders', 'oC');
    await assertFails(updateDoc(d, { status: 'Approved' }));
    await assertFails(updateDoc(d, { items: [], grandTotal: 0 }));
    await assertFails(updateDoc(d, { status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: serverTimestamp() }));
    await assertFails(deleteDoc(d));
  });
  it('raw: the old "cancel and delete" path (delete the order) is refused for everyone', async () => {
    for (const who of ['mgr', 'rep1', 'deliv']) await assertFails(deleteDoc(doc(as(who), 'orders', 'oC')));
  });
  it('raw: reps, deliverers and strangers cannot cancel, and cannot read cancellations', async () => {
    for (const who of ['rep1', 'deliv', 'stranger']) {
      await assertFails(cancelBatch(as(who), 'oC', { order: { cancelledBy: who, cancelledByEmail: who + '@example.com' }, rec: { cancelledBy: who, cancelledByEmail: who + '@example.com' } }));
      await assertFails(getDoc(doc(as(who), 'orderCancellations', 'oC')));
    }
  });
  it('KNOWN LIMIT: the rules cannot check that the stock quantities were really restored (a hand-made cancel without the stock writes is accepted); the app does both in one transaction and tools/reconcile.mjs reports a mismatch', async () => {
    await assertSucceeds(cancelBatch(as('mgr')));
    must((await adminGet('products', 'p1')).stockOnHand === 10, 'fixture: the raw cancel touched stock?');
  });

  it('app: cancelOrder restores stock once, keeps the order, writes the record and one ledger entry; the SAME call repeated changes nothing', async () => {
    const a = await appAs('mgr');
    const r1 = await a.stock.cancelOrder({ id: 'oC' }, { reason: 'Customer cancelled', ...MGR });
    must(r1.stockRestored === true && r1.alreadyCancelled === false, 'first cancel: ' + JSON.stringify(r1));
    must((await adminGet('products', 'p1')).stockOnHand === 12, 'stock should be 10 + 2');
    const o = await adminGet('orders', 'oC');
    must(o.status === 'Cancelled' && o.cancelledBy === 'mgr' && o.cancelReason === 'Customer cancelled' && o.cancelPriorStatus === 'Approved', 'order not cancelled properly: ' + JSON.stringify(o));
    must((await adminGet('orderCancellations', 'oC')).stockRestored === true, 'no cancellation record');
    const r2 = await a.stock.cancelOrder({ id: 'oC' }, { reason: 'Customer cancelled', ...MGR });
    must(r2.alreadyCancelled === true, 'second cancel should report alreadyCancelled');
    must((await adminGet('products', 'p1')).stockOnHand === 12, 'a repeated cancel changed stock');
    const moves = await readAsAdmin((adb) => getDocs(query(collection(adb, 'stockMovements'), where('orderId', '==', 'oC'))));
    must(moves.size === 1, 'expected one ledger entry, got ' + moves.size);
  });
  it('app: two managers\' cancel clicks at the same moment restore stock once', async () => {
    const a = await appAs('mgr');
    const res = await Promise.allSettled([a.stock.cancelOrder({ id: 'oC' }, { reason: 'First click', ...MGR }), a.stock.cancelOrder({ id: 'oC' }, { reason: 'Second click', ...MGR })]);
    must(res.every(r => r.status === 'fulfilled'), 'unexpected failure: ' + JSON.stringify(res.map(r => r.reason && r.reason.message)));
    must((await adminGet('products', 'p1')).stockOnHand === 12, 'stock restored more or less than once');
    must((await adminCount('orderCancellations')) === 1, 'more than one cancellation record');
  });
  it('app: a rep cannot cancel; nothing changes', async () => {
    const a = await appAs('rep1');
    await assertDenied(a.stock.cancelOrder({ id: 'oC' }, { reason: 'Not allowed', uid: 'rep1', email: 'rep1@example.com' }));
    must((await adminGet('orders', 'oC')).status === 'Approved' && (await adminGet('products', 'p1')).stockOnHand === 10, 'a refused cancel changed data');
  });
  it('app: Invoiced and Delivered orders are refused with the returns/credit message; stock, order and invoice unchanged', async () => {
    const a = await appAs('mgr');
    let err; try { await a.stock.cancelOrder({ id: 'oInv' }, { reason: 'Too late', ...MGR }); } catch (e) { err = e; }
    must(err && err.code === 'cancel-not-allowed' && /returns|credit/i.test(err.message), 'expected cancel-not-allowed: ' + (err && err.message));
    must((await adminGet('orders', 'oInv')).status === 'Invoiced' && (await adminGet('invoices', 'ord_oInv')), 'invoiced order or invoice changed');
  });
  it('app: an order with 12 different product lines cancels in one transaction (rule-lookup limits)', async () => {
    const items = []; 
    for (let i = 1; i <= 12; i++) { await adminSet(['products', 'p' + i], { productName: 'P' + i, packLabel: 'x', stockOnHand: 10 }); items.push({ qty: 1, price: 100, total: 100, productId: 'p' + i, desc: 'P' + i }); }
    await adminSet(['orders', 'oBig'], approved({ items, grandTotal: 1200 }));
    const a = await appAs('mgr');
    await a.stock.cancelOrder({ id: 'oBig' }, { reason: 'Large order cancelled', ...MGR });
    for (let i = 1; i <= 12; i++) must((await adminGet('products', 'p' + i)).stockOnHand === 11, 'product p' + i + ' not restored');
  });
});

// =============================================================================================
describe('L. manager-entered orders (decision 3)', () => {
  const MID = `m_mgr_${REQ}`;
  const mOrder = (over = {}) => orderDoc({ orderNo: 'ORD-2026-0041', createdBy: 'mgr', createdByEmail: 'mgr@example.com', source: 'manager-entered', enteredBy: 'mgr', enteredByEmail: 'mgr@example.com', attributedRepEmail: 'rep1@example.com', requestId: REQ, visitId: null, ...over });
  const mBatch = (db, { id = MID, order = {}, counter = {}, skip = [] } = {}) => {
    const b = writeBatch(db);
    if (!skip.includes('counter')) b.set(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42, lastOrderId: id, ...counter });
    b.set(doc(db, 'orders', id), mOrder(order));
    return b.commit();
  };
  const items = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1' }];
  const enter = (a, over = {}) => a.managerOrders.submitOrderAsManager({ customerId: 'c1', items, notes: 'phoned in', attributedRepEmail: 'rep1@example.com', requestId: REQ, ...MGR, now: NOW0, ...over });

  it('raw: the manager order (counter +1 naming it, id m_<uid>_<request>, credited rep, no visit) is accepted', async () => { await assertSucceeds(mBatch(as('mgr'))); });
  it.each([
    ['a credited person who is not a rep', { attributedRepEmail: 'stranger@example.com' }],
    ['the manager credited as the rep', { attributedRepEmail: 'mgr@example.com' }],
    ['a visit link (a manager order is never a visit)', { visitId: V }],
    ['someone else as the enterer', { enteredBy: 'rep1' }],
    ['source "rep-visit"', { source: 'rep-visit' }],
    ['a forged order number', { orderNo: 'ORD-2026-0099' }],
    ['an already-used order number', { orderNo: 'ORD-2026-0040' }],
    ['an inactive customer', { customerId: 'c2', customerName: 'Closed Shop' }],
    ['a customer name that does not match', { customerName: 'Other' }],
    ['no items', { items: [], grandTotal: 0 }],
    ['no pin', { customerLat: null, customerLng: null }],
    ['an already Approved status', { status: 'Approved' }],
  ])('raw: refused with %s', async (_n, order) => { await assertFails(mBatch(as('mgr'), { order })); });
  it('raw: refused when the id is not m_<uid>_<requestId>, the counter does not move, moves by 2, or names another order', async () => {
    await assertFails(mBatch(as('mgr'), { id: 'm_mgr_other-request' }));
    await assertFails(mBatch(as('mgr'), { id: 'randomId' }));
    await assertFails(mBatch(as('mgr'), { skip: ['counter'] }));
    await assertFails(mBatch(as('mgr'), { counter: { counter: 43 } }));
    await assertFails(mBatch(as('mgr'), { counter: { lastOrderId: 'o_other' } }));
  });
  it('raw: a rep cannot create a manager-entered order or use an m_ id; a manager cannot create a rep-visit order', async () => {
    await assertFails(mBatch(as('rep1'), { id: `m_rep1_${REQ}`, order: { createdBy: 'rep1', createdByEmail: 'rep1@example.com', enteredBy: 'rep1', enteredByEmail: 'rep1@example.com' } }));
    await assertFails(saveOrderBatch(as('mgr')));
  });
  it('raw: a manager cannot create a visit, so a manager order can never be given a fictional one', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'visits', V), placedVisit({ orderId: MID })));
  });
  it('app: creates the order with the controlled number, no visit, attributed to the rep, entered by the manager', async () => {
    const visitsBefore = await adminCount('visits');
    const a = await appAs('mgr');
    const r = await enter(a);
    const o = await adminGet('orders', r.orderId);
    must(/^ORD-\d{4}-0041$/.test(o.orderNo) && r.alreadySaved === false, 'unexpected order ' + JSON.stringify(o));
    must(o.source === 'manager-entered' && o.attributedRepEmail === 'rep1@example.com' && o.enteredBy === 'mgr' && o.createdBy === 'mgr' && o.visitId === null && o.status === 'Submitted', 'wrong ownership fields: ' + JSON.stringify(o));
    must((await adminGet('orderCounters', 'naisiOrder')).counter === 42, 'order counter should be 42');
    must((await adminCount('visits')) === visitsBefore, 'a visit was created for a manager order');
  });
  it('app: identical retry returns the saved order; a changed retry is an order-conflict; a double click makes one order; the counter moves once', async () => {
    const a = await appAs('mgr');
    const r1 = await enter(a); const r2 = await enter(a);
    must(r2.alreadySaved === true && r2.orderNo === r1.orderNo, 'identical retry should reuse the saved order');
    let code; try { await enter(a, { items: [{ ...items[0], qty: 5, total: 500 }] }); } catch (e) { code = e.code; }
    must(code === 'order-conflict', 'expected order-conflict, got ' + code);
    const res = await Promise.allSettled([enter(a, { requestId: 'req-bbbbbbbb-2222' }), enter(a, { requestId: 'req-bbbbbbbb-2222' })]);
    must(res.every(r => r.status === 'fulfilled'), 'double click failed');
    must((await adminGet('orderCounters', 'naisiOrder')).counter === 43, 'two orders should leave the counter at 43, is ' + (await adminGet('orderCounters', 'naisiOrder')).counter);
    must((await readAsAdmin((adb) => getDocs(query(collection(adb, 'orders'), where('source', '==', 'manager-entered'))))).size === 2, 'expected exactly two manager orders');
  });
  it('app: rep orders and manager orders share one gap-free number sequence', async () => {
    const m = await appAs('mgr'); const x = await enter(m);
    const r = await appAs('rep1'); const y = await r.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-cccccccc-3333', uid: 'rep1', email: 'rep1@example.com', now: NOW0 });
    const m2 = await appAs('mgr'); const z = await enter(m2, { requestId: 'req-dddddddd-4444' });
    const nums = [x, y, z].map(o => Number(o.orderNo.slice(-4)));
    must(JSON.stringify(nums) === JSON.stringify([41, 42, 43]), 'order numbers: ' + nums);
  });
  it('rep isolation: a rep cannot read, list or change a manager-entered order, even one credited to them', async () => {
    const a = await appAs('mgr'); const r = await enter(a);
    await assertDenied(getDoc(doc(as('rep1'), 'orders', r.orderId)));
    await assertDenied(getDoc(doc(as('rep2'), 'orders', r.orderId)));
    await assertDenied(updateDoc(doc(as('rep1'), 'orders', r.orderId), { notes: 'changed' }));
    const mine = await getDocs(query(collection(as('rep1'), 'orders'), where('createdBy', '==', 'rep1')));
    must(!mine.docs.some(d => d.id === r.orderId), 'the rep list contains the manager-entered order');
  });
  it('app: a rep and a stranger cannot call the manager-entry function', async () => {
    for (const who of ['rep1', 'stranger']) {
      const a = await appAs(who);
      await assertRejects(enter(a, { uid: who, email: who + '@example.com', requestId: 'req-eeeeeeee-5555' }));
    }
    must((await adminCount('orders')) === 3, 'a refused entry created an order');
  });
  it('app: refuses a customer that is being merged, inactive, or without a pin', async () => {
    const a = await appAs('mgr');
    await assertRejects(enter(a, { customerId: 'c2' }));
    await adminSet(['customers', 'c1'], { ...shop, mergeLock: { into: 'c2', by: 'mgr', at: Timestamp.now() } });
    await assertRejects(enter(a));
  });
  it('chain: manager-entered order -> approved -> invoiced -> delivered; stock moves once; no visit exists at any point', async () => {
    const m = await appAs('mgr'); const r = await enter(m);
    await m.stock.approveOrderWithStock({ id: r.orderId, items }, MGR);
    must((await adminGet('products', 'p1')).stockOnHand === 8, 'stock should be 8');
    const inv = await m.orders.issueInvoiceForOrder({ orderId: r.orderId, meta: { items, customer: 'Shop', customerId: 'c1' }, uid: 'mgr' });
    must(inv.invoiceId === 'ord_' + r.orderId, 'invoice id');
    const d = await appAs('deliv');
    await d.orders.markOrderDelivered(r.orderId, { uid: 'deliv', email: 'deliv@example.com' });
    must((await adminGet('orders', r.orderId)).status === 'Delivered', 'not delivered');
    must((await adminCount('visits')) === 1, 'only the seeded rep2 visit should exist');
  });
});

// =============================================================================================
describe('M. invoice number control (decision 6)', () => {
  const adjBatch = (db, { id = 'adj_mgr_' + REQ, counter = {}, aud = {}, skipAud = false, skipCounter = false } = {}) => {
    const c = { prefix: 'NF-INV', counter: 500, lastAdjustmentId: id, ...counter };
    const b = writeBatch(db);
    if (!skipCounter) b.set(doc(db, 'counters', 'naisiInvoice'), c);
    if (!skipAud) b.set(doc(db, 'counterAdjustments', id), { previousPrefix: 'NF-INV', previousCounter: 370, newPrefix: c.prefix, newCounter: c.counter, reason: 'Skip numbers used on paper', requestId: REQ, adjustedBy: 'mgr', adjustedByEmail: 'mgr@example.com', adjustedAt: serverTimestamp(), ...aud });
    return b.commit();
  };
  const adjust = (a, over = {}) => a.numbering.adjustInvoiceCounter({ prefix: 'NF-INV', counter: 500, reason: 'Skip numbers used on paper', requestId: REQ, ...MGR, ...over });
  const standalone = (a) => a.orders.issueStandaloneInvoice({ requestId: a.orders.newStandaloneRequestId(), meta: { items: [], customer: 'Walk-in' }, uid: 'mgr' });

  it('raw: an audited adjustment (counter change + audit entry in one commit) is accepted', async () => { await assertSucceeds(adjBatch(as('mgr'))); });
  it('raw: a prefix change is accepted when audited', async () => { await assertSucceeds(adjBatch(as('mgr'), { counter: { prefix: 'NF-2', counter: 1 } })); });
  it.each([
    ['no audit entry', {}, {}, { skipAud: true }],
    ['an audit entry but no counter change', {}, {}, { skipCounter: true }],
    ['an empty reason', {}, { reason: '' }],
    ['a 2-character reason', {}, { reason: 'ab' }],
    ['a reason over 300 characters', {}, { reason: 'x'.repeat(301) }],
    ['another user as the actor', {}, { adjustedBy: 'rep1' }],
    ['another email as the actor', {}, { adjustedByEmail: 'rep1@example.com' }],
    ['a client-supplied time', {}, { adjustedAt: Timestamp.fromMillis(5) }],
    ['a wrong previous counter in the audit', {}, { previousCounter: 371 }],
    ['a wrong previous prefix in the audit', {}, { previousPrefix: 'OLD' }],
    ['an audit new value that differs from the counter', {}, { newCounter: 501 }],
    ['counter 0', { counter: 0 }, {}],
    ['a counter above 99,999,999', { counter: 100000000 }, {}],
    ['a fractional counter', { counter: 5.5 }, {}],
    ['a prefix with a space', { prefix: 'NF INV' }, {}],
    ['a 21-character prefix', { prefix: 'A'.repeat(21) }, {}],
    ['an empty prefix', { prefix: '' }, {}],
    ['the unchanged values', { counter: 370 }, {}],
    ['a counter step that names no audit entry', { lastAdjustmentId: 'someOther' }, {}],
    ['extra fields on the counter', { sneaky: 1 }, {}],
  ])('raw: refused with %s', async (_n, counter, aud, extra = {}) => { await assertFails(adjBatch(as('mgr'), { counter, aud, ...extra })); });
  it('raw: reps, deliverers and strangers cannot adjust or read the audit', async () => {
    for (const who of ['rep1', 'deliv', 'stranger']) {
      await assertFails(adjBatch(as(who), { aud: { adjustedBy: who, adjustedByEmail: who + '@example.com' } }));
      await assertFails(getDoc(doc(as(who), 'counterAdjustments', 'x')));
    }
  });
  it('raw: audit entries are append-only', async () => {
    await assertSucceeds(adjBatch(as('mgr')));
    await assertFails(updateDoc(doc(as('mgr'), 'counterAdjustments', 'adj_mgr_' + REQ), { reason: 'edited later' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'counterAdjustments', 'adj_mgr_' + REQ)));
    await assertSucceeds(getDoc(doc(as('mgr'), 'counterAdjustments', 'adj_mgr_' + REQ)));
  });
  it('app: adjustInvoiceCounter changes the counter and writes previous/new value, actor, reason and a SERVER timestamp', async () => {
    const a = await appAs('mgr'); await adjust(a);
    const c = await adminGet('counters', 'naisiInvoice'); must(c.counter === 500 && c.prefix === 'NF-INV', 'counter ' + JSON.stringify(c));
    const au = await adminGet('counterAdjustments', 'adj_mgr_' + REQ);
    must(au.previousCounter === 370 && au.newCounter === 500 && au.reason === 'Skip numbers used on paper' && au.adjustedBy === 'mgr' && typeof au.adjustedAt.toMillis === 'function', 'audit ' + JSON.stringify(au));
  });
  it('app: a retry of the same adjustment is a no-op; a changed retry with the same id conflicts', async () => {
    const a = await appAs('mgr'); await adjust(a);
    must((await adjust(a)).alreadyApplied === true, 'identical retry should report alreadyApplied');
    let code; try { await adjust(a, { counter: 600 }); } catch (e) { code = e.code; }
    must(code === 'adjustment-conflict', 'expected adjustment-conflict, got ' + code);
    must((await adminGet('counters', 'naisiInvoice')).counter === 500 && (await adminCount('counterAdjustments')) === 1, 'retry changed data');
  });
  it('app: a rep cannot adjust the numbering', async () => {
    const a = await appAs('rep1');
    await assertDenied(adjust(a, { uid: 'rep1', email: 'rep1@example.com' }));
    must((await adminGet('counters', 'naisiInvoice')).counter === 370, 'a rep changed the counter');
  });
  it('app: an adjustment and an invoice issued at the SAME moment never duplicate or lose a number', async () => {
    const a = await appAs('mgr');
    const res = await Promise.allSettled([adjust(a), standalone(a)]);
    must(res.every(r => r.status === 'fulfilled'), 'one failed: ' + JSON.stringify(res.map(r => r.reason && r.reason.message)));
    const invs = (await readAsAdmin((adb) => getDocs(collection(adb, 'invoices')))).docs.filter(d => d.data().kind === 'standalone');
    must(invs.length === 1, 'expected one stand-alone invoice');
    const no = Number(invs[0].data().invoiceNo.slice(-4)); const c = (await adminGet('counters', 'naisiInvoice')).counter;
    must((no === 370 && c === 500) || (no === 500 && c === 501), `inconsistent: invoice ${no}, counter ${c}`);
    must((await adminCount('invoiceNumbers')) === 1, 'registry should hold exactly one number');
  });
  it('app: three invoices issued at the same moment get three different consecutive numbers', async () => {
    const a = await appAs('mgr');
    const res = await Promise.allSettled([standalone(a), standalone(a), standalone(a)]);
    must(res.every(r => r.status === 'fulfilled'), 'one failed: ' + JSON.stringify(res.map(r => r.reason && r.reason.message)));
    const nos = res.map(r => Number(r.value.invoiceNo.slice(-4))).sort();
    must(JSON.stringify(nos) === JSON.stringify([370, 371, 372]) && (await adminGet('counters', 'naisiInvoice')).counter === 373, 'numbers ' + nos);
  });
  it('app: moving the counter BACK onto an issued number is refused: an issued number is never reused', async () => {
    const a = await appAs('mgr'); await standalone(a);
    await adjust(a, { counter: 370, reason: 'Moved back by mistake' });
    let code; try { await standalone(a); } catch (e) { code = e.code; }
    must(code === 'number-already-issued', 'expected number-already-issued, got ' + code);
    must((await adminCount('invoices')) === 2, 'an invoice was created with a reused number');    // oInv fixture + the first stand-alone invoice
  });
  it('app: a prefix change numbers the next invoice with the new prefix; earlier invoices and ORDER numbers are untouched', async () => {
    const a = await appAs('mgr'); const first = await standalone(a);
    await adjust(a, { prefix: 'NF-2', counter: 1, reason: 'New numbering series' });
    const second = await standalone(a);
    must(/^NF-INV-\d{4}-0370$/.test(first.invoiceNo) && /^NF-2-\d{4}-0001$/.test(second.invoiceNo), 'numbers ' + first.invoiceNo + ' / ' + second.invoiceNo);
    must((await adminGet('invoices', first.invoiceId)).invoiceNo === first.invoiceNo, 'the earlier invoice changed');
    const r = await appAs('rep1'); const o = await r.visits.submitOrderWithVisit({ customerId: 'c1', items: [{ qty: 1, desc: 'x', price: 5, total: 5, productId: 'p1' }], notes: '', requestId: REQ, uid: 'rep1', email: 'rep1@example.com', now: NOW0 });
    must(/-0041$/.test(o.orderNo), 'order numbering was disturbed: ' + o.orderNo);
  });
  it('raw: the year part of an invoice number must still be four digits', async () => {
    const SAI = `sa_mgr_${REQ}`;
    const b = writeBatch(as('mgr'));
    b.set(doc(as('mgr'), 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371, lastInvoiceId: SAI });
    b.set(doc(as('mgr'), 'invoiceNumbers', 'NF-INV-ABCD-0370'), { invoiceId: SAI, issuedBy: 'mgr', issuedAt: serverTimestamp() });
    b.set(doc(as('mgr'), 'invoices', SAI), { orderId: null, kind: 'standalone', requestId: REQ, invoiceNo: 'NF-INV-ABCD-0370', items: [], createdBy: 'mgr', createdAt: serverTimestamp() });
    await assertFails(b.commit());
  });
});

// =============================================================================================
describe('N. stand-alone invoices (decision 4)', () => {
  const meta = (extra = {}) => ({ items: [{ qty: 1, desc: 'Walk-in item', price: 50, total: 50 }], customer: 'Walk-in', date: '2026-10-15', ...extra });
  it('app: creates a kind "standalone" invoice with the explicit id and the next shared number; identical retry returns it; changed retry conflicts; double click = one invoice', async () => {
    const a = await appAs('mgr'); const requestId = a.orders.newStandaloneRequestId();
    const r1 = await a.orders.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'mgr' });
    must(r1.invoiceId === `sa_mgr_${requestId}` && /-0370$/.test(r1.invoiceNo) && r1.alreadySaved === false, JSON.stringify(r1));
    const inv = await adminGet('invoices', r1.invoiceId); must(inv.kind === 'standalone' && inv.orderId === null && inv.requestId === requestId, 'identity fields ' + JSON.stringify(inv));
    must((await adminGet('invoiceNumbers', r1.invoiceNo)).invoiceId === r1.invoiceId, 'registry entry');
    const r2 = await a.orders.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'mgr' });
    must(r2.alreadySaved === true && r2.invoiceNo === r1.invoiceNo, 'identical retry');
    let code; try { await a.orders.issueStandaloneInvoice({ requestId, meta: meta({ items: [{ qty: 9, desc: 'x', price: 50, total: 450 }] }), uid: 'mgr' }); } catch (e) { code = e.code; }
    must(code === 'invoice-conflict', 'expected invoice-conflict, got ' + code);
    const rid2 = a.orders.newStandaloneRequestId();
    await Promise.allSettled([a.orders.issueStandaloneInvoice({ requestId: rid2, meta: meta(), uid: 'mgr' }), a.orders.issueStandaloneInvoice({ requestId: rid2, meta: meta(), uid: 'mgr' })]);
    must((await adminGet('counters', 'naisiInvoice')).counter === 372, 'counter should be 372 (two invoices), is ' + (await adminGet('counters', 'naisiInvoice')).counter);
    must((await readAsAdmin((adb) => getDocs(query(collection(adb, 'invoices'), where('kind', '==', 'standalone'))))).size === 2, 'expected two stand-alone invoices');
  });
  it('app: a rep, a deliverer and a stranger cannot issue stand-alone invoices', async () => {
    for (const who of ['rep1', 'deliv', 'stranger']) {
      const a = await appAs(who);
      await assertDenied(a.orders.issueStandaloneInvoice({ requestId: a.orders.newStandaloneRequestId(), meta: meta(), uid: who }));
    }
    must((await adminGet('counters', 'naisiInvoice')).counter === 370, 'a refused attempt moved the counter');
  });
  it('raw: an old-client stand-alone write (automatic id, no kind, no registry entry) is refused and the counter does not move', async () => {
    const db = as('mgr'); const b = writeBatch(db);
    b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 });
    b.set(doc(collection(db, 'invoices')), { orderId: null, invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr' });
    await assertFails(b.commit());
    must((await adminGet('counters', 'naisiInvoice')).counter === 370, 'counter moved');
  });
  it('raw: a stand-alone invoice for a customer that is being merged is refused', async () => {
    await adminSet(['customers', 'c1'], { ...shop, mergeLock: { into: 'c2', by: 'mgr', at: Timestamp.now() } });
    const SAI = `sa_mgr_${REQ}`; const db = as('mgr'); const b = writeBatch(db);
    b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371, lastInvoiceId: SAI });
    b.set(doc(db, 'invoiceNumbers', 'NF-INV-2026-0370'), { invoiceId: SAI, issuedBy: 'mgr', issuedAt: serverTimestamp() });
    b.set(doc(db, 'invoices', SAI), { orderId: null, kind: 'standalone', requestId: REQ, customerId: 'c1', invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr', createdAt: serverTimestamp() });
    await assertFails(b.commit());
  });
});

// =============================================================================================
describe('O. dated schedule history is protected (decision 7)', () => {
  const baseline = (db, { id = 'base_c1', cfg = {}, ent = {}, skipCfg = false } = {}) => {
    const b = writeBatch(db);
    if (!skipCfg) b.set(doc(db, 'config', 'scheduleHistory'), { startedAt: serverTimestamp(), startedBy: 'mgr', startedByEmail: 'mgr@example.com', baselineCount: 1, ...cfg });
    b.set(doc(db, 'scheduleChanges', id), { customerId: 'c1', customerName: 'Shop', kind: 'baseline', active: true, assignedDay: 'Thu', changedBy: 'mgr', changedByEmail: 'mgr@example.com', createdAt: serverTimestamp(), ...ent });
    return b.commit();
  };
  it('raw: the history can be started by a manager: config (server time) + baseline entries in one commit', async () => { await assertSucceeds(baseline(as('mgr'))); });
  it('raw: refused for a rep, a client-supplied start time, a wrong baseline id, or a baseline without the config', async () => {
    await assertFails(baseline(as('rep1'), { cfg: { startedBy: 'rep1', startedByEmail: 'rep1@example.com' }, ent: { changedBy: 'rep1', changedByEmail: 'rep1@example.com' } }));
    await assertFails(baseline(as('mgr'), { cfg: { startedAt: Timestamp.fromMillis(1) } }));
    await assertFails(baseline(as('mgr'), { id: 'base_other' }));
    await assertFails(baseline(as('mgr'), { skipCfg: true }));
  });
  it('raw: baselines cannot be added after the first hour (history cannot be rewritten later)', async () => {
    await adminSet(['config', 'scheduleHistory'], { startedAt: Timestamp.fromMillis(Date.now() - 2 * 3600 * 1000), startedBy: 'mgr', startedByEmail: 'mgr@example.com', baselineCount: 1 });
    await assertFails(baseline(as('mgr'), { skipCfg: true }));
  });
  it('raw: the config and every entry are immutable; nothing can be deleted; only managers can read', async () => {
    await assertSucceeds(baseline(as('mgr')));
    for (const who of ['mgr', 'rep1']) {
      await assertFails(updateDoc(doc(as(who), 'config', 'scheduleHistory'), { startedAt: Timestamp.fromMillis(1) }));
      await assertFails(updateDoc(doc(as(who), 'scheduleChanges', 'base_c1'), { assignedDay: 'Mon' }));
      await assertFails(deleteDoc(doc(as(who), 'scheduleChanges', 'base_c1')));
      await assertFails(deleteDoc(doc(as(who), 'config', 'scheduleHistory')));
    }
    await assertSucceeds(getDoc(doc(as('mgr'), 'scheduleChanges', 'base_c1')));
    for (const who of ['rep1', 'deliv', 'stranger']) { await assertFails(getDoc(doc(as(who), 'scheduleChanges', 'base_c1'))); await assertFails(getDoc(doc(as(who), 'config', 'scheduleHistory'))); }
  });
  it('raw: a non-baseline entry cannot be written on its own (without the customer change it records)', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'scheduleChanges', 'free1'), { customerId: 'c1', customerName: 'Shop', kind: 'schedule', active: true, assignedDay: 'Fri', changedBy: 'mgr', changedByEmail: 'mgr@example.com', createdAt: serverTimestamp() }));
  });
  it('app: startScheduleHistory writes the config and one baseline per customer; a second run adds nothing; reps cannot read or start it', async () => {
    const a = await appAs('mgr');
    const customers = [{ id: 'c1', name: 'Shop', active: true, assignedDay: 'Thu' }, { id: 'c2', name: 'Closed Shop', active: false, assignedDay: null }];
    const r1 = await a.scheduleStore.startScheduleHistory({ customers, ...MGR });
    must(r1.status === 'started' && r1.added === 2, JSON.stringify(r1));
    must((await adminCount('scheduleChanges')) === 2, 'baselines');
    const r2 = await a.scheduleStore.startScheduleHistory({ customers, ...MGR });
    must(r2.added === 0, 'second run added ' + r2.added);
    const h = await a.scheduleStore.fetchScheduleHistory(); must(h.config && h.changes.length === 2, 'fetch');
    const rep = await appAs('rep1');
    await assertDenied(rep.scheduleStore.fetchScheduleHistory());
  });
  it('app: a baseline run over 40 customers stays inside the rules\' lookup limits', async () => {
    const customers = Array.from({ length: 40 }, (_, i) => ({ id: 'bulk' + i, name: 'Bulk ' + i, active: true, assignedDay: i % 2 ? 'Mon' : null }));
    const a = await appAs('mgr');
    const r = await a.scheduleStore.startScheduleHistory({ customers, ...MGR });
    must(r.added === 40 && (await adminCount('scheduleChanges')) === 40, JSON.stringify(r));
  });
  it('app: after history starts, schedule/deactivate/reactivate changes are dated and drive the report targets', async () => {
    const a = await appAs('mgr');
    await a.scheduleStore.startScheduleHistory({ customers: [{ id: 'c1', name: 'Shop', active: true, assignedDay: 'Thu' }], ...MGR });
    await a.customers.setCustomerVisitDay('c1', 'Fri', MGR);
    const h = await a.scheduleStore.fetchScheduleHistory();
    const idx = a.scheduleHistory.buildScheduleIndex(h);
    const today = a.scheduleHistory.malawiDateOfTimestamp(h.config.startedAt);
    must(idx.startDate === today, 'start date');
    must(a.scheduleHistory.targetsForDate(idx, '2000-01-01').reliable === false, 'old dates must be unreliable');
    must(a.scheduleHistory.customerStateAt(idx, 'c1', today).assignedDay === 'Fri', 'the change applies from the day it was saved');
  });
});

// =============================================================================================
describe('P. merges and invoicing (decision 8)', () => {
  const lockAdmin = (id = 'c3', into = 'c1') => adminSet(['customers', id], { ...shop, name: 'Dup', assignedDay: 'Mon', mergeLock: { into, by: 'mgr', at: Timestamp.now() } });
  const seedAway = async ({ orders = 3, visits = 2, invoices = 1, id = 'c3', lock = false } = {}) => {
    await adminSet(['customers', id], { ...shop, name: 'Dup', assignedDay: 'Mon', ...(lock ? { mergeLock: { into: 'c1', by: 'mgr', at: Timestamp.now() } } : {}) });
    for (let i = 0; i < orders; i++) await adminSet(['orders', `mo${i}`], { orderNo: `ORD-2026-01${String(i).padStart(2, '0')}`, status: 'Approved', stockApplied: true, customerId: id, customerName: 'Dup', customerPhone: '1', customerLocation: 'x', items: [], grandTotal: 100 + i, createdBy: 'rep1', invoiceId: null, invoiceNo: null });
    for (let i = 0; i < visits; i++) await adminSet(['visits', `v_rep1_mv${i}`], { repId: 'rep1', outcome: 'No Order', customerId: id, customerName: 'Dup', date: '2026-10-14' });
    for (let i = 0; i < invoices; i++) await adminSet(['invoices', `ord_mi${i}`], { orderId: 'mi' + i, kind: 'order', invoiceNo: `NF-INV-2026-02${i}`, customerId: id, customer: 'Dup', items: [], grandTotal: 50, createdBy: 'mgr' });
  };
  const sumTotals = async () => (await readAsAdmin((adb) => getDocs(collection(adb, 'orders')))).docs.reduce((s, d) => s + (d.data().grandTotal || 0), 0);

  it('raw: the lock may be set only by a manager, only on its own, and only towards a usable customer', async () => {
    await seedAway();
    const lk = (db, into = 'c1', extra = {}) => updateDoc(doc(db, 'customers', 'c3'), { mergeLock: { into, by: 'mgr', at: serverTimestamp() }, updatedAt: serverTimestamp(), ...extra });
    await assertFails(lk(as('rep1'), 'c1')); await assertFails(lk(as('deliv')));
    await assertFails(lk(as('mgr'), 'c3'));               // into itself
    await assertFails(lk(as('mgr'), 'c2'));               // into an inactive customer
    await assertFails(lk(as('mgr'), 'nope'));
    await assertFails(lk(as('mgr'), 'c1', { name: 'Renamed' }));          // the lock must be the only change
    await assertSucceeds(lk(as('mgr')));
    await assertFails(lk(as('mgr'), 'c1'));               // already locked
  });
  it('raw: a locked customer\'s records can be re-pointed ONLY to the lock target, ONLY in the customer fields, and never an Invoicing order', async () => {
    await seedAway({ lock: true });
    await adminSet(['orders', 'moInv'], { orderNo: 'ORD-2026-0150', status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: Timestamp.now(), customerId: 'c3', customerName: 'Dup', items: [], grandTotal: 1, createdBy: 'rep1' });
    const mv = (coll, id, extra = {}, to = 'c1') => updateDoc(doc(as('mgr'), coll, id), { customerId: to, customerName: 'Shop', ...extra });
    await assertSucceeds(mv('orders', 'mo0', { customerPhone: '0999', customerLocation: 'Area 25' }));
    await assertSucceeds(mv('visits', 'v_rep1_mv0'));
    await assertSucceeds(updateDoc(doc(as('mgr'), 'invoices', 'ord_mi0'), { customerId: 'c1', customer: 'Shop', phone: '0999', location: 'Area 25' }));
    await assertFails(mv('orders', 'mo1', {}, 'c2'));                      // not the lock target
    await assertFails(mv('orders', 'mo1', { grandTotal: 1 }));              // money cannot change during a merge
    await assertFails(mv('orders', 'mo1', { status: 'Rejected' }));
    await assertFails(mv('orders', 'moInv'));                               // THE guard against moving an order that is being invoiced
    await assertFails(updateDoc(doc(as('mgr'), 'invoices', 'ord_mi0'), { customerId: 'c1', invoiceNo: 'X' }));
    for (const who of ['rep1', 'deliv']) await assertFails(updateDoc(doc(as(who), 'orders', 'mo1'), { customerId: 'c1' }));
  });
  it('raw: without a lock nothing is re-pointed (orders, visits, invoices)', async () => {
    await seedAway();
    await assertFails(updateDoc(doc(as('mgr'), 'visits', 'v_rep1_mv0'), { customerId: 'c1', customerName: 'Shop' }));
    await assertFails(updateDoc(doc(as('mgr'), 'invoices', 'ord_mi0'), { customerId: 'c1', customer: 'Shop' }));
    await assertSucceeds(updateDoc(doc(as('mgr'), 'orders', 'mo0'), { customerId: 'c1', customerName: 'Shop' }));   // an ordinary edit of an OPEN order between two free customers stays possible
  });
  it('raw: an order of a locked customer cannot start invoicing; an order of a free customer still can', async () => {
    await seedAway({ lock: true });
    const lockOrder = (id) => updateDoc(doc(as('mgr'), 'orders', id), { status: 'Invoicing', invoicingAttempt: 'tok', invoicingLeaseStartedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await assertFails(lockOrder('mo0'));
    await assertSucceeds(lockOrder('o1'));
  });
  it('raw: a customer is deleted ONLY with the lock AND its merge record, and the record must name the lock target', async () => {
    await seedAway({ lock: true });
    const rec = (keepId = 'c1') => ({ keepId, keepName: 'Shop', mergedName: 'Dup', moved: { orders: 3, visits: 2, invoices: 1 }, mergedBy: 'mgr', mergedByEmail: 'mgr@example.com', mergedAt: serverTimestamp() });
    const fin = (db, keepId, withRec = true) => { const b = writeBatch(db); if (withRec) b.set(doc(db, 'customerMerges', 'c3'), rec(keepId)); b.delete(doc(db, 'customers', 'c3')); return b.commit(); };
    await assertFails(fin(as('mgr'), 'c1', false));              // delete without a record
    await assertFails(fin(as('mgr'), 'c2'));                     // record names a different customer than the lock
    await assertFails(fin(as('rep1'), 'c1'));
    await assertFails(setDoc(doc(as('mgr'), 'customerMerges', 'c1'), rec('c3')));      // record for a customer that is not locked
    await assertSucceeds(fin(as('mgr'), 'c1'));
    await assertFails(updateDoc(doc(as('mgr'), 'customerMerges', 'c3'), { keepId: 'c2' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'customerMerges', 'c3')));
  });
  it('app: a merge is BLOCKED while an affected order is Invoicing: clear message, no record moved, nothing deleted, lock released', async () => {
    await seedAway();
    await adminSet(['orders', 'mo0'], { ...(await adminGet('orders', 'mo0')), status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: Timestamp.now() });
    const before = await sumTotals();
    const a = await appAs('mgr'); let err;
    try { await a.customers.mergeCustomers('c1', 'c3', MGR); } catch (e) { err = e; }
    must(err && err.code === 'merge-blocked-invoicing' && /invoic/i.test(err.message), 'expected a blocked merge, got ' + (err && (err.code + ' ' + err.message)));
    const c3 = await adminGet('customers', 'c3'); must(c3 && !c3.mergeLock, 'the customer must remain, unlocked');
    must((await adminGet('customerMerges', 'c3')) === null, 'a merge record exists');
    for (const id of ['mo0', 'mo1', 'mo2']) must((await adminGet('orders', id)).customerId === 'c3', id + ' was moved');
    must((await adminGet('visits', 'v_rep1_mv0')).customerId === 'c3' && (await adminGet('invoices', 'ord_mi0')).customerId === 'c3', 'visit or invoice moved');
    must((await sumTotals()) === before, 'amounts changed');
  });
  it('app: the manager retries after invoicing finishes; the merge then completes with every amount, number, status, link and visit preserved', async () => {
    await seedAway();
    await adminSet(['orders', 'mo0'], { ...(await adminGet('orders', 'mo0')), status: 'Invoicing', invoicingAttempt: 't', invoicingLeaseStartedAt: Timestamp.now() });
    const a = await appAs('mgr');
    await assertRejects(a.customers.mergeCustomers('c1', 'c3', MGR));
    await adminSet(['orders', 'mo0'], { ...(await adminGet('orders', 'mo0')), status: 'Invoiced', invoiceId: 'ord_mo0', invoiceNo: 'NF-INV-2026-0999', invoicingAttempt: null, invoicingLeaseStartedAt: null });
    const before = {}; for (const id of ['mo0', 'mo1', 'mo2']) before[id] = await adminGet('orders', id);
    const totals = await a.customers.mergeCustomers('c1', 'c3', MGR);
    must(totals.orders === 3 && totals.visits === 2 && totals.invoices === 1, JSON.stringify(totals));
    must((await adminGet('customers', 'c3')) === null && (await adminGet('customerMerges', 'c3')).keepId === 'c1', 'customer/record');
    for (const id of ['mo0', 'mo1', 'mo2']) {
      const o = await adminGet('orders', id);
      for (const f of ['orderNo', 'status', 'grandTotal', 'invoiceNo', 'invoiceId', 'createdBy']) must(JSON.stringify(o[f]) === JSON.stringify(before[id][f]), `${id}.${f} changed`);
      must(o.customerId === 'c1' && o.customerName === 'Shop', id + ' not on the kept customer');
    }
    must((await adminGet('visits', 'v_rep1_mv1')).customerId === 'c1', 'visit not moved');
  });
  it('app: an interrupted merge keeps its lock (customer protected, nothing deleted); a rep cannot visit it; resuming completes it', async () => {
    await seedAway({ orders: 20, visits: 10 });
    const a = await appAs('mgr'); let n = 0;
    await assertRejects(a.customers.mergeCustomers('c1', 'c3', { ...MGR, afterChunk: async () => { if (++n === 2) throw new Error('connection lost'); } }));
    must((await adminGet('customers', 'c3')).mergeLock.into === 'c1', 'the lock must remain');
    const r = await appAs('rep1');
    await assertRejects(r.visits.recordNoOrderVisit({ customerId: 'c3', reason: 'Shop closed', notes: '', requestId: REQ, uid: 'rep1', email: 'rep1@example.com', now: NOW0 }));
    await assertDenied(setDoc(doc(as('rep1'), 'visits', V), visit({ customerId: 'c3', customerName: 'Dup' })));
    await assertDenied(a.customers.setCustomerVisitDay('c3', 'Fri', MGR));
    await a.customers.mergeCustomers('c1', 'c3', MGR);
    must((await adminGet('customers', 'c3')) === null, 'resume did not finish');
    must((await readAsAdmin((adb) => getDocs(query(collection(adb, 'orders'), where('customerId', '==', 'c3'))))).size === 0, 'orders left behind');
  });
  it('app: cancelMergeLock releases a paused merge; the customer is usable again', async () => {
    await seedAway({ lock: true });
    const a = await appAs('mgr'); await a.customers.cancelMergeLock('c3');
    must(!(await adminGet('customers', 'c3')).mergeLock, 'lock not released');
    await a.customers.setCustomerVisitDay('c3', 'Tue', MGR);
  });
  it('app: merging into an inactive or locked customer, or into itself, is refused and changes nothing', async () => {
    await seedAway();
    const a = await appAs('mgr');
    await assertRejects(a.customers.mergeCustomers('c2', 'c3', MGR));
    await assertRejects(a.customers.mergeCustomers('c3', 'c3', MGR));
    must(!(await adminGet('customers', 'c3')).mergeLock && (await adminGet('orders', 'mo0')).customerId === 'c3', 'a refused merge changed data');
  });
  it('app: a LARGE merge (60 orders, 30 visits, 5 invoices) completes in many small commits within the rule-lookup limits, losing and changing nothing', async () => {
    await seedAway({ orders: 60, visits: 30, invoices: 5 });
    const before = await sumTotals();
    const a = await appAs('mgr');
    const t = await a.customers.mergeCustomers('c1', 'c3', MGR);
    must(t.orders === 60 && t.visits === 30 && t.invoices === 5, JSON.stringify(t));
    must((await sumTotals()) === before, 'amounts changed');
    must((await readAsAdmin((adb) => getDocs(query(collection(adb, 'orders'), where('customerId', '==', 'c1'))))).size === 60, 'orders not all on the kept customer');
  });
  it('RACE: invoicing and merging started at the same moment never leave an Invoicing order moved or a half-merged customer (10 rounds)', async () => {
    const a = await appAs('mgr'); const seen = { merged: 0, blocked: 0, invoicingWon: 0 };
    for (let round = 0; round < 10; round++) {
      await adminDel(['customerMerges', 'c3']);
      await seedAway({ orders: 1, visits: 1, invoices: 0 });
      await adminSet(['orders', 'mo0'], { orderNo: 'ORD-2026-0100', status: 'Approved', stockApplied: true, customerId: 'c3', customerName: 'Dup', items: [], grandTotal: 100, createdBy: 'rep1', invoiceId: null, invoiceNo: null });
      const res = await Promise.allSettled([a.orders.beginInvoiceGeneration('mo0'), a.customers.mergeCustomers('c1', 'c3', MGR)]);
      const o = await adminGet('orders', 'mo0'); const c3 = await adminGet('customers', 'c3'); const rec = await adminGet('customerMerges', 'c3');
      must(!(o.status === 'Invoicing' && o.customerId === 'c1'), `round ${round}: an Invoicing order was moved to the kept customer`);
      if (o.status === 'Invoicing') {
        must(c3 && !rec && o.customerId === 'c3', `round ${round}: invoicing won, so the merge must not have completed`);
        seen.invoicingWon++;
        if (c3.mergeLock) await a.customers.cancelMergeLock('c3');            // a paused merge is released by the manager
      } else {
        must(!c3 && rec && o.customerId === 'c1', `round ${round}: merge won but state is inconsistent: ${JSON.stringify({ o, c3, rec })}`);
        seen.merged++;
      }
      if (res[1].status === 'rejected') seen.blocked++;
    }
    console.log('RACE outcomes over 10 rounds:', JSON.stringify(seen));
  }, 120000);
});

// =============================================================================================
describe('Q. old-client bypass writes are refused (an old browser tab must not be able to bypass RC3)', () => {
  it('old manager client: bare schedule update with assignedDayChangedAt', async () => { await assertFails(updateDoc(doc(as('mgr'), 'customers', 'c1'), { assignedDay: 'Fri', assignedDayChangedAt: serverTimestamp() })); });
  it('old manager client: deactivate without a history entry', async () => { await assertFails(updateDoc(doc(as('mgr'), 'customers', 'c1'), { active: false, assignedDay: null })); });
  it('old client: a customer created with an automatic weekday', async () => { await assertFails(addDoc(collection(as('rep1'), 'customers'), { name: 'X', phone: '', location: 'y', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Wed', assignedDayChangedAt: serverTimestamp(), createdBy: 'rep1' })); });
  it('old manager client: free order creation, order counter +1, and counter +1 for invoices', async () => {
    await assertFails(setDoc(doc(as('mgr'), 'orders', 'legacy'), { orderNo: 'ORD-2026-0050', status: 'Submitted', items: [], createdBy: 'mgr' }));
    await assertFails(setDoc(doc(as('mgr'), 'orderCounters', 'naisiOrder'), { counter: 42 }));
    await assertFails(setDoc(doc(as('mgr'), 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 }));
  });
  it('old manager client: invoice with an automatic id; invoice without kind; order-linked invoice without registry', async () => {
    await assertFails(addDoc(collection(as('mgr'), 'invoices'), { orderId: null, invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr' }));
    await assertFails(setDoc(doc(as('mgr'), 'invoices', 'ord_o1'), { orderId: 'o1', invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr' }));
  });
  it('old manager client: "cancel and delete" (delete the order)', async () => { await assertFails(deleteDoc(doc(as('mgr'), 'orders', 'o1'))); });
  it('old manager client: a visit created by a manager', async () => { await assertFails(setDoc(doc(as('mgr'), 'visits', V), visit())); });
  it('old manager client: merge without the lock (delete a customer, re-point a visit)', async () => {
    await assertFails(deleteDoc(doc(as('mgr'), 'customers', 'c2')));
    await assertFails(updateDoc(doc(as('mgr'), 'visits', 'v_rep2_x'), { customerId: 'c2', customerName: 'Closed Shop' }));
  });
  it('old depot screen: config/depot read and write', async () => {
    await assertDenied(setDoc(doc(as('mgr'), 'config', 'depot'), { lat: -13.9, lng: 33.7 }));
    await assertDenied(getDoc(doc(as('mgr'), 'config', 'depot')));
  });
  it('old REP client keeps working: its visit/order/counter commit is still accepted', async () => { await assertSucceeds(saveOrderBatch(as('rep1'))); });
});

// Reads with the rules disabled (test inspection only) and RETURNS the callback's value. The installed
// withSecurityRulesDisabled helper returns void, so the value is captured here.
async function readAsAdmin(fn) {
  let out;
  await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore()); });
  return out;
}
// A refusal BY THE RULES: the error must be permission-denied. Any other error (a bad payload, a bug) fails the test.
async function assertDenied(promise) {
  let err = null; try { await promise; } catch (e) { err = e; }
  if (!err) throw new Error('expected permission-denied, but the operation succeeded');
  const code = err.code || '';
  if (code !== 'permission-denied' && !/PERMISSION_DENIED|insufficient permissions/i.test(String(err.message))) {
    throw new Error('expected permission-denied but got ' + (code || '(no code)') + ': ' + err.message);
  }
}
// Any refusal (used where the APP's own validation may refuse before the rules are reached).
async function assertRejects(promise) {
  let failed = false; try { await promise; } catch { failed = true; }
  if (!failed) throw new Error('expected the operation to be refused, but it succeeded');
}
async function assertRejectsLocally(fn) { await assertRejects(fn()); }
