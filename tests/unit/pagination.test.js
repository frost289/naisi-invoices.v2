import { describe, it, expect } from 'vitest';
const { createPagedLoadGuard, mergeById } = await import('../../src/ui.js');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

// A tiny list driven exactly the way main.js drives each paged list.
function makeList() {
  const guard = createPagedLoadGuard();
  const s = { rows: [], cursor: null, hasMore: true, filter: 'A', loading: false, loadingEvents: [], errors: [] };
  const pending = [];
  s.fetchImpl = (filter, cursor) => { const d = deferred(); pending.push({ filter, cursor, d }); return d.promise; };
  s.pending = pending;
  s.reset = () => { guard.reset(); s.rows = []; s.cursor = null; s.hasMore = true; };
  s.next = () => {
    if (!s.hasMore) return Promise.resolve(false);
    const cursor = s.cursor, filter = s.filter;           // captured synchronously
    return guard.run({
      setLoading: (on) => { s.loading = on; s.loadingEvents.push(on); },
      fetch: () => s.fetchImpl(filter, cursor),
      apply: (r) => { s.rows = mergeById(s.rows, r.items); s.cursor = r.cursor; s.hasMore = r.hasMore; },
      onError: (e) => s.errors.push(e.message),
    });
  };
  return s;
}
const page = (ids, cursor, hasMore = true) => ({ items: ids.map(id => ({ id })), cursor, hasMore });
const ids = (s) => s.rows.map(r => r.id);

describe('createPagedLoadGuard', () => {
  it('normal sequence: pages append in order, no duplicates', async () => {
    const s = makeList();
    const p1 = s.next(); s.pending[0].d.resolve(page(['a', 'b'], 'cb')); await p1;
    const p2 = s.next(); expect(s.pending[1].cursor).toBe('cb'); s.pending[1].d.resolve(page(['c'], 'cc', false)); await p2;
    expect(ids(s)).toEqual(['a', 'b', 'c']); expect(s.hasMore).toBe(false);
  });
  it('filter change while a page is in flight: the OLD response (arriving LAST) is discarded', async () => {
    const s = makeList();
    const old = s.next();                                  // filter A, in flight
    s.filter = 'B'; s.reset();
    const fresh = s.next();                                // filter B
    s.pending[1].d.resolve(page(['b1', 'b2'], 'cb2')); await fresh;
    s.pending[0].d.resolve(page(['a1', 'a2'], 'ca2'));     // stale arrives afterwards
    expect(await old).toBe(false);
    expect(ids(s)).toEqual(['b1', 'b2']);
    expect(s.cursor).toBe('cb2');
  });
  it('stale response arriving FIRST is also discarded and does not clear the current request loading state', async () => {
    const s = makeList();
    const old = s.next();
    s.filter = 'B'; s.reset();
    const fresh = s.next();
    s.pending[0].d.resolve(page(['a1'], 'ca1')); await old;
    expect(ids(s)).toEqual([]);
    expect(s.loading).toBe(true);                          // B is still loading
    s.pending[1].d.resolve(page(['b1'], 'cb1')); await fresh;
    expect(ids(s)).toEqual(['b1']); expect(s.loading).toBe(false);
  });
  it('a stale failure does not show an error or alter state', async () => {
    const s = makeList();
    const old = s.next(); s.reset(); const fresh = s.next();
    s.pending[0].d.reject(new Error('old failed')); await old;
    expect(s.errors).toEqual([]);
    s.pending[1].d.resolve(page(['x'], 'cx')); await fresh;
    expect(ids(s)).toEqual(['x']);
  });
  it('a current failure is reported once and the list can be retried', async () => {
    const s = makeList();
    const p = s.next(); s.pending[0].d.reject(new Error('net')); await p;
    expect(s.errors).toEqual(['net']); expect(s.loading).toBe(false);
    const p2 = s.next(); s.pending[1].d.resolve(page(['a'], 'ca')); await p2;
    expect(ids(s)).toEqual(['a']);
  });
  it('double-clicking Load more runs one fetch only (no overlapping pages)', async () => {
    const s = makeList();
    const p1 = s.next(); const p2 = s.next();
    expect(s.pending).toHaveLength(1);
    s.pending[0].d.resolve(page(['a'], 'ca')); await Promise.all([p1, p2]);
    expect(ids(s)).toEqual(['a']);
  });
  it('the cursor and filter used are the ones captured at request time, even if state changes before the await returns', async () => {
    const s = makeList();
    s.cursor = 'c1'; s.filter = 'A';
    const p = s.next();
    s.filter = 'B';                                        // changed without reset (a bug elsewhere) — request still carries A
    expect(s.pending[0]).toMatchObject({ filter: 'A', cursor: 'c1' });
    s.pending[0].d.resolve(page(['a'], 'c2')); await p;
  });
  it('overlapping page content from two loads cannot duplicate rows (mergeById)', () => {
    expect(mergeById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]).map(r => r.id)).toEqual(['a', 'b', 'c']);
  });
});
