import { describe, it, expect } from 'vitest';
const { reconcile } = await import('../../tools/reconcile-logic.js');
const it1 = [{ productId: 'p1', desc: 'A', qty: 2, price: 100, total: 200 }];
const ord = (id, status, over = {}) => ({ id, status, customerName: 'Shop', items: it1, grandTotal: 200, ...over });
const inv = (id, over = {}) => ({ id, invoiceNo: 'N-' + id, customer: 'Shop', items: it1, grandTotal: 200, ...over });
const types = (r) => r.findings.map(f => f.type).sort();

describe('reconcile (read-only classification)', () => {
  it('clean data: only info', () => {
    const r = reconcile({ orders: [ord('o1', 'Invoiced', { invoiceId: 'ord_o1', invoiceNo: 'N-ord_o1' })], invoices: [inv('ord_o1', { orderId: 'o1' })] });
    expect(r.safeToEnableResume).toBe(true); expect(r.findings).toEqual([]);
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
    const r = reconcile({ orders: [], invoices: [inv('s1', { customer: 'Walk-in' })] });
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
  const mv = (orderId, delta, type = 'order-cancelled') => ({ orderId, delta, type });
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
    const r = reconcile({ orders: [], invoices: [inv('old1', { orderId: 'x' })], invoiceNumbers: [{ id: 'N-old1' }] });
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
