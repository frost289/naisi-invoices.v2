import { db } from './firebase.js';
import {
  doc, runTransaction, collection, serverTimestamp,
  query, where, orderBy, limit, startAfter, getDocs
} from 'firebase/firestore';

const PAGE_SIZE = 25;

// Every stock change — manual or order-driven — is written to this
// collection as an append-only ledger, alongside the product's new
// stockOnHand. Nothing ever updates or deletes a stockMovements doc.

// ---- Manual adjustment (receiving stock, corrections, stock counts) ----
export async function adjustStockManually(productId, delta, { reason, uid, email }) {
  if (!delta) throw new Error('Enter a non-zero adjustment.');
  await runTransaction(db, async (tx) => {
    const productRef = doc(db, 'products', productId);
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists()) throw new Error('Product no longer exists.');
    const product = productSnap.data();
    const previousStock = product.stockOnHand || 0;
    const newStock = previousStock + delta;

    tx.update(productRef, { stockOnHand: newStock, updatedAt: serverTimestamp() });

    const movementRef = doc(collection(db, 'stockMovements'));
    tx.set(movementRef, {
      productId, productName: product.productName, packLabel: product.packLabel,
      type: 'manual', delta, previousStock, newStock,
      reason: reason || '', orderId: null, orderNo: null,
      createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
    });
  });
}

// ---- Approving a Submitted order: decrement stock + flip status ----
// Runs as a single transaction so an order can never end up Approved
// with only some of its stock decremented, or vice versa. Only items
// with a productId (added via quick-add, tied to a real catalog
// product) are tracked — free-text/custom line items are skipped.
export async function approveOrderWithStock(order, { uid, email }) {
  const trackedItems = (order.items || []).filter(it => it.productId);

  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', order.id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    if (orderSnap.data().status !== 'Submitted') {
      throw new Error('This order is no longer Submitted — someone else may have already processed it.');
    }

    // Firestore transactions require all reads before any writes.
    const productRefs = trackedItems.map(it => doc(db, 'products', it.productId));
    const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));

    tx.update(orderRef, {
      status: 'Approved', stockApplied: true,
      approvedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });

    trackedItems.forEach((it, i) => {
      const snap = productSnaps[i];
      if (!snap.exists()) return; // product was deleted since the order was placed — skip
      const product = snap.data();
      const previousStock = product.stockOnHand || 0;
      const newStock = previousStock - it.qty; // allowed to go negative — soft warning happens in the UI before this is called

      tx.update(productRefs[i], { stockOnHand: newStock, updatedAt: serverTimestamp() });

      const movementRef = doc(collection(db, 'stockMovements'));
      tx.set(movementRef, {
        productId: it.productId, productName: product.productName, packLabel: product.packLabel,
        type: 'order-approved', delta: -it.qty, previousStock, newStock,
        reason: '', orderId: order.id, orderNo: order.orderNo,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    });
  });
}

// ---- Cancelling an Approved order: restore stock, then hard-delete it ----
// Orders are permanently deleted on cancel (not soft-cancelled), so this
// still restores stock and still writes a stockMovements entry — the
// ledger is append-only and doesn't require the order doc to keep
// existing, so the audit trail survives even though the order itself
// is gone. Skipping this step would leave stockOnHand permanently
// understated every time an approved order is cancelled.
export async function cancelApprovedOrderAndDelete(order, { uid, email }) {
  const trackedItems = (order.items || []).filter(it => it.productId);

  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', order.id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    if (orderSnap.data().status !== 'Approved') {
      throw new Error('This order is no longer Approved — someone else may have already processed it.');
    }

    const productRefs = trackedItems.map(it => doc(db, 'products', it.productId));
    const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));

    tx.delete(orderRef);

    trackedItems.forEach((it, i) => {
      const snap = productSnaps[i];
      if (!snap.exists()) return;
      const product = snap.data();
      const previousStock = product.stockOnHand || 0;
      const newStock = previousStock + it.qty;

      tx.update(productRefs[i], { stockOnHand: newStock, updatedAt: serverTimestamp() });

      const movementRef = doc(collection(db, 'stockMovements'));
      tx.set(movementRef, {
        productId: it.productId, productName: product.productName, packLabel: product.packLabel,
        type: 'order-cancelled-deleted', delta: it.qty, previousStock, newStock,
        reason: '', orderId: order.id, orderNo: order.orderNo,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    });
  });
}

