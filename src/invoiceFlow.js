// Per-order bulk invoicing, kept free of UI so it can be tested.
//
//   issue(...)   -> issueInvoiceForOrder (injected)      saves the invoice
//   makePdf(...) -> generatePdf (injected)               downloads a PDF
//
// Rule: once issue() has resolved the invoice IS saved. A PDF problem after
// that is reported as "saved, PDF failed", and the retry callback only calls
// makePdf again — it never calls issue().
import { orderRevisionKey } from './orderRevision.js';

export function buildOrderInvoiceMeta(order, today) {
  return {
    date: today,
    customer: order.customerName || '-',
    customerId: order.customerId || null,
    phone: order.customerPhone === '-' ? '-' : (order.customerPhone || '-'),
    location: order.customerLocation === '-' ? '-' : (order.customerLocation || '-'),
    terms: 'CASH ON DELIVERY (COD)',
    providerPhone: '',
    notes: order.notes || '',
    items: order.items || [],
  };
}

export async function invoiceOrderForBulk({ order, today, uid, issue, makePdf }) {
  const meta = buildOrderInvoiceMeta(order, today);
  let committed;
  try {
    committed = await issue({ orderId: order.id, meta, expectedRevision: orderRevisionKey(order), uid });
  } catch (err) {
    if (err.alreadyInvoiced) return { state: 'skipped', invoiceNo: err.invoiceNo, text: 'Already invoiced earlier' };
    return { state: 'failed', text: err.message };
  }
  const pdfArgs = { ...meta, invoiceNo: committed.invoiceNo };
  try {
    makePdf(pdfArgs);
  } catch (pdfErr) {
    console.error(pdfErr);
    return {
      state: 'done', invoiceNo: committed.invoiceNo, amount: committed.grandTotal,
      text: `Invoice saved · PDF failed (${pdfErr?.message || pdfErr})`,
      retryPdf: () => makePdf(pdfArgs),
    };
  }
  return { state: 'done', invoiceNo: committed.invoiceNo, amount: committed.grandTotal, text: 'Invoice saved and downloaded' };
}
