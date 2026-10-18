import { db } from './firebase.js';
import {
  collection, doc, getDoc, getDocs,
  serverTimestamp, query, where, orderBy, limit, startAfter, runTransaction
} from 'firebase/firestore';
import { COUNTER_DOC, buildInvoiceNo } from './numbering.js';
import { makeError, orderRevisionKey } from './orderRevision.js';

const PAGE_SIZE = 25;

export const ORDER_STATUSES = ['Draft', 'Submitted', 'Approved', 'Invoicing', 'Invoiced', 'Dispatched', 'Delivered', 'Rejected', 'Cancelled'];

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

// Rejecting a Submitted order (no stock was ever touched). Cancelling is a separate, audited operation: stock.js cancelOrder.
export async function rejectOrder(id, managerNotes = '') {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'orders', id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Order no longer exists.');
    if (snap.data().status !== 'Submitted') throw new Error('Only a Submitted order can be rejected. Refresh the list.');
    tx.update(ref, { status: 'Rejected', rejectedAt: serverTimestamp(), managerNotes, updatedAt: serverTimestamp() });
  });
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
    // A customer that is being merged away cannot have an order start invoicing (the merge waits for invoicing, and
    // invoicing waits for the merge). The security rules enforce the same thing; this gives the clear message.
    if (o.customerId) {
      const custSnap = await tx.get(doc(db, 'customers', o.customerId));
      if (custSnap.exists() && custSnap.data().mergeLock) {
        throw makeError('This order\'s customer is being merged with another customer right now. Try again in a few minutes.', { code: 'customer-merging' });
      }
    }

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
    tx.update(orderRef, { status: 'Approved', invoicingAttempt: null, invoicingAttemptEnded: attemptToken, invoicingLeaseStartedAt: null, updatedAt: serverTimestamp() });
  });
}

// Reserves the next invoice number, writes the invoice and (for an order)
// marks it Invoiced - one all-or-nothing transaction.
//   orderId + attemptToken : invoice for an order locked by beginInvoiceGeneration
//   invoiceId              : stand-alone (walk-in) invoice only - derived from the request id, see standaloneInvoiceIdFor
//   expectedRevision       : orderRevisionKey of the order as the manager saw
//                            it; the commit is refused if it has changed since
//   meta                   : invoice fields WITHOUT invoiceNo
// Every invoice carries an explicit identity: kind 'order' (id ord_<orderId>) or kind 'standalone' (id sa_<uid>_<requestId>).
// A write without it - an old copy of the app, or a hand-made write - is refused by the security rules.
// The issued number is also stored once in invoiceNumbers/{invoiceNo}: a number can never be issued twice, even after the
// next number has been adjusted by hand (the commit fails with 'number-already-issued' and nothing is saved).
export async function commitInvoice({ orderId = null, attemptToken = null, invoiceId = null, requestId = null, expectedRevision = null, meta, uid }) {
  const items = meta.items || [];
  const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
  if (!orderId && !(typeof invoiceId === 'string' && invoiceId.startsWith(`sa_${uid}_`))) {
    throw new Error('A stand-alone invoice needs its request id (standaloneInvoiceIdFor).');
  }
  const targetId = orderId ? invoiceIdForOrder(orderId) : invoiceId;

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
          `An invoice (${invoiceSnap.data().invoiceNo}) already exists for this order but the order is not marked Invoiced. No new invoice was created - this needs manual review.`,
          { code: 'invoice-conflict', invoiceNo: invoiceSnap.data().invoiceNo });
      }
      if (o.status !== 'Invoicing' || !attemptToken || o.invoicingAttempt !== attemptToken) {
        throw makeError('This invoicing attempt is no longer the active one (it was released or taken over). Nothing was saved.', { code: 'lock-lost' });
      }
      if (expectedRevision !== null && orderRevisionKey(o) !== expectedRevision) {
        throw makeError('This order was changed after you loaded it. Nothing was saved - refresh the list and review the order again.', { code: 'order-changed' });
      }
    } else if (invoiceSnap.exists()) {
      // A retry of a stand-alone invoice whose first attempt DID commit (the acknowledgement was lost): report the
      // saved invoice, create nothing and use no number. If the retry carries DIFFERENT details it is refused.
      const saved = invoiceSnap.data();
      if (standaloneKey(saved) !== standaloneKey({ ...meta, grandTotal })) {
        throw makeError(`This invoice was already saved as ${saved.invoiceNo} with different details. The new details were NOT saved. Start a new invoice if you need another.`, { code: 'invoice-conflict', invoiceNo: saved.invoiceNo });
      }
      return { invoiceId: targetId, invoiceNo: saved.invoiceNo, grandTotal: saved.grandTotal, next: counter, alreadySaved: true };
    }

    const invoiceNo = buildInvoiceNo(counter.prefix, counter.counter);
    const numberRef = doc(db, 'invoiceNumbers', invoiceNo);
    const numberSnap = await tx.get(numberRef);          // still a read: must come before the writes below
    if (numberSnap.exists()) {
      throw makeError(`Invoice number ${invoiceNo} was already issued. Nothing was saved. A manager must raise the next invoice number above the highest number already used (Invoices -> Numbering).`, { code: 'number-already-issued', invoiceNo });
    }
    const next = { prefix: counter.prefix, counter: counter.counter + 1 };

    tx.set(COUNTER_DOC, { ...next, lastInvoiceId: targetId });
    tx.set(numberRef, { invoiceId: targetId, issuedBy: uid, issuedAt: serverTimestamp() });
    tx.set(invoiceRef, {
      ...meta, invoiceNo, grandTotal, orderId: orderId || null,
      kind: orderId ? 'order' : 'standalone',
      ...(orderId ? {} : { requestId: invoiceId.slice(`sa_${uid}_`.length) }),
      createdBy: uid, createdAt: serverTimestamp(),
    });
    if (orderRef) {
      tx.update(orderRef, {
        status: 'Invoiced', invoiceId: targetId, invoiceNo,
        invoicingAttempt: null, invoicingAttemptEnded: attemptToken, invoicingLeaseStartedAt: null,
        invoicedAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
    }
    return { invoiceId: targetId, invoiceNo, grandTotal, next, alreadySaved: false };
  });
}

// What identifies "the same stand-alone invoice" on a retry: customer, date, items and total.
function standaloneKey(inv) {
  return JSON.stringify([inv.customerId || null, String(inv.customer ?? ''), String(inv.date ?? ''),
    (inv.items || []).map(it => [Number(it.qty) || 0, String(it.desc ?? ''), Number(it.price) || 0, Number(it.total) || 0]),
    Number(inv.grandTotal) || 0]);
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

// Stand-alone (walk-in) invoice, manager only. Its id is derived from a request id that the screen keeps until the
// save succeeds, so a double click or a retry after a lost acknowledgement finds the saved invoice instead of creating
// another one or using another number. Use newStandaloneRequestId() for a NEW invoice.
export const standaloneInvoiceIdFor = (uid, requestId) => `sa_${uid}_${requestId}`;
export function newStandaloneRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
export async function issueStandaloneInvoice({ requestId, meta, uid }) {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error('Missing request id.');
  return await commitInvoice({ invoiceId: standaloneInvoiceIdFor(uid, requestId), meta, uid });
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