// RC3 data migration planner. PURE: takes data, returns a plan. Never writes. Invents nothing.
//
// Actions it may propose (all additive, none overwrite or delete a business value):
//   REGISTER_NUMBER  create invoiceNumbers/{invoiceNo} {invoiceId, issuedBy, issuedAt, migrated:true} for an invoice number that is not registered yet
//   LABEL_KIND       set kind:'order' on an old invoice that an order demonstrably points to (order.invoiceId, or invoice.orderId)
// Things it only REPORTS (a person must decide; the tool will not guess):
//   NEEDS_REVIEW     old invoice with no order link and no kind (stand-alone? orphan?), duplicate numbers, cancelled orders with no record
//   COUNTER_BEHIND   the counter would issue an existing number (fix in the app: Invoices -> Numbering, with a reason)
//   HISTORY_NOT_STARTED  the schedule history has not been started (a manager does it in the app so the server clock is used)
export function planMigration({ invoices = [], orders = [], invoiceNumbers = [], counter = null, cancellations = [], scheduleConfig = null }) {
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
  if (!scheduleConfig) report.push({ type: 'HISTORY_NOT_STARTED', detail: 'Schedule history is not started. A manager starts it in the app; until then past dates show "no reliable history".' });
  return { actions, report };
}
