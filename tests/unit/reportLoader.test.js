import { describe, it, expect } from 'vitest';
const { requestReport } = await import('../../src/reportLoader.js');
const { createPagedLoadGuard } = await import('../../src/ui.js');
const { buildPerformanceReport } = await import('../../src/visitSchedule.js');
const { buildScheduleIndex } = await import('../../src/scheduleHistory.js');
const { baselineHistory } = await import('../helpers/history.js');

// A tiny stand-in for the report screen: controls, the report on screen, the loading flag.
function screen() {
  const pending = [];                                   // requests whose answers we release by hand
  const s = {
    guard: createPagedLoadGuard(), controls: { from: '', to: '' }, shown: null, loading: false, loadingLog: [], errors: [], invalid: [],
    fetchCalls: [],
    fetch({ from, to }) { s.fetchCalls.push({ from, to }); return new Promise((resolve, reject) => pending.push({ from, to, resolve, reject })); },
    // what the button handlers do: read the controls NOW, then request
    run() {
      return requestReport(s.guard, {
        from: s.controls.from, to: s.controls.to,
        fetch: s.fetch,
        apply: (visits, range) => { s.shown = { range, visits }; },
        onError: (e) => s.errors.push(e.message),
        onInvalid: (m) => s.invalid.push(m),
        setLoading: (on) => { s.loading = on; s.loadingLog.push(on); },
      });
    },
    setRange(from, to) { s.controls = { from, to }; },
    pending,
    answer(i, visits) { pending[i].resolve(visits); },
    fail(i, msg) { pending[i].reject(new Error(msg)); },
  };
  return s;
}
const tick = () => new Promise(r => setTimeout(r, 0));
const day = (date) => [{ date, repEmail: 'r1@x', customerId: 'a', customerName: 'A', outcome: 'No Order', reasonNoOrder: 'Shop closed' }];

