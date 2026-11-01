// Phase 1, Stage 4 — expense control reports.
//
// Each report is a PURE builder: records in -> { title, columns, rows, totals, note }. One renderer
// (src/controlReportsUi.js) and one Excel exporter (exportReportXlsx below) serve every report, and the arithmetic is
// unit-tested without a database (tests/unit/controlReports.test.js).
//
// Dates: a report range is two Malawi calendar dates 'YYYY-MM-DD' (inclusive). Records carrying a date string
// (expense lines, expenses) are compared directly; records carrying a timestamp (money issued, decisions, periods)
// are converted to their Malawi calendar day first.

import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs, query, where } from 'firebase/firestore';
import { malawiDate } from './malawiTime.js';
import { round2, periodPosition, closingBalance } from './floatMath.js';
import { categoryLabel } from './expenseCategories.js';

// ---------- small helpers ----------
const day = (ts) => (ts && ts.toDate ? malawiDate(ts.toDate()) : (typeof ts === 'string' ? ts : ''));
const inRange = (d, from, to) => !!d && d >= from && d <= to;
const sum = (xs, f) => round2(xs.reduce((s, x) => s + Number(f(x) || 0), 0));
export function personName(names, uid, email) {
  const p = names && names[uid];
  return (p && (p.name || p.email)) || email || uid || '—';
}
const col = (key, label, type = 'text') => ({ key, label, type });
const byText = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));

// ===================================================================================================
// PRIORITY 1
// ===================================================================================================

// 1. Float Balance Summary — current position of every float holder.
export function floatBalanceSummary({ settings, openPeriods, names }) {
  const openBy = Object.fromEntries((openPeriods || []).map(p => [p.staffUid, p]));
  const rows = (settings || []).map(s => {
    const p = openBy[s.staffUid];
    const pos = p ? periodPosition(p) : null;
    return {
      person: personName(names, s.staffUid, s.staffEmail),
      target: round2(s.floatTarget || 0),
      status: p ? 'Open since ' + (p.startDate || '') : 'No open period',
      opening: pos ? pos.opening : null,
      issued: pos ? pos.issued : null,
      approved: pos ? pos.approved : null,
      balance: pos ? pos.balance : (s.lastClosingBalance != null ? round2(s.lastClosingBalance) : null),
      topUp: pos ? pos.topUp : null,
    };
  }).sort(byText('person'));
  const open = rows.filter(r => r.topUp != null);
  return {
    title: 'Float Balance Summary',
    columns: [col('person', 'Person'), col('target', 'Target', 'money'), col('status', 'Period'), col('opening', 'Opening', 'money'),
      col('issued', 'Issued', 'money'), col('approved', 'Approved', 'money'), col('balance', 'Balance', 'money'), col('topUp', 'Top-up to target', 'money')],
    rows,
    totals: { person: 'Total', target: sum(rows, r => r.target), opening: sum(open, r => r.opening), issued: sum(open, r => r.issued),
      approved: sum(open, r => r.approved), balance: sum(rows, r => r.balance), topUp: sum(open, r => r.topUp) },
    note: 'Balance for a person with no open period is their last closing balance. Cash in the field = total balance.',
  };
}

