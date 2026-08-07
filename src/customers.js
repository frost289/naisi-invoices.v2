import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, updateDoc,
  serverTimestamp, query, orderBy, limit, startAfter
} from 'firebase/firestore';

const PAGE_SIZE = 25;

// Full fetch — kept for the invoice form's autocomplete, which needs to
// substring-match against every customer, not just one loaded page.
export async function fetchAllCustomers() {
  const q = query(collection(db, 'customers'), orderBy('name'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Paginated fetch — used by the "Manage Customers" list view.
export async function fetchCustomersPage(cursor = null) {
  const constraints = [orderBy('name'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'customers'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function addCustomer({ name, phone, location, uid }) {
  const docRef = await addDoc(collection(db, 'customers'), {
    name, phone, location, createdBy: uid,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateCustomer(id, { name, phone, location }) {
  await updateDoc(doc(db, 'customers', id), { name, phone, location, updatedAt: serverTimestamp() });
}

export function findExactNameMatch(customers, name) {
  const target = name.trim().toLowerCase();
  return customers.find(c => (c.name || '').trim().toLowerCase() === target) || null;
}