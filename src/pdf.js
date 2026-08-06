import { jsPDF } from 'jspdf';
import { LOGO_DATA_URI } from './logo.js';
import { mwk } from './items.js';
import { formatDate } from './preview.js';

export function generatePdf({ invoiceNo, date, customer, phone, location, terms, providerPhone, items, notes }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 48;
  const forest = [20, 64, 31], leaf = [76, 175, 80], muted = [107, 117, 104], ink = [23, 36, 26];

  const logoW = 170, logoH = logoW * (418 / 866);
  doc.addImage(LOGO_DATA_URI, 'PNG', (pageWidth - logoW) / 2, 34, logoW, logoH);
  let y = 34 + logoH + 18;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...muted);
  doc.text('SALES INVOICE', pageWidth / 2, y, { align: 'center', charSpace: 1.5 });
  y += 16;

  if (providerPhone) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...forest);
    doc.text('Tel: ' + providerPhone, pageWidth / 2, y, { align: 'center' });
    y += 16;
  }
  y += 6;

  doc.setDrawColor(...leaf); doc.setLineWidth(1.2);
  doc.line(margin, y, pageWidth - margin, y);
  y += 22;

  const dateStr = date ? formatDate(date) : '-';

  function labelValue(label, value, x, yy, align) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...muted);
    doc.text(label.toUpperCase(), x, yy, { align: align || 'left' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...forest);
    doc.text(String(value), x, yy + 14, { align: align || 'left' });
  }

  labelValue('Invoice No.', invoiceNo, margin, y);
  labelValue('Date', dateStr, pageWidth - margin, y, 'right');
  y += 40;
  labelValue('Customer', customer, margin, y);
  labelValue('Phone', phone, pageWidth - margin, y, 'right');
  y += 40;
  labelValue('Location', location, margin, y);
  labelValue('Terms', terms, pageWidth - margin, y, 'right');
  y += 30;

  doc.setDrawColor(217, 211, 194); doc.setLineWidth(0.7);
  doc.line(margin, y, pageWidth - margin, y);
  y += 22;

  const colQtyX = margin, colDescX = margin + 40;
  const colPriceX = pageWidth - margin - 150, colTotalX = pageWidth - margin;

  doc.setFillColor(...forest);
  doc.rect(margin, y - 12, pageWidth - margin * 2, 20, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255);
  doc.text('QTY', colQtyX + 4, y + 2);
  doc.text('DESCRIPTION', colDescX, y + 2);
  doc.text('UNIT PRICE', colPriceX + 60, y + 2, { align: 'right' });
  doc.text('TOTAL', colTotalX, y + 2, { align: 'right' });
  y += 20;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  let grandTotal = 0;

  if (items.length === 0) {
    doc.setTextColor(...muted);
    doc.text('No items added', colDescX, y + 6);
    y += 20;
  }

  items.forEach((it, idx) => {
    grandTotal += it.total;
    const rowH = 20;
    if (idx % 2 === 1) {
      doc.setFillColor(246, 244, 236);
      doc.rect(margin, y - 6, pageWidth - margin * 2, rowH, 'F');
    }
    doc.setTextColor(...ink);
    doc.text(String(it.qty), colQtyX + 4, y + 8);
    doc.text(it.desc || '-', colDescX, y + 8, { maxWidth: colPriceX - colDescX - 10 });
    doc.text(mwk(it.price), colPriceX + 60, y + 8, { align: 'right' });
    doc.text(mwk(it.total), colTotalX, y + 8, { align: 'right' });
    y += rowH;
  });

  y += 14;
  doc.setDrawColor(...leaf); doc.setLineWidth(1.2);
  doc.line(pageWidth - margin - 220, y - 10, pageWidth - margin, y - 10);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...forest);
  doc.text('GRAND TOTAL', pageWidth - margin - 220, y + 8);
  doc.setFontSize(14);
  doc.text(mwk(grandTotal), pageWidth - margin, y + 10, { align: 'right' });
  y += 36;

  if (notes) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...muted);
    doc.text('NOTES', margin, y); y += 14;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
    const noteLines = doc.splitTextToSize(notes, pageWidth - margin * 2);
    doc.text(noteLines, margin, y);
    y += noteLines.length * 12 + 16;
  }

  y += 20;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...ink);
  doc.text('Customer Signature: ______________________________________', margin, y);
  y += 34;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...forest);
  doc.text('Thank you for your business!', pageWidth / 2, y, { align: 'center' });

  const fileSafeInvoiceNo = invoiceNo.replace(/[^a-zA-Z0-9-_]/g, '_');
  const custSafe = customer.replace(/[^a-zA-Z0-9-_]/g, '_');
  const filename = `${fileSafeInvoiceNo}_${custSafe}.pdf`;

  try { doc.save(filename); } catch (e) { console.warn('doc.save failed', e); }
  const blobUrl = doc.output('bloburl');
  const opened = window.open(blobUrl, '_blank');
  if (!opened) {
    const a = document.createElement('a');
    a.href = blobUrl; a.download = filename; a.target = '_blank';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  return { grandTotal, filename };
}