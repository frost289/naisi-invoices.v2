import { db } from './firebase.js';
import {
  collection, doc, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp, Timestamp
} from 'firebase/firestore';

// ---- Failed-delivery reasons (big, icon-led buttons for the delivery person) ----
export const FAIL_REASONS = [
  { code: 'shop_closed',        icon: '🔒', label: 'Shop closed' },
  { code: 'not_available',      icon: '🙋', label: 'Customer not available' },
  { code: 'refused',            icon: '✋', label: 'Customer refused' },
  { code: 'no_money',           icon: '💵', label: 'Customer had no money' },
  { code: 'location_not_found', icon: '📍', label: "Couldn't find the location" },
  { code: 'other',              icon: '📝', label: 'Other (write reason)' },
];

// An order stays "Invoiced" after a failed attempt so it remains on the
// delivery list for another try. The attempt itself is logged in its own
// collection (deliveryAttempts) so the manager can analyse failures
// without ever losing earlier attempts on the same order.
export async function markOrderDeliveryFailed(id, { uid, email, reasonCode, note = '' }) {
  const reason = FAIL_REASONS.find(r => r.code === reasonCode);
  if (!reason) throw new Error('Pick a reason first.');
  const cleanNote = (note || '').trim();
  if (reasonCode === 'other' && !cleanNote) throw new Error('Please write the reason.');

  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, 'orders', id);
    const snap = await tx.get(orderRef);
    if (!snap.exists()) throw new Error('Order no longer exists.');
    const o = snap.data();
    if (o.status !== 'Invoiced') {
      throw new Error('This order is no longer waiting for delivery — someone else may have already handled it.');
    }
    const attemptNo = (o.deliveryAttemptCount || 0) + 1;
    const area = (o.customerLocation && o.customerLocation !== '-') ? o.customerLocation : 'Unknown area';

    tx.update(orderRef, {
      lastDeliveryFailure: {
        reasonCode, reason: reason.label, note: cleanNote,
        byUid: uid, byEmail: email, at: serverTimestamp(),
      },
      deliveryAttemptCount: attemptNo,
      updatedAt: serverTimestamp(),
    });
    tx.set(doc(collection(db, 'deliveryAttempts')), {
      orderId: id, orderNo: o.orderNo || '',
      customerId: o.customerId || null, customerName: o.customerName || '',
      area, outcome: 'Failed',
      reasonCode, reason: reason.label, note: cleanNote,
      by: uid, byEmail: email, attemptNo, at: serverTimestamp(),
    });
  });
}

// ---- Manager analytics: data fetching ----
// Single-field range queries only (no composite indexes needed).
export async function fetchPendingDeliveries() {
  const snap = await getDocs(query(
    collection(db, 'orders'),
    where('status', '==', 'Invoiced'), orderBy('createdAt', 'desc'), limit(500)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchDeliveredSince(date) {
  const snap = await getDocs(query(
    collection(db, 'orders'),
    where('deliveredAt', '>=', Timestamp.fromDate(date)), orderBy('deliveredAt', 'desc'), limit(2000)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.status === 'Delivered');
}

export async function fetchFailedAttemptsSince(date) {
  const snap = await getDocs(query(
    collection(db, 'deliveryAttempts'),
    where('at', '>=', Timestamp.fromDate(date)), orderBy('at', 'desc'), limit(2000)
  ));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export * from './deliveryStats.js';
