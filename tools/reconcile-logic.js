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

const norm = (s) => String(s ?? '').trim().toLowerCase();
export function itemsFingerprint(items) {
  return (items || [])
    .map(i => `${norm(i.productId || i.desc)}|${Number(i.qty) || 0}|${Number(i.price) || 0}`)
    .sort().join(';');
}
const totalOf = (x) => Number(x.grandTotal ?? (x.items || []).reduce((s, i) => s + (i.total || 0), 0)) || 0;

export function reconcile({ orders = [], invoices = [] }) {
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
  const unlinked = invoices.filter(i => !linkedInvoiceIds.has(i.id));

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

  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  return { findings, counts, safeToEnableResume: findings.every(f => f.severity === 'info') };
}