// 2. Money Issued Log — every issue and reversal in the range.
export function moneyIssuedLog({ records, names, from, to }) {
  const rows = (records || []).filter(r => inRange(day(r.issuedAt), from, to)).map(r => ({
    date: day(r.issuedAt),
    person: personName(names, r.recipientUid, r.recipientEmail),
    type: r.kind === 'reversal' ? 'Reversal' : (r.reversedById ? 'Issue (reversed)' : 'Issue'),
    amount: r.kind === 'reversal' ? -round2(r.amount) : round2(r.amount),
    method: r.method || '',
    reference: r.reference || '',
    purpose: r.notes || '',
    by: personName(names, r.issuedBy, r.issuedByEmail),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));
  return {
    title: 'Money Issued Log',
    columns: [col('date', 'Date', 'date'), col('person', 'Person'), col('type', 'Type'), col('amount', 'Amount', 'money'),
      col('method', 'Method'), col('reference', 'Reference'), col('purpose', 'Notes / purpose'), col('by', 'Issued by')],
    rows,
    totals: { date: 'Net issued', amount: sum(rows, r => r.amount) },
    note: 'Reversals are shown as negative amounts; the net is what actually went out.',
  };
}

// 3. Expense Report Summary — every report created in the range, claimed vs approved.
export function expenseReportSummary({ reports, lines, names, from, to }) {
  const byReport = {};
  for (const l of lines || []) (byReport[l.reportId] = byReport[l.reportId] || []).push(l);
  const label = { draft: 'Draft', submitted: 'Waiting for approval', reviewed: 'Reviewed' };
  const rows = (reports || []).filter(r => inRange(day(r.createdAt), from, to)).map(r => {
    const ls = byReport[r.id] || [];
    const claimed = sum(ls, l => l.amount);
    const approved = sum(ls.filter(l => l.lineStatus === 'approved'), l => l.amount);
    const rejected = sum(ls.filter(l => l.lineStatus === 'rejected'), l => l.amount);
    return {
      created: day(r.createdAt), person: personName(names, r.ownerUid, r.ownerEmail), report: r.title || 'Expenses',
      status: r.status === 'draft' && r.returnNote ? 'Sent back' : (label[r.status] || r.status),
      lines: ls.length, claimed, approved, rejected, pending: round2(claimed - approved - rejected),
      approvalRate: claimed > 0 ? round2((approved / claimed) * 100) : null,
    };
  }).sort((a, b) => a.created.localeCompare(b.created) || a.person.localeCompare(b.person));
  const claimed = sum(rows, r => r.claimed), approved = sum(rows, r => r.approved);
  return {
    title: 'Expense Report Summary',
    columns: [col('created', 'Created', 'date'), col('person', 'Person'), col('report', 'Report'), col('status', 'Status'), col('lines', 'Lines', 'int'),
      col('claimed', 'Claimed', 'money'), col('approved', 'Approved', 'money'), col('rejected', 'Rejected', 'money'), col('pending', 'Pending', 'money'),
      col('approvalRate', 'Approved %', 'pct')],
    rows,
    totals: { created: 'Total', lines: rows.reduce((s, r) => s + r.lines, 0), claimed, approved, rejected: sum(rows, r => r.rejected),
      pending: sum(rows, r => r.pending), approvalRate: claimed > 0 ? round2((approved / claimed) * 100) : null },
  };
}

// 4. Itemised Expense Lines — every claimed line with an expense date in the range.
export function itemisedLines({ lines, reports, names, vehicles, from, to, status = null }) {
  const rep = Object.fromEntries((reports || []).map(r => [r.id, r]));
  const veh = Object.fromEntries((vehicles || []).map(v => [v.id, v.registration]));
  const st = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };
  const rows = (lines || []).filter(l => inRange(l.date, from, to) && (!status || l.lineStatus === status)).map(l => ({
    date: l.date,
    person: personName(names, l.ownerUid, rep[l.reportId] && rep[l.reportId].ownerEmail),
    category: categoryLabel(l.category), subcategory: l.subcategory || '',
    what: l.notes || '', amount: round2(l.amount),
    status: (rep[l.reportId] && rep[l.reportId].status === 'draft') ? 'Draft' : (st[l.lineStatus] || l.lineStatus),
    payee: l.payee || '', receipt: l.receiptRef || '', vehicle: l.vehicleId ? (veh[l.vehicleId] || 'Vehicle removed') : '',
    decisionNote: l.decisionNote || '', report: rep[l.reportId] ? (rep[l.reportId].title || 'Expenses') : '',
  })).sort((a, b) => a.date.localeCompare(b.date) || a.person.localeCompare(b.person));
  return {
    title: status === 'rejected' ? 'Rejected Expense Log' : 'Itemised Expense Lines',
    columns: [col('date', 'Date', 'date'), col('person', 'Person'), col('category', 'Category'), col('subcategory', 'Type'), col('what', 'What'),
      col('amount', 'Amount', 'money'), col('status', 'Status'), col('payee', 'Paid to'), col('receipt', 'Receipt'), col('vehicle', 'Vehicle'),
      col('decisionNote', status === 'rejected' ? 'Reason' : 'Manager note'), col('report', 'Report')],
    rows,
    totals: { date: 'Total', amount: sum(rows, r => r.amount) },
  };
}

