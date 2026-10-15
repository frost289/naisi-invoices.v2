import { db } from './firebase.js';
import {
  collection, addDoc, doc, getDoc, updateDoc, deleteDoc, getDocs,
  serverTimestamp, query, where, orderBy, limit, startAfter, runTransaction
} from 'firebase/firestore';
import { incrementOrderCounterAtomically } from './orderNumbering.js';
import { COUNTER_DOC, buildInvoiceNo } from './numbering.js';
import { makeError, orderRevisionKey } from './orderRevision.js';
import { isValidPin } from './customers.js';

const PAGE_SIZE = 25;

export const ORDER_STATUSES = ['Draft', 'Submitted', 'Approved', 'Invoicing', 'Invoiced', 'Dispatched', 'Delivered', 'Rejected', 'Cancelled'];

export async function submitOrder({ customerId, customerName, customerPhone, customerLocation, customerLat, customerLng, items, notes, uid, email }) {
  // The delivery point is the customer's pinned coordinates, snapshotted
  // onto the order. customerLocation stays as the human-readable area label.
  if (!isValidPin(customerLat, customerLng)) {
    throw new Error('This customer has no pinned location. Pin it before placing an order.');
  }
  const { usedNo } = await incrementOrderCounterAtomically();
  const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
  const docRef = await addDoc(collection(db, 'orders'), {
    orderNo: usedNo,
    status: 'Submitted',
    customerId, customerName, customerPhone, customerLocation, customerLat, customerLng,
    items, notes: notes || '', grandTotal,
    createdBy: uid, createdByEmail: email,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    submittedAt: serverTimestamp(),
    approvedAt: null, rejectedAt: null, cancelledAt: null, invoicedAt: null,
    managerNotes: '', invoiceId: null, invoiceNo: null,
  });
  return { id: docRef.id, orderNo: usedNo };
}

export async function fetchMyOrdersPage(uid, cursor = null) {
  const constraints = [where('createdBy', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'orders'), ...constraints));
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.at(-1) || null, hasMore: snap.docs.length === PAGE_SIZE };
}

export async function fetchOrdersByStatusPage(status, cursor = null) {
  const constraints = [where('status', '==', status), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'orders'), ...constraints));
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.at(-1) || null, hasMore: snap.docs.length === PAGE_SIZE };
}

export async function fetchAllOrdersPage(cursor = null) {
  const constraints = [orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'orders'), ...constraints));
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.at(-1) || null, hasMore: snap.docs.length === PAGE_SIZE };
}

