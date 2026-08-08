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

// Compact one-line summary of all items on an invoice, used in the
// Invoices sheet "Products" column so the manager can read it at a glance.
function buildProductSummary(items) {
  if (!items || items.length === 0) return '—';
  return items.map(it => `${it.qty}× ${it.desc || '—'}`).join(', ');
}

export async function buildAndDownloadInvoiceReport(invoices, fromDate, toDate) {
  const { labels, revenue, counts } = aggregateByDate(invoices);
  const revenueImg = renderChartImage({ labels, data: revenue, label: 'Revenue (MWK)', color: '#1f5c30', type: 'line' });
  const countImg = renderChartImage({ labels, data: counts, label: 'Invoices', color: '#c98a2c', type: 'bar' });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Naisi Foods Invoice Generator';
  workbook.created = new Date();

  // ---- Invoices sheet (one row per invoice) ----
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
      invoiceNo:  inv.invoiceNo,
      date:       inv.date,
      customer:   inv.customer,
      phone:      inv.phone,
      location:   inv.location,
      products:   buildProductSummary(inv.items),
      grandTotal: inv.grandTotal || 0,
    });
  });
  dataSheet.getColumn('grandTotal').numFmt = '#,##0.00';
  // Wrap the Products column so long text doesn't spill out of view.
  dataSheet.getColumn('products').alignment = { wrapText: true };

  // ---- Items Detail sheet (one row per line item) ----
  // This is the key addition: managers can pivot by description to see
  // which products sell most, or sum quantities across invoices.
  const itemsSheet = workbook.addWorksheet('Items Detail');
  itemsSheet.columns = [
    { header: 'Invoice No.', key: 'invoiceNo',   width: 18 },
    { header: 'Date',        key: 'date',        width: 12 },
    { header: 'Customer',    key: 'customer',    width: 24 },
    { header: 'Description', key: 'desc',        width: 38 },
    { header: 'Qty (Boxes)', key: 'qty',         width: 12 },
    { header: 'Unit Price',  key: 'unitPrice',   width: 14 },
    { header: 'Line Total',  key: 'lineTotal',   width: 14 },
  ];
  itemsSheet.getRow(1).font = { bold: true };
  invoices.forEach(inv => {
    (inv.items || []).forEach(it => {
      itemsSheet.addRow({
        invoiceNo: inv.invoiceNo,
        date:      inv.date,
        customer:  inv.customer,
        desc:      it.desc || '—',
        qty:       it.qty  || 0,
        unitPrice: it.price || 0,
        lineTotal: it.total || 0,
      });
    });
  });
  ['unitPrice', 'lineTotal'].forEach(col => {
    itemsSheet.getColumn(col).numFmt = '#,##0.00';
  });

  // ---- Charts sheet ----
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
  a.href = url;
  a.download = `naisi-invoices_${fromDate}_to_${toDate}.xlsx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}