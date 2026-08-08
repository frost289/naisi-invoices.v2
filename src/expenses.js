import { db } from './firebase.js';
import {
  collection, addDoc, doc, updateDoc, deleteDoc,
  serverTimestamp, query, where, orderBy, limit, startAfter, getDocs
} from 'firebase/firestore';

const PAGE_SIZE = 25;

export async function fetchAllExpensesPage(cursor = null) {
  const constraints = [orderBy('date', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'expenses'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function fetchMyExpensesPage(uid, cursor = null) {
  const constraints = [
    where('createdBy', '==', uid),
    orderBy('date', 'desc'),
    limit(PAGE_SIZE),
  ];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'expenses'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function addExpense({ date, category, amount, notes, uid, email }) {
  await addDoc(collection(db, 'expenses'), {
    date, category,
    amount: parseFloat(amount) || 0,
    notes: notes || '',
    createdBy: uid,
    createdByEmail: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateExpense(id, { date, category, amount, notes }) {
  await updateDoc(doc(db, 'expenses', id), {
    date, category,
    amount: parseFloat(amount) || 0,
    notes: notes || '',
    updatedAt: serverTimestamp(),
  });
}

export async function deleteExpense(id) {
  await deleteDoc(doc(db, 'expenses', id));
}