// 5. Fuel by Vehicle — fuel logged (Expenses / driver fuel log) plus approved Vehicle/Maintenance claims.
// Fuel without a vehicle is attributed to the vehicle assigned to the person who logged it (when exactly one), and
// counted separately so the attribution is visible; otherwise it is reported as "Not linked to a vehicle".
export function fuelByVehicle({ expenses, lines, vehicles, names, from, to }) {
  const vs = vehicles || [];
  const veh = Object.fromEntries(vs.map(v => [v.id, v]));
  const assigned = {};
  for (const v of vs) if (v.assignedToUid && v.active !== false) (assigned[v.assignedToUid] = assigned[v.assignedToUid] || []).push(v.id);
  const acc = {};
  const row = (key) => (acc[key] = acc[key] || { key, fuelCount: 0, fuel: 0, fuelViaDriver: 0, maintenance: 0 });
  for (const e of expenses || []) {
    if (e.category !== 'Fuel' || !inRange(e.date, from, to)) continue;
    let key = e.vehicleId && veh[e.vehicleId] ? e.vehicleId : null, viaDriver = false;
    if (!key && assigned[e.createdBy] && assigned[e.createdBy].length === 1) { key = assigned[e.createdBy][0]; viaDriver = true; }
    const r = row(key || '__none__:' + (e.createdBy || ''));
    r.fuelCount += 1; r.fuel += Number(e.amount || 0); if (viaDriver) r.fuelViaDriver += Number(e.amount || 0);
    if (!key) r.who = personName(names, e.createdBy, e.createdByEmail);
  }
  for (const l of lines || []) {
    if (l.category !== 'VehicleMaintenance' || l.lineStatus !== 'approved' || !inRange(l.date, from, to)) continue;
    row(l.vehicleId && veh[l.vehicleId] ? l.vehicleId : '__none__:' + l.ownerUid).maintenance += Number(l.amount || 0);
  }
  const rows = Object.values(acc).map(r => {
    const v = veh[r.key];
    return {
      vehicle: v ? v.registration : 'Not linked to a vehicle' + (r.who ? ' (' + r.who + ')' : ''),
      description: v ? (v.description || '') : '',
      driver: v && v.assignedToUid ? personName(names, v.assignedToUid) : '',
      fuelCount: r.fuelCount, fuel: round2(r.fuel), fuelViaDriver: round2(r.fuelViaDriver),
      maintenance: round2(r.maintenance), total: round2(r.fuel + r.maintenance),
    };
  }).sort((a, b) => b.total - a.total);
  return {
    title: 'Fuel by Vehicle',
    columns: [col('vehicle', 'Vehicle'), col('description', 'Description'), col('driver', 'Assigned driver'), col('fuelCount', 'Fuel entries', 'int'),
      col('fuel', 'Fuel', 'money'), col('fuelViaDriver', 'of which by assigned driver', 'money'), col('maintenance', 'Maintenance (approved)', 'money'),
      col('total', 'Total', 'money')],
    rows,
    totals: { vehicle: 'Total', fuelCount: rows.reduce((s, r) => s + r.fuelCount, 0), fuel: sum(rows, r => r.fuel),
      fuelViaDriver: sum(rows, r => r.fuelViaDriver), maintenance: sum(rows, r => r.maintenance), total: sum(rows, r => r.total) },
    note: '"of which by assigned driver": fuel logged without a vehicle, counted against the vehicle assigned to that driver. New driver fuel entries carry the vehicle automatically.',
  };
}

// 6. Rep Expense vs Float — per float holder over the range: what went out, what was claimed and decided.
export function expenseVsFloat({ settings, openPeriods, records, lines, names, from, to }) {
  const openBy = Object.fromEntries((openPeriods || []).map(p => [p.staffUid, p]));
  const rows = (settings || []).map(s => {
    const uid = s.staffUid;
    const issued = (records || []).filter(r => r.recipientUid === uid && inRange(day(r.issuedAt), from, to));
    const mine = (lines || []).filter(l => l.ownerUid === uid && inRange(l.date, from, to));
    const p = openBy[uid];
    const approved = sum(mine.filter(l => l.lineStatus === 'approved'), l => l.amount);
    const claimed = sum(mine, l => l.amount);
    return {
      person: personName(names, uid, s.staffEmail), target: round2(s.floatTarget || 0),
      issued: sum(issued, r => (r.kind === 'reversal' ? -1 : 1) * r.amount),
      claimed, approved,
      rejected: sum(mine.filter(l => l.lineStatus === 'rejected'), l => l.amount),
      pending: sum(mine.filter(l => l.lineStatus === 'pending'), l => l.amount),
      balanceNow: p ? periodPosition(p).balance : (s.lastClosingBalance != null ? round2(s.lastClosingBalance) : null),
      spendVsTarget: s.floatTarget > 0 ? round2((approved / s.floatTarget) * 100) : null,
    };
  }).sort(byText('person'));
  return {
    title: 'Rep Expense vs Float',
    columns: [col('person', 'Person'), col('target', 'Float target', 'money'), col('issued', 'Issued in range', 'money'), col('claimed', 'Claimed', 'money'),
      col('approved', 'Approved', 'money'), col('rejected', 'Rejected', 'money'), col('pending', 'Pending', 'money'), col('balanceNow', 'Balance now', 'money'),
      col('spendVsTarget', 'Approved as % of target', 'pct')],
    rows,
    totals: { person: 'Total', target: sum(rows, r => r.target), issued: sum(rows, r => r.issued), claimed: sum(rows, r => r.claimed),
      approved: sum(rows, r => r.approved), rejected: sum(rows, r => r.rejected), pending: sum(rows, r => r.pending), balanceNow: sum(rows, r => r.balanceNow) },
    note: 'Claims are counted by the date of the expense. "Approved as % of target" shows how hard each float is working over the range.',
  };
}

