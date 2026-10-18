// READ-ONLY decision aid for orders left in "Invoicing" (an interrupted attempt or a release interruption).
// INVOICING_RESUME_ENABLED is false, so the app never releases such a lock by itself and there is NO automatic ten-minute recovery.
// This function only classifies; a developer applies any change by hand (docs/RC6-DEVELOPER-REVIEW-GUIDE.md, "Stuck Invoicing").
//
// RC6: the RC5 classifier looked only at invoice.orderId and the id ord_<orderId>, so it could call an order SAFE_TO_RELEASE when a
// legacy invoice existed (linked by order.invoiceId / order.invoiceNo, by the number registry, or not linked at all). Releasing such an
// order lets the app issue a SECOND invoice for the same sale. SAFE_TO_RELEASE is now a narrow, positive conclusion:
//
//   every input present and well-formed
//   AND the export is confirmed to have been taken after writes were frozen (freezeConfirmed)
//   AND no invoice, registry entry or pointer of any kind is associated with the order
//   AND no unclaimed invoice looks like it (same customer, items and total: a POSSIBLE ORPHAN, never proof of identity)
//
// Verdicts:
//   SAFE_TO_RELEASE   all of the above hold. A developer may put the order back to Approved by hand.
//   ALREADY_INVOICED  an invoice exists and every link agrees. Do NOT release. (Complete the order record only after checking by hand.)
//   NEEDS_REVIEW      anything else: broken or conflicting links, multiple invoices, a registered number without its invoice, a possible
//                     orphan, an export not confirmed as taken after the freeze. Nothing is linked or released automatically.
// If an input is missing or malformed the result has inputsComplete:false and NO order gets a safety claim (verdict INPUTS_INCOMPLETE).
import { itemsFingerprint } from './reconcile-logic.js';

