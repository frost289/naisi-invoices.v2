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

// RC6.4: a sales rep's list holds ONLY his own Transport / Meals / Other + Internet / Packaging / Supplies expenses.
// The category filter is part of the query because the rules refuse a rep any read of Fuel, Maintenance, Bank or
// legacy Stock records (even his own older ones), so an unfiltered query would be denied.
// Needs the composite index createdBy ASC, category ASC, date DESC (firestore.indexes.json).
export const REP_EXPENSE_CATEGORIES = ['Transport', 'Meals', 'Other', 'Internet', 'Packaging', 'Supplies'];
export const DELIVERER_EXPENSE_CATEGORIES = ['Transport', 'Meals', 'Fuel', 'Other', 'Internet', 'Maintenance', 'Packaging', 'Supplies', 'Bank'];

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

// RC6.4: expenses now include optional structured fields for better expense tracking:
// - date: when the expense occurred
// - category: type of expense
// - amount: expense amount
// - payee: who/where the payment was made to
// - paidBy: who made the payment (distinct from logged user)
// - paymentMethod: how it was paid (cash, mobile, bank transfer, etc.)
// - receiptReference: receipt/reference number or ID for tracking
// - businessPurpose: optional notes about the business reason
// - vehicleId: for fuel/maintenance, which vehicle
// - litres: for fuel, how many litres
// - route: for transport, which route
// - notes: general notes or observations
export async function addExpense({
  date, category, amount, payee, paidBy, paymentMethod, receiptReference,
  businessPurpose, vehicleId, litres, route, notes, uid, email
}) {
  const expenseData = {
    date, category,
    amount: requireExpenseAmount(amount),
    payee: payee || '',
    paidBy: paidBy || uid,
    paymentMethod: paymentMethod || 'cash',
    receiptReference: receiptReference || '',
    businessPurpose: businessPurpose || '',
    notes: notes || '',
    createdBy: uid,
    createdByEmail: email,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  // Optional category-specific fields
  if (vehicleId) expenseData.vehicleId = vehicleId;
  if (litres && litres > 0) expenseData.litres = litres;
  if (route) expenseData.route = route;

  await addDoc(collection(db, 'expenses'), expenseData);
}

export async function updateExpense(id, {
  date, category, amount, payee, paidBy, paymentMethod, receiptReference,
  businessPurpose, vehicleId, litres, route, notes
}) {
  const updateData = {
    date, category,
    amount: requireExpenseAmount(amount),
    payee: payee || '',
    paidBy: paidBy || '',
    paymentMethod: paymentMethod || 'cash',
    receiptReference: receiptReference || '',
    businessPurpose: businessPurpose || '',
    notes: notes || '',
    updatedAt: serverTimestamp(),
  };

  // Remove empty optional fields to keep records clean
  if (vehicleId) updateData.vehicleId = vehicleId;
  if (litres && litres > 0) updateData.litres = litres;
  if (route) updateData.route = route;

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

// Get summary statistics for a set of expenses
export function expenseSummary(expenses) {
  if (!Array.isArray(expenses) || expenses.length === 0) {
    return {
      totalAmount: 0,
      byCategory: {},
      byPaymentMethod: {},
      missingReceipts: 0,
      recordCount: 0
    };
  }

  const byCategory = {};
  const byPaymentMethod = {};
  let totalAmount = 0;
  let missingReceipts = 0;

  expenses.forEach(exp => {
    totalAmount += exp.amount || 0;

    // By category
    if (!byCategory[exp.category]) byCategory[exp.category] = 0;
    byCategory[exp.category] += exp.amount || 0;

    // By payment method
    const method = exp.paymentMethod || 'cash';
    if (!byPaymentMethod[method]) byPaymentMethod[method] = 0;
    byPaymentMethod[method] += exp.amount || 0;

    // Missing receipts
    if (!exp.receiptReference) missingReceipts++;
  });

  return {
    totalAmount,
    byCategory,
    byPaymentMethod,
    missingReceipts,
    recordCount: expenses.length
  };
}