import { db } from './firebase.js';
import { assertOrderLines, validateOrderLines, round2 } from './orderLines.js';
import {
  doc, runTransaction, collection, serverTimestamp,
  query, where, orderBy, limit, startAfter, getDocs
} from 'firebase/firestore';
import { wholeNumber } from './numbers.js';
import { makeError, orderItemsKey, orderRevisionKey } from './orderRevision.js';

const PAGE_SIZE = 25;

// ---- Receiving supplier cases ----
// Stock is always held in the product's own pack (strip, packet, box,
// tin...). Suppliers deliver in cases, so this converts a delivery into
// packs: 3 cases × 14 strips per case = 42 strips.
//
// Policy: cases and packs-per-case must both be WHOLE numbers above zero
// (a part-case is recorded with "Adjust packs directly" instead), and a
// single receipt may not exceed MAX_RECEIPT_PACKS — a larger figure is
// almost certainly a typo. Returns null when the inputs are not usable.
export const MAX_RECEIPT_PACKS = 1_000_000;
const MAX_MANUAL_ADJUSTMENT = 1_000_000_000;

export function casesToPacks(cases, unitsPerCase) {
  const c = wholeNumber(cases), u = wholeNumber(unitsPerCase);
  if (c === null || u === null) return null;
  const packs = c * u;
  return (Number.isSafeInteger(packs) && packs <= MAX_RECEIPT_PACKS) ? packs : null;
}

// Every stock change — manual or order-driven — is written to the
// stockMovements collection as an append-only ledger, alongside the
// product's new stockOnHand. Nothing ever updates or deletes a
// stockMovements doc.

function movementRef() { return doc(collection(db, 'stockMovements')); }

// ---- Manual adjustment (receiving stock, corrections, stock counts) ----
export async function adjustStockManually(productId, delta, { reason, uid, email }) {
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) throw new Error('Enter a non-zero adjustment.');
  if (Math.abs(delta) > MAX_MANUAL_ADJUSTMENT) throw new Error('That adjustment is too large — check the number.');
  await runTransaction(db, async (tx) => {
    const productRef = doc(db, 'products', productId);
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) throw new Error('Product no longer exists.');
    const product = productSnap.data();
    const previousStock = product.stockOnHand || 0;
    const newStock = previousStock + delta;

    tx.update(productRef, { stockOnHand: newStock, updatedAt: serverTimestamp() });
    tx.set(movementRef(), {
      productId, productName: product.productName, packLabel: product.packLabel,
      type: 'manual', delta, previousStock, newStock,
      reason: reason || '', orderId: null, orderNo: null,
      createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
    });
  });
}

// ---- Receiving supplier cases: ONE transaction ----
// Adds cases × packs-per-case to stock, writes the ledger entry (the
// conversion is spelled out in its reason) and remembers packs-per-case
// on the product — all together, so a failed receipt can never leave the
// product's packs-per-case changed without the stock having moved.
export async function receiveStockCases(productId, cases, unitsPerCase, { reason, uid, email }) {
  const packs = casesToPacks(cases, unitsPerCase);
  if (packs === null) {
    throw new Error(`Enter whole numbers above 0 for cases received and packs per case (a single receipt can be at most ${MAX_RECEIPT_PACKS.toLocaleString('en-US')} packs).`);
  }
  const c = wholeNumber(cases), u = wholeNumber(unitsPerCase);
  const note = `Received ${c} case(s) × ${u} = ${packs}` + (reason ? ` — ${reason}` : '');
  return await runTransaction(db, async (tx) => {
    const productRef = doc(db, 'products', productId);
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) throw new Error('Product no longer exists.');
    const product = productSnap.data();
    const previousStock = product.stockOnHand || 0;
    const newStock = previousStock + packs;

    const patch = { stockOnHand: newStock, updatedAt: serverTimestamp() };
    if ((product.unitsPerCase ?? null) !== u) patch.unitsPerCase = u; // only written when it actually changes
    tx.update(productRef, patch);
    tx.set(movementRef(), {
      productId, productName: product.productName, packLabel: product.packLabel,
      type: 'manual', delta: packs, previousStock, newStock,
      reason: note, orderId: null, orderNo: null,
      createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
    });
    return { packs, newStock };
  });
}

// ---- Shared helpers for order-driven stock changes ----
// An order can list the same product on several lines. Everything below
// groups lines by productId so each product is read ONCE, checked against
// the COMBINED quantity, updated ONCE, and the ledger shows a running
// balance (previousStock -> newStock) that adds up line by line.
function groupTrackedLines(items) {
  const groups = new Map();
  (items || []).forEach(it => {
    if (!it.productId) return; // free-text / custom lines are not stock-tracked
    if (!groups.has(it.productId)) groups.set(it.productId, []);
    groups.get(it.productId).push({ desc: it.desc, qty: Number(it.qty) || 0 });
  });
  return groups;
}

