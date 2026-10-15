// Pure functions for the daily visit workflow (no Firestore, no DOM).
//
// Terms used everywhere (UI and reports):
//   scheduled customer  an ACTIVE customer whose weekly visit day (assignedDay)
//                       matches the weekday of the date in question.
//   visit               one recorded outcome (Order Placed / No Order). A shop can
//                       be visited more than once in a day; every visit is kept.
//   distinct visited    scheduled customers with at least one visit by THIS rep
//                       on that date. A repeat visit never counts twice.
//   still due           scheduled customers minus distinct visited.
//   orders taken        visits with outcome "Order Placed" (repeat visits and
//                       visits to unscheduled shops included).
//   no-order visits     visits with outcome "No Order" (same counting).
//   coverage %          distinct visited / scheduled. Blank when nothing is scheduled.
//   conversion %        orders taken / all recorded visits. Blank when there are no visits.
import { datesInRange, weekdayOfDate } from './malawiTime.js';

export function isActive(c) { return c && c.active !== false; }

export function scheduledForWeekday(customers, weekday) {
  return (customers || []).filter(c => isActive(c) && c.assignedDay === weekday);
}

export function scheduledForDate(customers, dateStr) {
  return scheduledForWeekday(customers, weekdayOfDate(dateStr));
}

// Progress for ONE rep on ONE date.
export function repDayProgress({ customers, visits, date }) {
  const scheduled = scheduledForDate(customers, date);
  const scheduledIds = new Set(scheduled.map(c => c.id));
  const mine = (visits || []).filter(v => v.date === date);
  const visitedIds = new Set(mine.filter(v => scheduledIds.has(v.customerId)).map(v => v.customerId));
  // latest outcome per customer, for the list ("recorded outcome today")
  const byCustomer = new Map();
  for (const v of mine) {
    const list = byCustomer.get(v.customerId) || [];
    list.push(v);
    byCustomer.set(v.customerId, list);
  }
  return {
    scheduled,
    scheduledCount: scheduled.length,
    visitedCount: visitedIds.size,
    stillDue: scheduled.filter(c => !visitedIds.has(c.id)),
    ordersTaken: mine.filter(v => v.outcome === 'Order Placed').length,
    noOrderVisits: mine.filter(v => v.outcome === 'No Order').length,
    totalVisits: mine.length,
    visitsByCustomer: byCustomer,
  };
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

// Manager report over a date range. `reps` is the list of rep emails (so reps with
// no visits still appear); visits are grouped by repEmail (lower-cased).
export function buildPerformanceReport({ customers, visits, reps, from, to, repFilter = 'all' }) {
  const dates = datesInRange(from, to);
  const repKey = (e) => String(e || '').trim().toLowerCase();
  const repSet = new Set((reps || []).map(repKey).filter(Boolean));
  for (const v of visits || []) if (v.repEmail) repSet.add(repKey(v.repEmail)); // a visit by someone no longer in the list is still reported
  let repList = [...repSet].sort();
  if (repFilter !== 'all') repList = repList.filter(r => r === repKey(repFilter));

  const inRange = (visits || []).filter(v => v.date >= from && v.date <= to);
  const rows = repList.map(rep => {
    const mine = inRange.filter(v => repKey(v.repEmail) === rep);
    let scheduledCount = 0, visitedCount = 0;
    const due = [];            // { date, customer }
    const extra = [];          // visits to shops that were not scheduled that day
    for (const date of dates) {
      const day = repDayProgress({ customers, visits: mine, date });
      scheduledCount += day.scheduledCount;
      visitedCount += day.visitedCount;
      day.stillDue.forEach(c => due.push({ date, customer: c }));
    }
    for (const v of mine) {
      const sched = scheduledForDate(customers, v.date).some(c => c.id === v.customerId);
      if (!sched) extra.push(v);
    }
    const orders = mine.filter(v => v.outcome === 'Order Placed');
    const noOrder = mine.filter(v => v.outcome === 'No Order');
    const valued = orders.filter(v => typeof v.orderValue === 'number' && Number.isFinite(v.orderValue));
    return {
      rep, scheduledCount, visitedCount, stillDueCount: scheduledCount - visitedCount, due,
      ordersTaken: orders.length, noOrderVisits: noOrder.length, totalVisits: mine.length,
      coveragePct: pct(visitedCount, scheduledCount), conversionPct: pct(orders.length, mine.length),
      orders, noOrder, extraVisits: extra,
      // order VALUE: only visits that carry a recorded value are summed; others are counted, never treated as 0
      valueTotal: valued.length ? valued.reduce((s, v) => s + v.orderValue, 0) : null,
      valuedOrders: valued.length, unvaluedOrders: orders.length - valued.length,
    };
  });
  return { from, to, days: dates.length, rows };
}

// Customers whose weekly day was changed on/after `fromDate` (YYYY-MM-DD, Malawi) —
// the report warns that earlier dates are computed with the CURRENT schedule.
export function scheduleChangedSince(customers, fromDate, toDateStr) {
  return (customers || []).filter(c => {
    const t = c.assignedDayChangedAt;
    const ms = t && typeof t.toMillis === 'function' ? t.toMillis() : null;
    if (ms === null) return false;
    return toDateStr(ms) >= fromDate;
  });
}
