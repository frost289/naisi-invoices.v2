import { db } from './firebase.js';
import { doc, getDoc, setDoc, runTransaction, onSnapshot } from 'firebase/firestore';

const COUNTER_DOC = doc(db, 'counters', 'naisiInvoice');

// Always the REAL current year — never stored, never manually editable.
export function currentYear() {
  return String(new Date().getFullYear());
}

export function pad4(n) {
  return String(n).padStart(4, '0');
}

export function buildInvoiceNo(prefix, counter) {
  return `${prefix}-${currentYear()}-${pad4(counter)}`;
}

// If the counter doc doesn't exist yet, only a manager can create it
// (matches the security rule). Submitters get a clear error instead
// of a silent failure.
export async function loadCounterState(isManager) {
  const snap = await getDoc(COUNTER_DOC);
  if (snap.exists()) return snap.data();

  if (!isManager) {
    throw new Error('Invoice numbering has not been set up yet. Ask a manager to sign in first.');
  }
  const initial = { prefix: 'NF-INV', counter: 1 };
  await setDoc(COUNTER_DOC, initial);
  return initial;
}

// Live sync: every connected screen updates the moment ANY invoice is
// submitted or a manager changes the settings, no refresh needed.
export function watchCounterState(onChange) {
  return onSnapshot(COUNTER_DOC, (snap) => {
    if (snap.exists()) onChange(snap.data());
  });
}

// The ONLY function that actually issues an invoice number. Runs as a
// transaction so two people submitting at the same moment can never
// receive the same number.
export async function incrementCounterAtomically() {
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(COUNTER_DOC);
    const data = snap.exists() ? snap.data() : { prefix: 'NF-INV', counter: 1 };
    const usedNo = buildInvoiceNo(data.prefix, data.counter);
    const next = { prefix: data.prefix, counter: data.counter + 1 };
    tx.set(COUNTER_DOC, next);
    return { usedNo, next };
  });
}

// Manager-only manual override (e.g. resuming from a paper invoice book).
// Enforced again server-side by the security rules.
export async function setCounterStart(prefix, counter) {
  await setDoc(COUNTER_DOC, { prefix, counter });
}