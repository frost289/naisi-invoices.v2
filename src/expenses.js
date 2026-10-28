import { db } from './firebase.js';
import { requireExpenseAmount } from './money.js';
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

// RC6.4: a sales rep's list holds ONLY his own Transport / Meals / Other expenses.
// The category filter is part of the query because the rules refuse a rep any read of Fuel or
// legacy Stock records (even his own older ones), so an unfiltered query would be denied.
// Needs the composite index createdBy ASC, category ASC, date DESC (firestore.indexes.json).
export const REP_EXPENSE_CATEGORIES = ['Transport', 'Meals', 'Other'];
export const DELIVERER_EXPENSE_CATEGORIES = ['Transport', 'Meals', 'Fuel', 'Other'];

export async function fetchMyExpensesPage(uid, cursor = null, { categories = REP_EXPENSE_CATEGORIES } = {}) {
  const constraints = [
    where('createdBy', '==', uid),
    ...(categories ? [where('category', 'in', categories)] : []),
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

// RC6.4: expenses with core fields for expense tracking.
export async function addExpense({ date, category, amount, notes, uid, email }) {
  const expenseData = {
    date, category,
    amount: requireExpenseAmount(amount),
    notes: notes || '',
    createdBy: uid,
    createdByEmail: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await addDoc(collection(db, 'expenses'), expenseData);
}

export async function updateExpense(id, { date, category, amount, notes }) {
  const updateData = {
    date, category,
    amount: requireExpenseAmount(amount),
    notes: notes || '',
    updatedAt: serverTimestamp(),
  };
  await updateDoc(doc(db, 'expenses', id), updateData);
}

export async function deleteExpense(id) {
  await deleteDoc(doc(db, 'expenses', id));
}

// Calculate expense totals by category
export function expensesTotalByCategory(expenses) {
  const byCategory = {};
  if (Array.isArray(expenses)) {
    expenses.forEach(exp => {
      if (!byCategory[exp.category]) byCategory[exp.category] = 0;
      byCategory[exp.category] += exp.amount || 0;
    });
  }
  return byCategory;
}
