// Finding 4: a customer merge made today must not change targets, visits, coverage or still-due figures for EARLIER dates.
import { describe, it, expect, beforeEach } from 'vitest';
import { F } from './_util.js';
import { baselineHistory, tsOn } from '../helpers/history.js';
const H = await import('../../src/scheduleHistory.js');
const vs = await import('../../src/visitSchedule.js');
const cust = await import('../../src/customers.js');

const C = (id, day = 'Thu') => ({ id, name: id.toUpperCase(), active: true, assignedDay: day });
const build = (customers, merges = []) => { const h = baselineHistory(customers, '2026-10-01'); return H.buildScheduleIndex({ ...h, merges }); };
const V = (customerId, over = {}) => ({ date: '2026-10-08', repEmail: 'r@x', customerId, customerName: customerId.toUpperCase(), outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '', ...over });
const report = (index, visits, from = '2026-10-08', to = '2026-10-08') => vs.buildPerformanceReport({ index, visits, reps: ['r@x'], from, to }).rows[0];
const figures = (r) => ({ s: r.scheduledCount, v: r.visitedCount, due: r.stillDueCount, cov: r.coveragePct, totalVisits: r.totalVisits, due_: r.due.map(d => d.customer.id) });

describe('F4 historical reporting is unchanged by a later merge (new merges keep the original shop on each visit)', () => {
  const KO = { visitsKeepOriginal: true };
  // 8 Oct 2026 is a Thursday. a and b are both Thursday shops. The rep visited ONLY b on the 8th.
  const before = () => report(build([C('a'), C('b')]), [V('b')]);
  it('baseline before any merge: 2 scheduled, 1 visited, a still due', () => {
    expect(figures(before())).toEqual({ s: 2, v: 1, due: 1, cov: 50, totalVisits: 1, due_: ['a'] });
  });
  it('after b is merged into a on the 14th (visit re-pointed to a, original kept): the 8th reports EXACTLY the same figures', () => {
    const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 1 }, ...KO }];
    const after = report(build([C('a'), C('b')], merges), [V('a', { originalCustomerId: 'b' })]);
    expect(figures(after)).toEqual(figures(before()));
  });
  it('both visited: 2 of 2 stays 2 of 2 (not 1 of 1)', () => {
    const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 1 }, ...KO }];
    const r = report(build([C('a'), C('b')], merges), [V('a'), V('a', { originalCustomerId: 'b' })]);
    expect([r.scheduledCount, r.visitedCount, r.coveragePct]).toEqual([2, 2, 100]);
  });
  it('after the merge date only the survivor is a target; the merged shop is not', () => {
    const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 0 }, ...KO }];
    const idx = build([C('a'), C('b')], merges);
    expect(H.targetsForDate(idx, '2026-10-08').targets.map(t => t.customerId)).toEqual(['a', 'b']);
    expect(H.targetsForDate(idx, '2026-10-15').targets.map(t => t.customerId)).toEqual(['a']);
  });
  it('a chain b -> a -> c keeps the first origin and every earlier date unchanged', () => {
    const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-12'), moved: { visits: 1 }, ...KO }, { id: 'a', keepId: 'c', mergedAt: tsOn('2026-10-14'), moved: { visits: 1 }, ...KO }];
    const idx = build([C('a'), C('b'), C('c')], merges);
    const r = report(idx, [V('c', { originalCustomerId: 'b' })]);
    expect([r.scheduledCount, r.visitedCount, r.due.map(d => d.customer.id).sort()]).toEqual([3, 1, ['a', 'c']]);
  });
  it('a visit made AFTER the merge to the survivor counts for the survivor', () => {
    const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 0 }, ...KO }];
    const r = report(build([C('a'), C('b')], merges), [V('a', { date: '2026-10-15' })], '2026-10-15', '2026-10-15');
    expect([r.scheduledCount, r.visitedCount]).toEqual([1, 1]);
  });
});

