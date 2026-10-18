// READ-ONLY reconciliation of orders and invoices (pure functions).
// Input: plain arrays (e.g. from a Firestore export). It never talks to Firestore
// and never "repairs" anything: it only classifies records so that a person can
// review them. Ambiguous cases are reported as such, never resolved.
//
// Classification of each order that has (or may need) an invoice:
//   OK                 Invoiced, invoiceId points to an invoice that exists and agrees (invoiceNo)
//   BROKEN_LINK        Invoiced but invoiceId is missing, or points to no invoice, or invoiceNo differs
//   STUCK_INVOICING    status "Invoicing" (an attempt was interrupted)
//   POSSIBLE_ORPHAN    Approved/Invoicing, no invoiceId, but unlinked invoice(s) look like it
//                      (same customer, same total, same item lines). AMBIGUOUS: human review.
// Plus invoice-level findings:
//   DUPLICATE_NUMBER   same invoiceNo on more than one invoice
//   MULTI_FOR_ORDER    more than one invoice claims the same orderId, or several orders point at one invoice
//   UNLINKED_INVOICE   invoice no order points to (may be a legitimate stand-alone invoice)
// RC3 findings (only when the matching optional input is supplied):
//   CANCELLED_NO_RECORD       Cancelled order without its orderCancellations record
//   CANCEL_STOCK_MISMATCH     for ONE ORDER and ONE PRODUCT, the 'order-cancelled' ledger quantity differs from what the order held
//                             (problem = missing | wrong-quantity | unexpected). Compared per orderId AND productId, never by total.
//                             The rules cannot check this; this does.
//   CANCEL_NOT_RESTORED_TWICE more 'order-cancelled' entries for one order+product than the order has lines for it (double restore)
//   MOVEMENT_UNATTRIBUTED     an 'order-cancelled' ledger entry with no orderId or no productId: it cannot be checked, so it is reported
// RC5 (data preflight, finding D) - lines are checked with the SAME validator the app and the rules use (src/orderLines.js, src/money.js):
//   INVALID_ORDER_LINES    an order whose stored lines RC5 cannot process (negative/fractional/NaN quantity, bad price or totals, no product and not a
//                          declared custom line, malformed product id, or more than 12 lines). Open orders (Submitted/Approved/Invoicing) are HIGH, the rest info.
//                          Each finding carries `reasons` and a `recovery` text; Approved orders also carry `ledgerNet` (the stock actually deducted, from the ledger).
//   UNKNOWN_PRODUCT        a stock-tracked line whose product is not in the catalogue (only when --products is supplied)
//   INVALID_INVOICE_LINES  an invoice whose lines would not pass today's validation (info: it stays valid history; only editing its lines is blocked)
// Result: { findings, counts, status, skippedChecks, safeToEnableResume, completeness, dataReadiness, releaseReadiness, preflight }.
//   completeness      COMPLETE | INCOMPLETE   did every check get its input?
//   dataReadiness     READY | BLOCKED | NOT_ASSESSED   can RC5 process this data? BLOCKED when a high/medium finding exists; NOT_ASSESSED when inputs are missing
//   releaseReadiness  always NOT_ASSESSED_BY_THIS_TOOL: a clean data check is NOT release approval (rules compilation, emulator tests and sign-offs are separate)
//   status CLEAN       every check ran and nothing needs attention (the only state that is safe)
//   status FINDINGS    at least one high/medium finding
//   status INCOMPLETE  an input was not supplied so a check did not run; this is NOT a clean result and is listed in skippedChecks
//   NUMBER_NOT_REGISTERED     an invoice number that is not in the invoiceNumbers registry (legacy invoices: run the migration tool)
//   COUNTER_BEHIND            the invoice counter would issue a number that already exists
//   LEGACY_INVOICE_NO_KIND    invoice without kind (created before RC3)
//   SCHEDULE_MISMATCH         a customer's current day/active state differs from its last schedule-history entry
//   MERGE_PAUSED              a customer still carries a merge lock (an interrupted merge)
//   MANAGER_ORDER_HAS_VISIT   a manager-entered order that carries a visit link