// ===================================================================================================
// PRIORITY 2
// ===================================================================================================

// Category Spend Analysis — approved claims by category, with each person's share.
export function categorySpend({ lines, names, from, to }) {
  const ok = (lines || []).filter(l => l.lineStatus === 'approved' && inRange(l.date, from, to));
  const total = sum(ok, l => l.amount);
  const byCat = {};
  for (const l of ok) {
    const c = (byCat[l.category] = byCat[l.category] || { amount: 0, count: 0, people: {} });
    c.amount += Number(l.amount); c.count += 1;
    c.people[l.ownerUid] = (c.people[l.ownerUid] || 0) + Number(l.amount);
  }
  const rows = Object.entries(byCat).map(([cat, c]) => {
    const [topUid, topAmt] = Object.entries(c.people).sort((a, b) => b[1] - a[1])[0];
    return { category: categoryLabel(cat), lines: c.count, amount: round2(c.amount), share: total > 0 ? round2((c.amount / total) * 100) : null,
      average: round2(c.amount / c.count), top: personName(names, topUid) + ' (' + round2((topAmt / c.amount) * 100) + '%)' };
  }).sort((a, b) => b.amount - a.amount);
  return {
    title: 'Category Spend Analysis',
    columns: [col('category', 'Category'), col('lines', 'Lines', 'int'), col('amount', 'Approved', 'money'), col('share', 'Share %', 'pct'),
      col('average', 'Average per line', 'money'), col('top', 'Biggest claimant (share)')],
    rows,
    totals: { category: 'Total', lines: ok.length, amount: total, share: total > 0 ? 100 : null },
    note: 'Approved float claims only. Fuel is outside the float; see Fuel by Vehicle.',
  };
}

// Period-over-Period — every closed float period, oldest first.
export function periodOverPeriod({ periods, names, from, to }) {
  const rows = (periods || []).filter(p => p.status === 'closed' && inRange(day(p.closedAt), from, to)).map(p => ({
    closed: day(p.closedAt), person: personName(names, p.staffUid, p.staffEmail), started: p.startDate || '',
    opening: round2(p.openingBalance || 0), issued: round2(p.totalIssued || 0), approved: round2(p.totalApproved || 0),
    closing: p.closingBalance != null ? round2(p.closingBalance) : closingBalance(p.openingBalance, p.totalIssued, p.totalApproved),
    topUp: round2(p.proposedTopUp || 0),
  })).sort((a, b) => a.closed.localeCompare(b.closed) || a.person.localeCompare(b.person));
  return {
    title: 'Period-over-Period',
    columns: [col('closed', 'Closed', 'date'), col('person', 'Person'), col('started', 'Started', 'date'), col('opening', 'Opening', 'money'),
      col('issued', 'Issued', 'money'), col('approved', 'Approved', 'money'), col('closing', 'Closing', 'money'), col('topUp', 'Proposed top-up', 'money')],
    rows,
    totals: { closed: 'Total', issued: sum(rows, r => r.issued), approved: sum(rows, r => r.approved), topUp: sum(rows, r => r.topUp) },
  };
}

// Manager Business Expenses — expenses logged by managers themselves (Expenses tab), by date.
export function managerOwnExpenses({ expenses, managerEmails, names, from, to }) {
  const m = new Set((managerEmails || []).map(e => String(e).toLowerCase()));
  const rows = (expenses || []).filter(e => inRange(e.date, from, to) && m.has(String(e.createdByEmail || '').toLowerCase())).map(e => ({
    date: e.date, by: personName(names, e.createdBy, e.createdByEmail), category: categoryLabel(e.category),
    amount: round2(e.amount), payee: e.payee || '', notes: e.notes || '',
  })).sort((a, b) => a.date.localeCompare(b.date));
  return {
    title: 'Manager Business Expenses',
    columns: [col('date', 'Date', 'date'), col('by', 'Manager'), col('category', 'Category'), col('amount', 'Amount', 'money'), col('payee', 'Paid to'), col('notes', 'Notes')],
    rows,
    totals: { date: 'Total', amount: sum(rows, r => r.amount) },
  };
}