describe('F4 merges recorded BEFORE the original shop was kept: irrecoverable ambiguity is flagged, not invented', () => {
  const merges = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 1 } }];
  it('a visit to "a" on the 8th with no original: could have been a or b. It is not credited to either; the shops it could belong to are left out for that rep and day; it is reported', () => {
    const rep = vs.buildPerformanceReport({ index: build([C('a'), C('b'), C('z')], merges), visits: [V('a')], reps: ['r@x'], from: '2026-10-08', to: '2026-10-08' });
    const r = rep.rows[0];
    expect(r.ambiguousVisits).toBe(1);
    expect(r.visitedCount).toBe(0);
    expect(r.scheduledCount).toBe(1);                       // only z remains verifiable
    expect(r.unverifiable.map(u => u.customer.id).sort()).toEqual(['a', 'b']);
    expect(r.totalVisits).toBe(1);                          // the visit itself is still a recorded visit
    expect(rep.ambiguity).toMatch(/cannot be recovered|cannot be told/i);
  });
  it('NOT ambiguous when the merge moved no visits (nothing could have been re-pointed)', () => {
    const none = [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14'), moved: { visits: 0 } }];
    const r = report(build([C('a'), C('b')], none), [V('a')]);
    expect([r.ambiguousVisits ?? 0, r.visitedCount, r.scheduledCount]).toEqual([0, 1, 2]);
  });
  it('NOT ambiguous for visits made on or after the merge date', () => {
    const r = report(build([C('a'), C('b')], merges), [V('a', { date: '2026-10-15' })], '2026-10-15', '2026-10-15');
    expect([r.ambiguousVisits ?? 0, r.visitedCount]).toEqual([0, 1]);
  });
});

