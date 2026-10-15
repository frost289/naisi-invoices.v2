import { describe, it, expect, beforeEach } from 'vitest';
import { F, line } from './_util.js';
const v = await import('../../src/visits.js');

const REQ = 'req-aaaaaaaa-1111';
const rep = { uid: 'rep1', email: 'rep1@naisi.test' };
const orderItems = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1' }];
const customer = (over = {}) => ({ name: 'Shop A', phone: '0999', location: 'Area 25', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Thu', ...over });
const visitsIn = () => [...F.store].filter(([p]) => p.startsWith('visits/')).map(([p, d]) => ({ path: p, ...d }));
const ordersIn = () => [...F.store].filter(([p]) => p.startsWith('orders/')).map(([p, d]) => ({ path: p, ...d }));
const NOW = () => new Date('2026-10-15T08:00:00Z');   // Thursday in Malawi
beforeEach(() => {
  F.reset();
  F.store.set('customers/c1', customer());
  F.store.set('orderCounters/naisiOrder', { counter: 41 });
});
const order = (over = {}) => v.submitOrderWithVisit({ customerId: 'c1', items: orderItems, notes: 'n', requestId: REQ, ...rep, now: NOW, ...over });
const noOrder = (over = {}) => v.recordNoOrderVisit({ customerId: 'c1', reason: 'Price too high', notes: '', requestId: REQ, ...rep, now: NOW, ...over });

describe('validation (data layer, not only the form)', () => {
  it('reason list: all eight, "Other" last', () => {
    expect(v.NO_ORDER_REASONS).toEqual(['Shop still has stock', 'Price too high', 'Stock unavailable', 'Shop owner unavailable', 'Shop closed', 'No money today', 'Not interested', 'Other']);
  });
  it.each([[undefined], [''], ['Made up reason']])('missing/unknown reason %j is refused and nothing is written', async (reason) => {
    await expect(noOrder({ reason })).rejects.toThrow(/reason/i);
    expect(visitsIn()).toHaveLength(0);
  });
  it.each([[''], ['  '], ['ab'], [undefined]])('"Other" without a real explanation (%j) is refused', async (notes) => {
    await expect(noOrder({ reason: 'Other', notes })).rejects.toThrow(/explain/i);
    expect(visitsIn()).toHaveLength(0);
  });
  it('"Other" with an explanation is saved with customer, rep, date, reason and explanation', async () => {
    await noOrder({ reason: 'Other', notes: '  Owner at a funeral  ' });
    const [saved] = visitsIn();
    expect(saved).toMatchObject({ customerId: 'c1', customerName: 'Shop A', repId: 'rep1', repEmail: 'rep1@naisi.test', date: '2026-10-15',
      outcome: 'No Order', reasonNoOrder: 'Other', reasonNotes: 'Owner at a funeral', orderId: null, schemaVersion: 2, scheduledDay: 'Thu', wasScheduled: true });
    expect(saved.createdAt.toMillis).toBeTypeOf('function');         // server timestamp
  });
  it('other reasons accept optional details (or none)', async () => {
    await noOrder({ requestId: 'req-bbbbbbbb-2222', reason: 'Shop closed', notes: '' });
    await noOrder({ requestId: 'req-cccccccc-3333', reason: 'No money today', notes: 'Back Friday' });
    expect(visitsIn()).toHaveLength(2);
  });
  it('over-long details are refused', async () => { await expect(noOrder({ notes: 'x'.repeat(501) })).rejects.toThrow(/500/); });
  it('order items are validated', async () => {
    for (const items of [[], null, [{ ...orderItems[0], productId: null }], [{ ...orderItems[0], qty: 0, total: 0 }], [{ ...orderItems[0], qty: 1.5, total: 150 }], [{ ...orderItems[0], total: 5 }], [{ ...orderItems[0], price: -1, total: -2 }]]) {
      await expect(order({ items })).rejects.toThrow();
    }
    expect(ordersIn()).toHaveLength(0); expect(visitsIn()).toHaveLength(0);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(41);
  });
  it('bad request id / missing customer / not signed in are refused', async () => {
    await expect(order({ requestId: 'x' })).rejects.toThrow(/request id/i);
    await expect(order({ customerId: '' })).rejects.toThrow(/customer/i);
    await expect(order({ uid: '' })).rejects.toThrow(/signed in/i);
  });
  it('inactive, unknown, or un-pinned customers are refused', async () => {
    F.store.set('customers/c1', customer({ active: false }));
    await expect(order()).rejects.toThrow(/inactive/i); await expect(noOrder()).rejects.toThrow(/inactive/i);
    await expect(order({ customerId: 'nope' })).rejects.toThrow(/no longer exists/i);
    F.store.set('customers/c1', customer({ lat: null, lng: null }));
    await expect(order()).rejects.toThrow(/pinned/i);
    expect(ordersIn()).toHaveLength(0);
  });
});

describe('order + visit are one atomic save', () => {
  it('saves order, visit and order number together; links them; snapshots the value', async () => {
    const r = await order();
    expect(r).toMatchObject({ orderNo: expect.stringMatching(/-0041$/), alreadySaved: false });
    const [o] = ordersIn(), [vis] = visitsIn();
    expect(o).toMatchObject({ status: 'Submitted', customerId: 'c1', customerName: 'Shop A', grandTotal: 200, createdBy: 'rep1', visitId: vis.path.split('/')[1] });
    expect(vis).toMatchObject({ outcome: 'Order Placed', orderId: o.path.split('/')[1], orderNo: o.orderNo, orderValue: 200 });
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
  });
  it('customer details come from the customer record, not from the screen', async () => {
    F.store.set('customers/c1', customer({ name: 'Real Name', phone: '0888' }));
    await order({ customerName: 'Spoofed' });
    expect(ordersIn()[0]).toMatchObject({ customerName: 'Real Name', customerPhone: '0888' });
  });
  it('a failed commit leaves NO order, NO visit and does not use the order number', async () => {
    F.hooks.failCommit = () => new Error('network drop');
    await expect(order()).rejects.toThrow('network drop');
    expect(ordersIn()).toHaveLength(0); expect(visitsIn()).toHaveLength(0);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(41);
    F.hooks.failCommit = null;
    const r = await order();                                  // the retry works and uses number 41
    expect(r.orderNo).toMatch(/-0041$/);
  });
  it('lost acknowledgement: retry with the same request id returns the SAME order, creates nothing new', async () => {
    F.hooks.failAfterCommit = () => new Error('ack lost');
    await expect(order()).rejects.toThrow('ack lost');
    expect(ordersIn()).toHaveLength(1);                       // it did commit
    F.hooks.failAfterCommit = null;
    const again = await order();
    expect(again.alreadySaved).toBe(true);
    expect(again.orderNo).toBe(ordersIn()[0].orderNo);
    expect(ordersIn()).toHaveLength(1); expect(visitsIn()).toHaveLength(1);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);   // one number used
  });
  it('double-click (two calls at once, same request id): one order, one visit, one number', async () => {
    const r = await Promise.all([order(), order()]);
    expect(r.filter(x => !x.alreadySaved)).toHaveLength(1);
    expect(r[0].orderNo).toBe(r[1].orderNo);
    expect(ordersIn()).toHaveLength(1); expect(visitsIn()).toHaveLength(1);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
  });
  it('a deliberate second visit (new request id) is a separate order and visit', async () => {
    await order(); await order({ requestId: 'req-dddddddd-4444' });
    expect(ordersIn()).toHaveLength(2); expect(visitsIn()).toHaveLength(2);
    expect(new Set(ordersIn().map(o => o.orderNo)).size).toBe(2);
  });
  it('two reps may use the same request id without colliding (ids include the rep)', async () => {
    await order(); await order({ uid: 'rep2', email: 'rep2@naisi.test' });
    expect(ordersIn()).toHaveLength(2);
  });
  it('retrying an "Order" request id that was saved as "No Order" is refused, not merged', async () => {
    await noOrder();
    await expect(order()).rejects.toThrow(/already saved/i);
  });
});

describe('no-order visit', () => {
  it('failed commit saves nothing; lost-ack retry and double-click create one visit', async () => {
    F.hooks.failCommit = () => new Error('drop');
    await expect(noOrder()).rejects.toThrow('drop');
    expect(visitsIn()).toHaveLength(0);
    F.hooks.failCommit = null;
    await Promise.all([noOrder(), noOrder()]);
    expect(visitsIn()).toHaveLength(1);
    F.hooks.failAfterCommit = () => new Error('x');
    await expect(noOrder({ requestId: 'req-eeeeeeee-5555' })).rejects.toThrow('x');
    F.hooks.failAfterCommit = null;
    expect((await noOrder({ requestId: 'req-eeeeeeee-5555' })).alreadySaved).toBe(true);
    expect(visitsIn()).toHaveLength(2);
  });
  it('records an unscheduled visit as wasScheduled=false', async () => {
    F.store.set('customers/c1', customer({ assignedDay: 'Mon' }));
    await noOrder();
    expect(visitsIn()[0]).toMatchObject({ scheduledDay: 'Mon', wasScheduled: false });
  });
  it('Malawi date: 23:30 UTC Thursday is recorded as Friday', async () => {
    await noOrder({ now: () => new Date('2026-10-15T23:30:00Z') });
    expect(visitsIn()[0].date).toBe('2026-10-16');
  });
});

describe('reading', () => {
  it('fetchMyVisitsForDate returns only this rep and this date, oldest first', async () => {
    await noOrder({ requestId: 'req-11111111-aaaa' });
    F.setClock(Date.now() + 5000);
    await noOrder({ requestId: 'req-22222222-bbbb', reason: 'Shop closed' });
    await noOrder({ requestId: 'req-33333333-cccc', uid: 'rep2', email: 'r2@x' });
    await noOrder({ requestId: 'req-44444444-dddd', now: () => new Date('2026-10-14T08:00:00Z') });
    const mine = await v.fetchMyVisitsForDate('rep1', '2026-10-15');
    expect(mine.map(x => x.requestId)).toEqual(['req-11111111-aaaa', 'req-22222222-bbbb']);
  });
});

// ---- Review finding 1: a retry with the SAME request id must be an identical retry, ----
// ---- otherwise it is a conflict that says what was already saved.                    ----
describe('identical retry vs changed retry (same request id)', () => {
  const counter = () => F.store.get('orderCounters/naisiOrder').counter;
  const snapshot = () => JSON.stringify([[...F.store].map(([p, d]) => [p, d])]);
  const lostAckOrder = async (over = {}) => {
    F.hooks.failAfterCommit = () => new Error('ack lost');
    await expect(order(over)).rejects.toThrow('ack lost');
    F.hooks.failAfterCommit = null;
  };
  const lostAckNoOrder = async (over = {}) => {
    F.hooks.failAfterCommit = () => new Error('ack lost');
    await expect(noOrder(over)).rejects.toThrow('ack lost');
    F.hooks.failAfterCommit = null;
  };
  const expectConflict = async (promise, savedCheck) => {
    let err; try { await promise; } catch (e) { err = e; }
    expect(err, 'a changed retry must be refused').toBeTruthy();
    expect(err.code).toBe('visit-conflict');
    expect(err.message).toMatch(/already saved/i);
    expect(err.message).toMatch(/not saved|were not|was not/i);   // says the new details were NOT saved
    expect(err.saved).toBeTruthy();
    if (savedCheck) savedCheck(err.saved);
  };

  it('identical order retry (notes padded with spaces) returns the saved order and writes nothing', async () => {
    await lostAckOrder();
    const before = snapshot();
    const again = await order({ notes: '  n  ' });
    expect(again).toMatchObject({ alreadySaved: true, orderNo: ordersIn()[0].orderNo });
    expect(snapshot()).toBe(before); expect(counter()).toBe(42);
  });
  it('identical no-order retry returns the saved visit and writes nothing', async () => {
    await lostAckNoOrder({ reason: 'Other', notes: 'Owner away' });
    const before = snapshot();
    const again = await noOrder({ reason: 'Other', notes: ' Owner away ' });
    expect(again.alreadySaved).toBe(true);
    expect(snapshot()).toBe(before);
  });

  describe('order retries that differ', () => {
    beforeEach(async () => { F.store.set('customers/c2', customer({ name: 'Shop B' })); await lostAckOrder(); });
    const cases = {
      'quantity 2 -> 5': { items: [{ ...orderItems[0], qty: 5, total: 500 }] },
      'a different product': { items: [{ ...orderItems[0], productId: 'p9' }] },
      'a different price': { items: [{ ...orderItems[0], price: 90, total: 180 }] },
      'an extra line': { items: [...orderItems, { qty: 1, desc: 'Other', price: 50, total: 50, productId: 'p2' }] },
      'a different customer': { customerId: 'c2' },
      'different order notes': { notes: 'something else' },
    };
    for (const [name, over] of Object.entries(cases)) {
      it(`${name}: conflict, shows what was saved, nothing changes`, async () => {
        const before = snapshot();
        await expectConflict(order(over), (s) => {
          expect(s).toMatchObject({ outcome: 'Order Placed', customerName: 'Shop A', orderNo: ordersIn()[0].orderNo, orderValue: 200 });
          expect(s.items).toEqual([expect.objectContaining({ productId: 'p1', qty: 2 })]);
        });
        expect(snapshot()).toBe(before);                 // no new or changed documents
        expect(ordersIn()).toHaveLength(1); expect(visitsIn()).toHaveLength(1);
        expect(ordersIn()[0].items[0].qty).toBe(2);      // the stored quantity is still 2
        expect(counter()).toBe(42);                      // no extra order number used
      });
    }
    it('the same request id saved as an order cannot be re-sent as No Order', async () => {
      const before = snapshot();
      await expectConflict(noOrder(), (s) => expect(s).toMatchObject({ outcome: 'Order Placed', orderNo: ordersIn()[0].orderNo }));
      expect(snapshot()).toBe(before);
    });
  });

  describe('no-order retries that differ', () => {
    beforeEach(async () => { F.store.set('customers/c2', customer({ name: 'Shop B' })); await lostAckNoOrder({ reason: 'Price too high', notes: 'wants discount' }); });
    const cases = {
      'a different reason': { reason: 'Shop closed' },
      'a different explanation': { notes: 'something else' },
      'a different customer': { customerId: 'c2' },
      'reason "Other" with an explanation': { reason: 'Other', notes: 'new text' },
    };
    for (const [name, over] of Object.entries(cases)) {
      it(`${name}: conflict, shows what was saved, nothing changes`, async () => {
        const before = snapshot();
        await expectConflict(noOrder({ reason: 'Price too high', notes: 'wants discount', ...over }), (s) =>
          expect(s).toMatchObject({ outcome: 'No Order', customerName: 'Shop A', reasonNoOrder: 'Price too high', reasonNotes: 'wants discount' }));
        expect(snapshot()).toBe(before);
        expect(visitsIn()).toHaveLength(1);
      });
    }
    it('the same request id saved as No Order cannot be re-sent as an order', async () => {
      const before = snapshot();
      await expectConflict(order(), (s) => expect(s.outcome).toBe('No Order'));
      expect(snapshot()).toBe(before); expect(ordersIn()).toHaveLength(0); expect(counter()).toBe(41);
    });
  });

  it('a conflict never invents a new request id: only a deliberate new id saves a second visit', async () => {
    await lostAckOrder();
    await expect(order({ items: [{ ...orderItems[0], qty: 5, total: 500 }] })).rejects.toMatchObject({ code: 'visit-conflict' });
    const r = await order({ items: [{ ...orderItems[0], qty: 5, total: 500 }], requestId: 'req-ffffffff-6666' });
    expect(r.alreadySaved).toBe(false);
    expect(ordersIn()).toHaveLength(2); expect(counter()).toBe(43);
  });
});
