// Order-line and money validation (RC4 finding 3). PURE. Mirrors the bounded schema in rules/firestore.rules (lineOk / linesAndTotalOk).
//
// Policy (documented in docs/RULES-CHANGES.md):
//   - currency MWK, 2 decimals; a line total is qty x price, rounded half-up to 2 decimals; the order total is the sum of the line totals.
//   - tolerance 0.01 between a stored total and the recomputed one (the rules use the same tolerance).
//   - 1..12 lines. qty > 0 and <= 1,000,000; price >= 0; every number finite.
//   - a line WITH a productId is stock-tracked: quantity must be a whole number. A line without a productId is a custom line:
//     fractional quantity allowed, never stock-tracked.
export const MAX_ORDER_LINES = 12;
export const MONEY_TOLERANCE = 0.01;
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function validateOrderLines(items, grandTotal) {
  const problems = [];
  if (!Array.isArray(items) || items.length < 1) return { ok: false, problems: ['The order has no lines.'] };
  if (items.length > MAX_ORDER_LINES) problems.push(`An order can have at most ${MAX_ORDER_LINES} lines (it has ${items.length}).`);
  let sum = 0;
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== 'object') { problems.push(`Line ${n} is not valid.`); return; }
    const { qty, price, total, productId } = it;
    if (!isNum(qty) || qty <= 0 || qty > 1e6) problems.push(`Line ${n}: quantity must be a number above 0.`);
    if (!isNum(price) || price < 0 || price > 1e9) problems.push(`Line ${n}: price must be 0 or more.`);
    if (!isNum(total)) problems.push(`Line ${n}: total is not a number.`);
    else if (isNum(qty) && isNum(price) && Math.abs(total - round2(qty * price)) > MONEY_TOLERANCE) problems.push(`Line ${n}: total does not equal quantity x price.`);
    if (productId !== undefined && productId !== null) {
      if (typeof productId !== 'string' || !productId) problems.push(`Line ${n}: product is not valid.`);
      else if (isNum(qty) && !Number.isInteger(qty)) problems.push(`Line ${n}: a stock item needs a whole-number quantity.`);
    }
    if (isNum(total)) sum += total;
  });
  if (grandTotal !== undefined && (!isNum(grandTotal) || grandTotal < 0 || Math.abs(grandTotal - sum) > MONEY_TOLERANCE)) problems.push('The order total does not equal the sum of its lines.');
  return { ok: problems.length === 0, problems };
}

export function assertOrderLines(items, grandTotal, makeError) {
  const r = validateOrderLines(items, grandTotal);
  if (!r.ok) throw makeError('Order lines are not valid: ' + r.problems.join(' '), { code: 'invalid-order-lines', problems: r.problems });
}
