// Regression tests for the eight owner decisions (RC3). Data layer only (in-memory Firestore stand-in);
// the same behaviours are enforced again by the security rules and tested on the emulator in tests/rules.
import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, line, seedProduct, seedOrder, withId, ledger, invoices, seedCounter, meta } from './_util.js';
import { baselineHistory, change, tsOn } from '../helpers/history.js';
const stock = await import('../../src/stock.js');
const cust = await import('../../src/customers.js');
const mo = await import('../../src/managerOrders.js');
const num = await import('../../src/numbering.js');
const onum = await import('../../src/orderNumbering.js');
const orders = await import('../../src/orders.js');
const H = await import('../../src/scheduleHistory.js');
const store = await import('../../src/scheduleStore.js');
const vs = await import('../../src/visitSchedule.js');
const visits = await import('../../src/visits.js');

const mgr = { uid: 'mgr1', email: 'mgr@naisi.test' };
const REQ = 'req-aaaaaaaa-0001';
const NOW = () => new Date('2026-10-15T08:00:00Z');
const pinned = (over = {}) => ({ name: 'Shop A', phone: '0999', location: 'Area 25', lat: -13.9, lng: 33.7, active: true, assignedDay: 'Thu', ...over });
const at = (store_, prefix) => [...store_].filter(([p]) => p.startsWith(prefix)).map(([p, d]) => ({ path: p, ...d }));
beforeEach(() => { F.reset(); F.setClock(Date.parse('2026-10-15T08:00:00Z')); });

describe('decision 1 - customers and schedule', () => {
  it('a new customer is active and UNSCHEDULED (no weekday is invented)', async () => {
    const id = await cust.addCustomer({ name: 'New Shop', phone: '0888', location: 'Area 3', lat: -13.9, lng: 33.7, uid: 'rep1' });
    expect(F.store.get('customers/' + id)).toMatchObject({ active: true, assignedDay: null, createdBy: 'rep1' });
  });
  it('a customer without a pin cannot be added', async () => {
    await expect(cust.addCustomer({ name: 'x', phone: '', location: '', lat: null, lng: null, uid: 'rep1' })).rejects.toThrow(/pinned/i);
  });
  it('managers see new customers awaiting scheduling; scheduled, inactive and merging ones are not listed', () => {
    const list = H.awaitingScheduling([{ id: 'a', active: true, assignedDay: null }, { id: 'b', active: true, assignedDay: 'Mon' }, { id: 'c', active: false, assignedDay: null }, { id: 'd', active: true, assignedDay: null, mergeLock: { into: 'a' } }, { id: 'e' }]);
    expect(list.map(c => c.id)).toEqual(['a', 'e']);
  });
  it('setting a visit day updates the customer AND appends one history entry in the same commit', async () => {
    F.store.set('customers/c1', pinned({ assignedDay: null }));
    const r = await cust.setCustomerVisitDay('c1', 'Fri', mgr);
    expect(F.store.get('customers/c1')).toMatchObject({ assignedDay: 'Fri', active: true, lastScheduleChangeId: r.changeId });
    const ch = at(F.store, 'scheduleChanges/');
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ customerId: 'c1', kind: 'schedule', assignedDay: 'Fri', active: true, changedBy: 'mgr1' });
  });
  it('repeating the same day is a no-op and writes no history', async () => {
    F.store.set('customers/c1', pinned({ assignedDay: 'Fri' }));
    expect(await cust.setCustomerVisitDay('c1', 'Fri', mgr)).toEqual({ unchanged: true });
    expect(at(F.store, 'scheduleChanges/')).toHaveLength(0);
  });
  it('only Monday to Saturday are valid; null takes the shop off the schedule', async () => {
    F.store.set('customers/c1', pinned());
    await expect(cust.setCustomerVisitDay('c1', 'Sun', mgr)).rejects.toThrow(/Monday to Saturday/);
    await cust.setCustomerVisitDay('c1', null, mgr);
    expect(F.store.get('customers/c1').assignedDay).toBeNull();
  });
  it('deactivate clears the day and records it; reactivate brings the shop back UNSCHEDULED', async () => {
    F.store.set('customers/c1', pinned());
    await cust.deactivateCustomer('c1', mgr);
    expect(F.store.get('customers/c1')).toMatchObject({ active: false, assignedDay: null });
    await cust.reactivateCustomer('c1', mgr);
    expect(F.store.get('customers/c1')).toMatchObject({ active: true, assignedDay: null });
    expect(at(F.store, 'scheduleChanges/').map(c => c.kind).sort()).toEqual(['deactivate', 'reactivate']);
  });
  it('reactivating an already-active customer never clears its day', async () => {
    F.store.set('customers/c1', pinned());
    expect(await cust.reactivateCustomer('c1', mgr)).toEqual({ unchanged: true });
    expect(F.store.get('customers/c1').assignedDay).toBe('Thu');
  });
  it('a customer that is being merged cannot be rescheduled', async () => {
    F.store.set('customers/c1', pinned({ mergeLock: { into: 'c2' } }));
    await expect(cust.setCustomerVisitDay('c1', 'Mon', mgr)).rejects.toMatchObject({ code: 'customer-merging' });
  });
  it('unscheduled customers are not targets and do not reduce a rep\'s completion', () => {
    const customers = [{ id: 'a', name: 'A', active: true, assignedDay: 'Thu' }, { id: 'n', name: 'New', active: true, assignedDay: null }];
    const p = vs.repDayProgress({ customers, visits: [{ date: '2026-10-15', customerId: 'a', repEmail: 'r@x', outcome: 'No Order' }], date: '2026-10-15' });
    expect(p).toMatchObject({ scheduledCount: 1, visitedCount: 1 });
    expect(p.stillDue).toHaveLength(0);
  });
  it('a rep CAN still visit an unscheduled customer; the visit is recorded but is not a target', async () => {
    F.store.set('customers/n', pinned({ assignedDay: null }));
    const r = await visits.recordNoOrderVisit({ customerId: 'n', reason: 'Shop closed', notes: '', requestId: REQ, uid: 'rep1', email: 'r@x', now: NOW });
    expect(F.store.get('visits/' + r.visitId)).toMatchObject({ scheduledDay: null, wasScheduled: false });
  });
});

