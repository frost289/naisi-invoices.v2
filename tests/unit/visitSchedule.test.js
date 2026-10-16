import { describe, it, expect } from 'vitest';
import { baselineHistory, change } from '../helpers/history.js';
const s = await import('../../src/visitSchedule.js');
const H = await import('../../src/scheduleHistory.js');
// Reports take targets from the dated schedule history. This stand-in history starts long before the dates used here
// and records each customer's schedule as given, so the figures below mean what they always meant.
const idx = (customers, extra = {}) => { const h = baselineHistory(customers); return H.buildScheduleIndex({ ...h, changes: [...h.changes, ...(extra.changes || [])], merges: extra.merges || [] }); };

// 2026-10-15 is a Thursday, 2026-10-16 Friday.
const cust = [
  { id: 'a', name: 'A', active: true, assignedDay: 'Thu' },
  { id: 'b', name: 'B', active: true, assignedDay: 'Thu' },
  { id: 'c', name: 'C', active: true, assignedDay: 'Thu' },
  { id: 'd', name: 'D (inactive)', active: false, assignedDay: 'Thu' },
  { id: 'e', name: 'E (Friday)', active: true, assignedDay: 'Fri' },
  { id: 'f', name: 'F (no day)', active: true, assignedDay: null },
  { id: 'g', name: 'G (legacy, no active field)', assignedDay: 'Thu' },
];
const visit = (over) => ({ date: '2026-10-15', repEmail: 'r1@x', customerId: 'a', customerName: 'A', outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '', ...over });

describe('scheduled list', () => {
  it('only ACTIVE customers on that weekday; inactive and other days excluded; missing active flag counts as active', () => {
    expect(s.scheduledForDate(cust, '2026-10-15').map(c => c.id)).toEqual(['a', 'b', 'c', 'g']);
    expect(s.scheduledForDate(cust, '2026-10-16').map(c => c.id)).toEqual(['e']);
    expect(s.scheduledForDate(cust, '2026-10-18')).toEqual([]);            // Sunday
  });
});

describe('rep day progress', () => {
  it('counts distinct scheduled shops; a repeat visit is kept but not double counted', () => {
    const visits = [visit({ customerId: 'a', outcome: 'Order Placed', orderNo: 'ORD-1' }), visit({ customerId: 'a' }), visit({ customerId: 'b' })];
    const p = s.repDayProgress({ customers: cust, visits, date: '2026-10-15' });
    expect(p).toMatchObject({ scheduledCount: 4, visitedCount: 2, ordersTaken: 1, noOrderVisits: 2, totalVisits: 3 });
    expect(p.stillDue.map(c => c.id)).toEqual(['c', 'g']);
    expect(p.visitsByCustomer.get('a')).toHaveLength(2);
  });
  it('a visit to an unscheduled shop does not count towards completion but is in the totals', () => {
    const p = s.repDayProgress({ customers: cust, visits: [visit({ customerId: 'e' })], date: '2026-10-15' });
    expect(p.visitedCount).toBe(0); expect(p.stillDue).toHaveLength(4); expect(p.noOrderVisits).toBe(1);
  });
  it('ignores visits from other dates', () => {
    const p = s.repDayProgress({ customers: cust, visits: [visit({ date: '2026-10-14' })], date: '2026-10-15' });
    expect(p.visitedCount).toBe(0); expect(p.totalVisits).toBe(0);
  });
  it('a shop that became inactive after being visited is not in scheduled', () => {
    const c2 = cust.map(c => (c.id === 'a' ? { ...c, active: false } : c));
    const p = s.repDayProgress({ customers: c2, visits: [visit({ customerId: 'a' })], date: '2026-10-15' });
    expect(p.scheduledCount).toBe(3); expect(p.visitedCount).toBe(0);
  });
});