// ---- Cancelling an Approved order: restore stock + flip status ----
// Currently unused (cancel hard-deletes the order — see
// cancelApprovedOrderAndDelete above) but kept in case that decision
// changes later, since soft-cancel is the safer default for audit
// trails and this is already written and tested against that model.
export async function cancelApprovedOrderWithStock(order, { uid, email }) {
  const trackedItems = (order.items || []).filter(it => it.productId);

  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', order.id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    if (orderSnap.data().status !== 'Approved') {
      throw new Error('This order is no longer Approved — someone else may have already processed it.');
    }

    const productRefs = trackedItems.map(it => doc(db, 'products', it.productId));
    const productSnaps = await Promise.all(productRefs.map(ref => tx.get(ref)));

    tx.update(orderRef, {
      status: 'Cancelled', stockApplied: false,
      cancelledAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });

    trackedItems.forEach((it, i) => {
      const snap = productSnaps[i];
      if (!snap.exists()) return;
      const product = snap.data();
      const previousStock = product.stockOnHand || 0;
      const newStock = previousStock + it.qty;

      tx.update(productRefs[i], { stockOnHand: newStock, updatedAt: serverTimestamp() });

      const movementRef = doc(collection(db, 'stockMovements'));
      tx.set(movementRef, {
        productId: it.productId, productName: product.productName, packLabel: product.packLabel,
        type: 'order-cancelled', delta: it.qty, previousStock, newStock,
        reason: '', orderId: order.id, orderNo: order.orderNo,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    });
  });
}

// ---- Editing an already-Approved order's items ----
// Stock was already decremented once when it was approved. This
// re-applies just the difference between old and new quantities per
// product, instead of double-counting or leaving stock to drift.
export async function reapplyStockForOrderEdit(order, newItems, { uid, email }) {
  const oldByProduct = {};
  (order.items || []).forEach(it => {
    if (it.productId) oldByProduct[it.productId] = (oldByProduct[it.productId] || 0) + it.qty;
  });
  const newByProduct = {};
  (newItems || []).forEach(it => {
    if (it.productId) newByProduct[it.productId] = (newByProduct[it.productId] || 0) + it.qty;
  });

  const productIds = new Set([...Object.keys(oldByProduct), ...Object.keys(newByProduct)]);
  const deltas = {};
  productIds.forEach(pid => {
    const diff = (oldByProduct[pid] || 0) - (newByProduct[pid] || 0); // qty increased -> negative delta (more stock consumed)
    if (diff !== 0) deltas[pid] = diff;
  });

  const ids = Object.keys(deltas);
  if (ids.length === 0) return;

  await runTransaction(db, async (tx) => {
    const refs = ids.map(pid => doc(db, 'products', pid));
    const snaps = await Promise.all(refs.map(ref => tx.get(ref)));

    refs.forEach((ref, i) => {
      const snap = snaps[i];
      if (!snap.exists()) return;
      const product = snap.data();
      const previousStock = product.stockOnHand || 0;
      const delta = deltas[ids[i]];
      const newStock = previousStock + delta;

      tx.update(ref, { stockOnHand: newStock, updatedAt: serverTimestamp() });

      const movementRef = doc(collection(db, 'stockMovements'));
      tx.set(movementRef, {
        productId: ids[i], productName: product.productName, packLabel: product.packLabel,
        type: 'order-edited', delta, previousStock, newStock,
        reason: '', orderId: order.id, orderNo: order.orderNo,
        createdBy: uid, createdByEmail: email, createdAt: serverTimestamp(),
      });
    });
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
