import { describe, it, expect } from 'vitest';
const { reconcile } = await import('../../tools/reconcile-logic.js');
const it1 = [{ productId: 'p1', desc: 'A', qty: 2, price: 100, total: 200 }];
const ord = (id, status, over = {}) => ({ id, status, customerName: 'Shop', items: it1, grandTotal: 200, ...over });
const inv = (id, over = {}) => ({ id, invoiceNo: 'N-' + id, customer: 'Shop', items: it1, grandTotal: 200, ...over });
const types = (r) => r.findings.map(f => f.type).sort();
// every optional input supplied (and empty/consistent), so a result can be CLEAN; individual tests override what they need
const ALL = (over = {}) => ({ cancellations: [], stockMovements: [], invoiceNumbers: [], counter: { prefix: 'ZZ', counter: 1 }, customers: [], scheduleChanges: [], scheduleConfig: {}, ...over });

describe('reconcile (read-only classification)', () => {
  it('clean data: only info', () => {
    const r = reconcile({ orders: [ord('o1', 'Invoiced', { invoiceId: 'ord_o1', invoiceNo: 'N-ord_o1' })], invoices: [inv('ord_o1', { orderId: 'o1', kind: 'order' })], ...ALL({ invoiceNumbers: [{ id: 'N-ord_o1' }] }) });
    expect(r.safeToEnableResume).toBe(true); expect(r.findings).toEqual([]); expect(r.status).toBe('CLEAN');
  });
  it('legacy orphan: Approved order, no link, matching unlinked invoice -> POSSIBLE_ORPHAN (not auto-fixed)', () => {
    const r = reconcile({ orders: [ord('o1', 'Approved')], invoices: [inv('legacy1')] });
    expect(types(r)).toEqual(['POSSIBLE_ORPHAN', 'UNLINKED_INVOICE']);
    expect(r.safeToEnableResume).toBe(false);
    expect(r.findings.find(f => f.type === 'POSSIBLE_ORPHAN')).toMatchObject({ orderIds: ['o1'], invoiceIds: ['legacy1'] });
  });
  it('orphan on an order stuck in Invoicing is reported as both', () => {
    expect(types(reconcile({ orders: [ord('o1', 'Invoicing')], invoices: [inv('legacy1')] }))).toEqual(['POSSIBLE_ORPHAN', 'STUCK_INVOICING', 'UNLINKED_INVOICE']);
  });
  it('stand-alone invoice with no matching order is info only', () => {
    const r = reconcile({ orders: [], invoices: [inv('s1', { customer: 'Walk-in', kind: 'order' })], ...ALL({ invoiceNumbers: [{ id: 'N-s1' }] }) });
    expect(r.findings).toHaveLength(1); expect(r.findings[0].severity).toBe('info'); expect(r.safeToEnableResume).toBe(true);
  });
  it('different total or items is NOT matched as an orphan', () => {
    const r = reconcile({ orders: [ord('o1', 'Approved')], invoices: [inv('x', { grandTotal: 300, items: [{ ...it1[0], qty: 3 }] })] });
    expect(types(r)).toEqual(['UNLINKED_INVOICE']);
  });
  it('Invoiced order whose invoice is missing / number differs -> BROKEN_LINK', () => {
    expect(types(reconcile({ orders: [ord('o1', 'Invoiced', { invoiceId: 'gone' })], invoices: [] }))).toEqual(['BROKEN_LINK']);
    expect(types(reconcile({ orders: [ord('o1', 'Invoiced', { invoiceId: 'i1', invoiceNo: 'X' })], invoices: [inv('i1', { invoiceNo: 'Y' })] }))).toEqual(['BROKEN_LINK']);
    expect(types(reconcile({ orders: [ord('o1', 'Invoiced')], invoices: [] }))).toEqual(['BROKEN_LINK']);
  });
  it('duplicate invoice numbers and multiple invoices for one order', () => {
    const r = reconcile({ orders: [ord('o1', 'Invoiced', { invoiceId: 'a' })], invoices: [inv('a', { invoiceNo: 'D', orderId: 'o1' }), inv('b', { invoiceNo: 'D', orderId: 'o1' })] });
    expect(types(r)).toContain('DUPLICATE_NUMBER'); expect(types(r)).toContain('MULTI_FOR_ORDER');
  });
  it('is pure: inputs are not modified', () => {
    const orders = [ord('o1', 'Approved')], invoices = [inv('legacy1')];
    const snap = JSON.stringify({ orders, invoices }); reconcile({ orders, invoices });
    expect(JSON.stringify({ orders, invoices })).toBe(snap);
  });
});