describe('manager report always matches the selected range', () => {
  it('REVIEW SCENARIO: 14 Oct is slow; the controls move to 15 Oct and a new report is requested; only 15 Oct is shown', async () => {
    const s = screen();
    s.setRange('2026-10-14', '2026-10-14'); const first = s.run();
    s.setRange('2026-10-15', '2026-10-15'); const second = s.run();
    expect(s.fetchCalls).toEqual([{ from: '2026-10-14', to: '2026-10-14' }, { from: '2026-10-15', to: '2026-10-15' }]);   // the newer range IS requested
    s.answer(0, day('2026-10-14')); await first;                  // stale answer arrives first
    expect(s.shown).toBeNull(); expect(s.loading).toBe(true);     // ignored; still loading the newer one
    s.answer(1, day('2026-10-15')); await second;
    expect(s.shown.range).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(s.shown.visits[0].date).toBe('2026-10-15');
    expect(s.controls).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(s.loading).toBe(false);
  });
  it('responses arriving out of order: the newest request wins even when it answers first', async () => {
    const s = screen();
    s.setRange('2026-10-12', '2026-10-12'); const a = s.run();
    s.setRange('2026-10-13', '2026-10-13'); const b = s.run();
    s.setRange('2026-10-14', '2026-10-14'); const c = s.run();
    s.answer(2, day('2026-10-14')); await c;
    s.answer(0, day('2026-10-12')); await a;
    s.answer(1, day('2026-10-13')); await b;
    expect(s.shown.range.from).toBe('2026-10-14'); expect(s.shown.visits[0].date).toBe('2026-10-14');
    expect(s.loading).toBe(false);
  });
  it('rapid shortcut clicks (Today, This week, Today): last one wins, stale ones never overwrite', async () => {
    const s = screen();
    s.setRange('2026-10-15', '2026-10-15'); const t1 = s.run();                 // Today
    s.setRange('2026-10-12', '2026-10-15'); const w = s.run();                  // This week
    s.setRange('2026-10-15', '2026-10-15'); const t2 = s.run();                 // Today again
    expect(s.fetchCalls).toHaveLength(3);
    s.answer(1, [...day('2026-10-13'), ...day('2026-10-15')]); await w;         // week answer arrives first
    expect(s.shown).toBeNull();
    s.answer(2, day('2026-10-15')); await t2;
    s.answer(0, day('2026-10-15')); await t1;
    expect(s.shown.range).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(s.shown.visits).toHaveLength(1);
  });
  it('a stale request that FAILS after a newer one succeeded shows no error and keeps the newer report and loading state', async () => {
    const s = screen();
    s.setRange('2026-10-14', '2026-10-14'); const a = s.run();
    s.setRange('2026-10-15', '2026-10-15'); const b = s.run();
    s.answer(1, day('2026-10-15')); await b;
    s.fail(0, 'network'); await a;
    expect(s.errors).toEqual([]);
    expect(s.shown.range.from).toBe('2026-10-15');
    expect(s.loading).toBe(false);
  });
  it('a stale request that fails BEFORE the newer one answers does not switch loading off or show an error', async () => {
    const s = screen();
    s.setRange('2026-10-14', '2026-10-14'); const a = s.run();
    s.setRange('2026-10-15', '2026-10-15'); const b = s.run();
    s.fail(0, 'network'); await a;
    expect(s.errors).toEqual([]); expect(s.loading).toBe(true);
    s.answer(1, day('2026-10-15')); await b;
    expect(s.shown.range.from).toBe('2026-10-15'); expect(s.loading).toBe(false);
  });
  it('the NEWEST request failing is reported, and the older report is not pretended to be new', async () => {
    const s = screen();
    s.setRange('2026-10-14', '2026-10-14'); const a = s.run(); s.answer(0, day('2026-10-14')); await a;
    s.setRange('2026-10-15', '2026-10-15'); const b = s.run(); s.fail(1, 'offline'); await b;
    expect(s.errors).toEqual(['offline']);
    expect(s.shown.range.from).toBe('2026-10-14');         // what is on screen still says which range it is
  });
  it('a custom range change while loading is applied with the range that was fetched, not the range in the controls when it arrives', async () => {
    const s = screen();
    s.setRange('2026-10-01', '2026-10-31'); const a = s.run();
    s.setRange('2026-09-01', '2026-09-30');                // user edits the boxes but has not pressed Show yet
    s.answer(0, day('2026-10-05')); await a;
    expect(s.shown.range).toEqual({ from: '2026-10-01', to: '2026-10-31' });   // displayed range = fetched range
  });
  it('an unusable range changes nothing: running request and shown report are left alone, the reason is reported', async () => {
    const s = screen();
    s.setRange('2026-10-14', '2026-10-14'); const a = s.run();
    s.setRange('2025-01-01', '2026-12-31'); const bad = await s.run();      // two years
    expect(bad).toBe(false); expect(s.invalid[0]).toMatch(/366/); expect(s.fetchCalls).toHaveLength(1);
    s.setRange('2026-10-16', '2026-10-15'); await s.run(); expect(s.invalid[1]).toMatch(/after/i);
    s.answer(0, day('2026-10-14')); await a;
    expect(s.shown.range.from).toBe('2026-10-14');
  });
  it('final controls, displayed range and totals agree (totals computed from the displayed range)', async () => {
    const s = screen();
    const customers = [{ id: 'a', name: 'A', active: true, assignedDay: 'Wed' }, { id: 'b', name: 'B', active: true, assignedDay: 'Thu' }];
    s.setRange('2026-10-14', '2026-10-14'); const a = s.run();      // Wednesday
    s.setRange('2026-10-15', '2026-10-15'); const b = s.run();      // Thursday
    s.answer(0, day('2026-10-14')); await a;
    s.answer(1, [{ date: '2026-10-15', repEmail: 'r1@x', customerId: 'b', customerName: 'B', outcome: 'Order Placed', orderId: 'o1', orderNo: '1', orderValue: 5 }]); await b;
    const rep = buildPerformanceReport({ index: buildScheduleIndex(baselineHistory(customers)), visits: s.shown.visits, reps: ['r1@x'], ...s.shown.range }).rows[0];
    expect(s.shown.range).toEqual(s.controls);
    expect(rep).toMatchObject({ scheduledCount: 1, visitedCount: 1, ordersTaken: 1, noOrderVisits: 0 });
  });
});