import { validateOrderLines } from '../src/orderLines.js';
import { MAX_ORDER_LINES } from '../src/money.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();
export function itemsFingerprint(items) {
  return (items || [])
    .map(i => `${norm(i.productId || i.desc)}|${Number(i.qty) || 0}|${Number(i.price) || 0}`)
    .sort().join(';');
}
const totalOf = (x) => Number(x.grandTotal ?? (x.items || []).reduce((s, i) => s + (i.total || 0), 0)) || 0;

// Inputs that a full assessment needs. A check whose input is missing does not run, and that is reported, not hidden.
const REQUIRED_INPUTS = [
  ['cancellations', 'cancellation records: CANCELLED_NO_RECORD and the stock-restoration check'],
  ['stockMovements', 'stock ledger: the cancellation stock-restoration check (by order and product)'],
  ['invoiceNumbers', 'invoice number registry: NUMBER_NOT_REGISTERED, LEGACY_INVOICE_NO_KIND'],
  ['counter', 'invoice counter: COUNTER_BEHIND'],
  ['customers', 'customers: MERGE_PAUSED, SCHEDULE_MISMATCH'],
  ['scheduleChanges', 'schedule history entries: SCHEDULE_MISMATCH'],
  ['scheduleConfig', 'schedule history config: SCHEDULE_MISMATCH'],
];

