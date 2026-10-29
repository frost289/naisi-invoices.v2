// RC6.3 regression tests (owner review of RC6.2, 20 Oct 2026). Real app modules against the in-memory Firestore stand-in.
//   A. orders without a pin are saved (rep and manager paths), with null coordinates; valid pins copied exactly
//   B. weekly board: history unavailable, failed loads, ambiguous visits after legacy merges, agreement with Rep Performance
//   C. expense categories by role (rep: own Transport/Meals/Other only; query carries the category filter)
//   D. location-capture attribution: first capture stamped once (creation and later pinning alike), never moved by a re-pin
import { describe, it, expect, beforeEach } from 'vitest';
import { F } from './_util.js';
const visits = await import('../../src/visits.js');
const mo = await import('../../src/managerOrders.js');
const customers = await import('../../src/customers.js');
const expenses = await import('../../src/expenses.js');
import { expenseCategoriesFor, expenseCategoryOptionsForEdit, expenseTilesFor, repMaySeeExpense } from '../../src/expenseCategories.js';
import { buildWeekBoard, weekStartOf, weekDates } from '../../src/weekBoard.js';
import { buildScheduleIndex } from '../../src/scheduleHistory.js';
import { buildPerformanceReport } from '../../src/visitSchedule.js';
import { summarizeExpenses } from '../../src/money.js';

const REQ = 'req-aaaaaaaa-1111';
const NOW = () => new Date('2026-10-15T08:00:00Z');   // Thursday in Malawi
const items = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1' }];
const at = (prefix) => [...F.store].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ path: p, ...d }));
const shop = (over = {}) => ({ name: 'Shop A', phone: '0999', location: 'Area 25', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Thu', ...over });

beforeEach(() => {
  F.reset();
  F.setClock(Date.parse('2026-10-15T08:00:00Z'));
  F.store.set('orderCounters/naisiOrder', { counter: 41 });
  F.store.set('config/roles', { submitters: ['rep1@naisi.test', 'rep2@naisi.test'], managers: ['mgr@naisi.test'] });
});

// =====================================================================================================
describe('A. RC6.3 owner decision: a missing location never blocks an order', () => {
  const repOrder = (over = {}) => visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: REQ, uid: 'rep1', email: 'rep1@naisi.test', now: NOW, ...over });
  const mgrOrder = (over = {}) => mo.submitOrderAsManager({ customerId: 'c1', items, notes: '', attributedRepEmail: 'rep1@naisi.test', requestId: REQ, uid: 'mgr', email: 'mgr@naisi.test', now: NOW, ...over });

  it.each([
    ['no pin at all', { lat: null, lng: null }],
    ['pin fields missing', { lat: undefined, lng: undefined }],
    ['a broken legacy pin', { lat: 'x', lng: 999 }],
  ])('rep: an order for a shop with %s is saved once, with its visit and ONE counter step, and null coordinates', async (_n, over) => {
    const c = shop(over); for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
    F.store.set('customers/c1', c);
    const r = await repOrder();
    const [o] = at('orders/'), [v] = at('visits/');
    expect(r.alreadySaved).toBe(false);
    expect([o.customerLat, o.customerLng]).toEqual([null, null]);       // never invented
    expect(v).toMatchObject({ outcome: 'Order Placed', orderId: r.orderId });
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
    // identical retry (lost acknowledgement) reuses it
    const again = await repOrder();
    expect(again.alreadySaved).toBe(true);
    expect(at('orders/')).toHaveLength(1);
    expect(F.store.get('customers/c1').lat ?? null).toEqual(c.lat ?? null);   // the customer record is not changed by the order
  });
  it('rep: a valid pin is copied exactly', async () => {
    F.store.set('customers/c1', shop());
    await repOrder();
    const [o] = at('orders/');
    expect([o.customerLat, o.customerLng]).toEqual([-13.9, 33.7]);
  });
  it('manager-entered: an unpinned customer is accepted with null coordinates; a pinned one copies the pin; no visit is created', async () => {
    F.store.set('customers/c1', shop({ lat: null, lng: null }));
    const r = await mgrOrder();
    expect(F.store.get('orders/' + r.orderId)).toMatchObject({ customerLat: null, customerLng: null, source: 'manager-entered' });
    F.store.set('customers/c1', shop());
    const r2 = await mgrOrder({ requestId: 'req-bbbbbbbb-2222' });
    expect(F.store.get('orders/' + r2.orderId)).toMatchObject({ customerLat: -13.9, customerLng: 33.7 });
    expect(at('visits/')).toHaveLength(0);
  });
  it('still refused: inactive customer, merging customer (unchanged safeguards)', async () => {
    F.store.set('customers/c1', shop({ lat: null, lng: null, active: false }));
    await expect(repOrder()).rejects.toThrow(/inactive/i);
    F.store.set('customers/c1', shop({ lat: null, lng: null, mergeLock: { into: 'c2' } }));
    await expect(mgrOrder()).rejects.toMatchObject({ code: 'customer-merging' });
    expect(at('orders/')).toHaveLength(0);
  });
});

