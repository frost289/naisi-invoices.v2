// RC3 data migration planner. PURE: takes data, returns a plan. Never writes. Invents nothing.
//
// Actions it may propose (all additive, none overwrite or delete a business value):
//   REGISTER_NUMBER  create invoiceNumbers/{invoiceNo} {invoiceId, issuedBy, issuedAt, migrated:true} for an invoice number that is not registered yet
//   LABEL_KIND       set kind:'order' on an old invoice that an order demonstrably points to (order.invoiceId, or invoice.orderId)
// Things it only REPORTS (a person must decide; the tool will not guess):
//   NEEDS_REVIEW     old invoice with no order link and no kind (stand-alone? orphan?), duplicate numbers, cancelled orders with no record
//   COUNTER_BEHIND   the counter would issue an existing number (fix in the app: Invoices -> Numbering, with a reason)
//   INVALID_LINES    (RC5) an order/invoice whose lines RC5 cannot process (invalid or more than 12 lines). Open orders make the assessment BLOCKED.
//   UNKNOWN_PRODUCT  (RC6) an order line whose product id is not in the supplied catalogue. Open orders make the assessment BLOCKED.
//   HISTORY_NOT_STARTED  the schedule history has not been started (a manager does it in the app so the server clock is used)
import { validateOrderLines } from '../src/orderLines.js';
// RC6: `products` (the catalogue, an array; [] = a real empty catalogue) and `missingInputs` (names of export files that were not supplied)
// make the assessment honest: with a required input missing the assessment is INCOMPLETE, never CLEAN.
export function planMigration({ invoices = [], orders = [], invoiceNumbers = [], counter = null, cancellations = [], scheduleConfig = null, products = null, missingInputs = [] }) {
  const actions = [], report = [];
  const registered = new Set(invoiceNumbers.map(n => n.id || n.invoiceNo));
  const byNo = new Map();
  for (const inv of invoices) if (inv.invoiceNo) (byNo.get(inv.invoiceNo) || byNo.set(inv.invoiceNo, []).get(inv.invoiceNo)).push(inv);
  const linkedBy = new Map();      // invoice id -> order id that points to it
  for (const o of orders) if (o.invoiceId) linkedBy.set(o.invoiceId, o.id);

  for (const [no, list] of byNo) {
    if (list.length > 1) { report.push({ type: 'NEEDS_REVIEW', invoiceIds: list.map(i => i.id), detail: `Invoice number ${no} is on ${list.length} invoices. Not registered; a person must decide which is real.` }); continue; }
    const inv = list[0];
    if (!registered.has(no)) actions.push({ type: 'REGISTER_NUMBER', path: `invoiceNumbers/${no}`, data: { invoiceId: inv.id, issuedBy: inv.createdBy || 'migration', issuedAt: inv.createdAt || null, migrated: true } });
  }
  for (const inv of invoices) {
    if (inv.kind !== undefined) continue;
    if (inv.orderId || linkedBy.has(inv.id)) actions.push({ type: 'LABEL_KIND', path: `invoices/${inv.id}`, data: { kind: 'order' } });
    else report.push({ type: 'NEEDS_REVIEW', invoiceIds: [inv.id], detail: 'Old invoice with no order link: could be a stand-alone invoice or an orphan. Left unlabelled.' });
  }
  const rec = new Set(cancellations.map(c => c.id || c.orderId));
  for (const o of orders) if (o.status === 'Cancelled' && !rec.has(o.id)) report.push({ type: 'NEEDS_REVIEW', orderIds: [o.id], detail: 'Cancelled before RC3: there is no reason/actor record and none is invented. Its stock handling cannot be verified; run reconcile.' });
  if (counter && counter.prefix) {
    const n = (counter.counter || 0), pad = String(n).padStart(4, '0');
    const clash = [...byNo.keys()].find(no => no.startsWith(counter.prefix + '-') && no.endsWith('-' + pad));
    if (clash) report.push({ type: 'COUNTER_BEHIND', detail: `Next number would be …-${pad}, already used by ${clash}. Raise the counter in the app (Invoices -> Numbering) with a reason.` });
  }
  const OPEN = new Set(['Submitted', 'Approved', 'Invoicing']);
  for (const o of orders) {
    const v = validateOrderLines(o.items, o.grandTotal);
    if (!v.ok) report.push({ type: 'INVALID_LINES', open: OPEN.has(o.status), orderIds: [o.id], detail: `Order ${o.orderNo || o.id} (${o.status}) cannot be processed by RC5: ${v.problems.join(' ')} Run tools/reconcile.mjs for the recovery steps.` });
  }
  for (const inv of invoices) {
    const v = validateOrderLines(inv.items, inv.grandTotal, { invoice: true });
    if (!v.ok) report.push({ type: 'INVALID_LINES', open: false, invoiceIds: [inv.id], detail: `Invoice ${inv.invoiceNo || inv.id}: ${v.problems.join(' ')} (historical; only editing its lines is blocked).` });
  }
  const known = Array.isArray(products) ? new Set(products.map(p => p.id)) : null;
  if (known) for (const o of orders) {
    const unknown = [...new Set((Array.isArray(o.items) ? o.items : []).filter(i => i && typeof i.productId === 'string' && !known.has(i.productId)).map(i => i.productId))];
    if (unknown.length) report.push({ type: 'UNKNOWN_PRODUCT', open: OPEN.has(o.status), orderIds: [o.id], detail: `Order ${o.orderNo || o.id} (${o.status}) references product id(s) ${unknown.join(', ')} that are not in the catalogue. RC5/RC6 refuses to approve it until it is edited.` });
  }
  const missing = [...missingInputs, ...(known ? [] : ['products'])];
  if (!scheduleConfig) report.push({ type: 'HISTORY_NOT_STARTED', detail: 'Schedule history is not started. A manager starts it in the app; until then past dates show "no reliable history".' });
  // BLOCKED: RC5 cannot process an open order. REVIEW: something needs a person. CLEAN: nothing found. (Never "clean" while a record cannot be processed.)
  const blocked = report.some(r => (r.type === 'INVALID_LINES' || r.type === 'UNKNOWN_PRODUCT') && r.open);
  const assessment = blocked ? 'BLOCKED' : (missing.length ? 'INCOMPLETE' : (report.length ? 'REVIEW' : 'CLEAN'));
  return { actions, report, assessment, missingInputs: missing, notCoveredChecks: ['stock ledger and per-product cancellation restoration', 'customers and merge locks', 'schedule consistency against customer history (only history-start presence is checked here)'] };
}
