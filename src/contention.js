// RC6.5: safe retry for transactions that race (a double click, two managers at once, two invoices at the same moment).
//
// The security rules check a transaction's writes against the data AS IT IS when the commit arrives. When two commits race,
// the slower one is checked against data the faster one has just changed, and it is refused with permission-denied. The SDK
// does not retry permission-denied, so the second click failed instead of finding the first one's result. (Emulator run of
// 30 Oct 2026: tests L "double click", K "two managers' cancel", M "three invoices / adjustment + invoice".)
//
// runTransactionWithRetry re-runs the transaction ONLY when the documents it depends on (watch) have changed since the
// attempt started, i.e. when there really was a race. The re-run reads fresh data, so its own checks decide the outcome:
// an identical retry returns the saved result, a changed one reports its conflict, a new invoice takes the next number.
// A refusal on UNCHANGED data is a real rules refusal and is thrown at once. Every write stays validated by the rules.
import { runTransaction, getDoc } from 'firebase/firestore';

async function fingerprint(refs) {
  const parts = [];
  for (const ref of refs) {
    try {
      const snap = await getDoc(ref);
      parts.push(snap.exists() ? JSON.stringify(snap.data()) : '(missing)');
    } catch {
      parts.push('(unreadable)');       // e.g. a rep calling a manager-only function: no retry decision can be based on it
    }
  }
  return parts.join('\u0000');
}

const isRefusal = (err) => (err && (err.code === 'permission-denied' || /PERMISSION_DENIED/.test(String(err.message))));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runTransactionWithRetry(db, body, { watch = [], attempts = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const before = watch.length ? await fingerprint(watch) : '';
    try {
      return await runTransaction(db, body);
    } catch (err) {
      lastErr = err;
      if (!isRefusal(err) || !watch.length || attempt === attempts) throw err;
      const after = await fingerprint(watch);
      if (after === before || after.includes('(unreadable)')) throw err;   // nothing raced: a genuine refusal
      await pause(40 * attempt + Math.floor(Math.random() * 40));
    }
  }
  throw lastErr;
}
