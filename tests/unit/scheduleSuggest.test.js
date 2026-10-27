// Distance-based schedule suggestions: pure planner + the guarded apply path (in-memory Firestore stand-in).
import { describe, it, expect, beforeEach } from 'vitest';
import { F } from './_util.js';
const S = await import('../../src/scheduleSuggest.js');
const cust = await import('../../src/customers.js');
const { haversineKm } = await import('../../src/routing.js');
const mgr = { uid: 'mgr1', email: 'mgr@naisi.test' };
// three well separated areas around Lilongwe (about 8-12 km apart), 8 shops each, jittered deterministically
const AREAS = { north: [-13.93, 33.78], east: [-14.00, 33.86], south: [-14.07, 33.76] };
const shops = [];
let n = 0;
for (const [area, [la, ln]] of Object.entries(AREAS)) for (let i = 0; i < 8; i++) shops.push({ id: `${area}${i}`, name: `${area} ${i}`, active: true, assignedDay: null, lat: la + (i % 3) * 0.004, lng: ln + (Math.floor(i / 3)) * 0.004 });
const withDays = (f) => shops.map((s, i) => ({ ...s, assignedDay: f(s, i) }));
const area = (id) => id.replace(/\d+$/, '');
beforeEach(() => { F.reset(); F.setClock(Date.parse('2026-10-15T08:00:00Z')); });

describe('suggestSchedule - all (re-plan)', () => {
  it('puts nearby shops on the same day: 3 areas over 3 days -> one area per day', () => {
    const r = S.suggestSchedule(withDays(() => null), { days: ['Mon', 'Tue', 'Wed'], scope: 'all' });
    const dayOf = Object.fromEntries(r.changes.map(c => [c.id, c.to]));
    for (const a of Object.keys(AREAS)) expect(new Set(shops.filter(s => area(s.id) === a).map(s => dayOf[s.id])).size).toBe(1);
    expect(new Set(Object.values(dayOf)).size).toBe(3);
  });
  it('is deterministic and does not modify its input', () => {
    const input = withDays((s, i) => ['Mon', 'Tue', 'Wed'][i % 3]); const copy = JSON.stringify(input);
    const a = S.suggestSchedule(input, { days: ['Mon', 'Tue', 'Wed'], scope: 'all' }), b = S.suggestSchedule(input, { days: ['Mon', 'Tue', 'Wed'], scope: 'all' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)); expect(JSON.stringify(input)).toBe(copy);
  });
  it('a scrambled schedule gets a shorter total route; days stay balanced (within the tolerance)', () => {
    const scrambled = withDays((s, i) => ['Mon', 'Tue', 'Wed'][i % 3]);
    const r = S.suggestSchedule(scrambled, { days: ['Mon', 'Tue', 'Wed'], scope: 'all' });
    expect(r.after.totalKm).toBeLessThan(r.before.totalKm * 0.6);
    const sizes = r.after.perDay.map(d => d.count); expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(2);
  });
  it('an already well-planned schedule is left alone (the weekday names are matched so nobody moves needlessly)', () => {
    const good = withDays(s => ({ north: 'Wed', east: 'Mon', south: 'Fri' })[area(s.id)]);
    const r = S.suggestSchedule(good, { days: ['Mon', 'Wed', 'Fri'], scope: 'all' });
    expect(r.moves).toHaveLength(0);
  });
  it('shops with no pin, closed shops and shops being merged are never planned; no-pin shops are listed, not guessed', () => {
    const list = [...withDays(() => null), { id: 'nopin', name: 'No Pin', active: true, lat: null, lng: null }, { id: 'closed', name: 'Closed', active: false, lat: -13.9, lng: 33.7 },
      { id: 'merging', name: 'M', active: true, lat: -13.9, lng: 33.7, mergeLock: { into: 'north0' } }, { id: 'bad', name: 'Bad', active: true, lat: 999, lng: 33.7 }];
    const r = S.suggestSchedule(list, { scope: 'all' });
    const ids = new Set(r.changes.map(c => c.id));
    for (const x of ['nopin', 'closed', 'merging', 'bad']) expect(ids.has(x)).toBe(false);
    expect(r.skipped.map(s => s.id).sort()).toEqual(['bad', 'nopin']);
  });
  it('only the chosen days are used (e.g. no Saturday)', () => {
    const r = S.suggestSchedule(withDays(() => null), { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], scope: 'all' });
    expect(r.changes.every(c => c.to !== 'Sat')).toBe(true);
    expect(() => S.suggestSchedule(shops, { days: [] })).toThrow(/at least one/);
  });
  it('works for edge sizes: no shops, one shop, fewer shops than days', () => {
    expect(S.suggestSchedule([], { scope: 'all' }).changes).toEqual([]);
    expect(S.suggestSchedule([shops[0]], { scope: 'all' }).changes).toHaveLength(1);
    expect(new Set(S.suggestSchedule(shops.slice(0, 3), { scope: 'all' }).changes.map(c => c.to)).size).toBeLessThanOrEqual(3);
  });
});

