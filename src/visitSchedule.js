// Pure functions for the daily visit workflow (no Firestore, no DOM).
//
// Terms used everywhere (UI and reports):
//   scheduled customer  an ACTIVE customer whose weekly visit day (assignedDay)
//                       matches the weekday of the date in question. A customer with NO visit day (new, or
//                       reactivated and not yet scheduled) is not scheduled: it is never a target and never
//                       lowers a rep's completion. The rep's own screen uses the live schedule (repDayProgress);
//                       MANAGER REPORTS use the dated schedule history (scheduleHistory.js), so they show the
//                       targets that applied on each date, and say so when a date has no reliable history.
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
import { datesInRange, weekdayOfDate, malawiDate } from './malawiTime.js';
import { targetsForDate, visitIdentityAt } from './scheduleHistory.js';

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

const orderMalawiDate = (o) => {
  const t = o && o.createdAt;
  return t && typeof t.toMillis === 'function' ? malawiDate(new Date(t.toMillis())) : null;
};

// Manager report over a date range. `reps` is the list of rep emails (so reps with no visits still appear);
// visits are grouped by repEmail (lower-cased).
//   index             the schedule index (scheduleHistory.buildScheduleIndex). REQUIRED: targets always come from
//                     the history, never from today's schedule.
//   attributedOrders  orders a manager entered on behalf of a rep (source 'manager-entered'). They are reported in
//                     their own columns and never counted as visits, coverage or conversion.
// For dates with no reliable history, Scheduled / Visited / Coverage are NOT calculated for those dates (they are listed
// in unreliableDates, and coverage is null if no reliable date is left); orders, no-order visits and totals still come from
// the saved visits.
export function buildPerformanceReport({ index, visits, reps, from, to, repFilter = 'all', attributedOrders = [] }) {
  if (!index) throw new Error('buildPerformanceReport needs the schedule history index.');
  const dates = datesInRange(from, to);
  const repKey = (e) => String(e || '').trim().toLowerCase();
  const repSet = new Set((reps || []).map(repKey).filter(Boolean));
  for (const v of visits || []) if (v.repEmail) repSet.add(repKey(v.repEmail)); // a visit by someone no longer in the list is still reported
  const attributed = (attributedOrders || []).filter(o => { const d = orderMalawiDate(o); return d && d >= from && d <= to && o.status !== undefined; });
  for (const o of attributed) if (o.attributedRepEmail) repSet.add(repKey(o.attributedRepEmail));
  let repList = [...repSet].sort();
  if (repFilter !== 'all') repList = repList.filter(r => r === repKey(repFilter));

  const dayInfo = dates.map(date => ({ date, ...targetsForDate(index, date) }));
  const reliableDays = dayInfo.filter(d => d.reliable);
  const unreliableDates = dayInfo.filter(d => !d.reliable).map(d => d.date);
  const inRange = (visits || []).filter(v => v.date >= from && v.date <= to);

  const rows = repList.map(rep => {
    const mine = inRange.filter(v => repKey(v.repEmail) === rep);
    let scheduledCount = 0, visitedCount = 0;
    const due = [];            // { date, customer } - scheduled on a reliable date and not visited by this rep that day
    const unverifiable = [];   // { date, customer } - shops left out because a legacy merged visit cannot be attributed (finding 4)
    const identity = new Map(mine.map(v => [v, visitIdentityAt(index, v)]));
    const ambiguousVisits = mine.filter(v => identity.get(v).ambiguous);
    for (const day of dayInfo) {
      if (!day.reliable) continue;
      const todays = mine.filter(v => v.date === day.date);
      const visitedIds = new Set(todays.map(v => identity.get(v)).filter(i => !i.ambiguous).map(i => i.id));
      const doubtful = new Set(todays.map(v => identity.get(v)).filter(i => i.ambiguous).flatMap(i => i.candidates));
      for (const t of day.targets) {
        if (doubtful.has(t.customerId)) { unverifiable.push({ date: day.date, customer: { id: t.customerId, name: t.customerName } }); continue; }
        scheduledCount += 1;
        if (visitedIds.has(t.customerId)) visitedCount += 1;
        else due.push({ date: day.date, customer: { id: t.customerId, name: t.customerName } });
      }
    }
    // Visits to shops that were not scheduled that day: from the history where it is reliable, otherwise from
    // the flag the visit itself recorded when it was saved (wasScheduled), and left unclassified if neither exists.
    const extra = [];
    for (const v of mine) {
      const idn = identity.get(v);
      if (idn.ambiguous) continue;          // cannot be classified: reported in ambiguousVisits, never guessed
      const day = dayInfo.find(d => d.date === v.date);
      let scheduledThen;
      if (day && day.reliable) scheduledThen = day.targets.some(t => t.customerId === idn.id);
      else scheduledThen = typeof v.wasScheduled === 'boolean' ? v.wasScheduled : null;
      if (scheduledThen === false) extra.push(v);
    }
    const orders = mine.filter(v => v.outcome === 'Order Placed');
    const noOrder = mine.filter(v => v.outcome === 'No Order');
    // A closed shop COUNTS as a visit (owner decision, 18 Oct 2026) but is shown separately so contact visits stay visible.
    const closed = noOrder.filter(v => v.reasonNoOrder === 'Shop closed');
    const valued = orders.filter(v => typeof v.orderValue === 'number' && Number.isFinite(v.orderValue));
    const attrMine = attributed.filter(o => repKey(o.attributedRepEmail) === rep && o.status !== 'Cancelled' && o.status !== 'Rejected');
    const attrValue = attrMine.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0);
    return {
      rep, scheduledCount, visitedCount, stillDueCount: scheduledCount - visitedCount, due, unverifiable, ambiguousVisits: ambiguousVisits.length,
      reliableDays: reliableDays.length, unreliableDays: unreliableDates.length,
      ordersTaken: orders.length, noOrderVisits: noOrder.length, totalVisits: mine.length,
      closedVisits: closed.length, conversionExclClosedPct: pct(orders.length, mine.length - closed.length),
      coveragePct: pct(visitedCount, scheduledCount), conversionPct: pct(orders.length, mine.length),
      orders, noOrder, extraVisits: extra,
      // order VALUE: only visits that carry a recorded value are summed; others are counted, never treated as 0
      valueTotal: valued.length ? valued.reduce((s, v) => s + v.orderValue, 0) : null,
      valuedOrders: valued.length, unvaluedOrders: orders.length - valued.length,
      // Orders a manager entered for this rep. NOT visits: not in visited, coverage, conversion or totalVisits.
      attributedOrders: attrMine.length, attributedValue: attrMine.length ? attrValue : null,
      attributedCancelled: attributed.filter(o => repKey(o.attributedRepEmail) === rep && o.status === 'Cancelled').length,
    };
  });
  return {
    from, to, days: dates.length, rows,
    reliableDays: reliableDays.length, unreliableDates,
    ambiguity: (() => {
      const n = rows.reduce((a, r) => a + r.ambiguousVisits, 0);
      return n ? `${n} visit(s) in this range were made before a customer merge that was done earlier than the app kept the original shop. Which of the merged shops each one belongs to cannot be recovered, so they are not credited to any shop and those shops are left out of Scheduled, Visited and Still due for that rep and day (see "unverifiable"). The visits still count in the totals.` : null;
    })(),
    limitation: unreliableDates.length
      ? (index.startDate
        ? `Schedule history began on ${index.startDate}. For ${unreliableDates.length} day(s) in this range before that date there is no reliable record of who was scheduled, so Scheduled, Visited, Still due and Coverage are NOT calculated for those days. Orders and No-order counts are still shown from the saved visits.`
        : `Schedule history has not been started, so no day in this range has a reliable record of who was scheduled. Scheduled, Visited, Still due and Coverage are NOT calculated. Orders and No-order counts are still shown from the saved visits.`)
      : null,
  };
}
