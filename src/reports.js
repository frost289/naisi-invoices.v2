import { db } from './firebase.js';
import { collection, query, where, orderBy, getDocs, Timestamp } from 'firebase/firestore';

// These fetch EVERYTHING in the range at once (no pagination) — this is
// a manager-only summary report over a bounded date window, same
// pattern as the existing Excel export in export.js/invoices.js.
// If your order volume grows very large, switch this to a paginated
// or server-aggregated approach instead.

function startOfDayTimestamp(dateStr) {
  return Timestamp.fromDate(new Date(dateStr + 'T00:00:00'));
}
function endOfDayTimestamp(dateStr) {
  return Timestamp.fromDate(new Date(dateStr + 'T23:59:59.999'));
}

// Orders don't carry a plain date string (only createdAt/approvedAt/etc.
// timestamps), so this ranges on createdAt instead — "orders CREATED in
// this window", which is what a manager means by an order falling on a
// given day in practice.
export async function fetchOrdersInRange(fromDate, toDate) {
  const q = query(
    collection(db, 'orders'),
    where('createdAt', '>=', startOfDayTimestamp(fromDate)),
    where('createdAt', '<=', endOfDayTimestamp(toDate)),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchExpensesInRange(fromDate, toDate) {
  const q = query(
    collection(db, 'expenses'),
    where('date', '>=', fromDate), where('date', '<=', toDate),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchVisitsInRange(fromDate, toDate) {
  const q = query(
    collection(db, 'visits'),
    where('date', '>=', fromDate), where('date', '<=', toDate),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Aggregates everything into one summary object. invoices is passed in
// rather than fetched here because invoices.js already has a proven
// fetchInvoicesByDateRange — no need for a second implementation of the
// same query.
export function buildIntervalSummary({ orders, invoices, expenses, visits }) {
  const summary = {
    orders: { total: orders.length, byStatus: {} },
    invoices: { count: invoices.length, revenue: 0 },
    expenses: { count: expenses.length, total: 0, byCategory: { Transport: 0, Meals: 0, Other: 0 } },
    visits: { total: visits.length, ordersPlaced: 0, noOrder: 0, successRate: 0 },
    topProducts: [],
    netCashflow: 0,
  };

  orders.forEach(o => {
    summary.orders.byStatus[o.status] = (summary.orders.byStatus[o.status] || 0) + 1;
  });

  invoices.forEach(inv => { summary.invoices.revenue += inv.grandTotal || 0; });

  expenses.forEach(e => {
    summary.expenses.total += e.amount || 0;
    if (summary.expenses.byCategory[e.category] === undefined) summary.expenses.byCategory[e.category] = 0;
    summary.expenses.byCategory[e.category] += e.amount || 0;
  });

  visits.forEach(v => {
    if (v.outcome === 'Order Placed') summary.visits.ordersPlaced += 1;
    else summary.visits.noOrder += 1;
  });
  summary.visits.successRate = summary.visits.total
    ? Math.round((summary.visits.ordersPlaced / summary.visits.total) * 100)
    : 0;

  const productTotals = {};
  orders.forEach(o => {
    (o.items || []).forEach(it => {
      const key = it.desc || it.productName || 'Unknown item';
      productTotals[key] = (productTotals[key] || 0) + (it.qty || 0);
    });
  });
  summary.topProducts = Object.entries(productTotals)
    .map(([desc, qty]) => ({ desc, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  summary.netCashflow = summary.invoices.revenue - summary.expenses.total;

  return summary;
}
