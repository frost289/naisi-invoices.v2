import { db } from './firebase.js';
import { requireExpenseAmount } from './money.js';
import {
  collection, addDoc, doc, updateDoc, deleteDoc, getDocs, query, orderBy, limit, startAfter
} from 'firebase/firestore';

const PAGE_SIZE = 25;

// A stock purchase record (manager only):
// - supplier: vendor/supplier name
// - invoiceReference: invoice/reference number
// - purchaseDate: date item was purchased (separate from when logged)
// - invoiceTotal: total amount on the invoice
// - amountPaid: amount cash paid so far
// - balanceDue: amount still owed (invoiceTotal - amountPaid)
// - dueDate: when payment is due
// - paymentStatus: 'unpaid', 'part-paid', 'paid'
// - notes: optional notes about the purchase

export async function fetchStockPurchasesPage(cursor = null) {
  const constraints = [orderBy('purchaseDate', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'stockPurchases'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

export async function addStockPurchase({
  supplier, invoiceReference, purchaseDate, invoiceTotal, amountPaid,
  balanceDue, dueDate, paymentStatus, notes, uid, email
}) {
  const balance = invoiceTotal - amountPaid;
  const status = amountPaid === 0 ? 'unpaid' : (amountPaid >= invoiceTotal ? 'paid' : 'part-paid');

  await addDoc(collection(db, 'stockPurchases'), {
    supplier: supplier || '',
    invoiceReference: invoiceReference || '',
    purchaseDate,
    invoiceTotal: requireExpenseAmount(invoiceTotal),
    amountPaid: requireExpenseAmount(amountPaid || 0),
    balanceDue: requireExpenseAmount(balance),
    dueDate: dueDate || null,
    paymentStatus: paymentStatus || status,
    notes: notes || '',
    createdBy: uid,
    createdByEmail: email,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

export async function updateStockPurchase(id, {
  supplier, invoiceReference, purchaseDate, invoiceTotal, amountPaid,
  balanceDue, dueDate, paymentStatus, notes
}) {
  const balance = balanceDue !== undefined ? balanceDue : (invoiceTotal - amountPaid);
  const status = paymentStatus || (amountPaid === 0 ? 'unpaid' : (amountPaid >= invoiceTotal ? 'paid' : 'part-paid'));

  await updateDoc(doc(db, 'stockPurchases', id), {
    supplier: supplier || '',
    invoiceReference: invoiceReference || '',
    purchaseDate,
    invoiceTotal: requireExpenseAmount(invoiceTotal),
    amountPaid: requireExpenseAmount(amountPaid),
    balanceDue: requireExpenseAmount(balance),
    dueDate: dueDate || null,
    paymentStatus: status,
    notes: notes || '',
    updatedAt: new Date(),
  });
}

export async function deleteStockPurchase(id) {
  await deleteDoc(doc(db, 'stockPurchases', id));
}

export function validateStockPurchase(data) {
  const errors = [];
  if (!data.supplier || data.supplier.trim() === '') errors.push('Supplier name is required');
  if (data.invoiceTotal <= 0) errors.push('Invoice total must be greater than 0');
  if (data.amountPaid < 0) errors.push('Amount paid cannot be negative');
  if (data.amountPaid > data.invoiceTotal) errors.push('Amount paid cannot exceed invoice total');
  if (!data.purchaseDate) errors.push('Purchase date is required');
  return errors;
}