describe('suggestSchedule - unscheduled only (default)', () => {
  it('places new shops next to the shops already on a day and moves nobody else', () => {
    const existing = shops.filter(s => !s.id.endsWith('7')).map(s => ({ ...s, assignedDay: { north: 'Mon', east: 'Tue', south: 'Wed' }[area(s.id)] }));
    const newcomers = shops.filter(s => s.id.endsWith('7'));
    const r = S.suggestSchedule([...existing, ...newcomers], { days: ['Mon', 'Tue', 'Wed'] });
    expect(r.moves.map(m => m.id).sort()).toEqual(newcomers.map(s => s.id).sort());
    for (const m of r.moves) expect(m.to).toBe({ north: 'Mon', east: 'Tue', south: 'Wed' }[area(m.id)]);
    expect(r.moves.every(m => m.from === null)).toBe(true);
  });
  it('never refuses to place a shop because the days are full (capacity grows instead)', () => {
    const existing = shops.slice(0, 18).map(s => ({ ...s, assignedDay: 'Mon' }));
    const r = S.suggestSchedule([...existing, ...shops.slice(18).map(s => ({ ...s, assignedDay: null }))], { days: ['Mon', 'Tue'] });
    expect(r.moves).toHaveLength(6);
  });
  it('an uneven existing plan does not push a new shop across town: it still joins the nearby day', () => {
    const existing = [...shops.slice(8, 16).map(x => ({ ...x, assignedDay: 'Tue' })), { ...shops[0], id: 'n0', assignedDay: 'Mon' }, { ...shops[1], id: 'n1', assignedDay: 'Mon' }];
    const r = S.suggestSchedule([...existing, { ...shops[2], id: 'newN', name: 'New N', assignedDay: null }], { days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] });
    expect(r.moves).toHaveLength(1); expect(r.moves[0].to).toBe('Mon');
  });
  it('shops far from every existing group still get a day', () => {
    const far = { id: 'far', name: 'Far', active: true, assignedDay: null, lat: -15.4, lng: 35.0 };
    const r = S.suggestSchedule([...withDays(s => ({ north: 'Mon', east: 'Tue', south: 'Wed' }[area(s.id)])), far], { days: ['Mon', 'Tue', 'Wed'] });
    expect(r.moves).toHaveLength(1); expect(['Mon', 'Tue', 'Wed']).toContain(r.moves[0].to);
  });
  it('estimated route length uses straight-line distance and is reported per day', () => {
    const r = S.suggestSchedule(withDays(s => ({ north: 'Mon', east: 'Tue', south: 'Wed' }[area(s.id)])), { scope: 'all', days: ['Mon', 'Tue', 'Wed'] });
    expect(r.before.perDay.map(d => d.day)).toEqual(['Mon', 'Tue', 'Wed']);
    for (const d of r.before.perDay) expect(d.km).toBeGreaterThan(0);
    expect(haversineKm({ lat: -13.93, lng: 33.78 }, { lat: -14.0, lng: 33.86 })).toBeGreaterThan(5);
  });
});

describe('applySuggestions - guarded, dated, nothing silent', () => {
  const seed = () => { for (const s of shops.slice(0, 4)) F.store.set('customers/' + s.id, { ...s, assignedDay: null }); };
  const setDay = (id, to, from) => cust.setCustomerVisitDay(id, to, { ...mgr, expectedDay: from });
  it('applies each move through the normal schedule change: one dated history entry per shop', async () => {
    seed();
    const moves = shops.slice(0, 4).map(s => ({ id: s.id, name: s.name, from: null, to: 'Tue' }));
    const prog = [];
    const r = await S.applySuggestions(moves, { setDay, onProgress: (d, t) => prog.push([d, t]) });
    expect(r.applied).toHaveLength(4); expect(prog.at(-1)).toEqual([4, 4]);
    const hist = [...F.store].filter(([p]) => p.startsWith('scheduleChanges/')).map(([, d]) => d);
    expect(hist).toHaveLength(4); expect(hist.every(h => h.kind === 'schedule' && h.assignedDay === 'Tue' && h.changedBy === 'mgr1')).toBe(true);
    expect(F.store.get('customers/' + shops[0].id).assignedDay).toBe('Tue');
  });
  it('a shop whose day changed since the suggestion is skipped, not overwritten, and writes no history', async () => {
    seed(); F.store.set('customers/' + shops[1].id, { ...shops[1], assignedDay: 'Fri' });      // someone else scheduled it meanwhile
    const moves = shops.slice(0, 3).map(s => ({ id: s.id, name: s.name, from: null, to: 'Tue' }));
    const r = await S.applySuggestions(moves, { setDay });
    expect(r.applied.map(m => m.id)).toEqual([shops[0].id, shops[2].id]); expect(r.stale.map(m => m.id)).toEqual([shops[1].id]);
    expect(F.store.get('customers/' + shops[1].id).assignedDay).toBe('Fri');
    expect([...F.store].filter(([p]) => p.startsWith('scheduleChanges/'))).toHaveLength(2);
  });
  it('one failing shop (merge lock, deleted) does not stop the rest', async () => {
    seed(); F.store.set('customers/' + shops[0].id, { ...shops[0], assignedDay: null, mergeLock: { into: 'x' } }); F.store.delete('customers/' + shops[2].id);
    const moves = shops.slice(0, 4).map(s => ({ id: s.id, name: s.name, from: null, to: 'Mon' }));
    const r = await S.applySuggestions(moves, { setDay });
    expect(r.applied.map(m => m.id)).toEqual([shops[1].id, shops[3].id]); expect(r.failed.map(m => m.id)).toEqual([shops[0].id, shops[2].id]);
    expect(r.failed[0].error).toMatch(/merg/i);
  });
  it('re-running the same suggestion after it was applied changes nothing (no duplicate history)', async () => {
    seed(); const moves = [{ id: shops[0].id, name: 'x', from: null, to: 'Mon' }];
    await S.applySuggestions(moves, { setDay });
    const again = await S.applySuggestions(moves, { setDay });
    expect(again.stale).toHaveLength(1);
    expect([...F.store].filter(([p]) => p.startsWith('scheduleChanges/'))).toHaveLength(1);
  });
});
