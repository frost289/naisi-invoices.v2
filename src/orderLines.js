// Order-line and money validation. PURE. Mirrors the bounded schema in rules/firestore.rules (lineOk / linesAndTotalOk); the policy and
// every constant live in money.js. A line is exactly one of:
//   - STOCK-TRACKED: productId (catalogue id, see PRODUCT_ID_RE), whole-number qty, no `custom` flag
//   - CUSTOM: no productId and custom === true (freight, discounts...): any positive qty, never stock-tracked, allowed on invoices and on
//             orders edited by a manager, NEVER on a rep's or manager-entered goods order (catalogueOnly)
// Anything else (missing/null/empty/malformed productId without custom:true, custom:false, custom together with a productId) is invalid.
import { MONEY_TOLERANCE, MAX_ORDER_LINES, MAX_QTY, MAX_PRICE, MAX_TOTAL, PRODUCT_ID_RE, round2, isMoney } from './money.js';
export { MONEY_TOLERANCE, MAX_ORDER_LINES, round2 };

export function lineKind(it) {
  if (!it || typeof it !== 'object') return 'invalid';
  const pid = it.productId;
  if (pid !== undefined && pid !== null) return (typeof pid === 'string' && PRODUCT_ID_RE.test(pid) && it.custom === undefined) ? 'tracked' : 'invalid';
  return it.custom === true ? 'custom' : 'untracked';        // 'untracked' = no stock identity and not declared custom: never acceptable
}

export function validateOrderLines(items, grandTotal, { catalogueOnly = false, invoice = false } = {}) {
  const problems = [];
  if (!Array.isArray(items) || items.length < 1) return { ok: false, problems: ['The order has no lines.'] };
  if (items.length > MAX_ORDER_LINES) problems.push(`An order can have at most ${MAX_ORDER_LINES} lines (it has ${items.length}).`);
  let sum = 0;
  items.forEach((it, i) => {
    const n = i + 1;
    if (!it || typeof it !== 'object') { problems.push(`Line ${n} is not valid.`); return; }
    const { qty, price, total } = it;
    if (!isMoney(qty) || !(qty > 0) || qty > MAX_QTY) problems.push(`Line ${n}: quantity must be a number above 0.`);
    if (!isMoney(price) || price < 0 || price > MAX_PRICE) problems.push(`Line ${n}: price must be 0 or more.`);
    if (!isMoney(total)) problems.push(`Line ${n}: total is not a number.`);
    else if (isMoney(qty) && isMoney(price) && !(Math.abs(total - qty * price) <= MONEY_TOLERANCE)) problems.push(`Line ${n}: total does not equal quantity x price.`);
    const kind = lineKind(it);
    if (kind === 'invalid') problems.push(`Line ${n}: the product reference is not valid.`);
    else if (kind === 'untracked' && !invoice) problems.push(`Line ${n}: it has no product from the catalogue (choose a product, or mark it as a custom line).`);
    else if (kind === 'custom' && catalogueOnly) problems.push(`Line ${n}: only catalogue products are allowed on this order.`);
    else if (kind === 'tracked' && isMoney(qty) && !Number.isInteger(qty)) problems.push(`Line ${n}: a stock item needs a whole-number quantity.`);
    if (isMoney(total)) sum += total;
  });
  if (grandTotal !== undefined && (!isMoney(grandTotal) || grandTotal < 0 || grandTotal > MAX_TOTAL || !(Math.abs(grandTotal - sum) <= MONEY_TOLERANCE))) problems.push('The order total does not equal the sum of its lines.');
  return { ok: problems.length === 0, problems };
}

export function assertOrderLines(items, grandTotal, makeError, opts) {
  const r = validateOrderLines(items, grandTotal, opts);
  if (!r.ok) throw makeError('Order lines are not valid: ' + r.problems.join(' '), { code: 'invalid-order-lines', problems: r.problems });
}
