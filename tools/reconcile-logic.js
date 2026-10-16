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
//   CANCEL_STOCK_MISMATCH     the cancellation says stock was restored, but the 'order-cancelled' ledger entries do not add up to the
//                             order's tracked quantities (or exist when none were restored). The rules cannot check this; this does.
//   CANCEL_NOT_RESTORED_TWICE more than one 'order-cancelled' set of entries for one order (double restore)
//   NUMBER_NOT_REGISTERED     an invoice number that is not in the invoiceNumbers registry (legacy invoices: run the migration tool)
//   COUNTER_BEHIND            the invoice counter would issue a number that already exists
//   LEGACY_INVOICE_NO_KIND    invoice without kind (created before RC3)
//   SCHEDULE_MISMATCH         a customer's current day/active state differs from its last schedule-history entry
//   MERGE_PAUSED              a customer still carries a merge lock (an interrupted merge)
//   MANAGER_ORDER_HAS_VISIT   a manager-entered order that carries a visit link

const norm = (s) => String(s ?? '').trim().toLowerCase();
export function itemsFingerprint(items) {
  return (items || [])
    .map(i => `${norm(i.productId || i.desc)}|${Number(i.qty) || 0}|${Number(i.price) || 0}`)
    .sort().join(';');
}
const totalOf = (x) => Number(x.grandTotal ?? (x.items || []).reduce((s, i) => s + (i.total || 0), 0)) || 0;

export function reconcile({ orders = [], invoices = [], stockMovements = null, cancellations = null, invoiceNumbers = null, counter = null,
  customers = null, scheduleChanges = null, scheduleConfig = null }) {
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
      const byOrder = new Map();
      for (const m of stockMovements) if (m.type === 'order-cancelled' && m.orderId) (byOrder.get(m.orderId) || byOrder.set(m.orderId, []).get(m.orderId)).push(m);
      for (const o of orders) {
        if (o.status !== 'Cancelled') continue;
        const rec = recById.get(o.id); const moves = byOrder.get(o.id) || [];
        const restored = moves.reduce((n, m) => n + (Number(m.delta) || 0), 0);
        if (rec && rec.stockRestored === true && restored !== trackedQty(o)) add('CANCEL_STOCK_MISMATCH', 'high', { orderIds: [o.id] }, `Cancellation says stock was restored; the ledger restored ${restored} but the order had ${trackedQty(o)} tracked packs.`);
        if (rec && rec.stockRestored === false && moves.length) add('CANCEL_STOCK_MISMATCH', 'high', { orderIds: [o.id] }, 'Cancellation says no stock was restored, but ledger entries exist.');
        if (moves.length > (o.items || []).filter(i => i.productId && Number(i.qty)).length) add('CANCEL_NOT_RESTORED_TWICE', 'high', { orderIds: [o.id] }, `${moves.length} restore entries for ${(o.items || []).length} lines: possible double restore.`);
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

  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  return { findings, counts, safeToEnableResume: findings.every(f => f.severity === 'info') };
}
