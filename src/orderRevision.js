// Pure helpers (no Firebase) shared by orders.js and stock.js.

export function makeError(message, props = {}) {
  return Object.assign(new Error(message), props);
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// What STOCK depends on: which products and how many of each.
export function orderItemsKey(items) {
  return JSON.stringify((items || []).map(it => [num(it.qty), String(it.desc ?? ''), num(it.price), it.productId || null]));
}

// What an INVOICE depends on: customer details, notes and the items. Used to
// detect that an order was changed after the screen that is about to approve
// or invoice it was loaded — the action is then refused instead of silently
// acting on content the manager has not seen.
export function orderRevisionKey(order) {
  return JSON.stringify([
    order.customerId || null,
    String(order.customerName ?? ''),
    String(order.customerPhone ?? ''),
    String(order.customerLocation ?? ''),
    String(order.notes ?? ''),
    orderItemsKey(order.items),
  ]);
}