describe('decision 2 - cancellation keeps history and restores stock exactly once', () => {
  const cancel = (id = 'o1', reason = 'Customer cancelled') => stock.cancelOrder(withId(id), { reason, ...user });
  it('a reason is required (not blank, not too short)', async () => {
    seedProduct(95); seedOrder('o1', 'Approved');
    await expect(cancel('o1', '  ')).rejects.toThrow();
    await expect(cancel('o1', 'x')).rejects.toThrow();
    expect(F.store.get('orders/o1').status).toBe('Approved');
    expect(at(F.store, 'orderCancellations/')).toHaveLength(0);
  });
  it('Approved: status Cancelled, order kept, stock restored, ledger entry added, audit record written', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    const r = await cancel();
    expect(r).toMatchObject({ alreadyCancelled: false, stockRestored: true, priorStatus: 'Approved' });
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger()).toHaveLength(1);
    expect(ledger()[0]).toMatchObject({ type: 'order-cancelled', delta: 2 });
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Cancelled', cancelledBy: 'u1', cancelPriorStatus: 'Approved' });
    expect(F.store.get('orderCancellations/o1')).toMatchObject({ stockRestored: true, priorStatus: 'Approved', reason: 'Customer cancelled' });
  });
  it('Submitted: cancelled without touching stock', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted');
    expect(await cancel()).toMatchObject({ stockRestored: false });
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger()).toHaveLength(0);
  });
  it('double click / repeated call restores stock only once', async () => {
    seedProduct(98); seedOrder('o1', 'Approved');
    await cancel(); const again = await cancel();
    expect(again.alreadyCancelled).toBe(true);
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger()).toHaveLength(1);
  });
  it('two managers cancelling at the same moment: stock restored once', async () => {
    seedProduct(98); seedOrder('o1', 'Approved');
    await Promise.allSettled([cancel(), cancel('o1', 'Other manager')]);
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger()).toHaveLength(1);
    expect(at(F.store, 'orderCancellations/')).toHaveLength(1);
  });
  it('lost acknowledgement then retry: stock restored once', async () => {
    seedProduct(98); seedOrder('o1', 'Approved');
    F.hooks.failAfterCommit = (w) => (w.some(([, ref]) => ref.path.startsWith('orderCancellations/')) ? new Error('ack lost') : null);
    await expect(cancel()).rejects.toThrow('ack lost');
    F.hooks.failAfterCommit = null;
    expect((await cancel()).alreadyCancelled).toBe(true);
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
  });
  it('cancel racing an edit of the same order: exactly one wins and stock stays consistent', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    F.hooks.beforeCommit = async ({ attempt }) => { if (attempt === 1 && !F.hooks.once) { F.hooks.once = true; F.store.set('orders/o1', { ...F.store.get('orders/o1'), notes: 'edited elsewhere' }); } };
    await cancel();
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(F.store.get('orders/o1').status).toBe('Cancelled');
  });
  it.each(['Invoicing', 'Invoiced', 'Dispatched', 'Delivered'])('%s orders cannot use pre-invoice cancellation; nothing changes', async (status) => {
    seedProduct(98); seedOrder('o1', status, { invoiceNo: status === 'Invoicing' ? null : 'NF-INV-2026-0001' });
    await expect(cancel()).rejects.toMatchObject({ code: 'cancel-not-allowed' });
    expect(F.store.get('orders/o1').status).toBe(status);
    expect(F.store.get('products/p1').stockOnHand).toBe(98);
    expect(ledger()).toHaveLength(0);
  });
  it('a Rejected order cannot be cancelled', async () => {
    seedOrder('o1', 'Rejected');
    await expect(cancel()).rejects.toMatchObject({ code: 'cancel-not-allowed' });
  });
  it('an order released earlier (stockApplied false) is cancelled without a second restore', async () => {
    seedProduct(100); seedOrder('o1', 'Approved', { stockApplied: false });
    expect(await cancel()).toMatchObject({ stockRestored: false });
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
  });
  it('a cancelled order cannot be approved again (stock would be deducted for nothing)', async () => {
    seedProduct(100); seedOrder('o1', 'Approved'); await cancel();
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toThrow();
    expect(F.store.get('products/p1').stockOnHand).toBeGreaterThanOrEqual(100);
  });
  it('a cancelled order cannot be invoiced', async () => {
    seedProduct(100); seedOrder('o1', 'Approved'); await cancel();
    await expect(orders.beginInvoiceGeneration('o1')).rejects.toThrow();
  });
});

