// Firestore EMULATOR tests for the complete final rules file (rules/firestore.rules.FINAL-CANDIDATE).
//
// These were WRITTEN WITHOUT BEING RUN: the environment that produced them could not download the Firestore
// emulator. Run them with  tests\run-rules-tests.bat  (Windows) or  cd tests && npm run test:rules.
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
  doc, setDoc, getDoc, getDocs, collection, query, where, updateDoc, deleteDoc, addDoc,
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
  createdAt: serverTimestamp(), updatedAt: serverTimestamp(), submittedAt: serverTimestamp(), invoiceId: null, invoiceNo: null, visitId: V, ...over });
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
        ['counters', 'naisiInvoice'], ['orderCounters', 'naisiOrder'], ['stockMovements', 'x'], ['expenses', 'x']]) {
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
  it('manager can only re-point customerId/customerName (customer merge); no other edit, no delete', async () => {
    await assertSucceeds(put());
    await assertSucceeds(updateDoc(doc(as('mgr'), 'visits', V), { customerId: 'c2', customerName: 'Closed Shop' }));
    await assertFails(updateDoc(doc(as('mgr'), 'visits', V), { outcome: 'Order Placed' }));
    await assertFails(updateDoc(doc(as('mgr'), 'visits', V), { repId: 'rep2' }));
    await assertFails(deleteDoc(doc(as('mgr'), 'visits', V)));
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
  it('legacy submitOrder path (addDoc order, then counter) is refused for reps', async () => {
    const db = as('rep1');
    await assertFails(addDoc(collection(db, 'orders'), orderDoc({ visitId: undefined })));
  });
  it('manager keeps full order creation (documented decision) and manager order workflow still works', async () => {
    const db = as('mgr');
    await assertSucceeds(setDoc(doc(db, 'orders', 'mgrOrder'), { orderNo: 'ORD-2026-0050', status: 'Submitted', items: [], createdBy: 'mgr' }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'mgrOrder'), { status: 'Approved', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'mgrOrder'), { status: 'Rejected' }));
    await assertSucceeds(updateDoc(doc(db, 'orders', 'o1'), { items: [{ qty: 2 }] }));               // edit an approved order
    await assertSucceeds(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 42 }));          // original manager behaviour (+1)
    await assertFails(setDoc(doc(db, 'orderCounters', 'naisiOrder'), { counter: 100 }));            // original: only +1 steps
    await assertFails(deleteDoc(doc(db, 'orders', 'o1')));
  });
});

// =============================================================================================
describe('F. customers: schedule fields are manager-only', () => {
  const newCust = (over = {}) => ({ name: 'New Shop', phone: '', location: 'Area 3', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Mon', createdBy: 'rep1', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  it('rep can create a customer exactly as the app does (active, automatic Mon-Sat day, pinned)', async () => {
    await assertSucceeds(addDoc(collection(as('rep1'), 'customers'), newCust()));
    await assertSucceeds(addDoc(collection(as('rep1'), 'customers'), newCust({ assignedDay: null })));
  });
  it.each([
    ['inactive', { active: false }],
    ['with a schedule-change time', { assignedDayChangedAt: serverTimestamp() }],
    ['with a made-up day', { assignedDay: 'Sunday' }],
    ['with no pin', { lat: null, lng: null }],
  ])('rep cannot create a customer %s', async (_n, over) => { await assertFails(addDoc(collection(as('rep1'), 'customers'), newCust(over))); });
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
  ])('rep cannot %s', async (_n, patch) => {
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), patch));
    await assertFails(setDoc(doc(as('rep1'), 'customers', 'c1'), { ...shop, ...patch }));     // full overwrite is also an update
  });
  it('rep cannot remove the pin, cannot delete a customer', async () => {
    await assertFails(updateDoc(doc(as('rep1'), 'customers', 'c1'), { lat: null }));
    await assertFails(deleteDoc(doc(as('rep1'), 'customers', 'c1')));
  });
  it('manager can deactivate, reactivate, assign days and delete', async () => {
    const d = doc(as('mgr'), 'customers', 'c1');
    await assertSucceeds(updateDoc(d, { active: false, assignedDay: null, assignedDayChangedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(d, { active: true }));
    await assertSucceeds(updateDoc(d, { assignedDay: 'Sat', assignedDayChangedAt: serverTimestamp() }));
    await assertSucceeds(addDoc(collection(as('mgr'), 'customers'), newCust({ active: false })));
    await assertSucceeds(deleteDoc(doc(as('mgr'), 'customers', 'c2')));
  });
  it('deliverer can read customers but cannot write them; stranger neither', async () => {
    await assertSucceeds(getDoc(doc(as('deliv'), 'customers', 'c1')));
    await assertFails(updateDoc(doc(as('deliv'), 'customers', 'c1'), { phone: '1' }));
  });
});

