import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, updateDoc, deleteDoc,
  serverTimestamp, query, orderBy, limit, startAfter
} from 'firebase/firestore';

const PAGE_SIZE = 25;

// Your original hardcoded catalog, now used as one-time seed data instead
// of being baked into the code — so the app behaves exactly like before
// on first run, but everything after that lives in Firestore and is
// manager-editable.
export const DEFAULT_PRODUCTS = [
  { productName: 'Angel Instant Dry Yeast', packLabel: 'Box (25 × 10g Sachets)', quantity: 25, price: 10500 },
  { productName: 'Angel Instant Dry Yeast', packLabel: 'Case (12 Boxes)', quantity: 12, price: 114000 },
  { productName: 'Bakerdream Instant Dry Yeast', packLabel: '1 × 450g Pack', quantity: 1, price: 8000 },
  { productName: 'Bakerdream Instant Dry Yeast', packLabel: 'Case (20 Packs)', quantity: 20, price: 153000 },
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

export async function addProduct({ productName, packLabel, quantity, price, uid }) {
  await addDoc(collection(db, 'products'), {
    productName, packLabel,
    quantity: parseFloat(quantity) || 0,
    price: parseFloat(price) || 0,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateProduct(id, { productName, packLabel, quantity, price }) {
  await updateDoc(doc(db, 'products', id), {
    productName, packLabel,
    quantity: parseFloat(quantity) || 0,
    price: parseFloat(price) || 0,
    updatedAt: serverTimestamp(),
  });
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