import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs, setDoc, runTransaction, onSnapshot, serverTimestamp, query, orderBy, limit } from 'firebase/firestore';
import { malawiYear } from './malawiTime.js';
import { makeError } from './orderRevision.js';

export const COUNTER_DOC = doc(db, 'counters', 'naisiInvoice');
export const DEFAULT_PREFIX = 'NF-INV';

// The year in invoice numbers is always the REAL current year in Malawi - never stored, never manually editable.
export function currentYear(now = new Date()) {
  return malawiYear(now);
}

export function pad4(n) {
  return String(n).padStart(4, '0');
}

export function buildInvoiceNo(prefix, counter, now = new Date()) {
  return `${prefix}-${currentYear(now)}-${pad4(counter)}`;
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
  const initial = { prefix: DEFAULT_PREFIX, counter: 1 };
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

// ---- Adjusting the next invoice number (manager only) ----
// Invoice numbers are issued automatically, one at a time, inside the invoice commit (orders.js commitInvoice).
// The ONLY other way the counter can change is this audited adjustment. It
//   - needs a written reason,
//   - runs in a transaction on the same counter document the invoice commit reads, so an adjustment and an
//     invoice being generated at the same moment cannot interleave: one of them is retried against the other's result,
//   - writes an append-only audit record (previous value, new value, who, why, server time) in the SAME commit,
//   - can never cause a number to be issued twice: every issued number is also stored once in `invoiceNumbers`,
//     and the invoice commit is refused if its number is already there (see commitInvoice).
// The security rules enforce all of this too (rules/firestore.rules.FINAL-CANDIDATE, `counters` and `counterAdjustments`).
export const MAX_COUNTER = 99_999_999;
export const MIN_REASON = 3;
export const MAX_REASON = 300;
const PREFIX_RE = /^[A-Za-z0-9-]{1,20}$/;

export function validateCounterAdjustment({ prefix, counter, reason }) {
  if (typeof prefix !== 'string' || !PREFIX_RE.test(prefix)) return 'The prefix must be 1 to 20 letters, digits or hyphens.';
  if (!Number.isSafeInteger(counter) || counter < 1 || counter > MAX_COUNTER) return `The next number must be a whole number from 1 to ${MAX_COUNTER.toLocaleString('en-US')}.`;
  const r = String(reason ?? '').trim();
  if (r.length < MIN_REASON) return 'Enter the reason for changing the numbering (at least 3 characters).';
  if (r.length > MAX_REASON) return `The reason must be ${MAX_REASON} characters or fewer.`;
  return null;
}

export const adjustmentIdFor = (uid, requestId) => `adj_${uid}_${requestId}`;

export async function adjustInvoiceCounter({ prefix, counter, reason, requestId, uid, email }) {
  const problem = validateCounterAdjustment({ prefix, counter, reason });
  if (problem) throw new Error(problem);
  if (!uid) throw new Error('Not signed in.');
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new Error('Missing request id.');
  const adjRef = doc(db, 'counterAdjustments', adjustmentIdFor(uid, requestId));
  const cleanReason = String(reason).trim();

  return await runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(COUNTER_DOC);
    const adjSnap = await tx.get(adjRef);
    if (adjSnap.exists()) {
      // Retry of an adjustment that was already saved (lost acknowledgement / double click): report it, change nothing.
      const a = adjSnap.data();
      if (a.newPrefix !== prefix || a.newCounter !== counter || a.reason !== cleanReason) {
        throw makeError('This numbering change was already saved with different details. Nothing was changed. Review the audit list and start a new change if needed.', { code: 'adjustment-conflict' });
      }
      return { alreadyApplied: true, previous: { prefix: a.previousPrefix, counter: a.previousCounter }, next: { prefix: a.newPrefix, counter: a.newCounter } };
    }
    if (!counterSnap.exists()) throw new Error('Invoice numbering has not been set up yet.');
    const before = counterSnap.data();
    if (before.prefix === prefix && before.counter === counter) throw new Error('That is already the current numbering. Nothing to change.');
    tx.set(COUNTER_DOC, { prefix, counter, lastAdjustmentId: adjRef.id });
    tx.set(adjRef, {
      previousPrefix: before.prefix, previousCounter: before.counter,
      newPrefix: prefix, newCounter: counter,
      reason: cleanReason, requestId,
      adjustedBy: uid, adjustedByEmail: email, adjustedAt: serverTimestamp(),
    });
    return { alreadyApplied: false, previous: { prefix: before.prefix, counter: before.counter }, next: { prefix, counter } };
  });
}

// Newest first. Managers only (the rules allow nobody else to read it).
export async function fetchCounterAdjustments(max = 20) {
  const snap = await getDocs(query(collection(db, 'counterAdjustments'), orderBy('adjustedAt', 'desc'), limit(max)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
