import { db, auth } from './firebase.js';
import { doc, getDoc, setDoc, runTransaction } from 'firebase/firestore';

const COUNTER_DOC = doc(db, 'counters', 'naisiInvoice');

export async function loadCounterState() {
  const snap = await getDoc(COUNTER_DOC);
  if (snap.exists()) return snap.data();
  const initial = { prefix: 'NF-INV', year: String(new Date().getFullYear()), counter: 1 };
  await setDoc(COUNTER_DOC, initial);
  return initial;
}

export function pad4(n) {
  return String(n).padStart(4, '0');
}

export function buildInvoiceNo(prefix, year, counter) {
  return `${prefix}-${year}-${pad4(counter)}`;
}

// Runs as a transaction so two devices can never grab the same number.
export async function incrementCounterAtomically() {
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(COUNTER_DOC);
    const data = snap.exists()
      ? snap.data()
      : { prefix: 'NF-INV', year: String(new Date().getFullYear()), counter: 1 };
    const usedNo = buildInvoiceNo(data.prefix, data.year, data.counter);
    const next = { ...data, counter: data.counter + 1 };
    tx.set(COUNTER_DOC, next);
    return { usedNo, next };
  });
}

export async function savePrefixYear(prefix, year, counter) {
  await setDoc(COUNTER_DOC, { prefix, year, counter });
}