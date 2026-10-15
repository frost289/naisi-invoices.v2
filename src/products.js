import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy, limit, startAfter, onSnapshot
} from 'firebase/firestore';

import { wholeNumber } from './numbers.js';

const PAGE_SIZE = 25;

// Your original hardcoded catalog, now used as one-time seed data instead
// of being baked into the code — so the app behaves exactly like before
// on first run, but everything after that lives in Firestore and is
// manager-editable. stockOnHand starts at 0 for seeded products — a
// manager sets real starting stock via the Adjust Stock screen.
export const DEFAULT_PRODUCTS = [
  { productName: 'Angel Instant Dry Yeast', packLabel: 'Box (25 × 10g Sachets)', quantity: 25, price: 10500, stockOnHand: 0 },
  { productName: 'Angel Instant Dry Yeast', packLabel: 'Case (12 Boxes)', quantity: 12, price: 114000, stockOnHand: 0 },
  { productName: 'Bakerdream Instant Dry Yeast', packLabel: '1 × 450g Pack', quantity: 1, price: 8000, stockOnHand: 0 },
  { productName: 'Bakerdream Instant Dry Yeast', packLabel: 'Case (20 Packs)', quantity: 20, price: 153000, stockOnHand: 0 },
];

export async function fetchAllProducts() {
  const q = query(collection(db, 'products'), orderBy('productName'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchProductsPage(cursor = null) {
  const constraints = [orderBy('productName'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'products'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

// Live sync for stock levels: fires immediately on this device after any
// local write, and within moments on every OTHER connected device too —
// a manager adjusting stock on their phone shows up on a rep's quick-add
// grid without either of them refreshing. Returns an unsubscribe function.
export function watchAllProducts(onChange) {
  const q = query(collection(db, 'products'), orderBy('productName'));
  return onSnapshot(q, (snap) => {
    onChange(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

// stockOnHand here is only ever the STARTING stock for a brand-new
// product — there's no "previous" figure to log against, so this
// writes it directly rather than going through the stock ledger.
// Every change after creation must go through adjustStockManually()
// or an order approval/cancellation so it stays logged.
// unitsPerCase: how many of THIS pack arrive in one supplier case
// (e.g. 1 case of Amanda 100g = 14 strips). Optional. Validated here, where
// it is written, not only in the HTML form: blank/undefined/null means
// "not set"; anything else must be a whole number above 0.
export function normaliseUnitsPerCase(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const n = wholeNumber(value);
  if (n === null) throw new Error('Packs per case must be a whole number above 0 (or left blank).');
  return n;
}

// stockOnHand here is only ever the STARTING stock for a brand-new
// product — there's no "previous" figure to log against, so this
// writes it directly rather than going through the stock ledger.
// Every change after creation must go through adjustStockManually(),
// receiveStockCases() or an order approval/cancellation so it stays logged.
export async function addProduct({ productName, packLabel, quantity, price, stockOnHand, unitsPerCase = null, uid }) {
  const perCase = normaliseUnitsPerCase(unitsPerCase);
  await addDoc(collection(db, 'products'), {
    productName, packLabel,
    quantity: parseFloat(quantity) || 0,
    // The field is only written when it is actually set, so the app keeps
    // working against Firestore rules that do not yet know about it.
    ...(perCase !== null ? { unitsPerCase: perCase } : {}),
    price: parseFloat(price) || 0,
    stockOnHand: parseFloat(stockOnHand) || 0,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

// Deliberately does NOT touch stockOnHand — catalog edits (rename,
// re-pack, reprice) should never silently change stock. Use
// adjustStockManually() for that, so it's always logged.
// unitsPerCase: undefined = leave as is; null/'' = clear; number = set.
export async function updateProduct(id, { productName, packLabel, quantity, price, unitsPerCase }) {
  const patch = {
    productName, packLabel,
    quantity: parseFloat(quantity) || 0,
    price: parseFloat(price) || 0,
    updatedAt: serverTimestamp(),
  };
  if (unitsPerCase !== undefined) patch.unitsPerCase = normaliseUnitsPerCase(unitsPerCase);
  await updateDoc(doc(db, 'products', id), patch);
}

export async function deleteProduct(id) {
  await deleteDoc(doc(db, 'products', id));
}

// Only runs once: if the catalog is completely empty, populate it with
// the original price-list products so the app works immediately without
// a manager having to retype everything.
export async function seedDefaultProductsIfEmpty(uid) {
  const existing = await fetchAllProducts();
  if (existing.length > 0) return false;
  for (const p of DEFAULT_PRODUCTS) {
    await addProduct({ ...p, uid });
  }
  return true;
}
