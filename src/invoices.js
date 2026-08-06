import { db } from './firebase.js';
import {
  collection, query, where, orderBy, getDocs,
  doc, getDoc, updateDoc
} from 'firebase/firestore';

export async function fetchMyInvoices(uid) {
  const q = query(
    collection(db, 'invoices'),
    where('createdBy', '==', uid),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchAllInvoices() {
  const q = query(collection(db, 'invoices'), orderBy('createdAt', 'desc'));
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