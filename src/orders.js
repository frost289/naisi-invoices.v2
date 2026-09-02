import { db } from './firebase.js';
import {
  collection, addDoc, doc, getDoc, updateDoc, deleteDoc, getDocs,
  serverTimestamp, query, where, orderBy, limit, startAfter, runTransaction
} from 'firebase/firestore';
import { incrementOrderCounterAtomically } from './orderNumbering.js';

const PAGE_SIZE = 25;

export const ORDER_STATUSES = ['Draft', 'Submitted', 'Approved', 'Invoicing', 'Invoiced', 'Dispatched', 'Rejected', 'Cancelled'];

export async function submitOrder({ customerId, customerName, customerPhone, customerLocation, items, notes, uid, email }) {
  const { usedNo } = await incrementOrderCounterAtomically();
  const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
  const docRef = await addDoc(collection(db, 'orders'), {
    orderNo: usedNo,
    status: 'Submitted',
    customerId, customerName, customerPhone, customerLocation,
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

export async function updateOrderDetails(id, { customerId, customerName, customerPhone, customerLocation, items, notes }) {
  const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
  await updateDoc(doc(db, 'orders', id), {
    customerId, customerName, customerPhone, customerLocation,
    items, notes: notes || '', grandTotal,
    updatedAt: serverTimestamp(),
  });
}

export async function setOrderStatus(id, status, managerNotes = '') {
  const patch = { status, updatedAt: serverTimestamp() };
  if (status === 'Approved') patch.approvedAt = serverTimestamp();
  if (status === 'Rejected') { patch.rejectedAt = serverTimestamp(); patch.managerNotes = managerNotes; }
  if (status === 'Cancelled') patch.cancelledAt = serverTimestamp();
  await updateDoc(doc(db, 'orders', id), patch);
}

// Called when a manager finishes generating a printable invoice from
// an approved order — links the two records and moves the order to
// its terminal "Invoiced" state. Only proceeds from 'Invoicing' (the
// lock set by beginInvoiceGeneration below), so this can't accidentally
// finalize an order that was never actually locked for invoicing.
export async function markOrderInvoiced(id, { invoiceId, invoiceNo }) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    if (orderSnap.data().status !== 'Invoicing') {
      throw new Error('This order is not currently being invoiced — its status changed unexpectedly.');
    }
    tx.update(orderRef, {
      status: 'Invoiced', invoiceId, invoiceNo,
      invoicedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
}

// ---- Duplicate-invoice prevention ----
// An order can only ever be locked into 'Invoicing' from 'Approved'.
// If a manager double-clicks Download PDF, has two tabs open on the
// same order, or a page reload retries the click, every attempt after
// the first sees status !== 'Approved' here and is rejected — the
// Firestore transaction guarantees this holds even across devices,
// the same way approveOrderWithStock's status check does for stock.
export async function beginInvoiceGeneration(id) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) throw new Error('Order no longer exists.');
    const status = orderSnap.data().status;
    if (status === 'Invoiced') {
      const err = new Error('This order has already been invoiced.');
      err.alreadyInvoiced = true;
      err.invoiceNo = orderSnap.data().invoiceNo;
      throw err;
    }
    if (status !== 'Approved') {
      throw new Error(`This order is currently "${status}", not Approved — someone else may already be invoicing it.`);
    }
    tx.update(orderRef, { status: 'Invoicing', updatedAt: serverTimestamp() });
  });
}

// Recovery path: if PDF generation or the invoice write fails AFTER
// the lock above succeeded, this puts the order back to 'Approved' so
// it isn't stuck in 'Invoicing' forever with no way to retry.
export async function revertInvoiceGeneration(id) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) return;
    if (orderSnap.data().status !== 'Invoicing') return; // already resolved some other way — leave it alone
    tx.update(orderRef, { status: 'Approved', updatedAt: serverTimestamp() });
  });
}