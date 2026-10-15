import { db } from './firebase.js';
import {
  collection, doc, getDocs, runTransaction, serverTimestamp,
  query, where, orderBy, limit, startAfter
} from 'firebase/firestore';
import { ORDER_COUNTER_DOC, buildOrderNo } from './orderNumbering.js';
import { isValidPin } from './customers.js';
import { makeError } from './orderRevision.js';
import { malawiDate, weekdayOfDate } from './malawiTime.js';

const PAGE_SIZE = 25;

// No-order reasons. The rep must choose one deliberately (the form has no default).
// "Other" requires a written explanation; the rest may carry optional details.
export const NO_ORDER_REASONS = [
  'Shop still has stock',
  'Price too high',
  'Stock unavailable',
  'Shop owner unavailable',
  'Shop closed',
  'No money today',
  'Not interested',
  'Other',
];
export const MIN_OTHER_EXPLANATION = 3;   // non-blank characters
export const MAX_NOTES_LENGTH = 500;

// ---- validation (used by the screens AND enforced again before any write) ----
export function validateNoOrderInput({ reason, notes }) {
  const text = String(notes ?? '').trim();
  if (!reason || !NO_ORDER_REASONS.includes(reason)) return 'Choose a reason for no order.';
  if (reason === 'Other' && text.length < MIN_OTHER_EXPLANATION) return 'Please explain the reason when you choose "Other".';
  if (text.length > MAX_NOTES_LENGTH) return `Details must be ${MAX_NOTES_LENGTH} characters or fewer.`;
  return null;
}

export function validateOrderItems(items) {
  if (!Array.isArray(items) || items.length === 0) return 'Add at least one item.';
  for (const [i, it] of items.entries()) {
    const n = i + 1;
    if (!it || typeof it !== 'object') return `Item ${n} is not valid.`;
    if (typeof it.productId !== 'string' || !it.productId) return `Item ${n} must be chosen from the product list.`;
    if (!Number.isSafeInteger(it.qty) || it.qty <= 0) return `Item ${n}: quantity must be a whole number above 0.`;
    if (!Number.isFinite(it.price) || it.price < 0) return `Item ${n}: price is not valid.`;
    if (!Number.isFinite(it.total) || Math.abs(it.total - it.qty * it.price) > 0.01) return `Item ${n}: total does not match quantity x price.`;
  }
  return null;
}

// ---- idempotency ----
// The screen creates ONE request id when a shop is selected and keeps it until the
// save succeeds (or the shop is changed). The visit and order document ids are derived
// from it, so a double-click or a retry after a lost acknowledgement finds the
// already-saved visit and returns it instead of creating anything new.
export function newRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
export const visitIdFor = (uid, requestId) => `v_${uid}_${requestId}`;
export const orderIdFor = (uid, requestId) => `o_${uid}_${requestId}`;

function checkBasics({ customerId, requestId, uid }) {
  if (!uid) throw new Error('Not signed in.');
  if (!customerId) throw new Error('Select a customer first.');
  if (typeof requestId !== 'string' || !REQUEST_ID_RE.test(requestId)) throw new Error('Missing request id.');
}

function requireActiveCustomer(snap) {
  if (!snap.exists()) throw new Error('That customer no longer exists.');
  const c = snap.data();
  if (c.active === false) throw new Error('That customer is inactive and cannot be visited.');
  return c;
}

function visitBase({ customerId, customer, uid, email, requestId, now }) {
  const date = malawiDate(now());
  const scheduledDay = customer.assignedDay || null;
  return {
    schemaVersion: 2, requestId,
    customerId, customerName: customer.name,
    repId: uid, repEmail: email,
    date,                                   // calendar date in Malawi (see malawiTime.js)
    scheduledDay,                           // the customer's weekly day AT THE TIME of the visit
    wasScheduled: scheduledDay === weekdayOfDate(date),
    createdAt: serverTimestamp(),           // authoritative time of the event
  };
}

// ---- identical retry vs changed retry ----
// The same request id may only be used again for the SAME submission (a double-click or a
// retry after a lost acknowledgement). If anything differs - customer, outcome, products,
// quantities, prices, order notes, reason, explanation - the old save stays exactly as it
// was and the caller gets a 'visit-conflict' error that carries what WAS saved. The new
// details are never merged, never saved, and no new request id is made behind the rep's back.
const clean = (s) => String(s ?? '').trim();
const lineKey = (it) => [it && it.productId, it && it.qty, it && it.price, it && it.total].join('|');
const sameItems = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((it, i) => lineKey(it) === lineKey(b[i]));

function savedSummary(visit, order) {
  return {
    outcome: visit.outcome, customerId: visit.customerId, customerName: visit.customerName, date: visit.date,
    reasonNoOrder: visit.reasonNoOrder ?? null, reasonNotes: visit.reasonNotes ?? '',
    orderId: visit.orderId ?? null, orderNo: visit.orderNo ?? null, orderValue: visit.orderValue ?? null,
    items: order && Array.isArray(order.items) ? order.items.map(it => ({ ...it })) : null,
    notes: order ? order.notes ?? '' : null,
  };
}

function describeSaved(s) {
  if (s.outcome === 'Order Placed') {
    const lines = s.items ? s.items.map(it => `${it.qty} x ${it.desc || it.productId}`).join(', ') : 'items not available';
    return `Order ${s.orderNo || ''} for ${s.customerName}: ${lines}`;
  }
  return `No Order at ${s.customerName}: ${s.reasonNoOrder || 'no reason recorded'}${s.reasonNotes ? ' (' + s.reasonNotes + ')' : ''}`;
}

