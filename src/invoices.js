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

// RC6.5: an issued invoice keeps its customer (the rules refuse a change of customerId outside a merge). Checked here first so
// the manager gets a clear message instead of a permission error. Contact details (name, phone, location) can still be edited.
export async function updateInvoice(id, data) {
  const ref = doc(db, 'invoices', id);
  if (data && 'customerId' in data) {
    const snap = await getDoc(ref);
    const current = snap.exists() ? (snap.data().customerId ?? null) : null;
    const requested = data.customerId ?? null;
    if (requested === null && current !== null) {
      // Retyping the customer name on the edit screen clears the picker's id. That is a contact-detail edit, not a move:
      // keep the invoice linked to its customer.
      data = { ...data, customerId: current };
    } else if (requested !== current) {
      const err = new Error('An issued invoice cannot be moved to a different customer. Nothing was saved. Keep the original customer, or issue a new invoice for the correct customer.');
      err.code = 'invoice-customer-locked';
      throw err;
    }
  }
  await updateDoc(ref, data);
}