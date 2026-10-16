// A manager entering an order ON BEHALF of a sales rep (for example a phoned-in order).
//
// What is recorded (and why):
//   createdBy / createdByEmail   the manager - the person who actually entered the order (authorisation, audit)
//   enteredBy / enteredByEmail   the same manager, named explicitly so reports never confuse it with the rep
//   attributedRepEmail           the rep the order is credited to (must be a current rep; checked by the rules)
//   source: 'manager-entered'    distinguishes it from rep-entered orders ('rep-visit')
//   visitId: null                NO visit is created. The order is not a shop visit: it does not count towards a rep's
//                                visited shops, coverage or conversion. Reports show it in its own "attributed orders" column.
// The order number comes from the same controlled counter as rep orders, in the same transaction (the rules refuse a
// counter step without its order and an order whose number is not the counter value). Nobody can type a number.
// Retries are safe: the order id is derived from the request id (m_<uid>_<requestId>); an identical retry returns the
// saved order, a changed retry is refused with 'order-conflict' and nothing is overwritten.
import { db } from './firebase.js';
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { ORDER_COUNTER_DOC, buildOrderNo } from './orderNumbering.js';
import { isValidPin } from './customers.js';
import { makeError } from './orderRevision.js';
import { validateOrderItems } from './visits.js';

export const managerOrderIdFor = (uid, requestId) => `m_${uid}_${requestId}`;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const clean = (s) => String(s ?? '').trim();
const lineKey = (it) => [it && it.productId, it && it.qty, it && it.price, it && it.total].join('|');
const sameItems = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((it, i) => lineKey(it) === lineKey(b[i]));
export const normaliseRepEmail = (e) => String(e ?? '').trim().toLowerCase();

export async function submitOrderAsManager({ customerId, items, notes, attributedRepEmail, requestId, uid, email, now = () => new Date() }) {
  if (!uid) throw new Error('Not signed in.');
  if (!customerId) throw new Error('Select a customer first.');
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new Error('Missing request id.');
  const rep = normaliseRepEmail(attributedRepEmail);
  if (!rep) throw new Error('Choose the sales rep this order is for.');
  const problem = validateOrderItems(items);
  if (problem) throw new Error(problem);
  const orderRef = doc(db, 'orders', managerOrderIdFor(uid, requestId));
  const grandTotal = items.reduce((sum, it) => sum + it.total, 0);

  return await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    const customerSnap = await tx.get(doc(db, 'customers', customerId));
    const counterSnap = await tx.get(ORDER_COUNTER_DOC);
    const rolesSnap = await tx.get(doc(db, 'config', 'roles'));
    if (orderSnap.exists()) {
      const o = orderSnap.data();
      const same = o.customerId === customerId && o.attributedRepEmail === rep && sameItems(o.items, items) && clean(o.notes) === clean(notes);
      if (!same) {
        throw makeError(`This order was already saved differently as ${o.orderNo}. The new details were NOT saved. Review the saved order; start a new order if you need another.`, { code: 'order-conflict', saved: { orderNo: o.orderNo, orderId: orderRef.id } });
      }
      return { orderId: orderRef.id, orderNo: o.orderNo, alreadySaved: true };
    }
    const submitters = rolesSnap.exists() ? (rolesSnap.data().submitters || []) : [];
    if (!submitters.includes(rep)) throw new Error('That person is not a sales rep, so the order cannot be credited to them.');
    if (!customerSnap.exists()) throw new Error('That customer no longer exists.');
    const customer = customerSnap.data();
    if (customer.active === false) throw new Error('That customer is inactive. Reactivate the customer before entering an order.');
    if (customer.mergeLock) throw makeError('That customer is being merged with another customer right now. Try again in a few minutes.', { code: 'customer-merging' });
    if (!isValidPin(customer.lat, customer.lng)) throw new Error('This customer has no pinned location. Pin it before entering an order.');

    const counter = counterSnap.exists() ? counterSnap.data().counter : 1;
    const orderNo = buildOrderNo(counter, now());
    tx.set(ORDER_COUNTER_DOC, { counter: counter + 1, lastOrderId: orderRef.id });
    tx.set(orderRef, {
      orderNo, status: 'Submitted', source: 'manager-entered', requestId,
      customerId, customerName: customer.name, customerPhone: customer.phone || '-', customerLocation: customer.location || '-',
      customerLat: customer.lat, customerLng: customer.lng,
      items, notes: clean(notes), grandTotal,
      createdBy: uid, createdByEmail: email, enteredBy: uid, enteredByEmail: email, attributedRepEmail: rep,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), submittedAt: serverTimestamp(),
      approvedAt: null, rejectedAt: null, cancelledAt: null, invoicedAt: null,
      managerNotes: '', invoiceId: null, invoiceNo: null, visitId: null,
    });
    return { orderId: orderRef.id, orderNo, alreadySaved: false };
  });
}