const norm = (s) => String(s ?? '').trim().toLowerCase();
const totalOf = (x) => Number(x.grandTotal ?? (x.items || []).reduce((s, i) => s + (i.total || 0), 0)) || 0;
const isDoc = (d) => d && typeof d === 'object' && typeof d.id === 'string' && d.id.length > 0;
const validIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function classifyStuckInvoicing({ orders, invoices, invoiceNumbers, frozenAt = null, exportedAt = null } = {}) {
  const problems = [];
  const need = (name, v) => { if (!Array.isArray(v)) problems.push(`${name} was not supplied (or is not a list).`); else if (!v.every(isDoc)) problems.push(`${name} contains an entry without an id.`); };
  need('orders', orders); need('invoices', invoices); need('invoiceNumbers', invoiceNumbers);
  const inputsComplete = problems.length === 0;

  // Freeze confirmation: the person running the tool states when writes were frozen and when the export was taken.
  let freezeConfirmed = false, freezeNote;
  if (!validIso(frozenAt) || !validIso(exportedAt)) freezeNote = 'Not confirmed: supply --frozen-at and --exported-at (ISO times). A release cannot be recommended from an export that may predate the freeze.';
  else if (Date.parse(exportedAt) < Date.parse(frozenAt)) freezeNote = 'Not confirmed: the export was taken BEFORE writes were frozen. Take a new export after the freeze.';
  else { freezeConfirmed = true; freezeNote = `Export at ${exportedAt} is after the freeze at ${frozenAt}.`; }

  if (!inputsComplete) {
    const stuck = Array.isArray(orders) ? orders.filter(o => o && o.status === 'Invoicing') : [];
    return { inputsComplete, freezeConfirmed, freezeNote, problems,
      orders: stuck.map(o => ({ orderId: o.id, orderNo: o.orderNo || null, customer: o.customerName || null, verdict: 'INPUTS_INCOMPLETE', reasons: ['A required input is missing or malformed, so nothing can be concluded about this order.'], manualSteps: ['Do not change the order. Supply all three exports and run again.'] })),
      summary: { total: stuck.length, safe: 0, alreadyInvoiced: 0, review: 0, incomplete: stuck.length } };
  }

  const invById = new Map(invoices.map(i => [i.id, i]));
  const registryByNo = new Map(invoiceNumbers.map(n => [n.id, n]));
  const claimedBy = new Map();                       // invoice id -> order ids that point at it (order.invoiceId)
  for (const o of orders) if (o.invoiceId) (claimedBy.get(o.invoiceId) || claimedBy.set(o.invoiceId, []).get(o.invoiceId)).push(o.id);

  const out = [];
  for (const o of orders) {
    if (o.status !== 'Invoicing') continue;
    const reasons = [];                              // anything that blocks SAFE_TO_RELEASE
    const related = new Map();                       // invoice id -> how it is associated
    const link = (inv, how) => related.set(inv.id, [...(related.get(inv.id) || []), how]);
    const detId = 'ord_' + o.id;

    // 1. pointers on the order
    if (o.invoiceId) { const inv = invById.get(o.invoiceId); if (inv) link(inv, 'order.invoiceId'); else reasons.push(`Order.invoiceId points to ${o.invoiceId}, which does not exist.`); }
    if (o.invoiceNo) {
      const byNo = invoices.filter(i => i.invoiceNo === o.invoiceNo);
      byNo.forEach(i => link(i, 'order.invoiceNo'));
      if (!byNo.length) reasons.push(`Order.invoiceNo is ${o.invoiceNo}, but no invoice carries that number.`);
      if (registryByNo.has(o.invoiceNo) && !byNo.length) reasons.push(`Number ${o.invoiceNo} is registered but its invoice is missing.`);
    }
    // 2. pointers on invoices and the deterministic id
    invoices.filter(i => i.orderId === o.id).forEach(i => link(i, 'invoice.orderId'));
    if (invById.has(detId)) link(invById.get(detId), 'deterministic id');
    // 3. registry relationships
    for (const n of invoiceNumbers) {
      const targets = [n.invoiceId].filter(Boolean);
      if (targets.includes(detId) || (n.invoiceId && related.has(n.invoiceId))) {
        const inv = invById.get(n.invoiceId);
        if (!inv) reasons.push(`Registered number ${n.id} points to invoice ${n.invoiceId}, which does not exist.`);
        else { link(inv, 'number registry'); if (inv.invoiceNo && inv.invoiceNo !== n.id) reasons.push(`Registry entry ${n.id} points to invoice ${inv.id}, which carries number ${inv.invoiceNo}.`); }
      }
    }
    // 4. consistency of what was found
    const ids = [...related.keys()];
    for (const id of ids) {
      const inv = invById.get(id);
      if (inv.orderId && inv.orderId !== o.id) reasons.push(`Invoice ${inv.invoiceNo || id} says it belongs to order ${inv.orderId}, not this order.`);
      const others = (claimedBy.get(id) || []).filter(x => x !== o.id);
      if (others.length) reasons.push(`Invoice ${inv.invoiceNo || id} is also claimed by order(s) ${others.join(', ')}.`);
      if (inv.invoiceNo && !registryByNo.has(inv.invoiceNo)) reasons.push(`Invoice number ${inv.invoiceNo} is not in the number registry (legacy invoice: run the migration preflight).`);
      else if (inv.invoiceNo && registryByNo.get(inv.invoiceNo).invoiceId && registryByNo.get(inv.invoiceNo).invoiceId !== id) reasons.push(`Number ${inv.invoiceNo} is registered to invoice ${registryByNo.get(inv.invoiceNo).invoiceId}, not ${id}.`);
    }
    if (ids.length > 1) reasons.push(`${ids.length} invoices are associated with this order (${ids.join(', ')}).`);

    // 5. possible orphans: unclaimed invoices that look like this order (never proof of identity)
    let orphans = [];
    if (!ids.length) {
      const fp = itemsFingerprint(o.items), total = totalOf(o);
      orphans = invoices.filter(i => !i.orderId && !(claimedBy.get(i.id) || []).length && norm(i.customer) === norm(o.customerName) && totalOf(i) === total && itemsFingerprint(i.items) === fp).map(i => i.id);
      if (orphans.length) reasons.push(`Possible orphan invoice(s) ${orphans.join(', ')} have the same customer, items and total and are linked to no order. That is NOT proof they belong to this order: a person must decide. Nothing is linked automatically.`);
    }

    let verdict;
    if (ids.length === 1 && !reasons.some(r => !/not in the number registry/.test(r))) { verdict = 'ALREADY_INVOICED'; }
    else if (ids.length >= 1 || reasons.length) verdict = 'NEEDS_REVIEW';
    else if (!freezeConfirmed) { verdict = 'NEEDS_REVIEW'; reasons.push(`No invoice or link was found, but a release is not recommended. ${freezeNote}`); }
    else verdict = 'SAFE_TO_RELEASE';

    const how = ids.map(id => `${invById.get(id).invoiceNo || id} (${related.get(id).join(', ')})`);
    out.push({ orderId: o.id, orderNo: o.orderNo || null, customer: o.customerName || null, verdict, associatedInvoices: how, possibleOrphans: orphans,
      reasons: verdict === 'ALREADY_INVOICED' ? [`Invoice ${how[0]} exists for this order. Do not release the lock.`, ...reasons] : verdict === 'SAFE_TO_RELEASE' ? ['No invoice, pointer, registry entry or look-alike exists, and the export was taken after the freeze.'] : reasons,
      manualSteps: verdict === 'SAFE_TO_RELEASE'
        ? ['Confirm writes are still frozen (rules/maintenance-freeze.rules).', `In the Firebase console open orders/${o.id}.`, 'Set status = "Approved"; delete invoicingAttempt and invoicingLeaseStartedAt; set updatedAt = now.', 'Take a new export and re-run this tool: the order must no longer be listed.']
        : ['Do not change the order or any invoice. Resolve with the owner using the reasons above; this tool never links or releases anything.'] });
  }
  return { inputsComplete, freezeConfirmed, freezeNote, problems, orders: out,
    summary: { total: out.length, safe: out.filter(x => x.verdict === 'SAFE_TO_RELEASE').length, alreadyInvoiced: out.filter(x => x.verdict === 'ALREADY_INVOICED').length, review: out.filter(x => x.verdict === 'NEEDS_REVIEW').length, incomplete: 0 } };
}