describe('manager report', () => {
  const visits = [
    visit({ repEmail: 'r1@x', customerId: 'a', outcome: 'Order Placed', orderId: 'o1', orderNo: 'ORD-1', orderValue: 500 }),
    visit({ repEmail: 'r1@x', customerId: 'a', outcome: 'Order Placed', orderId: 'o2', orderNo: 'ORD-2' }),               // legacy: no value
    visit({ repEmail: 'r1@x', customerId: 'b', reasonNoOrder: 'Other', reasonNotes: 'owner away' }),
    visit({ repEmail: 'r2@x', customerId: 'a', outcome: 'Order Placed', orderId: 'o3', orderNo: 'ORD-3', orderValue: 100 }),
    visit({ repEmail: 'r1@x', date: '2026-10-16', customerId: 'e' }),
  ];
  const reps = ['r1@x', 'r2@x', 'r3@x'];
  const report = (over = {}) => s.buildPerformanceReport({ index: idx(cust), visits, reps, from: '2026-10-15', to: '2026-10-16', ...over });

  it('includes reps with no visits', () => {
    const r3 = report().rows.find(r => r.rep === 'r3@x');
    expect(r3).toMatchObject({ totalVisits: 0, visitedCount: 0, ordersTaken: 0, noOrderVisits: 0, scheduledCount: 5, stillDueCount: 5, coveragePct: 0, conversionPct: null });
  });
  it('per-rep numbers match the saved visits', () => {
    const r1 = report().rows.find(r => r.rep === 'r1@x');
    expect(r1).toMatchObject({ scheduledCount: 5, visitedCount: 3, stillDueCount: 2, ordersTaken: 2, noOrderVisits: 2, totalVisits: 4 });
    expect(r1.due.map(d => d.customer.id + '@' + d.date)).toEqual(['c@2026-10-15', 'g@2026-10-15']);
    expect(r1.noOrder.map(v => v.reasonNotes)).toContain('owner away');
    expect(r1.extraVisits).toHaveLength(0);
    expect(r1.coveragePct).toBe(60); expect(r1.conversionPct).toBe(50);
  });
  it('two reps share the schedule but progress is separate', () => {
    const [r1, r2] = ['r1@x', 'r2@x'].map(e => report().rows.find(r => r.rep === e));
    expect(r1.scheduledCount).toBe(r2.scheduledCount);
    expect(r2).toMatchObject({ visitedCount: 1, ordersTaken: 1 });
  });
  it('rep filter', () => { expect(report({ repFilter: 'r2@x' }).rows.map(r => r.rep)).toEqual(['r2@x']); });
  it('date filter excludes visits outside the range', () => {
    const r = report({ from: '2026-10-16', to: '2026-10-16' }).rows.find(x => x.rep === 'r1@x');
    expect(r).toMatchObject({ scheduledCount: 1, visitedCount: 1, totalVisits: 1, ordersTaken: 0 });
  });
  it('order values: missing historical values are NOT zero', () => {
    const r1 = report().rows.find(r => r.rep === 'r1@x');
    expect(r1.valueTotal).toBe(500); expect(r1.valuedOrders).toBe(1); expect(r1.unvaluedOrders).toBe(1);
    const r3 = report().rows.find(r => r.rep === 'r3@x');
    expect(r3.valueTotal).toBeNull();
    const none = s.buildPerformanceReport({ index: idx(cust), visits: [visits[1]], reps: ['r1@x'], from: '2026-10-15', to: '2026-10-15' }).rows[0];
    expect(none.valueTotal).toBeNull();
  });
  it('percentages are blank (null) when the divisor is zero', () => {
    const r = s.buildPerformanceReport({ index: idx([]), visits: [], reps: ['r1@x'], from: '2026-10-15', to: '2026-10-15' }).rows[0];
    expect(r.coveragePct).toBeNull(); expect(r.conversionPct).toBeNull();
  });
  it('a visit by an email not in the rep list still appears', () => {
    const r = s.buildPerformanceReport({ index: idx(cust), visits: [visit({ repEmail: 'Old@X' })], reps: [], from: '2026-10-15', to: '2026-10-15' });
    expect(r.rows.map(x => x.rep)).toEqual(['old@x']);
  });
  it('historical targets follow the schedule that applied AT THE TIME, not the current one (owner decision 7)', () => {
    // Shop c is moved from Thursday to Friday on Friday 2026-10-16. Thursday's target must stay on Thursday.
    const moved = idx(cust, { changes: [change('x1', 'c', 'schedule', { assignedDay: 'Fri', date: '2026-10-16', name: 'C' })] });
    const r1 = s.buildPerformanceReport({ index: moved, visits, reps, from: '2026-10-15', to: '2026-10-16' }).rows.find(r => r.rep === 'r1@x');
    expect(r1.scheduledCount).toBe(6);                                   // Thu: a,b,c,g  + Fri: e and the moved c
    expect(r1.due.map(d => d.customer.id + '@' + d.date)).toEqual(['c@2026-10-15', 'g@2026-10-15', 'c@2026-10-16']);
    // and a report for Thursday alone is exactly what it was before the change
    const thu = s.buildPerformanceReport({ index: moved, visits, reps, from: '2026-10-15', to: '2026-10-15' }).rows.find(r => r.rep === 'r1@x');
    expect(thu.scheduledCount).toBe(4);
  });
});

