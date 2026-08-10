import ExcelJS from 'exceljs';
import Chart from 'chart.js/auto';

function aggregateByDate(invoices) {
  const map = {};
  invoices.forEach(inv => {
    const d = inv.date || 'unknown';
    if (!map[d]) map[d] = { revenue: 0, count: 0 };
    map[d].revenue += inv.grandTotal || 0;
    map[d].count += 1;
  });
  const dates = Object.keys(map).sort();
  return {
    labels: dates,
    revenue: dates.map(d => map[d].revenue),
    counts: dates.map(d => map[d].count),
  };
}

function renderChartImage({ labels, data, label, color, type }) {
  const canvas = document.createElement('canvas');
  canvas.width = 700; canvas.height = 350;
  const chart = new Chart(canvas, {
    type,
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color, tension: 0.25 }] },
    options: { responsive: false, animation: false, plugins: { legend: { display: true } }, scales: { y: { beginAtZero: true } } },
  });
  const dataUrl = canvas.toDataURL('image/png');
  chart.destroy();
  return dataUrl;
}

function buildProductSummary(items) {
  if (!items || items.length === 0) return '—';
  return items.map(it => `${it.qty}× ${it.desc || '—'}`).join(', ');
}

function productKey(it) {
  return it.productName || it.desc || 'Unknown';
}

export async function buildAndDownloadInvoiceReport(invoices, fromDate, toDate) {
  const { labels, revenue, counts } = aggregateByDate(invoices);
  const revenueImg = renderChartImage({ labels, data: revenue, label: 'Revenue (MWK)', color: '#1f5c30', type: 'line' });
  const countImg = renderChartImage({ labels, data: counts, label: 'Invoices', color: '#c98a2c', type: 'bar' });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Naisi Foods Invoice Generator';
  workbook.created = new Date();

  const dataSheet = workbook.addWorksheet('Invoices');
  dataSheet.columns = [
    { header: 'Invoice No.', key: 'invoiceNo', width: 18 },
    { header: 'Date',        key: 'date',      width: 12 },
    { header: 'Customer',    key: 'customer',   width: 24 },
    { header: 'Phone',       key: 'phone',      width: 16 },
    { header: 'Location',    key: 'location',   width: 18 },
    { header: 'Products',    key: 'products',   width: 48 },
    { header: 'Total (MWK)', key: 'grandTotal', width: 16 },
  ];
  dataSheet.getRow(1).font = { bold: true };
  invoices.forEach(inv => {
    dataSheet.addRow({
      invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer,
      phone: inv.phone, location: inv.location,
      products: buildProductSummary(inv.items),
      grandTotal: inv.grandTotal || 0,
    });
  });
  dataSheet.getColumn('grandTotal').numFmt = '#,##0.00';
  dataSheet.getColumn('products').alignment = { wrapText: true };

  const itemsSheet = workbook.addWorksheet('Items Detail');
  itemsSheet.columns = [
    { header: 'Invoice No.', key: 'invoiceNo',   width: 18 },
    { header: 'Date',        key: 'date',        width: 12 },
    { header: 'Customer',    key: 'customer',    width: 24 },
    { header: 'Product',     key: 'product',     width: 30 },
    { header: 'Pack',        key: 'pack',        width: 26 },
    { header: 'Pack Qty',    key: 'packQty',      width: 12 },
    { header: 'Boxes Ordered', key: 'qty',       width: 14 },
    { header: 'Unit Price',  key: 'unitPrice',   width: 14 },
    { header: 'Line Total',  key: 'lineTotal',   width: 14 },
  ];
  itemsSheet.getRow(1).font = { bold: true };
  invoices.forEach(inv => {
    (inv.items || []).forEach(it => {
      itemsSheet.addRow({
        invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer,
        product: it.productName || it.desc || '—',
        pack: it.packLabel || '—',
        packQty: it.packQuantity ?? '—',
        qty: it.qty || 0,
        unitPrice: it.price || 0,
        lineTotal: it.total || 0,
      });
    });
  });
  ['unitPrice', 'lineTotal'].forEach(col => { itemsSheet.getColumn(col).numFmt = '#,##0.00'; });

  const totalsSheet = workbook.addWorksheet('Product Totals');
  const totals = {};
  invoices.forEach(inv => {
    (inv.items || []).forEach(it => {
      const key = productKey(it);
      if (!totals[key]) totals[key] = { qty: 0, revenue: 0 };
      totals[key].qty += it.qty || 0;
      totals[key].revenue += it.total || 0;
    });
  });
  const sortedTotals = Object.entries(totals).sort((a, b) => b[1].qty - a[1].qty);

  totalsSheet.columns = [
    { header: 'Product',        key: 'product', width: 34 },
    { header: 'Total Qty (Boxes)', key: 'qty',  width: 18 },
    { header: 'Total Revenue (MWK)', key: 'revenue', width: 20 },
  ];
  totalsSheet.getRow(1).font = { bold: true };
  sortedTotals.forEach(([product, t]) => {
    totalsSheet.addRow({ product, qty: t.qty, revenue: t.revenue });
  });
  totalsSheet.getColumn('revenue').numFmt = '#,##0.00';

  const chartSheet = workbook.addWorksheet('Charts');
  chartSheet.getCell('A1').value = `Report range: ${fromDate} to ${toDate}`;
  chartSheet.getCell('A1').font = { bold: true, size: 12 };
  const revenueImageId = workbook.addImage({ base64: revenueImg, extension: 'png' });
  chartSheet.addImage(revenueImageId, { tl: { col: 0, row: 2 }, ext: { width: 700, height: 350 } });
  const countImageId = workbook.addImage({ base64: countImg, extension: 'png' });
  chartSheet.addImage(countImageId, { tl: { col: 0, row: 22 }, ext: { width: 700, height: 350 } });

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `naisi-invoices_${fromDate}_to_${toDate}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}