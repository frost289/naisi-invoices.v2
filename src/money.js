// ONE currency policy (RC5), shared by every screen and mirrored literally in rules/firestore.rules (tests/unit/money.test.js compares them).
//   Currency: MWK, 2 decimals.
//   A line total is stored as round2(qty x price) and is accepted when |total - qty x price| <= MONEY_TOLERANCE, computed on the UNROUNDED
//   product with the same double arithmetic the rules use. The order/invoice total is accepted when |grandTotal - sum of the line totals| <= MONEY_TOLERANCE.
//   Limits: 1..MAX_ORDER_LINES lines; 0 < qty <= MAX_QTY; 0 <= price <= MAX_PRICE; 0 <= grandTotal <= MAX_TOTAL; 0 < expense <= MAX_EXPENSE.
//   A stock-tracked line (has productId) needs a whole-number quantity; an explicit custom line (custom:true, no productId) may be fractional.
export const MONEY_TOLERANCE = 0.01;
// RC6.5: lowered from 12 to 6. On the Firestore emulator, 12-line orders exceeded the rules' budget of 1,000 evaluated
// expressions per request (approve, edit, invoice, cancel and even a single 12-line create were refused). The price card has
// 4 products, so 6 lines leaves room for every product plus extra lines. Lowering or raising this is a one-constant change
// here PLUS the unrolled line checks in rules/firestore.rules (linesAndTotalOk / linesSum); the tests follow this constant.
export const MAX_ORDER_LINES = 6;
export const MAX_QTY = 1000000;
export const MAX_PRICE = 1000000000;
export const MAX_TOTAL = 1000000000000;
export const MAX_EXPENSE = 1000000000000;
export const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const isMoney = (v) => typeof v === 'number' && Number.isFinite(v);

// A stored/typed amount that is a finite number >= 0, else null. Strings are NOT accepted from storage (a stored amount must be a number).
export const moneyOrNull = (v) => (isMoney(v) && v >= 0 ? v : null);

// mwk() returns plain TEXT built only from digits, comma, point and letters. It can never contain markup, whatever it is given.
// A value that is not a finite number is shown as "Invalid amount" (never as 0), so bad financial data is visible.
export function mwk(n) {
  if (!isMoney(n)) return 'Invalid amount';
  return 'MWK ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Strict reading of an amount typed in a form: a number, or text such as "1500" / "99.5" (no units, no exponent). Throws code 'invalid-amount'.
export function requireExpenseAmount(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.\d{1,2})?\s*$/.test(v)) n = Number(v);
  if (!isMoney(n) || n <= 0 || n > MAX_EXPENSE) {
    throw Object.assign(new Error('Enter an amount greater than 0 (numbers only, up to 2 decimals).'), { code: 'invalid-amount' });
  }
  return round2(n);
}

// Totals for the expense screens/reports/exports. Malformed amounts are EXCLUDED and LISTED, never turned into 0 silently.
export function summarizeExpenses(expenses, categories = ['Transport', 'Meals', 'Fuel', 'Stock', 'Other']) {
  const byCategory = Object.fromEntries(categories.map(c => [c, 0]));
  const invalid = [];
  let total = 0, validCount = 0;
  for (const e of expenses || []) {
    const amt = isMoney(e.amount) && e.amount > 0 ? e.amount : null;
    if (amt === null) { invalid.push({ id: e.id || null, category: e.category ?? null, date: e.date ?? null }); continue; }
    total += amt; validCount += 1;
    byCategory[e.category] = (byCategory[e.category] || 0) + amt;
  }
  return { total, byCategory, invalid, validCount };
}
