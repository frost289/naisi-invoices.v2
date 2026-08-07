import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, updateDoc,
  serverTimestamp, query, orderBy
} from 'firebase/firestore';

export async function fetchAllCustomers() {
  const q = query(collection(db, 'customers'), orderBy('name'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addCustomer({ name, phone, location, uid }) {
  const docRef = await addDoc(collection(db, 'customers'), {
    name, phone, location,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateCustomer(id, { name, phone, location }) {
  await updateDoc(doc(db, 'customers', id), {
    name, phone, location, updatedAt: serverTimestamp(),
  });
}

// Case-insensitive exact match, used for the duplicate-name warning.
export function findExactNameMatch(customers, name) {
  const target = name.trim().toLowerCase();
  return customers.find(c => (c.name || '').trim().toLowerCase() === target) || null;
}