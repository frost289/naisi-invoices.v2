import { MAX_PRICE, mwk } from './money.js';

// OWNER DECISION RC6.1: warn and require manager acknowledgement, without
// repricing the submitted order or blocking a deliberately agreed discount.
// `price` is the catalogue field written by src/products.js. A missing or
// malformed price is visibly skipped, never treated as a free product.
export function reviewOrderPrices(items, catalogue) {
  const products = new Map((catalogue || []).map(p => [p.id, p]));
  const lines = [];
  for (const [index, item] of (items || []).entries()) {
    if (!item.productId) continue;
    const price = products.get(item.productId)?.price;
    const cataloguePrice = typeof price === 'number' && Number.isFinite(price) && price >= 0 && price <= MAX_PRICE ? price : null;
    lines.push({ line: index + 1, productId: item.productId, description: String(item.desc || item.productId), orderPrice: item.price, cataloguePrice });
  }
  const differences = lines.filter(l => l.cataloguePrice !== null && l.orderPrice !== l.cataloguePrice);
  const missingPrices = lines.filter(l => l.cataloguePrice === null);
  // This is a content fingerprint, not an authorization token. Transactions
  // recompute it from current order/product reads on every SDK retry. The
  // server rules still independently restrict approval to a manager.
  const key = JSON.stringify(lines);
  return { differences, missingPrices, key };
}

// Plain text only; callers must use textContent (or escape if in a table).
export function orderPriceReviewText(review) {
  const text = [];
  if (review.differences.length) {
    text.push('Catalogue price warning — acknowledge before approval:');
    for (const l of review.differences) text.push('Line ' + l.line + ': ' + l.description + ' — order ' + mwk(l.orderPrice) + '; current catalogue ' + mwk(l.cataloguePrice) + '.');
    text.push('Approval keeps the order prices shown above.');
  }
  for (const l of review.missingPrices) text.push('Line ' + l.line + ': ' + l.description + ' — no valid catalogue price; comparison skipped.');
  if (!text.length) text.push('All tracked line prices match the current catalogue.');
  return text.join('\n');
}
