import ExcelJS from 'exceljs';
import Chart from 'chart.js/auto';

// Buckets invoices by their date string into two parallel series.
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

// Renders a Chart.js chart on an off-DOM canvas, returns a PNG data URL.
function renderChartImage({ labels, data, label, color, type }) {
  const canvas = document.createElement('canvas');
  canvas.width = 700;
  canvas.height = 350;

  const chart = new Chart(canvas, {
    type,
    data: { labels, datasets: [{ label, data, borderColor: color, backgroundColor: color, tension: 0.25 }] },
    options: {
      responsive: false,
      animation: false,
      plugins: { legend: { display: true } },
      scales: { y: { beginAtZero: true } },
    },
  });

  const dataUrl = canvas.toDataURL('image/png');
  chart.destroy();
  return dataUrl;
}

export async function buildAndDownloadInvoiceReport(invoices, fromDate, toDate) {
  const { labels, revenue, counts } = aggregateByDate(invoices);

  const revenueImg = renderChartImage({ labels, data: revenue, label: 'Revenue (MWK)', color: '#1f5c30', type: 'line' });
  const countImg = renderChartImage({ labels, data: counts, label: 'Invoices', color: '#c98a2c', type: 'bar' });

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Naisi Foods Invoice Generator';
  workbook.created = new Date();

  // --- Data sheet ---
  const dataSheet = workbook.addWorksheet('Invoices');
  dataSheet.columns = [
    { header: 'Invoice No.', key: 'invoiceNo', width: 18 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Customer', key: 'customer', width: 24 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Location', key: 'location', width: 18 },
    { header: 'Total (MWK)', key: 'grandTotal', width: 16 },
  ];
  dataSheet.getRow(1).font = { bold: true };
  invoices.forEach(inv => {
    dataSheet.addRow({
      invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer,
      phone: inv.phone, location: inv.location, grandTotal: inv.grandTotal || 0,
    });
  });
  dataSheet.getColumn('grandTotal').numFmt = '#,##0.00';

  // --- Charts sheet ---
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
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}