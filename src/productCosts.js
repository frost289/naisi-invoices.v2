// Phase 1, Stage 1 — Product cost prices (manager-only)
//
// Tracks the buy-in / landed cost per product so that margin can be calculated
// on sales reports (Stage 4). One document per price-change event; history is
// preserved by adding a new document rather than overwriting.
//
// Document ID strategy: <slugified-product-name>_<YYYYMMDD>_<uid-prefix>
// (deterministic enough that a same-day re-entry for the same product is idempotent,
// but a date change always creates a new record.)
//
// Firestore collection: productCosts/{id}
// Fields:
//   productName    string   display name matching products collection
//   costPrice      number   MWK per selling unit (case or single item — must match invoicing unit)
//   effectiveFrom  string   YYYY-MM-DD (the date this price is active from)
//   updatedBy      string   uid of the manager who entered it
//   updatedAt      Timestamp

import { db } from './firebase.js';
import {
  collection, doc, setDoc, getDocs,
  query, where, orderBy, serverTimestamp,
} from 'firebase/firestore';

const COL = 'productCosts';

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function makeDocId(productName, effectiveFrom, uid) {
  return `${slugify(productName)}_${effectiveFrom.replace(/-/g, '')}_${uid.slice(0, 6)}`;
}

// Fetch all cost records for a product, newest first.
export async function fetchProductCostHistory(productName) {
  // Filter only; sorted here (a filter + orderBy on another field would need a composite index).
  const snap = await getDocs(query(collection(db, COL), where('productName', '==', productName)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
}

// Fetch the most recent cost entry for every product (for the manager overview).
export async function fetchLatestProductCosts() {
  const snap = await getDocs(
    query(collection(db, COL), orderBy('effectiveFrom', 'desc'))
  );
  // Deduplicate: keep only the first (newest) record per product name
  const seen = new Set();
  const result = [];
  for (const d of snap.docs) {
    const name = d.data().productName;
    if (!seen.has(name)) {
      seen.add(name);
      result.push({ id: d.id, ...d.data() });
    }
  }
  return result;
}

// Add a cost price record. Uses setDoc with the deterministic id so a same-day
// re-save for the same product is idempotent (no duplicates for the same date).
export async function setProductCost({ productName, costPrice, effectiveFrom, uid }) {
  const id = makeDocId(productName, effectiveFrom, uid);
  const data = {
    productName: productName.trim(),
    costPrice: Number(costPrice),
    effectiveFrom,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(db, COL, id), data);
}