export async function fetchOrderById(id) {
  const snap = await getDoc(doc(db, 'orders', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function setOrderStatus(id, status, managerNotes = '') {
  const patch = { status, updatedAt: serverTimestamp() };
  if (status === 'Approved') patch.approvedAt = serverTimestamp();
  if (status === 'Rejected') { patch.rejectedAt = serverTimestamp(); patch.managerNotes = managerNotes; }
  if (status === 'Cancelled') patch.cancelledAt = serverTimestamp();
  await updateDoc(doc(db, 'orders', id), patch);
}

// ============= INVOICING =============
// How "one invoice per order" is protected, and what it does NOT cover:
//
//  1. LOCK WITH OWNER. beginInvoiceGeneration moves Approved -> Invoicing and
//     stamps the order with a random attempt token and a lease start time.
//     commitInvoice and revertInvoiceGeneration only act while the order
//     still carries THAT token, so an attempt that was superseded can neither
//     commit nor release the newer attempt's lock.
//
//  2. ONE ATOMIC COMMIT. commitInvoice reserves the next invoice number,
//     writes the invoice and marks the order Invoiced in a single Firestore
//     transaction. A failed commit writes nothing and uses no number.
//
//  3. STABLE IDENTITY. An order's invoice always has the document id
//     "ord_<orderId>", and the commit refuses if that document exists, so
//     two new-code attempts cannot both create it even if status fields are
//     wrong. Stand-alone invoices use a client-chosen id (see
//     issueStandaloneInvoice) so a retry after a lost acknowledgement is
//     recognised instead of duplicated.
//
// NOT covered by client code alone: browser tabs still running the previous
// version of the app (they use separate writes with automatic ids) and
// invoices an older version left orphaned. Only Firestore security rules can
// stop old clients — see docs/DEPLOYMENT-AND-RULES.md and rules/. That is
// also why automatic resume of interrupted attempts (below) ships DISABLED.

// Resume of interrupted attempts: OFF until legacy data has been reconciled
// and the rules are deployed (docs/DEPLOYMENT-AND-RULES.md, steps 1-5).
export const INVOICING_RESUME_ENABLED = false;
// A lock younger than this is never taken over. A real attempt holds its lock
// for seconds; the long lease only matters after a closed tab or crash.
export const INVOICING_LEASE_MS = 10 * 60 * 1000;

export function invoiceIdForOrder(orderId) { return `ord_${orderId}`; }

function newToken() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'tok-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Lease expiry policy and clock skew: the lease start is a SERVER timestamp,
// compared with this device's clock. A device whose clock is BEHIND sees the
// lease as younger than it is (age <= 0 means "not expired"), so it waits
// longer — the safe direction. A device whose clock is far AHEAD may take a
// lock over early; that is still safe, because the superseded attempt can no
// longer commit (token check). A missing/unreadable timestamp is never
// treated as expired. The authoritative expiry check belongs in the security
// rules, using request.time (rules/invoicing.rules.fragment).
export function isLeaseExpired(leaseStartedAt, leaseMs, nowMs) {
  if (!leaseStartedAt || typeof leaseStartedAt.toMillis !== 'function') return false;
  return nowMs - leaseStartedAt.toMillis() > leaseMs;
}

function alreadyInvoicedError(order) {
  return makeError('This order has already been invoiced.', { alreadyInvoiced: true, invoiceNo: order.invoiceNo });
}

// Locks an Approved order for invoicing. Returns { attemptToken }, which
// must be passed to commitInvoice / revertInvoiceGeneration.
export async function beginInvoiceGeneration(id, { resume = INVOICING_RESUME_ENABLED, leaseMs = INVOICING_LEASE_MS, now = () => Date.now() } = {}) {
  const attemptToken = newToken(); // created once, outside the callback (the SDK may re-run it)
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    const o = orderSnap.data();
    if (o.status === 'Invoiced' || o.invoiceId) throw alreadyInvoicedError(o);

    if (o.status === 'Invoicing') {
      const busy = (why) => makeError(
        `This order is currently "Invoicing" (${why}). Check the Invoices list for an invoice for this customer first, then ask a manager to review it.`,
        { code: 'invoicing-in-progress' });
      if (!resume) throw busy('another attempt is running, or an earlier one was interrupted');
      if (!o.invoicingAttempt) throw busy('locked by an older version of the app — needs manual review');
      if (!isLeaseExpired(o.invoicingLeaseStartedAt, leaseMs, now())) throw busy('another attempt is still within its lease');
      // expired lease on a locked order created by this version: take it over
    } else if (o.status !== 'Approved') {
      throw new Error(`This order is currently "${o.status}", not Approved — someone else may already be invoicing it.`);
    }

    tx.update(orderRef, {
      status: 'Invoicing', invoicingAttempt: attemptToken,
      invoicingLeaseStartedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
  return { attemptToken };
}

// Releases the lock — but only if it is still OURS. Called when an attempt
// fails before committing. If the commit actually went through (lost
// acknowledgement) or another attempt has taken over, this does nothing.
export async function revertInvoiceGeneration(id, attemptToken) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) return;
    const o = orderSnap.data();
    if (o.status !== 'Invoicing' || !attemptToken || o.invoicingAttempt !== attemptToken) return;
    tx.update(orderRef, { status: 'Approved', invoicingAttempt: null, invoicingLeaseStartedAt: null, updatedAt: serverTimestamp() });
  });
}

// Reserves the next invoice number, writes the invoice and (for an order)
// marks it Invoiced — one all-or-nothing transaction.
//   orderId + attemptToken : invoice for an order locked by beginInvoiceGeneration
//   invoiceId              : stand-alone invoice only — a client-chosen id
//   expectedRevision       : orderRevisionKey of the order as the manager saw
//                            it; the commit is refused if it has changed since
//   meta                   : invoice fields WITHOUT invoiceNo
export async function commitInvoice({ orderId = null, attemptToken = null, invoiceId = null, expectedRevision = null, meta, uid }) {
  const items = meta.items || [];
  const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
  const targetId = orderId ? invoiceIdForOrder(orderId) : (invoiceId || doc(collection(db, 'invoices')).id);

  return await runTransaction(db, async (tx) => {
    // All reads first (Firestore requirement).
    const counterSnap = await tx.get(COUNTER_DOC);
    const invoiceRef = doc(db, 'invoices', targetId);
    const invoiceSnap = await tx.get(invoiceRef);
    const orderRef = orderId ? doc(db, 'orders', orderId) : null;
    const orderSnap = orderRef ? await tx.get(orderRef) : null;

    const counter = counterSnap.exists() ? counterSnap.data() : { prefix: 'NF-INV', counter: 1 };

    if (orderRef) {
      if (!orderSnap.exists()) throw new Error('Order no longer exists.');
      const o = orderSnap.data();
      if (o.status === 'Invoiced' || o.invoiceId) throw alreadyInvoicedError(o);
      if (invoiceSnap.exists()) {
        throw makeError(
          `An invoice (${invoiceSnap.data().invoiceNo}) already exists for this order but the order is not marked Invoiced. No new invoice was created — this needs manual review.`,
          { code: 'invoice-conflict', invoiceNo: invoiceSnap.data().invoiceNo });
      }
      if (o.status !== 'Invoicing' || !attemptToken || o.invoicingAttempt !== attemptToken) {
        throw makeError('This invoicing attempt is no longer the active one (it was released or taken over). Nothing was saved.', { code: 'lock-lost' });
      }
      if (expectedRevision !== null && orderRevisionKey(o) !== expectedRevision) {
        throw makeError('This order was changed after you loaded it. Nothing was saved — refresh the list and review the order again.', { code: 'order-changed' });
      }
    } else if (invoiceSnap.exists()) {
      // A retry of a stand-alone invoice whose first attempt DID commit (the
      // acknowledgement was lost): report the saved invoice, create nothing.
      const saved = invoiceSnap.data();
      return { invoiceId: targetId, invoiceNo: saved.invoiceNo, grandTotal: saved.grandTotal, next: counter, alreadySaved: true };
    }

    const invoiceNo = buildInvoiceNo(counter.prefix, counter.counter);
    const next = { prefix: counter.prefix, counter: counter.counter + 1 };

    tx.set(COUNTER_DOC, next);
    tx.set(invoiceRef, {
      ...meta, invoiceNo, grandTotal, orderId: orderId || null,
      createdBy: uid, createdAt: serverTimestamp(),
    });
    if (orderRef) {
      tx.update(orderRef, {
        status: 'Invoiced', invoiceId: targetId, invoiceNo,
        invoicingAttempt: null, invoicingLeaseStartedAt: null,
        invoicedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    return { invoiceId: targetId, invoiceNo, grandTotal, next, alreadySaved: false };
  });
}

// Lock -> commit -> (release the lock if the commit failed). The one place
// the three invoice screens (full page, quick modal, bulk) get an invoice
// for an order. Throws on failure; on success the invoice IS saved.
export async function issueInvoiceForOrder({ orderId, meta, expectedRevision = null, uid }) {
  const { attemptToken } = await beginInvoiceGeneration(orderId);
  try {
    return await commitInvoice({ orderId, attemptToken, expectedRevision, meta, uid });
  } catch (err) {
    try { await revertInvoiceGeneration(orderId, attemptToken); } catch (revertErr) { console.error(revertErr); }
    throw err;
  }
}

// Stand-alone invoice (not tied to an order). Pass the SAME invoiceId on a
// retry of the same click; use newStandaloneInvoiceId() for a new invoice.
export function newStandaloneInvoiceId() { return doc(collection(db, 'invoices')).id; }
export async function issueStandaloneInvoice({ invoiceId, meta, uid }) {
  return await commitInvoice({ invoiceId, meta, uid });
}


// ---- Delivery ----
// Shared pool for now: every delivery person sees every Invoiced
// order, no per-person assignment. Fine for one delivery guy; once
// there are several, this is the spot to introduce a fair-assignment
// scheme (round-robin by area, load-balancing by count, etc.) —
// flagged here deliberately as a future improvement, not built yet.
export async function fetchOrdersReadyToDeliverPage(cursor = null) {
  const constraints = [where('status', '==', 'Invoiced'), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'orders'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function markOrderDelivered(id, { uid, email }) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    if (orderSnap.data().status !== 'Invoiced') {
      throw new Error('This order is no longer marked Invoiced — someone else may have already delivered it.');
    }
    tx.update(orderRef, {
      status: 'Delivered', deliveredBy: uid, deliveredByEmail: email,
      deliveredAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
}