function conflictError(saved) {
  return makeError(
    `This visit was already saved differently: ${describeSaved(saved)}. The new details you entered were NOT saved. ` +
    'Review what was saved; if you really need another visit, start a new visit.',
    { code: 'visit-conflict', saved });
}

// ---- "No Order" visit: one transaction, idempotent ----
export async function recordNoOrderVisit({ customerId, reason, notes, requestId, uid, email, now = () => new Date() }) {
  checkBasics({ customerId, requestId, uid });
  const problem = validateNoOrderInput({ reason, notes });
  if (problem) throw new Error(problem);

  const visitRef = doc(db, 'visits', visitIdFor(uid, requestId));
  return await runTransaction(db, async (tx) => {
    const visitSnap = await tx.get(visitRef);
    const customerSnap = await tx.get(doc(db, 'customers', customerId));
    if (visitSnap.exists()) {
      const v = visitSnap.data();
      const same = v.outcome === 'No Order' && v.customerId === customerId
        && v.reasonNoOrder === reason && clean(v.reasonNotes) === clean(notes);
      if (!same) throw conflictError(savedSummary(v, null));
      return { visitId: visitRef.id, alreadySaved: true };
    }
    const customer = requireActiveCustomer(customerSnap);
    tx.set(visitRef, {
      ...visitBase({ customerId, customer, uid, email, requestId, now }),
      outcome: 'No Order',
      reasonNoOrder: reason,
      reasonNotes: String(notes ?? '').trim(),
      orderId: null, orderNo: null, orderValue: null,
    });
    return { visitId: visitRef.id, alreadySaved: false };
  });
}

// ---- "Order Placed" visit: order + visit + order number in ONE transaction ----
// Either all three are saved or none. The customer details are read from the customer
// record inside the transaction (not trusted from the screen). Stock and invoicing are
// untouched: the order starts as "Submitted", exactly like before, and goes through the
// existing approval workflow.
export async function submitOrderWithVisit({ customerId, items, notes, requestId, uid, email, now = () => new Date() }) {
  checkBasics({ customerId, requestId, uid });
  const problem = validateOrderItems(items);
  if (problem) throw new Error(problem);

  const visitRef = doc(db, 'visits', visitIdFor(uid, requestId));
  const orderRef = doc(db, 'orders', orderIdFor(uid, requestId));
  const grandTotal = items.reduce((sum, it) => sum + it.total, 0);

  return await runTransaction(db, async (tx) => {
    // All reads first.
    const visitSnap = await tx.get(visitRef);
    const customerSnap = await tx.get(doc(db, 'customers', customerId));
    const counterSnap = await tx.get(ORDER_COUNTER_DOC);
    const savedOrderSnap = await tx.get(orderRef);          // read for the comparison below (no writes on this path)
    if (visitSnap.exists()) {
      const v = visitSnap.data();
      const saved = savedOrderSnap.exists() ? savedOrderSnap.data() : null;
      const same = v.outcome === 'Order Placed' && v.customerId === customerId && !!saved
        && saved.customerId === customerId && sameItems(saved.items, items) && clean(saved.notes) === clean(notes);
      if (!same) throw conflictError(savedSummary(v, saved));
      return { visitId: visitRef.id, orderId: v.orderId, orderNo: v.orderNo, alreadySaved: true };
    }
    const customer = requireActiveCustomer(customerSnap);
    if (!isValidPin(customer.lat, customer.lng)) throw new Error('This customer has no pinned location. Pin it before placing an order.');

    const counter = counterSnap.exists() ? counterSnap.data().counter : 1;
    const orderNo = buildOrderNo(counter);
    tx.set(ORDER_COUNTER_DOC, { counter: counter + 1 });
    tx.set(orderRef, {
      orderNo, status: 'Submitted',
      customerId, customerName: customer.name, customerPhone: customer.phone || '-', customerLocation: customer.location || '-',
      customerLat: customer.lat, customerLng: customer.lng,
      items, notes: String(notes ?? '').trim(), grandTotal,
      createdBy: uid, createdByEmail: email,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(), submittedAt: serverTimestamp(),
      approvedAt: null, rejectedAt: null, cancelledAt: null, invoicedAt: null,
      managerNotes: '', invoiceId: null, invoiceNo: null,
      visitId: visitRef.id,
    });
    tx.set(visitRef, {
      ...visitBase({ customerId, customer, uid, email, requestId, now }),
      outcome: 'Order Placed',
      reasonNoOrder: null, reasonNotes: '',
      orderId: orderRef.id, orderNo, orderValue: grandTotal,   // value when the order was taken
    });
    return { visitId: visitRef.id, orderId: orderRef.id, orderNo, alreadySaved: false };
  });
}

// ---- reading ----
// Equality-only filters (no orderBy), so no composite index is needed.
export async function fetchMyVisitsForDate(uid, date) {
  const snap = await getDocs(query(collection(db, 'visits'), where('repId', '==', uid), where('date', '==', date)));
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const ms = (v) => (v.createdAt && typeof v.createdAt.toMillis === 'function' ? v.createdAt.toMillis() : 0);
  return items.sort((a, b) => ms(a) - ms(b));
}

export async function fetchMyVisitsPage(uid, cursor = null) {
  const constraints = [where('repId', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'visits'), ...constraints));
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.at(-1) || null, hasMore: snap.docs.length === PAGE_SIZE };
}
