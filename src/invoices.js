import { db } from './firebase.js';
import {
  collection, query, where, orderBy, limit, startAfter, getDocs,
  doc, getDoc, updateDoc
} from 'firebase/firestore';

const PAGE_SIZE = 25;

// ---- Paginated fetchers, used by the list views ----

export async function fetchMyInvoicesPage(uid, cursor = null) {
  const constraints = [where('createdBy', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'invoices'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function fetchAllInvoicesPage(cursor = null) {
  const constraints = [orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'invoices'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function fetchInvoicesByDateRangePage(fromDate, toDate, cursor = null) {
  const constraints = [
    where('date', '>=', fromDate), where('date', '<=', toDate),
    orderBy('date', 'desc'), limit(PAGE_SIZE),
  ];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'invoices'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

// ---- Full (non-paginated) fetch, used ONLY for the Excel export ----
// Export needs every matching invoice in the range, not just one page,
// so it deliberately bypasses pagination.
export async function fetchInvoicesByDateRange(fromDate, toDate) {
  const q = query(
    collection(db, 'invoices'),
    where('date', '>=', fromDate), where('date', '<=', toDate),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchInvoiceById(id) {
  const snap = await getDoc(doc(db, 'invoices', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function updateInvoice(id, data) {
  await updateDoc(doc(db, 'invoices', id), data);
}