describe('report range consistency (review finding 3)', () => {
  const thursdayShop = [{ id: 'a', name: 'A', active: true, assignedDay: 'Thu' }];
  const orderOn15Oct = [visit({ customerId: 'a', outcome: 'Order Placed', orderNo: 'ORD-1', orderId: 'o1', orderValue: 200 })];
  it('a two-year range is refused: it never counts the order while showing zero visited', () => {
    expect(() => s.buildPerformanceReport({ index: idx(thursdayShop), visits: orderOn15Oct, reps: ['r1@x'], from: '2025-01-01', to: '2026-12-31' })).toThrow(RangeError);
  });
  it('exactly 366 days covers scheduled, visited, orders and no-order over the SAME interval, including the last day', () => {
    const from = '2025-10-15', to = '2026-10-15';             // 366 days inclusive; both ends are Wed/Thu
    const visits = [visit({ date: '2026-10-15', customerId: 'a', outcome: 'Order Placed', orderId: 'o1', orderNo: 'ORD-1', orderValue: 200 }),
                    visit({ date: '2025-10-16', customerId: 'a', outcome: 'No Order' })];     // 2025-10-16 is a Thursday
    const r = s.buildPerformanceReport({ index: idx(thursdayShop), visits, reps: ['r1@x'], from, to }).rows[0];
    expect(r.ordersTaken).toBe(1); expect(r.noOrderVisits).toBe(1);
    expect(r.visitedCount).toBe(2);                              // both Thursdays are inside the interval
    expect(r.scheduledCount).toBe(53);                           // Thursdays from 2025-10-16 to 2026-10-15 inclusive
    expect(r.visitedCount + r.stillDueCount).toBe(r.scheduledCount);
  });
  it('a visit on the last day of a 366-day leap-year range is counted in every metric', () => {
    const visits = [visit({ date: '2024-12-31', customerId: 'a', outcome: 'Order Placed', orderId: 'o9', orderNo: 'ORD-9', orderValue: 10 })];
    const shop = [{ id: 'a', name: 'A', active: true, assignedDay: 'Tue' }];                  // 2024-12-31 is a Tuesday
    const r = s.buildPerformanceReport({ index: idx(shop), visits, reps: ['r1@x'], from: '2024-01-01', to: '2024-12-31' }).rows[0];
    expect(r.ordersTaken).toBe(1); expect(r.visitedCount).toBe(1);
  });
  it('the report states the interval it actually used', () => {
    const rep = s.buildPerformanceReport({ index: idx(thursdayShop), visits: [], reps: [], from: '2026-10-14', to: '2026-10-16' });
    expect(rep).toMatchObject({ from: '2026-10-14', to: '2026-10-16', days: 3 });
  });
});