export function reconcile({ orders = [], invoices = [], stockMovements = null, cancellations = null, invoiceNumbers = null, counter = null,
  customers = null, scheduleChanges = null, scheduleConfig = null, products = null }) {
  const invById = new Map(invoices.map(i => [i.id, i]));
  const findings = [];
  const add = (type, severity, ids, detail) => findings.push({ type, severity, ...ids, detail });

  // invoice-level
  const byNo = new Map();
  for (const inv of invoices) { if (inv.invoiceNo) (byNo.get(inv.invoiceNo) || byNo.set(inv.invoiceNo, []).get(inv.invoiceNo)).push(inv); }
  for (const [no, list] of byNo) if (list.length > 1) add('DUPLICATE_NUMBER', 'high', { invoiceIds: list.map(i => i.id) }, `Invoice number ${no} is on ${list.length} invoices.`);

  const pointers = new Map(); // invoiceId -> [orderIds that point to it]
  for (const o of orders) if (o.invoiceId) (pointers.get(o.invoiceId) || pointers.set(o.invoiceId, []).get(o.invoiceId)).push(o.id);
  for (const [invId, oids] of pointers) if (oids.length > 1) add('MULTI_FOR_ORDER', 'high', { invoiceIds: [invId], orderIds: oids }, `${oids.length} orders point at the same invoice.`);
  const claimed = new Map();  // orderId -> [invoice ids with orderId]
  for (const inv of invoices) if (inv.orderId) (claimed.get(inv.orderId) || claimed.set(inv.orderId, []).get(inv.orderId)).push(inv.id);
  for (const [oid, list] of claimed) if (list.length > 1) add('MULTI_FOR_ORDER', 'high', { orderIds: [oid], invoiceIds: list }, `${list.length} invoices claim order ${oid}.`);

  const linkedInvoiceIds = new Set([...pointers.keys()]);
  for (const inv of invoices) if (inv.orderId) linkedInvoiceIds.add(inv.id);
  const unlinked = invoices.filter(i => !linkedInvoiceIds.has(i.id) && i.kind !== 'standalone');   // an explicit stand-alone invoice is never an orphan candidate

  // order-level
  const unlinkedUsed = new Set();
  for (const o of orders) {
    if (o.status === 'Invoiced' || o.invoiceId) {
      const inv = o.invoiceId ? invById.get(o.invoiceId) : null;
      if (!inv) add('BROKEN_LINK', 'high', { orderIds: [o.id] }, o.invoiceId ? `Order points to invoice ${o.invoiceId}, which does not exist.` : 'Order is Invoiced but has no invoiceId.');
      else if (o.invoiceNo && inv.invoiceNo && o.invoiceNo !== inv.invoiceNo) add('BROKEN_LINK', 'high', { orderIds: [o.id], invoiceIds: [inv.id] }, `Order says ${o.invoiceNo}, invoice says ${inv.invoiceNo}.`);
      continue;
    }
    if (o.status === 'Invoicing') add('STUCK_INVOICING', 'medium', { orderIds: [o.id] }, 'An invoicing attempt was interrupted. Check Invoices before doing anything.');
    if (o.status === 'Invoicing' || o.status === 'Approved') {
      const fp = itemsFingerprint(o.items), total = totalOf(o);
      const matches = unlinked.filter(i => norm(i.customer) === norm(o.customerName) && totalOf(i) === total && itemsFingerprint(i.items) === fp);
      if (matches.length) {
        matches.forEach(m => unlinkedUsed.add(m.id));
        add('POSSIBLE_ORPHAN', 'high', { orderIds: [o.id], invoiceIds: matches.map(m => m.id) },
          `Order is ${o.status} with no invoice link, but ${matches.length} unlinked invoice(s) have the same customer, total and items. A person must decide: link, or leave.`);
      }
    }
  }
  for (const inv of unlinked) add('UNLINKED_INVOICE', unlinkedUsed.has(inv.id) ? 'high' : 'info', { invoiceIds: [inv.id] }, unlinkedUsed.has(inv.id) ? 'Matches an unlinked order (see POSSIBLE_ORPHAN).' : 'No order points to this invoice. May be a legitimate stand-alone invoice.');

  // ---- RC3 checks (each runs only when its input was supplied) ----
  const trackedQty = (o) => (o.items || []).reduce((n, i) => n + (i.productId ? Number(i.qty) || 0 : 0), 0);
  if (cancellations) {
    const recById = new Map(cancellations.map(c => [c.id || c.orderId, c]));
    for (const o of orders) if (o.status === 'Cancelled' && !recById.has(o.id)) add('CANCELLED_NO_RECORD', 'high', { orderIds: [o.id] }, 'Order is Cancelled but has no cancellation record.');
    if (stockMovements) {
      // restored[orderId][productId] = { qty, entries }
      const restored = new Map();
      for (const m of stockMovements) {
        if (m.type !== 'order-cancelled') continue;
        if (!m.orderId || !m.productId) { add('MOVEMENT_UNATTRIBUTED', 'medium', { orderIds: m.orderId ? [m.orderId] : [] }, `An order-cancelled stock entry (${m.id || 'no id'}) has no ${m.orderId ? 'productId' : 'orderId'}; it cannot be checked.`); continue; }
        const byProd = restored.get(m.orderId) || restored.set(m.orderId, new Map()).get(m.orderId);
        const cur = byProd.get(m.productId) || byProd.set(m.productId, { qty: 0, entries: 0 }).get(m.productId);
        cur.qty += Number(m.delta) || 0; cur.entries += 1;
      }
      const known = products ? new Set(products.map(p => p.id)) : null;   // when supplied, a deleted product is legitimately not restored
      for (const o of orders) {
        if (o.status !== 'Cancelled') continue;
        const r = recById.get(o.id); if (!r) continue;               // CANCELLED_NO_RECORD already reported
        const expected = new Map(), lines = new Map();
        if (r.stockRestored === true) for (const i of (o.items || [])) {
          const q = Number(i.qty) || 0;
          if (!i.productId || q <= 0 || (known && !known.has(i.productId))) continue;
          expected.set(i.productId, (expected.get(i.productId) || 0) + q); lines.set(i.productId, (lines.get(i.productId) || 0) + 1);
        }
        const actual = restored.get(o.id) || new Map();
        for (const pid of new Set([...expected.keys(), ...actual.keys()])) {
          const want = expected.get(pid) ?? 0, got = actual.get(pid)?.qty ?? 0, entries = actual.get(pid)?.entries ?? 0;
          let problem = null;
          if (!expected.has(pid)) problem = 'unexpected';
          else if (!actual.has(pid)) problem = 'missing';
          else if (got !== want) problem = 'wrong-quantity';
          if (problem) add('CANCEL_STOCK_MISMATCH', 'high', { orderIds: [o.id], productId: pid, expected: want, actual: got, problem },
            `Order ${o.orderNo || o.id}, product ${pid}: the order held ${want}, the ledger restored ${got} (${problem}).${r.stockRestored === false ? ' The cancellation says no stock was restored.' : ''}`);
          if (expected.has(pid) && entries > (lines.get(pid) || 0)) add('CANCEL_NOT_RESTORED_TWICE', 'high', { orderIds: [o.id], productId: pid, expected: want, actual: got, problem: 'duplicate' },
            `Order ${o.orderNo || o.id}, product ${pid}: ${entries} restore entries for ${lines.get(pid) || 0} line(s): possible double restore.`);
        }
      }
    }
  }
  if (invoiceNumbers) {
    const reg = new Set(invoiceNumbers.map(n => n.id || n.invoiceNo));
    for (const inv of invoices) if (inv.invoiceNo && !reg.has(inv.invoiceNo)) add('NUMBER_NOT_REGISTERED', 'medium', { invoiceIds: [inv.id] }, `Invoice number ${inv.invoiceNo} is not in the invoiceNumbers registry (created before RC3? run tools/migrate-rc3.mjs).`);
    if (counter && counter.prefix) {
      const no4 = (n) => String(n).padStart(4, '0');
      const clash = [...reg].find(no => no.startsWith(counter.prefix + '-') && no.endsWith('-' + no4(counter.counter)));
      if (clash) add('COUNTER_BEHIND', 'high', { invoiceIds: [] }, `The next invoice number would be ${counter.prefix}-…-${no4(counter.counter)}, which already exists (${clash}).`);
    }
  }
  if (invoiceNumbers) for (const inv of invoices) if (inv.kind === undefined) add('LEGACY_INVOICE_NO_KIND', 'info', { invoiceIds: [inv.id] }, 'Invoice was created before RC3 (no kind). Harmless; the migration tool can label it.');
  for (const o of orders) if (o.source === 'manager-entered' && o.visitId) add('MANAGER_ORDER_HAS_VISIT', 'high', { orderIds: [o.id] }, 'A manager-entered order must never be linked to a visit.');
  if (customers) {
    for (const c of customers) if (c.mergeLock) add('MERGE_PAUSED', 'medium', { customerIds: [c.id] }, `Customer "${c.name}" is locked for a merge into ${c.mergeLock.into}: resume or cancel it from Customers.`);
    if (scheduleConfig && scheduleChanges) {
      const last = new Map();
      for (const ch of [...scheduleChanges].sort((a, b) => (a.createdAt?.seconds ?? a.createdAt?.ms ?? 0) - (b.createdAt?.seconds ?? b.createdAt?.ms ?? 0))) last.set(ch.customerId, ch);
      for (const c of customers) {
        if (c.mergeLock) continue;
        const l = last.get(c.id);
        const curActive = c.active !== false, curDay = c.assignedDay ?? null;
        if (!l ? (curDay !== null || !curActive) : ((l.active !== false) !== curActive || (l.assignedDay ?? null) !== curDay))
          add('SCHEDULE_MISMATCH', 'medium', { customerIds: [c.id] }, `Customer "${c.name}": current schedule differs from the last history entry (a change made without a history entry).`);
      }
    }
  }

  // ---- RC5 preflight: order and invoice lines ----
  const OPEN = new Set(['Submitted', 'Approved', 'Invoicing']);
  const knownProducts = products ? new Set(products.map(p => p.id)) : null;
  const ledgerNet = (orderId) => {
    if (!stockMovements) return null;
    const net = {};
    for (const m of stockMovements) if (m.orderId === orderId && m.productId) net[m.productId] = (net[m.productId] || 0) + (Number(m.delta) || 0);
    return net;
  };
  const pre = { ordersChecked: orders.length, invoicesChecked: invoices.length, invalidOrders: [], invalidInvoices: [], oversizedOrders: [], oversizedInvoices: [], maxLinesFound: 0, records: [] };
  const recoveryFor = (o, net) => {
    if (o.status === 'Submitted') return 'No stock was deducted. A manager opens the order and corrects the lines (Orders > Edit), or Rejects / Cancels it. It cannot be approved until the lines are valid.';
    if (o.status === 'Approved') {
      const netTxt = net === null ? 'Supply --stock (the stock ledger) to see what stock was really deducted for it.'
        : `The ledger shows this net stock movement for the order (negative = deducted): ${Object.keys(net).length ? JSON.stringify(net) : 'none'}.`;
      return `RC5 cannot edit, invoice, or restore stock from these lines. ${netTxt} Recovery (docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md): the manager cancels it with "Cancel WITHOUT restoring stock (recovery)" and a reason, then makes one audited manual stock adjustment per product for exactly the ledger amount above, naming the order number in the reason. Nothing is invented: the ledger, not the order lines, is the source of the quantities.`;
    }
    if (o.status === 'Invoicing') return 'An invoicing attempt is open. Release or finish it first (docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md, maintenance procedure), then treat it as Approved.';
    return 'Historical record. No operation is blocked (it cannot be approved, edited or cancelled anyway); no action needed.';
  };
  for (const o of orders) {
    const n = Array.isArray(o.items) ? o.items.length : 0;
    pre.maxLinesFound = Math.max(pre.maxLinesFound, n);
    if (n > MAX_ORDER_LINES) pre.oversizedOrders.push(o.id);
    const v = validateOrderLines(o.items, o.grandTotal);
    const open = OPEN.has(o.status);
    if (!v.ok) {
      pre.invalidOrders.push(o.id);
      const net = o.status === 'Approved' ? ledgerNet(o.id) : null;
      const recovery = recoveryFor(o, o.status === 'Approved' ? net : null);
      pre.records.push({ collection: 'orders', id: o.id, orderNo: o.orderNo || null, status: o.status, reasons: v.problems, recovery });
      add('INVALID_ORDER_LINES', open ? 'high' : 'info', { orderIds: [o.id], reasons: v.problems, recovery, ...(net ? { ledgerNet: net } : {}) },
        `Order ${o.orderNo || o.id} (${o.status}): ${v.problems.join(' ')}`);
    }
    if (knownProducts && Array.isArray(o.items)) {
      const unknown = [...new Set(o.items.filter(i => i && typeof i.productId === 'string' && !knownProducts.has(i.productId)).map(i => i.productId))];
      if (unknown.length) add('UNKNOWN_PRODUCT', open ? 'high' : 'info', { orderIds: [o.id], productIds: unknown },
        `Order ${o.orderNo || o.id} (${o.status}) has line(s) for product id(s) ${unknown.join(', ')} that are not in the catalogue. Approval is refused until the order is edited.`);
    }
  }
  for (const inv of invoices) {
    const n = Array.isArray(inv.items) ? inv.items.length : 0;
    pre.maxLinesFound = Math.max(pre.maxLinesFound, n);
    if (n > MAX_ORDER_LINES) pre.oversizedInvoices.push(inv.id);
    const v = validateOrderLines(inv.items, inv.grandTotal, { invoice: true });
    if (!v.ok) {
      pre.invalidInvoices.push(inv.id);
      const recovery = 'Historical invoice: it stays valid and printable. Only editing its lines or totals is blocked by RC5 rules; correct it through a credit/re-issue process if a change is needed.';
      pre.records.push({ collection: 'invoices', id: inv.id, invoiceNo: inv.invoiceNo || null, status: 'issued', reasons: v.problems, recovery });
      add('INVALID_INVOICE_LINES', 'info', { invoiceIds: [inv.id], reasons: v.problems, recovery }, `Invoice ${inv.invoiceNo || inv.id}: ${v.problems.join(' ')}`);
    }
  }

  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  const given = { cancellations, stockMovements, invoiceNumbers, counter, customers, scheduleChanges, scheduleConfig };
  const skippedChecks = REQUIRED_INPUTS.filter(([k]) => given[k] === null || given[k] === undefined).map(([input, covers]) => ({ input, covers }));
  const attention = findings.some(f => f.severity !== 'info');
  const status = attention ? 'FINDINGS' : (skippedChecks.length ? 'INCOMPLETE' : 'CLEAN');
  const completeness = skippedChecks.length ? 'INCOMPLETE' : 'COMPLETE';
  const dataReadiness = findings.some(f => f.severity === 'high' || f.severity === 'medium') ? 'BLOCKED' : (skippedChecks.length ? 'NOT_ASSESSED' : 'READY');
  return { findings, counts, status, skippedChecks, safeToEnableResume: status === 'CLEAN', completeness, dataReadiness, releaseReadiness: 'NOT_ASSESSED_BY_THIS_TOOL', preflight: pre };
}