describe('decision 3 - manager-entered orders', () => {
  const items = [line(3)];
  beforeEach(() => {
    F.store.set('customers/c1', pinned());
    F.store.set('config/roles', { submitters: ['rep1@naisi.test', 'rep2@naisi.test'], managers: ['mgr@naisi.test'] });
    F.store.set('orderCounters/naisiOrder', { counter: 41 });
  });
  const enter = (over = {}) => mo.submitOrderAsManager({ customerId: 'c1', items, notes: 'phoned in', attributedRepEmail: 'rep1@naisi.test', requestId: REQ, ...mgr, now: NOW, ...over });
  it('creates a Submitted order with the next controlled number, attributed to the rep, entered by the manager', async () => {
    const r = await enter();
    expect(r).toMatchObject({ orderNo: 'ORD-2026-0041', alreadySaved: false });
    expect(F.store.get('orders/' + r.orderId)).toMatchObject({
      status: 'Submitted', source: 'manager-entered', attributedRepEmail: 'rep1@naisi.test',
      createdBy: 'mgr1', enteredBy: 'mgr1', enteredByEmail: 'mgr@naisi.test', visitId: null, grandTotal: 300,
    });
    expect(F.store.get('orderCounters/naisiOrder')).toEqual({ counter: 42, lastOrderId: r.orderId });
  });
  it('creates NO visit', async () => {
    await enter();
    expect(at(F.store, 'visits/')).toHaveLength(0);
  });
  it('the rep email is normalised; a non-rep (or the manager) cannot be credited', async () => {
    const r = await enter({ attributedRepEmail: '  REP1@Naisi.test ' });
    expect(F.store.get('orders/' + r.orderId).attributedRepEmail).toBe('rep1@naisi.test');
    await expect(enter({ requestId: 'req-bbbbbbbb-0002', attributedRepEmail: 'stranger@x.test' })).rejects.toThrow(/not a sales rep/);
    await expect(enter({ requestId: 'req-bbbbbbbb-0003', attributedRepEmail: 'mgr@naisi.test' })).rejects.toThrow(/not a sales rep/);
    await expect(enter({ requestId: 'req-bbbbbbbb-0004', attributedRepEmail: '' })).rejects.toThrow(/Choose the sales rep/);
  });
  it('identical retry (lost acknowledgement) returns the saved order; no second number is used', async () => {
    F.hooks.failAfterCommit = (w) => (w.some(([, ref]) => ref.path.startsWith('orders/')) ? new Error('ack lost') : null);
    await expect(enter()).rejects.toThrow('ack lost');
    F.hooks.failAfterCommit = null;
    const r = await enter();
    expect(r.alreadySaved).toBe(true);
    expect(at(F.store, 'orders/')).toHaveLength(1);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
  });
  it('a retry with CHANGED details is a conflict and changes nothing', async () => {
    await enter();
    await expect(enter({ items: [line(9)] })).rejects.toMatchObject({ code: 'order-conflict' });
    await expect(enter({ attributedRepEmail: 'rep2@naisi.test' })).rejects.toMatchObject({ code: 'order-conflict' });
    expect(at(F.store, 'orders/')).toHaveLength(1);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
  });
  it('a double click creates one order', async () => {
    await Promise.allSettled([enter(), enter()]);
    expect(at(F.store, 'orders/')).toHaveLength(1);
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(42);
  });
  it('refuses an inactive, merging or unpinned customer, and invalid items', async () => {
    F.store.set('customers/c1', pinned({ active: false }));
    await expect(enter()).rejects.toThrow(/inactive/);
    F.store.set('customers/c1', pinned({ mergeLock: { into: 'c2' } }));
    await expect(enter()).rejects.toMatchObject({ code: 'customer-merging' });
    F.store.set('customers/c1', pinned({ lat: null, lng: null }));
    await expect(enter()).rejects.toThrow(/pinned/);
    F.store.set('customers/c1', pinned());
    await expect(enter({ items: [] })).rejects.toThrow(/at least one item/i);
    expect(at(F.store, 'orders/')).toHaveLength(0);
  });
  it('shares the order sequence with rep orders (no gaps, no duplicates)', async () => {
    const a = await enter();
    const b = await visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: 'req-cccccccc-0003', uid: 'rep1', email: 'rep1@naisi.test', now: NOW });
    const c = await enter({ requestId: 'req-dddddddd-0004' });
    expect([a.orderNo, b.orderNo, c.orderNo]).toEqual(['ORD-2026-0041', 'ORD-2026-0042', 'ORD-2026-0043']);
  });
  it('rep-entered orders are tagged source "rep-visit" and still create their visit', async () => {
    const r = await visits.submitOrderWithVisit({ customerId: 'c1', items, notes: '', requestId: REQ, uid: 'rep1', email: 'rep1@naisi.test', now: NOW });
    expect(F.store.get('orders/' + r.orderId).source).toBe('rep-visit');
    expect(at(F.store, 'visits/')).toHaveLength(1);
  });
  it('reports count attributed orders SEPARATELY from visits', () => {
    const index = H.buildScheduleIndex(baselineHistory([{ id: 'c1', name: 'A', active: true, assignedDay: 'Thu' }]));
    const attributed = [
      { id: 'o9', orderNo: 'ORD-9', attributedRepEmail: 'rep1@naisi.test', grandTotal: 300, status: 'Submitted', createdAt: tsOn('2026-10-15') },
      { id: 'o10', orderNo: 'ORD-10', attributedRepEmail: 'rep1@naisi.test', grandTotal: 100, status: 'Cancelled', createdAt: tsOn('2026-10-15') },
    ];
    const rep = vs.buildPerformanceReport({ index, visits: [], reps: ['rep1@naisi.test'], from: '2026-10-15', to: '2026-10-15', attributedOrders: attributed });
    expect(rep.rows[0]).toMatchObject({ totalVisits: 0, visitedCount: 0, ordersTaken: 0, attributedOrders: 1, attributedValue: 300, attributedCancelled: 1 });
  });
});