describe('reconcile RC3 checks (read-only)', () => {
  const cancelled = (id, over = {}) => ord(id, 'Cancelled', { items: [{ productId: 'p1', desc: 'A', qty: 2, price: 100, total: 200 }], ...over });
  const rec = (id, stockRestored) => ({ id, orderId: id, stockRestored });
  const mv = (orderId, delta, type = 'order-cancelled') => ({ orderId, productId: 'p1', delta, type });
  it('a cancelled order without a record is flagged', () => {
    expect(types(reconcile({ orders: [cancelled('o1')], invoices: [], cancellations: [] }))).toEqual(['CANCELLED_NO_RECORD']);
  });
  it('a correct cancel (restored 2 of 2) is clean; a missing or short restore is a mismatch; a restore claimed false with entries is a mismatch', () => {
    const run = (r, moves) => types(reconcile({ orders: [cancelled('o1')], invoices: [], cancellations: [r], stockMovements: moves }));
    expect(run(rec('o1', true), [mv('o1', 2)])).toEqual([]);
    expect(run(rec('o1', true), [])).toEqual(['CANCEL_STOCK_MISMATCH']);
    expect(run(rec('o1', true), [mv('o1', 1)])).toEqual(['CANCEL_STOCK_MISMATCH']);
    expect(run(rec('o1', false), [mv('o1', 2)])).toContain('CANCEL_STOCK_MISMATCH');
    expect(run(rec('o1', false), [])).toEqual([]);
  });
  it('a double restore is detected', () => {
    const t = types(reconcile({ orders: [cancelled('o1')], invoices: [], cancellations: [rec('o1', true)], stockMovements: [mv('o1', 2), mv('o1', 2)] }));
    expect(t).toContain('CANCEL_NOT_RESTORED_TWICE'); expect(t).toContain('CANCEL_STOCK_MISMATCH');
  });
  it('invoice numbers missing from the registry, and a counter pointing at an issued number, are flagged', () => {
    const invs = [inv('i1', { invoiceNo: 'NF-INV-2026-0370', kind: 'standalone' })];
    expect(types(reconcile({ orders: [], invoices: invs, invoiceNumbers: [] }))).toEqual(['NUMBER_NOT_REGISTERED']);
    expect(types(reconcile({ orders: [], invoices: invs, invoiceNumbers: [{ id: 'NF-INV-2026-0370' }], counter: { prefix: 'NF-INV', counter: 370 } }))).toEqual(['COUNTER_BEHIND']);
    expect(types(reconcile({ orders: [], invoices: invs, invoiceNumbers: [{ id: 'NF-INV-2026-0370' }], counter: { prefix: 'NF-INV', counter: 371 } }))).toEqual([]);
  });
  it('explicit stand-alone invoices are never orphan candidates; legacy invoices without kind are info only', () => {
    expect(types(reconcile({ orders: [ord('o1', 'Approved')], invoices: [inv('s1', { kind: 'standalone' })] }))).toEqual([]);
    const r = reconcile({ orders: [], invoices: [inv('old1', { orderId: 'x' })], ...ALL({ invoiceNumbers: [{ id: 'N-old1' }] }) });
    expect(types(r)).toEqual(['LEGACY_INVOICE_NO_KIND']); expect(r.safeToEnableResume).toBe(true);
  });
  it('a manager-entered order with a visit link, a paused merge and a schedule changed without history are flagged', () => {
    expect(types(reconcile({ orders: [ord('m1', 'Submitted', { source: 'manager-entered', visitId: 'v1' })], invoices: [] }))).toEqual(['MANAGER_ORDER_HAS_VISIT']);
    const customers = [{ id: 'c1', name: 'A', active: true, assignedDay: 'Fri' }, { id: 'c2', name: 'B', active: true, assignedDay: 'Mon', mergeLock: { into: 'c1' } }, { id: 'c3', name: 'C', active: true, assignedDay: null }];
    const r = reconcile({ orders: [], invoices: [], customers, scheduleConfig: { startedAt: 1 }, scheduleChanges: [{ customerId: 'c1', active: true, assignedDay: 'Thu', createdAt: { ms: 1 } }] });
    expect(types(r)).toEqual(['MERGE_PAUSED', 'SCHEDULE_MISMATCH']);
  });
  it('is pure: inputs are not modified', () => {
    const input = { orders: [cancelled('o1')], invoices: [], cancellations: [rec('o1', true)], stockMovements: [mv('o1', 2)] };
    const copy = JSON.stringify(input); reconcile(input); expect(JSON.stringify(input)).toBe(copy);
  });
});