// ===================================================================================================
// Catalogue: what each report needs (the UI loads only that) and how it is built.
// ===================================================================================================
export const REPORTS = [
  { id: 'floatBalance', priority: 1, title: 'Float Balance Summary', range: false, needs: ['settings', 'openPeriods'], build: floatBalanceSummary },
  { id: 'moneyIssued', priority: 1, title: 'Money Issued Log', range: true, needs: ['records'], build: moneyIssuedLog },
  { id: 'reportSummary', priority: 1, title: 'Expense Report Summary', range: true, needs: ['reports', 'allLines'], build: (d) => expenseReportSummary({ ...d, lines: d.allLines }) },
  { id: 'itemised', priority: 1, title: 'Itemised Expense Lines', range: true, needs: ['lines', 'reports', 'vehicles'], build: itemisedLines },
  { id: 'fuelVehicle', priority: 1, title: 'Fuel by Vehicle', range: true, needs: ['expenses', 'lines', 'vehicles'], build: fuelByVehicle },
  { id: 'expenseVsFloat', priority: 1, title: 'Rep Expense vs Float', range: true, needs: ['settings', 'openPeriods', 'records', 'lines'], build: expenseVsFloat },
  { id: 'categorySpend', priority: 2, title: 'Category Spend Analysis', range: true, needs: ['lines'], build: categorySpend },
  { id: 'rejected', priority: 2, title: 'Rejected Expense Log', range: true, needs: ['lines', 'reports', 'vehicles'], build: (d) => itemisedLines({ ...d, status: 'rejected' }) },
  { id: 'periods', priority: 2, title: 'Period-over-Period', range: true, needs: ['periods'], build: periodOverPeriod },
  { id: 'managerExpenses', priority: 2, title: 'Manager Business Expenses', range: true, needs: ['expenses', 'managerEmails'], build: managerOwnExpenses },
];

// ---------- data loading (manager) ----------
async function all(name, ...cs) {
  const snap = await getDocs(cs.length ? query(collection(db, name), ...cs) : collection(db, name));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function loadReportData(needs, { from, to }) {
  const want = new Set(needs);
  const tasks = {
    settings: () => all('floatSettings'),
    openPeriods: () => all('floatPeriods', where('status', '==', 'open')),
    periods: () => all('floatPeriods'),
    records: () => all('moneyIssued'),
    reports: () => all('expenseReports'),
    // Lines by expense date (single-field range: no composite index needed).
    lines: () => all('expenseLines', where('date', '>=', from), where('date', '<=', to)),
    allLines: () => all('expenseLines'),
    expenses: () => all('expenses', where('date', '>=', from), where('date', '<=', to)),
    vehicles: () => all('vehicles'),
    managerEmails: async () => {
      const r = await getDoc(doc(db, 'config', 'roles'));
      return r.exists() ? r.data().managers || [] : [];
    },
  };
  const out = {};
  await Promise.all([...want].map(async (k) => { out[k] = await tasks[k](); }));
  return out;
}

// ---------- Excel export (every report) ----------
export async function exportReportXlsx(report, { from, to, rangeUsed }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Naisi Foods';
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([(rangeUsed ? 'Range: ' + from + ' to ' + to + '. ' : '') + 'Generated ' + malawiDate() + ' (Malawi time).']);
  if (report.note) ws.addRow([report.note]).font = { italic: true, color: { argb: 'FF666666' } };
  ws.addRow([]);
  const header = ws.addRow(report.columns.map(c => c.label));
  header.font = { bold: true };
  header.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF6EA' } }; });
  const fmt = { money: '#,##0.00', int: '0', pct: '0.0"%"' };
  const put = (r, bold) => {
    const row = ws.addRow(report.columns.map(c => (r[c.key] == null ? null : r[c.key])));
    report.columns.forEach((c, i) => { if (fmt[c.type]) row.getCell(i + 1).numFmt = fmt[c.type]; });
    if (bold) row.font = { bold: true };
  };
  report.rows.forEach(r => put(r, false));
  if (report.totals) put(report.totals, true);
  report.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.type === 'text' ? 24 : 16; });
  ws.views = [{ state: 'frozen', ySplit: header.number }];
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'naisi-' + report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + (rangeUsed ? '_' + from + '_to_' + to : '_' + malawiDate()) + '.xlsx';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