async function readProducts(tx, productIds) {
  const entries = await Promise.all(productIds.map(async (id) => {
    const ref = doc(db, 'products', id);
    return [id, { ref, snap: await tx.get(ref) }];
  }));
  return new Map(entries);
}

// sign: -1 = stock goes out (approval), +1 = stock comes back (cancel).
function writeLineMovements(tx, products, groups, { sign, type, order, uid, email, reasonFor = () => '' }) {
  for (const [productId, lines] of groups) {
    const entry = products.get(productId);
    if (!entry || !entry.snap.exists()) continue; // product was deleted since the order was placed — skip
    const product = entry.snap.data();
    let running = product.stockOnHand || 0;
    for (const line of lines) {
      if (!line.qty) continue;
      const previousStock = running;
      running = previousStock + sign * line.qty;
      tx.set(movementRef(), {
        productId, productName: product.productName, packLabel: product.packLabel,
        type, delta: sign * line.qty, previousStock, newStock: running,
        reason: reasonFor(running), orderId: order.id, orderNo: order.orderNo || null,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    }
    tx.update(entry.ref, { stockOnHand: running, updatedAt: serverTimestamp() });
  }
}

// ---- Approving a Submitted order: decrement stock + flip status ----
// Runs as a single transaction so an order can never end up Approved
// with only some of its stock decremented, or vice versa.
//
// The items, quantities and order number are taken from the order document
// READ INSIDE the transaction — never from the caller's cached copy. If the
// caller's copy shows different items (the order was edited after the list
// was loaded) the approval is refused so a manager never approves content
// they have not seen. The status check (must currently be 'Submitted')
// makes double-clicks, retries and two people approving at once safe.
//
// allowNegativeStock is a manager-only escape hatch (enforced in the
// UI layer, not here) for approving anyway and reconciling stock later.
export async function approveOrderWithStock(order, { uid, email, allowNegativeStock = false }) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', order.id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    const current = orderSnap.data();
    if (current.status !== 'Submitted') {
      throw new Error('This order is no longer Submitted — someone else may have already processed it.');
    }
    if (Array.isArray(order.items) && orderItemsKey(order.items) !== orderItemsKey(current.items)) {
      throw makeError('This order was changed after you loaded it. Refresh the list and review it before approving.', { code: 'order-changed' });
    }

    // Defense in depth (finding 3): the STORED lines are validated again; a negative or fractional quantity can never move stock.
    assertOrderLines(current.items, current.grandTotal, makeError);
    const groups = groupTrackedLines(current.items);
    // Firestore transactions require all reads before any writes.
    const products = await readProducts(tx, [...groups.keys()]);
    for (const [pid, lines] of groups) {
      if (!products.get(pid).snap.exists()) throw makeError(`A product on this order no longer exists (${[...new Set(lines.map(l => l.desc))].join(', ')}). Edit the order before approving.`, { code: 'unknown-product', productId: pid });
    }

    if (!allowNegativeStock) {
      const shortages = [];
      for (const [productId, lines] of groups) {
        const entry = products.get(productId);
        if (!entry.snap.exists()) continue;
        const available = entry.snap.data().stockOnHand || 0;
        const needed = lines.reduce((sum, l) => sum + l.qty, 0);
        if (needed > available) shortages.push({ desc: [...new Set(lines.map(l => l.desc))].join(' + '), needed, available });
      }
      if (shortages.length > 0) {
        const err = new Error('Insufficient stock for: ' + shortages.map(s => `${s.desc} (need ${s.needed}, have ${s.available})`).join(', '));
        err.isStockShortage = true;
        err.shortages = shortages;
        throw err;
      }
    }

    tx.update(orderRef, {
      status: 'Approved', stockApplied: true,
      approvedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    writeLineMovements(tx, products, groups, {
      sign: -1, type: 'order-approved', order: { id: order.id, orderNo: current.orderNo }, uid, email,
      reasonFor: (newStock) => (allowNegativeStock && newStock < 0 ? 'Manager override — approved despite insufficient stock' : ''),
    });
  });
}

// ---- Cancelling an order (manager): the order is KEPT, stock comes back exactly once ----
// Cancelling does NOT delete anything. The order stays in the system with status "Cancelled", the reason, who cancelled
// it and the SERVER time; an append-only record orderCancellations/{orderId} is written with it; and for an Approved
// order whose stock was deducted, the stock is restored and a stockMovements entry is written per line (the ledger is
// append-only and is never touched).
//
// Exactly once, three ways:
//   1. The transaction reads the order and the cancellation record, and acts only on a Submitted/Approved order with no
//      record. A second click, a retry after a lost acknowledgement, or a second person cancelling at the same moment
//      finds "Cancelled" / the record, changes nothing and gets { alreadyCancelled: true } (the Firestore transaction
//      conflict check re-runs the loser against the winner's result).
//   2. The record's document id IS the order id, so it can exist only once; the security rules refuse a second one.
//   3. The rules refuse any change to a Cancelled order, and refuse "Cancelled" for anything that is not Submitted/Approved.
//
// Not allowed here (by design, enforced by the rules too): Invoicing (an invoice is being created), Invoiced, Dispatched,
// Delivered. Those already carry financial and delivery consequences; they need a returns / credit-note process
// (docs/CANCELLATION-AND-RETURNS.md) that this release does not provide. Rejected orders are final.
export const MIN_CANCEL_REASON = 3;
export const MAX_CANCEL_REASON = 300;
export function validateCancelReason(reason) {
  const r = String(reason ?? '').trim();
  if (r.length < MIN_CANCEL_REASON) return 'Enter the reason for cancelling this order (at least 3 characters).';
  if (r.length > MAX_CANCEL_REASON) return `The reason must be ${MAX_CANCEL_REASON} characters or fewer.`;
  return null;
}

// recoverWithoutRestore (RC5, manager-only recovery for an Approved order whose stored lines RC5 cannot process): cancels the order and records
// stockRestored:false. NO stock movement is written and none is invented. The stock that approval really deducted is in the append-only ledger;
// the manager puts it back with ordinary audited manual adjustments (tools/reconcile.mjs prints the exact amounts). Refused for a valid order,
// so the normal "restore exactly once" path can never be skipped by choice.
export const RECOVERY_REASON_PREFIX = 'RECOVERY (stock not auto-restored): ';
export async function cancelOrder(order, { reason, uid, email, recoverWithoutRestore = false }) {
  const problem = validateCancelReason(reason);
  if (problem) throw new Error(problem);
  if (!uid) throw new Error('Not signed in.');
  const cleanReason = (recoverWithoutRestore ? RECOVERY_REASON_PREFIX : '') + String(reason).trim();
  if (cleanReason.length > MAX_CANCEL_REASON) throw new Error(`The reason is too long (${cleanReason.length} characters; maximum ${MAX_CANCEL_REASON}).`);
  const orderId = order.id;
  return await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', orderId);
    const cancelRef = doc(db, 'orderCancellations', orderId);
    const orderSnap = await tx.get(orderRef);
    const cancelSnap = await tx.get(cancelRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    const current = orderSnap.data();
    if (cancelSnap.exists() || current.status === 'Cancelled') {
      return { alreadyCancelled: true, stockRestored: cancelSnap.exists() ? !!cancelSnap.data().stockRestored : false };
    }
    if (current.status === 'Invoicing') {
      throw makeError('This order is being invoiced right now and cannot be cancelled. Wait for invoicing to finish or be released.', { code: 'cancel-not-allowed', status: current.status });
    }
    if (['Invoiced', 'Dispatched', 'Delivered'].includes(current.status)) {
      throw makeError(`This order is ${current.status}${current.invoiceNo ? ' (invoice ' + current.invoiceNo + ')' : ''} and can no longer be cancelled here. Use the returns / credit process instead; the order, invoice and stock are unchanged.`, { code: 'cancel-not-allowed', status: current.status });
    }
    if (current.status !== 'Submitted' && current.status !== 'Approved') {
      throw makeError(`This order is ${current.status} and cannot be cancelled.`, { code: 'cancel-not-allowed', status: current.status });
    }
    // Stock was deducted only when an order was approved (stockApplied false = it was explicitly released already).
    let restoreStock = current.status === 'Approved' && current.stockApplied !== false;
    if (recoverWithoutRestore) {
      if (!restoreStock) throw makeError('Recovery is only for an Approved order whose stock was deducted.', { code: 'recovery-not-needed' });
      if (validateOrderLines(current.items, current.grandTotal).ok) throw makeError('This order\'s lines are valid, so cancelling it restores its stock normally. Use the normal Cancel.', { code: 'recovery-not-needed' });
      restoreStock = false;                       // no movement is written; the manager corrects stock with audited manual adjustments
    } else if (restoreStock) {
      const v = validateOrderLines(current.items, current.grandTotal);
      if (!v.ok) throw makeError('This order\'s stored lines are not valid, so its stock cannot be restored from them. A manager can use "Cancel WITHOUT restoring stock (recovery)" and then correct stock with audited manual adjustments. Problems: ' + v.problems.join(' '), { code: 'invalid-order-lines', problems: v.problems });
    }
    const groups = restoreStock ? groupTrackedLines(current.items) : new Map();
    const products = await readProducts(tx, [...groups.keys()]);     // reads before writes

    tx.update(orderRef, {
      status: 'Cancelled', stockApplied: false,
      cancelReason: cleanReason, cancelledBy: uid, cancelledByEmail: email, cancelPriorStatus: current.status,
      cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    tx.set(cancelRef, {
      orderId, orderNo: current.orderNo || null, priorStatus: current.status, stockRestored: restoreStock,
      reason: cleanReason, cancelledBy: uid, cancelledByEmail: email, cancelledAt: serverTimestamp(),
    });
    writeLineMovements(tx, products, groups, {
      sign: +1, type: 'order-cancelled',
      order: { id: orderId, orderNo: current.orderNo }, uid, email,
      reasonFor: () => `Order cancelled: ${cleanReason}`,
    });
    return { alreadyCancelled: false, stockRestored: restoreStock, priorStatus: current.status };
  });
}

// ---- Editing a Submitted or Approved order: ONE transaction ----
// Saves the order's new details AND reconciles stock together. The old
// items are read from the order document inside the transaction (never from
// the caller's cached copy), so:
//   - repeating the same save (retry after a dropped connection, double
//     click) finds the stored items already equal to the new ones and does
//     nothing — stock is adjusted at most once;
//   - an edit made on a screen that is out of date is refused
//     (expectedRevision no longer matches) instead of overwriting someone
//     else's change and applying a wrong stock difference;
//   - an order that has meanwhile moved on (Invoicing, Invoiced, ...) is
//     refused.
// Stock is only touched for Approved orders (stock is deducted on approval);
// as before, an edit that increases quantities is not blocked by low stock.
export async function editOrderWithStock(orderId, { expectedRevision = null, details, items }, { uid, email }) {
  const grandTotal = round2((items || []).reduce((sum, it) => sum + (it.total || 0), 0));
  assertOrderLines(items, grandTotal, makeError);
  const next = {
    customerId: details.customerId || null,
    customerName: details.customerName, customerPhone: details.customerPhone, customerLocation: details.customerLocation,
    notes: details.notes || '', items,
  };
  const newRevision = orderRevisionKey(next);

  return await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', orderId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    const current = orderSnap.data();
    if (current.status !== 'Submitted' && current.status !== 'Approved') {
      throw makeError(`This order is now "${current.status}" and can no longer be edited.`, { code: 'order-status-changed' });
    }
    const currentRevision = orderRevisionKey(current);
    if (currentRevision === newRevision) return { unchanged: true }; // already saved (retry) — nothing to do
    if (expectedRevision !== null && currentRevision !== expectedRevision) {
      throw makeError('This order was changed by someone else after you opened it. Close this window, reopen the order and make your edit again.', { code: 'order-changed' });
    }

    if (current.status === 'Approved') assertOrderLines(current.items, current.grandTotal, makeError);   // stock follows the stored lines
    const deltas = new Map(); // productId -> change to stock (negative = more stock consumed)
    if (current.status === 'Approved') {
      const oldBy = new Map(), newBy = new Map();
      for (const [pid, lines] of groupTrackedLines(current.items)) oldBy.set(pid, lines.reduce((s, l) => s + l.qty, 0));
      for (const [pid, lines] of groupTrackedLines(items)) newBy.set(pid, lines.reduce((s, l) => s + l.qty, 0));
      for (const pid of new Set([...oldBy.keys(), ...newBy.keys()])) {
        const diff = (oldBy.get(pid) || 0) - (newBy.get(pid) || 0);
        if (diff !== 0) deltas.set(pid, diff);
      }
    }
    const products = await readProducts(tx, [...deltas.keys()]);

    tx.update(orderRef, { ...next, grandTotal, updatedAt: serverTimestamp() });
    for (const [pid, delta] of deltas) {
      const entry = products.get(pid);
      if (!entry.snap.exists()) continue;
      const product = entry.snap.data();
      const previousStock = product.stockOnHand || 0;
      const newStock = previousStock + delta;
      tx.update(entry.ref, { stockOnHand: newStock, updatedAt: serverTimestamp() });
      tx.set(movementRef(), {
        productId: pid, productName: product.productName, packLabel: product.packLabel,
        type: 'order-edited', delta, previousStock, newStock,
        reason: '', orderId, orderNo: current.orderNo || null,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    }
    return { unchanged: false };
  });
}

// ---- History for a single product (used by a future stock report / drill-down) ----
export async function fetchStockMovementsForProduct(productId, cursor = null) {
  const constraints = [where('productId', '==', productId), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'stockMovements'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

// ---- History across ALL products, newest first — the main stock ledger ----
export async function fetchAllStockMovementsPage(cursor = null) {
  const constraints = [orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'stockMovements'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}
