// The manager's ONE weekly schedule: the plan (which shops are due on which day) merged with what the reps actually did.
// Pure: no Firestore, no DOM. RC6.2 introduced it; RC6.3 makes every figure trustworthy.
//
// RC6.3 rules (owner review, 20 Oct 2026):
//   * A day that has started (past or today) is measured ONLY against the dated schedule history (scheduleHistory.targetsForDate).
//     When that history is not reliable for the date (not started yet, began later, or could not be loaded) the day is
//     "History unavailable": no targets, no Missed / Due, nothing counted in coverage. Today's plan is NEVER used to judge the past.
//     The visits recorded that day are still listed and still count as orders / no-order visits (they are facts).
//   * Visits are matched to shops with the same date-aware identity as the Rep Performance report (visitIdentityAt). A visit made
//     before a legacy merge that cannot be attributed is AMBIGUOUS: it is credited to no shop, the candidate shops are shown as
//     "Uncertain" and left out of Planned / Visited / Missed for that day - exactly the report's safeguard.
//   * If the visits could not be loaded, started days are "Data unavailable": no zero activity, no Missed, no percentages.
//   * Upcoming days show the CURRENT plan as "Planned" (nothing is measured on them).
//   * For one rep, the week totals over the started days equal buildPerformanceReport for the same rep and dates
//     (Scheduled = plannedSoFar, Visited = visitedSoFar, Still due = missed + due, Orders, No order). With "All reps" a shop counts
//     as visited when ANY rep visited it; the screen says so.
import { addDays, weekdayOfDate } from './malawiTime.js';
import { targetsForDate, visitIdentityAt } from './scheduleHistory.js';

export const BOARD_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const hasPin = (c) => !!c && typeof c.lat === 'number' && typeof c.lng === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lng);
const repKey = (e) => String(e || '').trim().toLowerCase();
const tsMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : null));

// Monday of the week that contains dateStr (Sunday belongs to the week that started the Monday before).
export function weekStartOf(dateStr) {
  const back = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekdayOfDate(dateStr)];
  return addDays(dateStr, -back);
}
export function weekDates(weekStart) { return BOARD_DAYS.map((_, i) => addDays(weekStart, i)); }

