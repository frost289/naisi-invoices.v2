// READ-ONLY decision aid for orders left in "Invoicing" (an interrupted attempt or a release interruption).
// INVOICING_RESUME_ENABLED is false, so the app never releases such a lock by itself and there is NO automatic ten-minute recovery.
// This function only classifies; a developer applies the change by hand (docs/RC5-DEVELOPER-ROLLOUT-GUIDE.md, section "Stuck Invoicing").
//   SAFE_TO_RELEASE   no invoice exists for the order (id ord_<orderId>, or any invoice naming the order) and no registered number points at one:
//                     put the order back to Approved (status, clear invoicingAttempt and invoicingLeaseStartedAt) - nothing was issued.
//   ALREADY_INVOICED  an invoice for the order exists: do NOT release. Set status Invoiced with invoiceId/invoiceNo only after checking
//                     the invoice, the number registry and the counter (this should not happen, saves are atomic) - treat as a high finding.
//   NEEDS_REVIEW      anything ambiguous (a number registered to an invoice that does not exist, several invoices, order missing lines...).
export function classifyStuckInvoicing({ orders = [], invoices = [], invoiceNumbers = [] }) {
  const byOrder = new Map();
  for (const inv of invoices) {
    const oid = inv.orderId || (typeof inv.id === 'string' && inv.id.startsWith('ord_') ? inv.id.slice(4) : null);
    if (oid) (byOrder.get(oid) || byOrder.set(oid, []).get(oid)).push(inv);
  }
  const invIds = new Set(invoices.map(i => i.id));
  const out = [];
  for (const o of orders) {
    if (o.status !== 'Invoicing') continue;
    const found = byOrder.get(o.id) || [];
    const reg = invoiceNumbers.filter(n => n.invoiceId && (n.invoiceId === 'ord_' + o.id || found.some(f => f.id === n.invoiceId)));
    const dangling = invoiceNumbers.filter(n => n.invoiceId === 'ord_' + o.id && !invIds.has(n.invoiceId));
    let verdict, why;
    if (found.length === 1 && !dangling.length) { verdict = 'ALREADY_INVOICED'; why = `Invoice ${found[0].invoiceNo || found[0].id} exists for this order. Do not release the lock.`; }
    else if (found.length > 1) { verdict = 'NEEDS_REVIEW'; why = `${found.length} invoices claim this order.`; }
    else if (dangling.length) { verdict = 'NEEDS_REVIEW'; why = `Number ${dangling[0].id || dangling[0].invoiceNo} is registered to invoice ord_${o.id}, which does not exist.`; }
    else if (reg.length) { verdict = 'NEEDS_REVIEW'; why = 'A registered number points at a related invoice.'; }
    else { verdict = 'SAFE_TO_RELEASE'; why = 'No invoice and no registered number exist for this order: the interrupted attempt issued nothing.'; }
    out.push({ orderId: o.id, orderNo: o.orderNo || null, customer: o.customerName || null, verdict, why,
      manualSteps: verdict === 'SAFE_TO_RELEASE'
        ? [`Freeze writes first (rules/maintenance-freeze.rules) or confirm no manager is invoicing it.`, `In the Firebase console (or an admin script run by the developer) open orders/${o.id}.`, `Set status = "Approved"; delete invoicingAttempt and invoicingLeaseStartedAt; set updatedAt = now.`, `Re-run this tool: the order must no longer be listed.`]
        : [`Do not change the order. Resolve with the owner: ${why}`] });
  }
  return { orders: out, summary: { total: out.length, safe: out.filter(x => x.verdict === 'SAFE_TO_RELEASE').length, alreadyInvoiced: out.filter(x => x.verdict === 'ALREADY_INVOICED').length, review: out.filter(x => x.verdict === 'NEEDS_REVIEW').length } };
}