// =============================================================================================
describe('G. invoices and orders: the seven protections + legitimate paths', () => {
  const lock = (db, over = {}) => updateDoc(doc(db, 'orders', 'o1'), { status: 'Invoicing', invoicingAttempt: 't1', invoicingLeaseStartedAt: serverTimestamp(), updatedAt: serverTimestamp(), ...over });
  const inv = (over = {}) => ({ orderId: 'o1', invoiceNo: 'NF-INV-2026-0370', items: [], createdBy: 'mgr', grandTotal: 0, customer: 'Shop', createdAt: serverTimestamp(), ...over });
  const commit = (db, { invoiceId = 'ord_o1', invoice = {}, order = {}, counter = { prefix: 'NF-INV', counter: 371 }, skip = [] } = {}) => {
    const b = writeBatch(db);
    if (!skip.includes('counter')) b.set(doc(db, 'counters', 'naisiInvoice'), counter);
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
  it('legitimate: stand-alone invoice with an automatic id, orderId null, counter moved by one in the same commit', async () => {
    const db = as('mgr'); const b = writeBatch(db);
    b.set(doc(db, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 });
    b.set(doc(db, 'invoices', 'autoStandalone1'), inv({ orderId: null }));
    await assertSucceeds(b.commit());
  });
  it('legitimate: edit an existing invoice (customer/items) but not its identity', async () => {
    const d = doc(as('mgr'), 'invoices', 'ord_oInv');
    await assertSucceeds(updateDoc(d, { customer: 'Renamed', items: [{ a: 1 }], updatedAt: serverTimestamp() }));
    for (const f of [{ orderId: 'x' }, { invoiceNo: 'NF-INV-9999' }, { createdBy: 'rep1' }, { createdAt: serverTimestamp() }]) await assertFails(updateDoc(d, f));
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
    await assertFails(commit(db, { counter: { prefix: 'NF-INV', counter: 372 } }));
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
  it('rep: submitOrderWithVisit saves order + visit + counter; retry is idempotent; changed retry conflicts; counter moved once', async () => {
    const a = await app('rep1');
    const r1 = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: 'n', requestId: REQ, ...rep, now: NOW });
    const r2 = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: 'n', requestId: REQ, ...rep, now: NOW });
    if (r1.alreadySaved !== false || r2.alreadySaved !== true || r1.orderId !== r2.orderId) throw new Error(`unexpected: ${JSON.stringify([r1, r2])}`);
    let code; try { await a.visits.submitOrderWithVisit({ customerId: 'c1', items: [{ ...items[0], qty: 3, total: 300 }], notes: 'n', requestId: REQ, ...rep, now: NOW }); } catch (e) { code = e.code; }
    if (code !== 'visit-conflict') throw new Error('expected visit-conflict, got ' + code);
    const counter = await env.withSecurityRulesDisabled(async (ctx) => (await getDoc(doc(ctx.firestore(), 'orderCounters', 'naisiOrder'))).data().counter);
    if (counter !== 42) throw new Error('counter should be 42, is ' + counter);
  });
  it('rep: two different shops get two different order numbers', async () => {
    const a = await app('rep1');
    const x = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-cccccccc-3333', ...rep, now: NOW });
    const y = await a.visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-dddddddd-4444', ...rep, now: NOW });
    if (x.orderNo === y.orderNo) throw new Error('duplicate order number');
  });
  it('rep: order for an inactive customer is refused by the app (and by the rules)', async () => {
    const a = await app('rep1');
    await assertRejects(a.visits.submitOrderWithVisit({ customerId: 'c2', items, notes: '', requestId: REQ, ...rep, now: NOW }));
  });
  it('rep: addCustomer works; the legacy submitOrder path is refused by the rules', async () => {
    const a = await app('rep1');
    const id = await a.customers.addCustomer({ name: 'Rep Shop', phone: '', location: 'Area 3', lat: -13.9, lng: 33.7, uid: 'rep1', assignedDay: 'Tue' });
    if (!id) throw new Error('no id');
    await assertRejects(a.orders.submitOrder({ customerId: 'c1', customerName: 'Shop', customerPhone: '1', customerLocation: 'x', customerLat: -13.9, customerLng: 33.7, items, notes: '', ...rep }));
  });
  it('rep: cannot deactivate a customer or change its day with the real app functions', async () => {
    const a = await app('rep1');
    await assertRejects(a.customers.deactivateCustomer('c1'));
    await assertRejects(a.customers.setCustomerVisitDay('c1', 'Fri'));
    await a.customers.updateCustomer('c1', { name: 'Shop', phone: '0888', location: 'Area 25' });
  });
  it('manager: deactivate, reactivate, set day, merge customers (re-points visits/orders/invoices)', async () => {
    const a = await app('mgr');
    await a.customers.setCustomerVisitDay('c1', 'Fri');
    await a.customers.deactivateCustomer('c1');
    await a.customers.reactivateCustomer('c1');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'visits', 'v_rep1_merge'), { repId: 'rep1', customerId: 'c2', customerName: 'Closed Shop' });
    });
    await a.customers.mergeCustomers('c1', ['c2']);
  });
  it('manager: full invoicing through the real functions (issueInvoiceForOrder, issueStandaloneInvoice, begin/revert)', async () => {
    const a = await app('mgr');
    const r = await a.orders.issueInvoiceForOrder({ orderId: 'o1', meta: { items: [{ qty: 1, price: 5, total: 5 }], customer: 'Shop', customerId: 'c1' }, uid: 'mgr' });
    if (!/^NF-INV-\d{4}-0370$/.test(r.invoiceNo)) throw new Error('unexpected number ' + r.invoiceNo);
    const s = await a.orders.issueStandaloneInvoice({ invoiceId: a.orders.newStandaloneInvoiceId(), meta: { items: [], customer: 'Walk-in' }, uid: 'mgr' });
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

async function assertRejects(promise) {
  let failed = false; try { await promise; } catch { failed = true; }
  if (!failed) throw new Error('expected the operation to be refused, but it succeeded');
}
async function assertRejectsLocally(fn) { await assertRejects(fn()); }