// ---------------- F5: stock reconciliation compares by order AND product; incomplete is not clean ----------------
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
describe('F5 cancellation stock restoration is checked per order AND per product', () => {
  const two = [{ productId: 'p1', desc: 'A', qty: 2, price: 10, total: 20 }, { productId: 'p2', desc: 'B', qty: 3, price: 10, total: 30 }, { desc: 'Custom line', qty: 4, price: 5, total: 20 }];
  const order = (over = {}) => ord('o1', 'Cancelled', { items: two, ...over });
  const rec = [{ id: 'o1', orderId: 'o1', stockRestored: true }];
  const m = (productId, delta, orderId = 'o1') => ({ id: Math.random().toString(36).slice(2), orderId, productId, delta, type: 'order-cancelled' });
  const run = (moves, extra = {}) => reconcile({ orders: [order()], invoices: [], cancellations: rec, stockMovements: moves, ...extra });
  const problems = (r) => r.findings.filter(f => /^CANCEL_/.test(f.type)).map(f => `${f.type}:${f.productId}:${f.problem}`).sort();

  it('THE REPRODUCTION: order needs p1=2 and p2=3 restored, movements restore p1=5 and p2=0 (same total of 5) -> flagged for BOTH products', () => {
    const r = run([m('p1', 5), m('p2', 0)]);
    expect(problems(r)).toEqual(['CANCEL_STOCK_MISMATCH:p1:wrong-quantity', 'CANCEL_STOCK_MISMATCH:p2:wrong-quantity']);
    expect(r.findings.find(f => f.productId === 'p1')).toMatchObject({ orderIds: ['o1'], expected: 2, actual: 5 });
    expect(r.findings.find(f => f.productId === 'p2')).toMatchObject({ expected: 3, actual: 0 });
  });
  it('a correct restore is clean (custom lines are not stock-tracked and are not expected)', () => {
    expect(problems(run([m('p1', 2), m('p2', 3)]))).toEqual([]);
  });
  it('missing: one product never restored', () => expect(problems(run([m('p1', 2)]))).toEqual(['CANCEL_STOCK_MISMATCH:p2:missing']));
  it('unexpected: a product the order never had was increased', () => {
    expect(problems(run([m('p1', 2), m('p2', 3), m('p9', 4)]))).toEqual(['CANCEL_STOCK_MISMATCH:p9:unexpected']);
  });
  it('duplicated: the same product restored twice (even if each entry looks plausible)', () => {
    const t = problems(run([m('p1', 2), m('p1', 2), m('p2', 3)]));
    expect(t).toContain('CANCEL_NOT_RESTORED_TWICE:p1:duplicate'); expect(t).toContain('CANCEL_STOCK_MISMATCH:p1:wrong-quantity');
  });
  it('a movement that points at the wrong order does not count for this one', () => {
    expect(problems(run([m('p1', 2), m('p2', 3, 'other')]))).toEqual(['CANCEL_STOCK_MISMATCH:p2:missing']);
  });
  it('two lines of one product are summed; a deleted product is not expected when the product list is supplied', () => {
    const o = order({ items: [{ productId: 'p1', qty: 1 }, { productId: 'p1', qty: 2 }, { productId: 'gone', qty: 5 }] });
    const base = { orders: [o], invoices: [], cancellations: rec };
    expect(problems(reconcile({ ...base, stockMovements: [m('p1', 1), m('p1', 2)], products: [{ id: 'p1' }] }))).toEqual([]);
    expect(problems(reconcile({ ...base, stockMovements: [m('p1', 1), m('p1', 2)] }))).toEqual(['CANCEL_STOCK_MISMATCH:gone:missing']);
  });
  it('a restore movement with no product or order cannot be checked: reported, never ignored', () => {
    const r = run([m('p1', 2), m('p2', 3), { id: 'x', type: 'order-cancelled', delta: 1 }]);
    expect(r.findings.some(f => f.type === 'MOVEMENT_UNATTRIBUTED')).toBe(true);
  });
  it('is read-only: frozen inputs are accepted and unchanged', () => {
    const input = deepFreeze({ orders: [order()], invoices: [], cancellations: rec, stockMovements: [m('p1', 5), m('p2', 0)] });
    expect(() => reconcile(input)).not.toThrow();
  });
});

describe('F5 an incomplete assessment is never reported as safe', () => {
  const full = (over = {}) => ({ orders: [], invoices: [], cancellations: [], stockMovements: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, customers: [], scheduleChanges: [], scheduleConfig: {}, ...over });
  it('with every input and nothing wrong: CLEAN and safe', () => {
    const r = reconcile(full());
    expect(r).toMatchObject({ status: 'CLEAN', safeToEnableResume: true, skippedChecks: [] });
  });
  it('orders + invoices only: INCOMPLETE, not safe, and the skipped checks are listed', () => {
    const r = reconcile({ orders: [], invoices: [] });
    expect(r.status).toBe('INCOMPLETE'); expect(r.safeToEnableResume).toBe(false);
    expect(r.skippedChecks.map(c => c.input).sort()).toEqual(['cancellations', 'counter', 'customers', 'invoiceNumbers', 'scheduleChanges', 'scheduleConfig', 'stockMovements']);
  });
  it('cancellation records but no stock movements: the stock check did not run -> INCOMPLETE', () => {
    const r = reconcile(full({ stockMovements: null }));
    expect(r.status).toBe('INCOMPLETE'); expect(r.skippedChecks.map(c => c.input)).toEqual(['stockMovements']);
  });
  it('a finding beats incomplete: status FINDINGS when something is wrong', () => {
    expect(reconcile(full({ orders: [ord('o1', 'Cancelled')] })).status).toBe('FINDINGS');
  });
});
