// Phase 1, Stage 2 — pure float arithmetic and id helpers (no Firestore; unit-tested in tests/unit/floatMath.test.js).
//
// Float accounting (design §4):
//   Closing Balance  = Opening Balance + Total Issued − Total Approved
//   Proposed Top-Up  = max(0, Float Target − Closing Balance)
// Rejected expense lines never reduce the balance. Fuel is outside the float system.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function closingBalance(opening, issued, approved) {
  return round2(Number(opening || 0) + Number(issued || 0) - Number(approved || 0));
}

export function proposedTopUp(target, closing) {
  return round2(Math.max(0, Number(target || 0) - Number(closing || 0)));
}

// Live position of an open (or closed) period document.
export function periodPosition(p) {
  if (!p) return null;
  const closing = closingBalance(p.openingBalance, p.totalIssued, p.totalApproved);
  return {
    opening: round2(p.openingBalance || 0),
    issued: round2(p.totalIssued || 0),
    approved: round2(p.totalApproved || 0),
    balance: closing,
    target: round2(p.floatTarget || 0),
    topUp: proposedTopUp(p.floatTarget, closing),
  };
}

// Net issued from a list of moneyIssued documents (issues minus reversals). Used to verify a period's running total.
export function netIssued(records) {
  return round2((records || []).reduce((s, r) => s + (r.kind === 'reversal' ? -1 : 1) * Number(r.amount || 0), 0));
}

// A positive money amount, at most MWK 1 billion, at most 2 decimals. Throws a readable error otherwise.
export function requireIssueAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Enter an amount greater than zero.');
  if (n > 1e9) throw new Error('Amount is too large.');
  return round2(n);
}

export function requireOpeningBalance(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Enter an opening balance (0 or more; negative if the person owes the business).');
  if (Math.abs(n) > 1e9) throw new Error('Opening balance is too large.');
  return round2(n);
}

// Deterministic ids. requestId is generated once when a form opens, so a double click or a retry writes the SAME document.
const cleanRequestId = (r) => String(r || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
export const periodId = (uid, yyyymmdd, requestId) => `fp_${uid}_${yyyymmdd}_${cleanRequestId(requestId).slice(0, 8)}`;
export const issueId = (uid, requestId) => `mi_${uid}_${cleanRequestId(requestId)}`;
export const reversalId = (originalId) => `mr_${originalId}`;

export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export const ISSUE_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'mobile', label: 'Mobile money (Airtel/TNM Mpamba)' },
  { value: 'bank', label: 'Bank transfer' },
];