// =====================================================================================================
const C = (id, day, over = {}) => ({ id, name: id.toUpperCase(), location: 'Area 25', active: true, assignedDay: day, lat: -13.9, lng: 33.7, ...over });
const V = (customerId, date, outcome, rep = 'rep1@x', extra = {}) => ({ customerId, customerName: customerId.toUpperCase(), date, outcome, repEmail: rep, createdAt: Date.parse(date + 'T08:00:00Z'), ...extra });
const base = (id, day, ms = Date.parse('2026-01-01T06:05:00Z')) => ({ id: 'base_' + id, customerId: id, customerName: id.toUpperCase(), kind: 'baseline', active: true, assignedDay: day, createdAt: ms });
const historyFor = (cs, extra = {}) => buildScheduleIndex({ config: { startedAt: Date.parse('2026-01-01T06:00:00Z') }, changes: cs.map(c => base(c.id, c.assignedDay)), ...extra });
const WEEK = '2026-10-12', TODAY = '2026-10-15';
const day = (b, date) => b.days.find(d => d.date === date);
const st = (b, date) => Object.fromEntries(day(b, date).rows.map(r => [r.customerId, r.status]));

describe('B1. weekly board with reliable history', () => {
  it('weeks start on Monday; Sunday belongs to the week before', () => {
    expect(weekStartOf('2026-10-15')).toBe('2026-10-12');
    expect(weekStartOf('2026-10-18')).toBe('2026-10-12');
    expect(weekDates(WEEK)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  });
  it('order / no order / missed (past) / due (today) / planned (upcoming); extra visits apart', () => {
    const cs = [C('a', 'Mon'), C('b', 'Tue'), C('c', 'Thu'), C('d', 'Thu', { lat: null, lng: null }), C('e', 'Fri')];
    const vs = [V('a', '2026-10-12', 'Order Placed', 'rep1@x', { orderValue: 100 }), V('c', TODAY, 'No Order', 'rep1@x', { reasonNoOrder: 'Shop closed' }), V('e', TODAY, 'Order Placed')];
    const b = buildWeekBoard({ customers: cs, visits: vs, index: historyFor(cs), weekStart: WEEK, today: TODAY });
    expect(st(b, '2026-10-12')).toEqual({ a: 'order' });
    expect(st(b, '2026-10-13')).toEqual({ b: 'missed' });
    expect(st(b, TODAY)).toEqual({ c: 'noorder', d: 'due' });
    expect(st(b, '2026-10-16')).toEqual({ e: 'planned' });
    expect(day(b, TODAY).extra.map(r => r.customerId)).toEqual(['e']);
    expect(b.totals).toMatchObject({ plannedSoFar: 4, visitedSoFar: 2, coveragePct: 50, missed: 1, due: 1, stillDue: 2, orders: 2, noOrder: 1, orderValue: 100, unavailableDays: [] });
  });
  it('a shop moved today shows on its OLD day for earlier dates (history), and on the new day from today', () => {
    const cs = [C('a', 'Thu')];
    const index = buildScheduleIndex({ config: { startedAt: Date.parse('2026-01-01T06:00:00Z') }, changes: [
      base('a', 'Tue'), { id: 'ch1', customerId: 'a', customerName: 'A', kind: 'schedule', active: true, assignedDay: 'Thu', createdAt: Date.parse('2026-10-15T07:00:00Z') }] });
    const b = buildWeekBoard({ customers: cs, visits: [], index, weekStart: WEEK, today: TODAY });
    expect(st(b, '2026-10-13')).toEqual({ a: 'missed' });
    expect(st(b, TODAY)).toEqual({ a: 'due' });
  });
});

describe('B2. RC6.3: no reliable history -> "History unavailable", never today\'s plan', () => {
  const cs = [C('a', 'Mon'), C('b', 'Tue'), C('c', 'Thu'), C('e', 'Fri')];
  const vs = [V('a', '2026-10-12', 'Order Placed')];
  it('history not started: past days and today are unavailable (no Missed, no Due, no coverage); visits still listed and counted as orders', () => {
    const b = buildWeekBoard({ customers: cs, visits: vs, index: null, weekStart: WEEK, today: TODAY });
    for (const d of ['2026-10-12', '2026-10-13', '2026-10-14', TODAY]) {
      expect(day(b, d).unavailable).toBe('history');
      expect(day(b, d).rows).toEqual([]);
    }
    expect(day(b, '2026-10-12').extra.map(r => [r.customerId, r.status])).toEqual([['a', 'order']]);
    expect(b.totals).toMatchObject({ plannedSoFar: 0, visitedSoFar: 0, coveragePct: null, missed: 0, due: 0, orders: 1 });
    expect(b.totals.unavailableDays).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', TODAY]);
    expect(st(b, '2026-10-16')).toEqual({ e: 'planned' });     // upcoming days still show the current plan
  });
  it('history began mid-week: earlier days unavailable, later days measured', () => {
    const index = buildScheduleIndex({ config: { startedAt: Date.parse('2026-10-14T06:00:00Z') }, changes: cs.map(c => base(c.id, c.assignedDay, Date.parse('2026-10-14T06:05:00Z'))) });
    const b = buildWeekBoard({ customers: cs, visits: vs, index, weekStart: WEEK, today: TODAY });
    expect(day(b, '2026-10-12').unavailable).toBe('history');
    expect(day(b, '2026-10-13').unavailable).toBe('history');
    expect(day(b, TODAY).unavailable).toBe(null);
    expect(b.totals).toMatchObject({ plannedSoFar: 1, missed: 0, due: 1 });   // only Thursday's c is measured
  });
  it('history failed to load: shown as history-failed, nothing judged', () => {
    const b = buildWeekBoard({ customers: cs, visits: vs, index: null, historyFailed: true, weekStart: WEEK, today: TODAY });
    expect(day(b, '2026-10-13').unavailable).toBe('history-failed');
    expect(b.totals.missed).toBe(0);
    expect(b.historyFailed).toBe(true);
    expect(b.totals.noHistoryDays).toEqual([]);                 // a FAILED load is not reported as "no history
  });
});

describe('B3. RC6.3: failed visit load is "Data unavailable", never zero activity', () => {
  it('no counts, no Missed, no percentages; upcoming plan still shown', () => {
    const cs = [C('a', 'Mon'), C('c', 'Thu'), C('e', 'Fri')];
    const b = buildWeekBoard({ customers: cs, visits: null, visitsFailed: true, index: historyFor(cs), weekStart: WEEK, today: TODAY });
    for (const d of ['2026-10-12', TODAY]) { expect(day(b, d).unavailable).toBe('visits'); expect(day(b, d).rows).toEqual([]); }
    expect(b.totals.activityAvailable).toBe(false);
    expect(b.totals.noHistoryDays).toEqual([]);                 // the history loaded fine: the message must not blame it
    expect(b.totals).toMatchObject({ plannedSoFar: 0, missed: 0, coveragePct: null, conversionPct: null });
    expect(st(b, '2026-10-16')).toEqual({ e: 'planned' });
  });
});

describe('B4. RC6.3: ambiguous visits after a LEGACY merge are never guessed', () => {
  // b was merged into a on Wed 14 Oct by a merge made before origins were kept (moved visits, no visitsKeepOriginal).
  // A visit on Mon 12 Oct now points at a: it may really have been b's.
  const cs = [C('a', 'Mon'), C('b', 'Mon', { active: false, assignedDay: null })];
  const index = buildScheduleIndex({
    config: { startedAt: Date.parse('2026-01-01T06:00:00Z') },
    changes: [base('a', 'Mon'), base('b', 'Mon')],
    merges: [{ id: 'b', keepId: 'a', mergedAt: Date.parse('2026-10-14T09:00:00Z'), moved: { visits: 3 } }],
  });
  const vs = [V('a', '2026-10-12', 'Order Placed')];
  it('both candidate shops are "uncertain", left out of Planned/Visited/Missed; the visit is credited to no shop but still counts as an order', () => {
    const b = buildWeekBoard({ customers: cs, visits: vs, index, weekStart: WEEK, today: TODAY });
    expect(st(b, '2026-10-12')).toEqual({ a: 'uncertain', b: 'uncertain' });
    expect(day(b, '2026-10-12').uncertainVisits).toHaveLength(1);
    expect(day(b, '2026-10-12').counts).toMatchObject({ planned: 0, visited: 0, missed: 0, uncertain: 2, orders: 1 });
    expect(b.totals.uncertainVisits).toBe(1);
  });
  it('the same numbers as the Rep Performance report for that rep and date', () => {
    const b = buildWeekBoard({ customers: cs, visits: vs, index, weekStart: WEEK, today: TODAY, repFilter: 'rep1@x' });
    const r = buildPerformanceReport({ index, visits: vs, reps: ['rep1@x'], from: '2026-10-12', to: '2026-10-12', repFilter: 'rep1@x' }).rows[0];
    const d = day(b, '2026-10-12').counts;
    expect([d.planned, d.visited, d.missed, d.orders]).toEqual([r.scheduledCount, r.visitedCount, r.stillDueCount, r.ordersTaken]);
    expect(r.unverifiable.length).toBe(2);
  });
});

describe('B5. RC6.3: Weekly Schedule and Rep Performance agree for the same rep and dates', () => {
  const cs = [C('a', 'Mon'), C('b', 'Tue'), C('c', 'Thu'), C('d', 'Thu', { lat: null, lng: null }), C('e', 'Fri'), C('f', 'Wed')];
  const vs = [
    V('a', '2026-10-12', 'Order Placed', 'rep1@x', { orderValue: 10 }), V('a', '2026-10-12', 'No Order', 'rep1@x'),   // repeat visit counts once as visited
    V('c', TODAY, 'No Order', 'rep1@x', { reasonNoOrder: 'Shop closed' }), V('e', TODAY, 'Order Placed', 'rep1@x'),   // e: extra (Friday shop)
    V('b', '2026-10-13', 'Order Placed', 'rep2@x'), V('c', TODAY, 'Order Placed', 'rep2@x'),
  ];
  const index = historyFor(cs);
  for (const rep of ['rep1@x', 'rep2@x']) {
    it(`${rep}: Scheduled / Visited / Still due / Orders / No order are identical (Mon..today)`, () => {
      const b = buildWeekBoard({ customers: cs, visits: vs, index, weekStart: WEEK, today: TODAY, repFilter: rep });
      const r = buildPerformanceReport({ index, visits: vs, reps: ['rep1@x', 'rep2@x'], from: WEEK, to: TODAY, repFilter: rep }).rows[0];
      expect({ s: b.totals.plannedSoFar, v: b.totals.visitedSoFar, due: b.totals.stillDue, o: b.totals.orders, n: b.totals.noOrder })
        .toEqual({ s: r.scheduledCount, v: r.visitedCount, due: r.stillDueCount, o: r.ordersTaken, n: r.noOrderVisits });
      expect(b.totals.coveragePct).toBe(r.coveragePct);
    });
  }
  it('also identical when part of the range has no reliable history', () => {
    const late = buildScheduleIndex({ config: { startedAt: Date.parse('2026-10-14T06:00:00Z') }, changes: cs.map(c => base(c.id, c.assignedDay, Date.parse('2026-10-14T06:05:00Z'))) });
    const b = buildWeekBoard({ customers: cs, visits: vs, index: late, weekStart: WEEK, today: TODAY, repFilter: 'rep1@x' });
    const r = buildPerformanceReport({ index: late, visits: vs, reps: ['rep1@x'], from: WEEK, to: TODAY, repFilter: 'rep1@x' }).rows[0];
    expect([b.totals.plannedSoFar, b.totals.visitedSoFar, b.totals.stillDue, b.totals.orders]).toEqual([r.scheduledCount, r.visitedCount, r.stillDueCount, r.ordersTaken]);
    expect(b.totals.unavailableDays).toEqual(['2026-10-12', '2026-10-13']);
  });
});

describe('B6. location-capture figure is informational and uses only the validated first capture', () => {
  it('counts firstPinnedDate in the week, per rep when filtered; a legacy pin without a stamp is not counted', () => {
    const cs = [C('a', 'Mon', { firstPinnedDate: '2026-10-14', firstPinnedByEmail: 'rep1@x' }), C('b', 'Mon', { firstPinnedDate: '2026-10-01', firstPinnedByEmail: 'rep1@x' }), C('c', 'Mon')];
    expect(buildWeekBoard({ customers: cs, visits: [], index: null, weekStart: WEEK, today: TODAY }).pins.capturedThisWeek).toBe(1);
    expect(buildWeekBoard({ customers: cs, visits: [], index: null, weekStart: WEEK, today: TODAY, repFilter: 'rep2@x' }).pins.capturedThisWeek).toBe(0);
  });
});

// =====================================================================================================
describe('C. RC6.4 expenses: expanded categories with structured fields (RC6.3 base with enhancements)', () => {
  it('categories: rep now has 6, manager all; rep edit options never include Fuel/Maintenance/Bank/Stock; tiles are exactly the role\'s categories', () => {
    const repCats = expenseCategoriesFor('rep').map(c => c.value);
    const mgmtCats = expenseCategoriesFor('manager').map(c => c.value);

    // RC6.4: reps now have Transport, Meals, Other, Internet, Packaging, Supplies (6 total, no Fuel/Maintenance/Bank)
    expect(repCats).toContain('Transport');
    expect(repCats).toContain('Meals');
    expect(repCats).toContain('Other');
    expect(repCats).toContain('Internet');
    expect(repCats).toContain('Packaging');
    expect(repCats).toContain('Supplies');
    expect(repCats).not.toContain('Fuel');
    expect(repCats).not.toContain('Maintenance');
    expect(repCats).not.toContain('Bank');

    // Managers see all operating categories
    expect(mgmtCats).toContain('Transport');
    expect(mgmtCats).toContain('Meals');
    expect(mgmtCats).toContain('Fuel');
    expect(mgmtCats).toContain('Internet');
    expect(mgmtCats).toContain('Maintenance');
    expect(mgmtCats).toContain('Packaging');
    expect(mgmtCats).toContain('Supplies');
    expect(mgmtCats).toContain('Bank');
    expect(mgmtCats).toContain('Other');

    const repOptions = expenseCategoryOptionsForEdit('rep', 'Fuel').map(c => c.value);
    expect(repOptions).not.toContain('Fuel');
    expect(repOptions).toContain('Transport');

    const mgmtOptions = expenseCategoryOptionsForEdit('manager', 'Fuel').map(c => c.value);
    expect(mgmtOptions).toContain('Fuel');

    const mgmtUnexpected = expenseCategoryOptionsForEdit('manager', 'Airtime').map(c => c.value);
    expect(mgmtUnexpected).toContain('Airtime');   // manager never loses an unexpected value

    // Tiles: rep should see his categories only
    const repTiles = expenseTilesFor('rep', { Transport: 10, Fuel: 5, Stock: 7 }).map(t => [t.value, t.amount]);
    expect(repTiles.some(t => t[0] === 'Transport' && t[1] === 10)).toBe(true);
    expect(repTiles.some(t => t[0] === 'Fuel')).toBe(false);
    expect(repTiles.some(t => t[0] === 'Stock')).toBe(false);

    // Visibility
    expect(repMaySeeExpense({ category: 'Fuel' }, 'rep')).toBe(false);
    expect(repMaySeeExpense({ category: 'Stock' }, 'rep')).toBe(false);
    expect(repMaySeeExpense({ category: null }, 'rep')).toBe(false);
    expect(repMaySeeExpense({ category: 'Transport' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Internet' }, 'rep')).toBe(true);
    expect(repMaySeeExpense({ category: 'Packaging' }, 'rep')).toBe(true);
  });
  it('the rep query returns only his own Transport/Meals/Other records, including none of his older Fuel/Stock, and paginates', async () => {
    const e = (id, createdBy, category, date) => F.store.set('expenses/' + id, { createdBy, category, date, amount: 100 });
    e('x1', 'rep1', 'Transport', '2026-10-15'); e('x2', 'rep1', 'Fuel', '2026-10-14'); e('x3', 'rep1', 'Stock', '2026-10-13');
    e('x4', 'rep2', 'Meals', '2026-10-15'); e('x5', 'mgr', 'Stock', '2026-10-15'); e('x6', 'rep1', 'Meals', '2026-10-10'); e('x7', 'rep1', 'Other', '2026-10-09');
    const page = await expenses.fetchMyExpensesPage('rep1');
    expect(page.items.map(x => x.id)).toEqual(['x1', 'x6', 'x7']);
    expect(page.items.every(x => x.createdBy === 'rep1' && ['Transport', 'Meals', 'Other'].includes(x.category))).toBe(true);
    // the rep's totals cannot include an excluded category
    expect(summarizeExpenses(page.items).total).toBe(300);
    for (let i = 0; i < 30; i++) e('p' + String(i).padStart(2, '0'), 'rep1', 'Meals', '2026-09-' + String(1 + (i % 28)).padStart(2, '0'));
    const p1 = await expenses.fetchMyExpensesPage('rep1');
    const p2 = await expenses.fetchMyExpensesPage('rep1', p1.lastDoc);
    expect(p1.items).toHaveLength(25); expect(p1.hasMore).toBe(true);
    expect(new Set([...p1.items, ...p2.items].map(x => x.id)).size).toBe(33);
    expect([...p1.items, ...p2.items].some(x => ['Fuel', 'Stock'].includes(x.category))).toBe(false);
  });
});

// =====================================================================================================
describe('D. RC6.3 location-capture attribution: stamped once, at first capture, by the person who captured it', () => {
  it('a customer created with a pin gets the first-capture stamp (same credit as pinning later)', async () => {
    const id = await customers.addCustomer({ name: 'New Shop', phone: '', location: 'Area 3', lat: -13.95, lng: 33.75, uid: 'rep1', email: 'rep1@naisi.test' });
    const c = F.store.get('customers/' + id);
    expect(c.firstPinnedBy).toBe('rep1');
    expect(c.firstPinnedByEmail).toBe('rep1@naisi.test');
    expect(typeof c.firstPinnedAt.toMillis).toBe('function');                  // server time, not a phone time
  });
  it('pinning an unpinned customer stamps it; re-pinning later moves the pin but NEVER the stamp (earlier weeks stay as they were)', async () => {
    F.store.set('customers/c1', shop({ lat: null, lng: null }));
    const r1 = await customers.updateCustomerLocation('c1', { lat: -13.91, lng: 33.71, uid: 'rep1', email: 'rep1@naisi.test' });
    expect(r1.firstCapture).toBe(true);
    const first = F.store.get('customers/c1');
    expect(first).toMatchObject({ lat: -13.91, lng: 33.71, firstPinnedBy: 'rep1', firstPinnedByEmail: 'rep1@naisi.test' });
    const firstAt = first.firstPinnedAt.toMillis();
    F.setClock(Date.parse('2026-10-22T08:00:00Z'));
    const r2 = await customers.updateCustomerLocation('c1', { lat: -13.92, lng: 33.72, uid: 'rep2', email: 'rep2@naisi.test' });
    expect(r2.firstCapture).toBe(false);
    const after = F.store.get('customers/c1');
    expect(after).toMatchObject({ lat: -13.92, lng: 33.72, firstPinnedBy: 'rep1', firstPinnedByEmail: 'rep1@naisi.test' });
    expect(after.firstPinnedAt.toMillis()).toBe(firstAt);
  });
  it('a customer that already had a pin before RC6.3 (no stamp) is not stamped by a re-pin: it was not a first capture', async () => {
    F.store.set('customers/c1', shop());
    const r = await customers.updateCustomerLocation('c1', { lat: -13.93, lng: 33.73, uid: 'rep1', email: 'rep1@naisi.test' });
    expect(r.firstCapture).toBe(false);
    expect('firstPinnedBy' in F.store.get('customers/c1')).toBe(false);
  });
  it('an invalid location is refused and nothing is written', async () => {
    F.store.set('customers/c1', shop({ lat: null, lng: null }));
    await expect(customers.updateCustomerLocation('c1', { lat: 999, lng: 33, uid: 'rep1', email: 'rep1@naisi.test' })).rejects.toThrow(/valid/);
    expect(F.store.get('customers/c1').lat).toBe(null);
  });
});
