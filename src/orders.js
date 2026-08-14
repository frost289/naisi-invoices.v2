import { db } from './firebase.js';
import {
  collection, addDoc, doc, getDoc, updateDoc, getDocs,
  serverTimestamp, query, where, orderBy, limit, startAfter
} from 'firebase/firestore';
import { incrementOrderCounterAtomically } from './orderNumbering.js';

const PAGE_SIZE = 25;

export const ORDER_STATUSES = ['Draft', 'Submitted', 'Approved', 'Invoiced', 'Dispatched', 'Rejected', 'Cancelled'];

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
// its terminal "Invoiced" state.
export async function markOrderInvoiced(id, { invoiceId, invoiceNo }) {
  await updateDoc(doc(db, 'orders', id), {
    status: 'Invoiced', invoiceId, invoiceNo,
    invoicedAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
}