describe('F4 mergeCustomers keeps the original shop on every moved visit', () => {
  beforeEach(() => { F.reset(); F.setClock(Date.parse('2026-10-15T08:00:00Z')); });
  const mgr = { uid: 'mgr1', email: 'mgr@naisi.test' };
  const put = (id, name) => F.store.set('customers/' + id, { name, phone: '1', location: 'x', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Thu' });
  it('stamps originalCustomerId once, and a second merge keeps the first origin', async () => {
    put('c', 'C'); put('a', 'A'); put('b', 'B');
    F.store.set('visits/v1', { customerId: 'b', customerName: 'B', date: '2026-10-08', repEmail: 'r@x', outcome: 'No Order' });
    F.store.set('visits/v2', { customerId: 'a', customerName: 'A', date: '2026-10-09', repEmail: 'r@x', outcome: 'No Order' });
    await cust.mergeCustomers('a', 'b', mgr);
    expect(F.store.get('visits/v1')).toMatchObject({ customerId: 'a', originalCustomerId: 'b' });
    expect(F.store.get('visits/v2').originalCustomerId).toBeUndefined();
    await cust.mergeCustomers('c', 'a', mgr);
    expect(F.store.get('visits/v1')).toMatchObject({ customerId: 'c', originalCustomerId: 'b' });
    expect(F.store.get('visits/v2')).toMatchObject({ customerId: 'c', originalCustomerId: 'a' });
  });
});

// RC5 finding C: a stamp written by a NEW merge must not erase the uncertainty a LEGACY merge already created.
describe('RC5-C mixed legacy and RC4 merge chains', () => {
  const KO = { visitsKeepOriginal: true };
  const legacy = (id, keepId, day, visits = 2) => ({ id, keepId, mergedAt: tsOn(day), moved: { visits } });          // no marker: origins were not kept
  const modern = (id, keepId, day, visits = 2) => ({ id, keepId, mergedAt: tsOn(day), moved: { visits }, ...KO });
  const ident = (merges, visit) => H.visitIdentityAt(build([C('a'), C('b'), C('c')], merges), visit);

  it('FAILS ON RC4: legacy b->a (14th), then new a->c (18th); a visit of the 8th stamped originalCustomerId=a stays AMBIGUOUS between a and b', () => {
    const r = ident([legacy('b', 'a', '2026-10-14'), modern('a', 'c', '2026-10-18')], { date: '2026-10-08', customerId: 'c', originalCustomerId: 'a' });
    expect(r.ambiguous).toBe(true);
    expect(r.id).toBe(null);
    expect(r.candidates).toEqual(expect.arrayContaining(['a', 'b']));
  });
  it('the same visit with no stamp is ambiguous too (unchanged behaviour)', () => {
    const r = ident([legacy('b', 'a', '2026-10-14'), modern('a', 'c', '2026-10-18')], { date: '2026-10-08', customerId: 'c' });
    expect(r.ambiguous).toBe(true);
  });
  it('CONTROL: a visit made AFTER the legacy merge (16th) and stamped a by the new merge is certain: a, then c after the 18th', () => {
    const merges = [legacy('b', 'a', '2026-10-14'), modern('a', 'c', '2026-10-18')];
    expect(ident(merges, { date: '2026-10-16', customerId: 'c', originalCustomerId: 'a' })).toMatchObject({ id: 'a', ambiguous: false });
    const idx = build([C('a'), C('b'), C('c')], merges);
    expect(H.visitIdentityAt(idx, { date: '2026-10-19', customerId: 'c', originalCustomerId: 'a' })).toMatchObject({ id: 'c', ambiguous: false });
  });
  it('CONTROL: a legacy merge that moved no visits creates no uncertainty', () => {
    expect(ident([legacy('b', 'a', '2026-10-14', 0), modern('a', 'c', '2026-10-18')], { date: '2026-10-08', customerId: 'c', originalCustomerId: 'a' })).toMatchObject({ id: 'a', ambiguous: false });
  });
  it('CONTROL: two new merges (b->a, a->c) keep exact origins; repeated chain unchanged', () => {
    const merges = [modern('b', 'a', '2026-10-14'), modern('a', 'c', '2026-10-18')];
    expect(ident(merges, { date: '2026-10-08', customerId: 'c', originalCustomerId: 'b' })).toMatchObject({ id: 'b', ambiguous: false });
    expect(ident(merges, { date: '2026-10-16', customerId: 'c', originalCustomerId: 'b' })).toMatchObject({ id: 'a', ambiguous: false });
    expect(ident(merges, { date: '2026-10-19', customerId: 'c', originalCustomerId: 'b' })).toMatchObject({ id: 'c', ambiguous: false });
  });
  it('legacy merge AFTER a new merge (new a->c first, then legacy b->a is impossible because a no longer exists): chain order respected', () => {
    const merges = [modern('b', 'a', '2026-10-12'), legacy('a', 'c', '2026-10-16')];
    // visit of the 8th stamped b by the new merge; the later legacy a->c re-pointed other visits but this one keeps its stamp
    expect(ident(merges, { date: '2026-10-08', customerId: 'c', originalCustomerId: 'b' })).toMatchObject({ id: 'b', ambiguous: false });
    // a visit with a stamp 'a'?? cannot exist from the new merge here; an unstamped visit now at c from before the legacy merge IS ambiguous
    expect(ident(merges, { date: '2026-10-08', customerId: 'c' }).ambiguous).toBe(true);
  });
  it('the performance report lists the stamped-but-uncertain visit as ambiguous and credits it to nobody', () => {
    const merges = [legacy('b', 'a', '2026-10-14'), modern('a', 'c', '2026-10-18')];
    const idx = build([C('a'), C('b'), C('c')], merges);
    const r = vs.buildPerformanceReport({ index: idx, visits: [V('c', { originalCustomerId: 'a' })], reps: ['r@x'], from: '2026-10-08', to: '2026-10-08' }).rows[0];
    expect(r.visitedCount).toBe(0);
    expect(r.ambiguousVisits).toBe(1);
  });
});
