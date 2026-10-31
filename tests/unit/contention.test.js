// RC6.5: runTransactionWithRetry (src/contention.js) re-runs a transaction ONLY when a refusal coincides with a real race on the
// documents it depends on. A refusal on unchanged data is a genuine rules refusal and must surface at once.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { docs: new Map(), runs: 0, plan: [] };
vi.mock('firebase/firestore', () => ({
  getDoc: async (ref) => ({ exists: () => state.docs.has(ref.path), data: () => state.docs.get(ref.path) }),
  runTransaction: async (_db, body) => {
    state.runs++;
    const step = state.plan.shift();
    if (step) step();                      // may change a watched doc (the "other click") and/or throw
    return body({});
  },
}));
const { runTransactionWithRetry } = await import('../../src/contention.js');

const ref = (path) => ({ path });
const denied = () => Object.assign(new Error('7 PERMISSION_DENIED: false for update'), { code: 'permission-denied' });

beforeEach(() => { state.docs = new Map([['counters/naisiInvoice', { counter: 370 }]]); state.runs = 0; state.plan = []; });

describe('runTransactionWithRetry', () => {
  it('a race (watched doc changed, then permission-denied) is retried and the re-run result returned', async () => {
    state.plan = [() => { state.docs.set('counters/naisiInvoice', { counter: 371 }); throw denied(); }];
    const out = await runTransactionWithRetry({}, async () => 'second attempt', { watch: [ref('counters/naisiInvoice')] });
    expect(out).toBe('second attempt');
    expect(state.runs).toBe(2);
  });
  it('a refusal on UNCHANGED data is thrown at once (no retry)', async () => {
    state.plan = [() => { throw denied(); }];
    await expect(runTransactionWithRetry({}, async () => 'x', { watch: [ref('counters/naisiInvoice')] })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.runs).toBe(1);
  });
  it('other errors (app validation, conflicts) are never retried', async () => {
    state.plan = [() => { state.docs.set('counters/naisiInvoice', { counter: 999 }); throw Object.assign(new Error('order-conflict'), { code: 'order-conflict' }); }];
    await expect(runTransactionWithRetry({}, async () => 'x', { watch: [ref('counters/naisiInvoice')] })).rejects.toMatchObject({ code: 'order-conflict' });
    expect(state.runs).toBe(1);
  });
  it('gives up after the attempt limit even if every attempt races', async () => {
    let n = 370;
    state.plan = Array.from({ length: 3 }, () => () => { state.docs.set('counters/naisiInvoice', { counter: ++n }); throw denied(); });
    await expect(runTransactionWithRetry({}, async () => 'x', { watch: [ref('counters/naisiInvoice')], attempts: 3 })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.runs).toBe(3);
  });
  it('without watched documents it behaves exactly like runTransaction', async () => {
    state.plan = [() => { throw denied(); }];
    await expect(runTransactionWithRetry({}, async () => 'x')).rejects.toMatchObject({ code: 'permission-denied' });
    expect(state.runs).toBe(1);
  });
});
