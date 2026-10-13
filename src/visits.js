import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, serverTimestamp,
  query, where, orderBy, limit, startAfter
} from 'firebase/firestore';

const PAGE_SIZE = 25;

export const NO_ORDER_REASONS = ['Not interested', 'Stock issue', 'Price too high', 'Customer unavailable', 'Other'];

export async function submitVisit({ customerId, customerName, outcome, reasonNoOrder, reasonNotes, orderId, orderNo, uid, email }) {
  const docRef = await addDoc(collection(db, 'visits'), {
    customerId, customerName,
    repId: uid, repEmail: email,
    date: new Date().toISOString().slice(0, 10),
    outcome,
    reasonNoOrder: outcome === 'No Order' ? (reasonNoOrder || null) : null,
    reasonNotes: reasonNotes || '',
    orderId: orderId || null,
    orderNo: orderNo || null,
    createdAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function fetchMyVisitsPage(uid, cursor = null) {
  const constraints = [where('repId', '==', uid), orderBy('createdAt', 'desc'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'visits'), ...constraints));
  return { items: snap.docs.map(d => ({ id: d.id, ...d.data() })), lastDoc: snap.docs.at(-1) || null, hasMore: snap.docs.length === PAGE_SIZE };
}

// Fetches ALL visits (no page cap) — used for the manager's success-rate
// aggregation. Fine for a small-to-medium sales team; if the collection
// grows large, switch this to date-range queries instead.
export async function fetchAllVisitsForAggregation() {
  const snap = await getDocs(query(collection(db, 'visits'), orderBy('createdAt', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export function aggregateVisitsByRep(visits) {
  const map = {};
  for (const v of visits) {
    const key = v.repEmail || v.repId;
    if (!map[key]) map[key] = { repEmail: v.repEmail, total: 0, ordersPlaced: 0 };
    map[key].total += 1;
    if (v.outcome === 'Order Placed') map[key].ordersPlaced += 1;
  }
  return Object.values(map)
    .map(r => ({ ...r, successRate: r.total ? Math.round((r.ordersPlaced / r.total) * 100) : 0 }))
    .sort((a, b) => b.successRate - a.successRate);
}