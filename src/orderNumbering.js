import { db } from './firebase.js';
import { doc, runTransaction } from 'firebase/firestore';

const ORDER_COUNTER_DOC = doc(db, 'orderCounters', 'naisiOrder');

function currentYear() {
  return String(new Date().getFullYear());
}

function pad4(n) {
  return String(n).padStart(4, '0');
}

function buildOrderNo(counter) {
  return `ORD-${currentYear()}-${pad4(counter)}`;
}

export async function incrementOrderCounterAtomically() {
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(ORDER_COUNTER_DOC);
    const data = snap.exists() ? snap.data() : { counter: 1 };
    const usedNo = buildOrderNo(data.counter);
    const next = { counter: data.counter + 1 };
    tx.set(ORDER_COUNTER_DOC, next);
    return { usedNo, next };
  });
}