// customers  current customer docs (names, areas, pins; and the CURRENT plan for upcoming days)
// visits     visit docs for the week (any rep), or null when they could not be loaded (visitsFailed)
// index      schedule index (buildScheduleIndex) or null when the history could not be loaded / is not started
// historyFailed  true when loading the history failed (shown differently from "not started")
// today      Malawi date; repFilter 'all' or a rep email
export function buildWeekBoard({ customers = [], visits = [], index = null, historyFailed = false, visitsFailed = false, weekStart, today, repFilter = 'all' }) {
  const byId = new Map(customers.map(c => [c.id, c]));
  const dates = weekDates(weekStart);
  const mine = visitsFailed ? [] : (visits || []).filter(v => repFilter === 'all' || repKey(v.repEmail) === repKey(repFilter));
  const identityOf = (v) => (index ? visitIdentityAt(index, v) : { id: v.customerId, ambiguous: false, candidates: [] });
  const outcomeStatus = (v) => (v.outcome === 'Order Placed' ? 'order' : 'noorder');

  const days = dates.map((date, i) => {
    const weekday = BOARD_DAYS[i];
    const phase = date < today ? 'past' : date === today ? 'today' : 'upcoming';
    const dayVisits = mine.filter(v => v.date === date).slice().sort((a, b) => (tsMs(a.createdAt) ?? 0) - (tsMs(b.createdAt) ?? 0));
    const counts = { planned: 0, visited: 0, missed: 0, due: 0, uncertain: 0, extraShops: 0, noPin: 0,
      orders: dayVisits.filter(v => v.outcome === 'Order Placed').length,
      noOrder: dayVisits.filter(v => v.outcome === 'No Order').length,
      orderValue: dayVisits.filter(v => v.outcome === 'Order Placed' && typeof v.orderValue === 'number' && Number.isFinite(v.orderValue)).reduce((s, v) => s + v.orderValue, 0) };
    const base = { date, weekday, phase, rows: [], extra: [], uncertainVisits: [], counts, unavailable: null, planSource: null };

    if (phase === 'upcoming') {
      base.planSource = 'current';
      base.rows = customers.filter(c => c.active !== false && c.assignedDay === weekday && !c.mergeLock)
        .map(c => ({ customerId: c.id, name: c.name || '', location: c.location || '', hasPin: hasPin(c), currentDay: c.assignedDay || null, active: true, status: 'planned', visits: [], last: null }))
        .sort((a, b) => a.name.localeCompare(b.name));
      counts.planned = base.rows.length;
      counts.noPin = base.rows.filter(r => !r.hasPin).length;
      return base;
    }
    if (visitsFailed) { base.unavailable = 'visits'; return base; }

    // Identity of every visit as of its own date (never guessed).
    const ided = dayVisits.map(v => ({ v, idn: identityOf(v) }));
    base.uncertainVisits = ided.filter(x => x.idn.ambiguous).map(x => x.v);
    const visitsByShop = new Map();
    for (const { v, idn } of ided) {
      if (idn.ambiguous) continue;
      const list = visitsByShop.get(idn.id) || []; list.push(v); visitsByShop.set(idn.id, list);
    }
    const shopRow = (id, name, extra) => {
      const c = byId.get(id) || {};
      const vs = visitsByShop.get(id) || [];
      return { customerId: id, name: c.name || name || '(removed shop)', location: c.location || '', hasPin: hasPin(c), currentDay: c.assignedDay || null, active: c.active !== false && !c.mergeLock, visits: vs, last: vs[vs.length - 1] || null, ...extra };
    };

    const hist = index ? targetsForDate(index, date) : null;
    if (!hist || !hist.reliable) {
      // No reliable plan for this date: list what was recorded, judge nothing.
      base.unavailable = historyFailed ? 'history-failed' : 'history';
      base.extra = [...visitsByShop.keys()].map(id => { const r = shopRow(id, visitsByShop.get(id)[0].customerName); return { ...r, status: outcomeStatus(r.last) }; })
        .sort((a, b) => a.name.localeCompare(b.name));
      return base;
    }

    base.planSource = 'history';
    const doubtful = new Set(ided.filter(x => x.idn.ambiguous).flatMap(x => x.idn.candidates));
    const plannedIds = new Set(hist.targets.map(t => t.customerId));
    base.rows = hist.targets.map(t => {
      if (doubtful.has(t.customerId)) return shopRow(t.customerId, t.customerName, { status: 'uncertain' });
      const r = shopRow(t.customerId, t.customerName, {});
      r.status = r.last ? outcomeStatus(r.last) : (phase === 'past' ? 'missed' : 'due');
      return r;
    });
    const order = { due: 0, missed: 1, uncertain: 2, noorder: 3, order: 4 };
    base.rows.sort((a, b) => (order[a.status] - order[b.status]) || a.name.localeCompare(b.name));
    base.extra = [...visitsByShop.keys()].filter(id => !plannedIds.has(id))
      .map(id => { const r = shopRow(id, visitsByShop.get(id)[0].customerName); return { ...r, status: outcomeStatus(r.last) }; })
      .sort((a, b) => a.name.localeCompare(b.name));
    const countable = base.rows.filter(r => r.status !== 'uncertain');
    counts.planned = countable.length;
    counts.visited = countable.filter(r => r.visits.length).length;
    counts.missed = countable.filter(r => r.status === 'missed').length;
    counts.due = countable.filter(r => r.status === 'due').length;
    counts.uncertain = base.rows.length - countable.length;
    counts.extraShops = base.extra.length;
    counts.noPin = base.rows.filter(r => !r.hasPin).length;
    return base;
  });

  const started = days.filter(d => d.phase !== 'upcoming');
  const measured = started.filter(d => !d.unavailable);
  const sum = (arr, k) => arr.reduce((s, d) => s + d.counts[k], 0);
  const plannedSoFar = sum(measured, 'planned'), visitedSoFar = sum(measured, 'visited');
  const totals = {
    activityAvailable: !visitsFailed,
    plannedWeek: sum(measured, 'planned') + sum(days.filter(d => d.phase === 'upcoming'), 'planned'),
    plannedSoFar, visitedSoFar,
    coveragePct: plannedSoFar > 0 ? Math.round((visitedSoFar / plannedSoFar) * 100) : null,
    missed: sum(measured, 'missed'), due: sum(measured, 'due'), uncertain: sum(measured, 'uncertain'),
    stillDue: sum(measured, 'missed') + sum(measured, 'due'),
    orders: sum(started, 'orders'), noOrder: sum(started, 'noOrder'), orderValue: sum(started, 'orderValue'),
    extraShops: sum(measured, 'extraShops'),
    uncertainVisits: started.reduce((s, d) => s + d.uncertainVisits.length, 0),
    unavailableDays: started.filter(d => d.unavailable).map(d => d.date),
    noHistoryDays: started.filter(d => d.unavailable === 'history').map(d => d.date),   // only days whose history is missing (not failed loads)
  };
  totals.conversionPct = (totals.orders + totals.noOrder) > 0 ? Math.round((totals.orders / (totals.orders + totals.noOrder)) * 100) : null;

  // Location capture (INFORMATIONAL, never part of coverage): active shops without a pin, and first captures this week.
  const active = customers.filter(c => c.active !== false && !c.mergeLock);
  const weekFrom = dates[0], weekTo = addDays(weekStart, 6);   // Mon..Sun
  const capturedThisWeek = customers.filter(c => {
    const d = c.firstPinnedDate;           // Malawi date of the rules-validated firstPinnedAt, prepared by the caller
    if (!d || d < weekFrom || d > weekTo) return false;
    return repFilter === 'all' || repKey(c.firstPinnedByEmail) === repKey(repFilter);
  });
  const pins = { activeCustomers: active.length, missing: active.filter(c => !hasPin(c)).length, capturedThisWeek: capturedThisWeek.length };
  const unscheduled = active.filter(c => !c.assignedDay).length;

  return { weekStart, dates, days, totals, pins, unscheduled, repFilter, historyFailed, visitsFailed };
}