describe('decision 4 - standalone invoices use the same sequence', () => {
  it('number comes from the shared counter; the registry records it; kind is "standalone"', async () => {
    seedCounter(370);
    const requestId = orders.newStandaloneRequestId();
    const r = await orders.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'mgr1' });
    const inv = F.store.get('invoices/' + r.invoiceId);
    expect(inv.invoiceNo).toMatch(/-0370$/);
    expect(inv).toMatchObject({ kind: 'standalone', requestId, createdBy: 'mgr1', orderId: null });
    expect(F.store.get('invoiceNumbers/' + inv.invoiceNo)).toBeTruthy();
    expect(F.store.get('counters/naisiInvoice')).toMatchObject({ counter: 371, lastInvoiceId: r.invoiceId });
  });
  it('order invoices and standalone invoices take consecutive numbers', async () => {
    seedCounter(370); seedProduct(100); seedOrder('o1', 'Approved');
    const s1 = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    const s2 = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    const nos = [s1, s2].map(r => F.store.get('invoices/' + r.invoiceId).invoiceNo);
    expect(nos.map(n => Number(n.slice(-4)))).toEqual([370, 371]);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(372);
  });
});

describe('decision 6 - number control', () => {
  beforeEach(() => seedCounter(370));
  const adjust = (over = {}) => num.adjustInvoiceCounter({ prefix: 'NF-INV', counter: 500, reason: 'Skip numbers used on paper', requestId: REQ, uid: 'mgr1', email: 'mgr@naisi.test', ...over });
  it('a reason is required; bad prefix / number rejected; nothing written', async () => {
    await expect(adjust({ reason: '' })).rejects.toThrow(/reason/);
    await expect(adjust({ reason: 'ab' })).rejects.toThrow(/reason/);
    await expect(adjust({ prefix: 'bad prefix!' })).rejects.toThrow(/prefix/);
    await expect(adjust({ counter: 0 })).rejects.toThrow(/whole number/);
    await expect(adjust({ counter: 1.5 })).rejects.toThrow(/whole number/);
    await expect(adjust({ counter: 1e12 })).rejects.toThrow(/whole number/);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(370);
    expect(at(F.store, 'counterAdjustments/')).toHaveLength(0);
  });
  it('audit records previous/new value, actor, reason and a server timestamp', async () => {
    await adjust();
    expect(F.store.get('counters/naisiInvoice')).toMatchObject({ prefix: 'NF-INV', counter: 500 });
    const a = at(F.store, 'counterAdjustments/')[0];
    expect(a).toMatchObject({ previousPrefix: 'NF-INV', previousCounter: 370, newPrefix: 'NF-INV', newCounter: 500, reason: 'Skip numbers used on paper', adjustedBy: 'mgr1', adjustedByEmail: 'mgr@naisi.test' });
    expect(typeof a.adjustedAt.toMillis()).toBe('number');
  });
  it('retry of the same adjustment is a no-op; changed details with the same request id conflict', async () => {
    await adjust();
    expect((await adjust()).alreadyApplied).toBe(true);
    await expect(adjust({ counter: 600 })).rejects.toMatchObject({ code: 'adjustment-conflict' });
    expect(F.store.get('counters/naisiInvoice').counter).toBe(500);
    expect(at(F.store, 'counterAdjustments/')).toHaveLength(1);
  });
  it('a no-change adjustment is refused', async () => {
    await expect(adjust({ counter: 370 })).rejects.toThrow(/already the current/);
  });
  it('adjusting at the same moment as an invoice is issued never reuses or skips a number silently: one of them retries on the new state', async () => {
    F.hooks.beforeCommit = async ({ attempt }) => {
      if (attempt === 1 && !F.hooks.once) { F.hooks.once = true; await adjust(); }   // adjustment lands while the invoice transaction is open
    };
    const r = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    const inv = F.store.get('invoices/' + r.invoiceId);
    expect(Number(inv.invoiceNo.slice(-4))).toBe(500);                  // took the adjusted counter, not the stale 370
    expect(F.store.get('counters/naisiInvoice').counter).toBe(501);
  });
  it('an invoice number that was issued can never be issued again, even if the counter is moved back', async () => {
    const first = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    const no = F.store.get('invoices/' + first.invoiceId).invoiceNo;
    await adjust({ counter: 370, reason: 'Moving back by mistake' });
    await expect(orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' })).rejects.toMatchObject({ code: 'number-already-issued' });
    expect(invoices().filter(i => i.invoiceNo === no)).toHaveLength(1);
  });
  it('a prefix change applies to the next invoice only; earlier invoices keep their numbers', async () => {
    const a = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    await adjust({ prefix: 'NF-2', counter: 1, reason: 'New numbering series' });
    const b = await orders.issueStandaloneInvoice({ requestId: orders.newStandaloneRequestId(), meta: meta(), uid: 'mgr1' });
    expect(F.store.get('invoices/' + a.invoiceId).invoiceNo).toMatch(/^NF-INV-/);
    expect(F.store.get('invoices/' + b.invoiceId).invoiceNo).toMatch(/^NF-2-\d{4}-0001$/);
  });
  it('the year in the number is the MALAWI year (UTC+2): 31 Dec 23:30 UTC is already next year', () => {
    expect(num.buildInvoiceNo('NF-INV', 7, new Date('2026-12-31T21:59:00Z'))).toBe('NF-INV-2026-0007');
    expect(num.buildInvoiceNo('NF-INV', 7, new Date('2026-12-31T22:00:00Z'))).toBe('NF-INV-2027-0007');
    expect(onum.buildOrderNo(7, new Date('2026-12-31T22:00:00Z'))).toBe('ORD-2027-0007');
  });
  it('order numbers are independent of invoice-number adjustments', async () => {
    F.store.set('orderCounters/naisiOrder', { counter: 41 });
    await adjust();
    expect(F.store.get('orderCounters/naisiOrder').counter).toBe(41);
  });
});

describe('decision 7 - dated schedule history', () => {
  const C = (id, day = 'Thu', extra = {}) => ({ id, name: id.toUpperCase(), active: true, assignedDay: day, ...extra });
  const targets = (idx, d) => H.targetsForDate(idx, d).targets.map(t => t.customerId);
  const build = (customers, changes = [], merges = []) => { const h = baselineHistory(customers, '2026-10-01'); return H.buildScheduleIndex({ ...h, changes: [...h.changes, ...changes], merges }); };

  it('a change takes effect from the START of the Malawi day it was saved (14:00 Wed also changes Wed, not Tue)', () => {
    const idx = build([C('a', 'Wed')], [change('x', 'a', 'schedule', { assignedDay: 'Fri', date: '2026-10-14', time: '12:00' })]);   // 14:00 Malawi
    expect(targets(idx, '2026-10-13')).toEqual([]);               // Tuesday: nothing
    expect(targets(idx, '2026-10-14')).toEqual([]);               // Wednesday: now a Friday shop
    expect(targets(idx, '2026-10-16')).toEqual(['a']);
    expect(targets(idx, '2026-10-07')).toEqual(['a']);            // last Wednesday keeps the Wednesday target
  });
  it('the Malawi date is used, not UTC: 23:30 UTC on the 14th is already the 15th in Malawi', () => {
    const idx = build([C('a', 'Wed')], [change('x', 'a', 'schedule', { assignedDay: 'Thu', date: '2026-10-14', time: '23:30' })]);
    expect(H.effectiveDateOf({ kind: 'schedule', createdAt: tsOn('2026-10-14', '23:30') })).toBe('2026-10-15');
    expect(targets(idx, '2026-10-14')).toEqual(['a']);            // still Wednesday's target
    expect(targets(idx, '2026-10-15')).toEqual(['a']);            // and a Thursday one from the 15th
  });
  it('several changes on one day: the last one decides that day', () => {
    const idx = build([C('a', 'Mon')], [change('x1', 'a', 'schedule', { assignedDay: 'Tue', date: '2026-10-06', time: '06:00' }), change('x2', 'a', 'schedule', { assignedDay: 'Wed', date: '2026-10-06', time: '09:00' })]);
    expect(targets(idx, '2026-10-07')).toEqual(['a']);            // Wednesday
    expect(targets(idx, '2026-10-06')).toEqual([]);               // Tuesday is not a target day any more
  });
  it('deactivation stops targets from that day; earlier days keep theirs', () => {
    const idx = build([C('a')], [change('d', 'a', 'deactivate', { active: false, assignedDay: null, date: '2026-10-15' })]);
    expect(targets(idx, '2026-10-08')).toEqual(['a']);
    expect(targets(idx, '2026-10-15')).toEqual([]);
  });
  it('reactivation alone does not make a target (the shop is unscheduled until a manager picks a day)', () => {
    const idx = build([C('a')], [change('d', 'a', 'deactivate', { active: false, assignedDay: null, date: '2026-10-08' }), change('r', 'a', 'reactivate', { active: true, assignedDay: null, date: '2026-10-12' })]);
    expect(targets(idx, '2026-10-15')).toEqual([]);
    const idx2 = build([C('a')], [change('d', 'a', 'deactivate', { active: false, assignedDay: null, date: '2026-10-08' }), change('r', 'a', 'reactivate', { active: true, assignedDay: null, date: '2026-10-12' }), change('s', 'a', 'schedule', { assignedDay: 'Thu', date: '2026-10-13' })]);
    expect(targets(idx2, '2026-10-15')).toEqual(['a']);
    expect(targets(idx2, '2026-10-08')).toEqual([]);              // the Thursday it was inactive is not rewritten
  });
  it('unscheduled customers (baseline or new) are never targets', () => {
    const idx = build([C('a', null)]);
    expect(targets(idx, '2026-10-15')).toEqual([]);
  });
  it('a customer first scheduled later has no target before that day', () => {
    const idx = build([], [change('n', 'n', 'schedule', { assignedDay: 'Thu', date: '2026-10-13' })]);
    expect(targets(idx, '2026-10-08')).toEqual([]);
    expect(targets(idx, '2026-10-15')).toEqual(['n']);
  });
  it('dates before the history began are UNRELIABLE: no targets are produced, with an explicit reason', () => {
    const idx = build([C('a')]);
    const t = H.targetsForDate(idx, '2026-09-24');
    expect(t).toMatchObject({ reliable: false, targets: [] });
    expect(t.reason).toMatch(/2026-10-01/);
    expect(H.targetsForDate(H.buildScheduleIndex({}), '2026-10-15')).toMatchObject({ reliable: false });
  });
  it('a report over reliable and unreliable days lists the unreliable ones, reports targets only for reliable ones, and never invents a percentage', () => {
    const idx = build([C('a')]);
    const v = [{ date: '2026-09-24', repEmail: 'r@x', customerId: 'a', outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '' },
               { date: '2026-10-15', repEmail: 'r@x', customerId: 'a', outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '' }];
    const rep = vs.buildPerformanceReport({ index: idx, visits: v, reps: ['r@x'], from: '2026-09-24', to: '2026-10-15' });
    expect(rep.unreliableDates.length).toBe(7);     // all of 24 Sep .. 30 Sep
    expect(rep.limitation).toBeTruthy();
    expect(rep.rows[0]).toMatchObject({ totalVisits: 2, scheduledCount: 3 });
    const old = vs.buildPerformanceReport({ index: idx, visits: v.slice(0, 1), reps: ['r@x'], from: '2026-09-24', to: '2026-09-30' });
    expect(old.rows[0]).toMatchObject({ scheduledCount: 0, coveragePct: null, totalVisits: 1 });
    expect(old.reliableDays).toBe(0);
  });
  it('merges: before the merge both shops were targets on their own days; a shop merged away is not a target from the merge day', () => {
    // a = Thursday shop, b = Friday shop, b merged into a on Thursday 15 Oct.
    const idx = build([C('a', 'Thu'), C('b', 'Fri')], [], [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-15') }]);
    expect(targets(idx, '2026-10-09')).toEqual(['a']);            // Friday before the merge: b's target is credited to the survivor a
    expect(targets(idx, '2026-10-16')).toEqual([]);               // Friday after the merge: b no longer exists as a target
    expect(targets(idx, '2026-10-08')).toEqual(['a']);
    expect(H.resolveCustomerId(idx, 'b')).toBe('a');
  });
  it('merged shops with the SAME day count once (their visits all belong to the survivor, so coverage can never exceed 100%)', () => {
    const idx = build([C('a'), C('b')], [], [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-15') }]);
    expect(targets(idx, '2026-10-08')).toEqual(['a']);
    expect(targets(idx, '2026-10-15')).toEqual(['a']);
  });
  it('a visit recorded against a merged-away customer id still counts for the surviving shop', () => {
    const idx = build([C('a'), C('b')], [], [{ id: 'b', keepId: 'a', mergedAt: tsOn('2026-10-14') }]);
    const v = [{ date: '2026-10-08', repEmail: 'r@x', customerId: 'b', outcome: 'No Order', reasonNoOrder: 'Shop closed', reasonNotes: '' }];
    const r = vs.buildPerformanceReport({ index: idx, visits: v, reps: ['r@x'], from: '2026-10-08', to: '2026-10-08' }).rows[0];
    expect(r.scheduledCount).toBe(1);
    expect(r.visitedCount).toBe(1);
    expect(r.coveragePct).toBe(100);
  });
  it('mismatch detection flags a customer changed without a history entry', () => {
    const idx = build([C('a', 'Thu')]);
    expect(H.findScheduleMismatches(idx, [C('a', 'Thu')])).toEqual([]);
    expect(H.findScheduleMismatches(idx, [C('a', 'Fri')])).toHaveLength(1);
    expect(H.findScheduleMismatches(idx, [C('z', 'Fri')])).toHaveLength(1);
    expect(H.findScheduleMismatches(idx, [C('z', null)])).toEqual([]);
  });
  it('history entries are produced by the real app functions and drive the report', async () => {
    const customers = [C('c1', 'Thu', { name: 'Shop' })];
    F.store.set('customers/c1', pinned({ assignedDay: 'Thu' }));
    F.setClock(Date.parse('2026-10-01T06:00:00Z'));
    expect(await store.startScheduleHistory({ customers, uid: 'mgr1', email: 'mgr@naisi.test', now: () => Date.now() })).toMatchObject({ status: 'started', added: 1 });
    F.setClock(Date.parse('2026-10-14T10:00:00Z'));
    await cust.setCustomerVisitDay('c1', 'Fri', mgr);
    const hist = await store.fetchScheduleHistory();
    const idx = H.buildScheduleIndex(hist);
    expect(targets(idx, '2026-10-08')).toEqual(['c1']);   // Thursday last week
    expect(targets(idx, '2026-10-15')).toEqual([]);       // this Thursday: now a Friday shop
    expect(targets(idx, '2026-10-16')).toEqual(['c1']);
  });
  it('starting history twice within the window adds nothing new; after the window it refuses', async () => {
    const customers = [C('c1')];
    F.setClock(Date.parse('2026-10-01T06:00:00Z'));
    await store.startScheduleHistory({ customers, uid: 'mgr1', email: 'm', now: () => Date.now() });
    expect(await store.startScheduleHistory({ customers, uid: 'mgr1', email: 'm', now: () => Date.now() })).toMatchObject({ added: 0 });
    F.setClock(Date.parse('2026-10-03T06:00:00Z'));
    expect(await store.startScheduleHistory({ customers, uid: 'mgr1', email: 'm', now: () => Date.now() })).toMatchObject({ status: 'already-started' });
  });
});

describe('decision 8 - merges and invoicing', () => {
  const seedMerge = ({ orders = 3, visits_ = 3, invoicing = false } = {}) => {
    F.store.set('customers/keep', pinned({ name: 'Keep' }));
    F.store.set('customers/away', pinned({ name: 'Away' }));
    for (let i = 0; i < orders; i++) F.store.set('orders/o' + i, { orderNo: 'ORD-' + i, status: invoicing && i === 0 ? 'Invoicing' : 'Approved', customerId: 'away', customerName: 'Away', grandTotal: 100 + i, invoiceNo: null, invoiceId: null });
    for (let i = 0; i < visits_; i++) F.store.set('visits/v' + i, { customerId: 'away', customerName: 'Away', date: '2026-10-0' + (i + 1), repEmail: 'r@x', outcome: 'No Order' });
    F.store.set('invoices/i1', { customerId: 'away', customer: 'Away', invoiceNo: 'NF-INV-2026-0001', grandTotal: 500, orderId: 'o1' });
  };
  const merge = (over = {}) => cust.mergeCustomers('keep', 'away', { ...mgr, ...over });
  it('moves orders, visits and invoices; keeps amounts, numbers, statuses and links; deletes the merged shop; records the merge', async () => {
    seedMerge();
    const before = { o: [...F.store].filter(([p]) => p.startsWith('orders/')).map(([p, d]) => [p, d.orderNo, d.status, d.grandTotal]) };
    const t = await merge();
    expect(t).toMatchObject({ orders: 3, visits: 3, invoices: 1 });
    expect(F.store.has('customers/away')).toBe(false);
    expect(F.store.get('customerMerges/away')).toMatchObject({ keepId: 'keep', mergedBy: 'mgr1', moved: { orders: 3, visits: 3, invoices: 1 } });
    expect(at(F.store, 'orders/').every(o => o.customerId === 'keep' && o.customerName === 'Keep')).toBe(true);
    expect(at(F.store, 'visits/').every(v => v.customerId === 'keep')).toBe(true);
    expect(F.store.get('invoices/i1')).toMatchObject({ customerId: 'keep', invoiceNo: 'NF-INV-2026-0001', grandTotal: 500, orderId: 'o1' });
    expect([...F.store].filter(([p]) => p.startsWith('orders/')).map(([p, d]) => [p, d.orderNo, d.status, d.grandTotal])).toEqual(before.o);
    expect(F.store.get('customers/keep').mergeLock).toBeUndefined();
  });
  it('is BLOCKED while an affected order is Invoicing: clear message, nothing moved, nothing deleted, lock released', async () => {
    seedMerge({ invoicing: true });
    await expect(merge()).rejects.toMatchObject({ code: 'merge-blocked-invoicing', message: expect.stringMatching(/invoic/i) });
    expect(F.store.has('customers/away')).toBe(true);
    expect(F.store.get('customers/away').mergeLock).toBeFalsy();
    expect(at(F.store, 'orders/').every(o => o.customerId === 'away')).toBe(true);
    expect(at(F.store, 'visits/').every(v => v.customerId === 'away')).toBe(true);
    expect(F.store.has('customerMerges/away')).toBe(false);
  });
  it('the manager can retry after invoicing finishes (no automatic queue)', async () => {
    seedMerge({ invoicing: true });
    await expect(merge()).rejects.toMatchObject({ code: 'merge-blocked-invoicing' });
    F.store.set('orders/o0', { ...F.store.get('orders/o0'), status: 'Invoiced', invoiceNo: 'NF-INV-2026-0002', invoiceId: 'i2' });
    await expect(merge()).resolves.toMatchObject({ orders: 3 });
  });
  it('resuming a paused merge re-checks: an order found in Invoicing now stops it again, keeps the lock, deletes nothing', async () => {
    seedMerge();
    F.store.set('customers/away', pinned({ name: 'Away', mergeLock: { into: 'keep' } }));
    F.store.set('orders/o1', { ...F.store.get('orders/o1'), status: 'Invoicing' });
    await expect(merge()).rejects.toMatchObject({ code: 'merge-blocked-invoicing' });
    expect(F.store.get('customers/away').mergeLock).toMatchObject({ into: 'keep' });   // kept: resumable
    expect(F.store.has('customers/away')).toBe(true);
    expect(F.store.has('customerMerges/away')).toBe(false);
    expect(at(F.store, 'orders/').every(o => o.customerId === 'away')).toBe(true);
  });
  // The race "an order enters Invoicing between the check and the move" cannot be proven with the in-memory stand-in
  // (it has no rules). It is enforced by the rules (orderMergeMoveOk refuses to move an Invoicing order; entering
  // Invoicing refuses a locked customer) and is tested on the emulator in tests/rules (group M).
  it('the customer being merged away cannot start a new order invoice (lock check inside the invoicing transaction)', async () => {
    F.store.set('customers/away', pinned({ mergeLock: { into: 'keep' } }));
    seedOrder('o1', 'Approved', { customerId: 'away' });
    await expect(orders.beginInvoiceGeneration('o1')).rejects.toMatchObject({ code: 'customer-merging' });
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
  it('a locked customer cannot receive new visits or manager orders', async () => {
    F.store.set('customers/away', pinned({ mergeLock: { into: 'keep' } }));
    await expect(visits.recordNoOrderVisit({ customerId: 'away', reason: 'Shop closed', notes: '', requestId: REQ, uid: 'rep1', email: 'r@x', now: NOW })).rejects.toMatchObject({ code: 'customer-merging' });
  });
  it('a large merge (650 orders, 400 visits) moves everything in chunks and loses nothing', async () => {
    F.store.set('customers/keep', pinned({ name: 'Keep' })); F.store.set('customers/away', pinned({ name: 'Away' }));
    for (let i = 0; i < 650; i++) F.store.set('orders/o' + i, { orderNo: 'ORD-' + i, status: 'Approved', customerId: 'away', grandTotal: 10 });
    for (let i = 0; i < 400; i++) F.store.set('visits/v' + i, { customerId: 'away', date: '2026-10-01', repEmail: 'r@x', outcome: 'No Order' });
    const t = await merge();                       // default chunk (8): about 130 commits
    expect(t).toMatchObject({ orders: 650, visits: 400, invoices: 0 });
    expect(at(F.store, 'orders/').filter(o => o.customerId === 'keep')).toHaveLength(650);
    expect(F.store.has('customers/away')).toBe(false);
  });
  it('an interrupted merge keeps its lock (resumable); resuming completes it; cancelling releases the lock', async () => {
    seedMerge();
    F.hooks.failCommit = null;
    let n = 0;
    await expect(merge({ chunk: 2, afterChunk: async () => { if (++n === 1) throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
    expect(F.store.get('customers/away').mergeLock).toMatchObject({ into: 'keep' });
    expect(F.store.has('customers/away')).toBe(true);
    await expect(merge()).resolves.toBeTruthy();
    expect(F.store.has('customers/away')).toBe(false);
    // cancel path
    seedMerge();
    F.store.set('customers/away', pinned({ name: 'Away', mergeLock: { into: 'keep' } }));
    await cust.cancelMergeLock('away');
    expect(F.store.get('customers/away').mergeLock).toBeFalsy();
  });
  it('cannot merge into itself, or into a customer that is itself being merged', async () => {
    seedMerge();
    await expect(cust.mergeCustomers('keep', 'keep', mgr)).rejects.toThrow(/itself/);
    F.store.set('customers/keep', pinned({ name: 'Keep', mergeLock: { into: 'zzz' } }));
    await expect(merge()).rejects.toMatchObject({ code: 'customer-merging' });
  });
});
