// RC5 finding D: the read-only preflight must find malformed and oversized legacy orders/invoices, say why, and never report a clean migration for them.
import { describe, it, expect } from 'vitest';
import { reconcile } from '../../tools/reconcile-logic.js';
import { planMigration } from '../../tools/migrate-logic.js';
import { MAX_ORDER_LINES } from '../../src/money.js';

const ok = (n = 1, pid = 'p1') => Array.from({ length: n }, (_, i) => ({ qty: 2, desc: 'Amanda ' + i, price: 5, total: 10, productId: pid + (n > 1 ? i : '') }));
const O = (id, status, items, over = {}) => ({ id, orderNo: 'ORD-' + id, status, customerId: 'c1', customerName: 'Shop', items, grandTotal: items.reduce((s, i) => s + (Number(i.total) || 0), 0), ...over });
// every input the reconciliation needs, so that "INCOMPLETE" can never explain a clean result
const FULL = { cancellations: [], stockMovements: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, customers: [], scheduleChanges: [], scheduleConfig: { startedAt: { ms: 1 } }, products: [{ id: 'p10' }] };

const types = (r) => r.findings.map(f => f.type);
const only = (r, t) => r.findings.filter(f => f.type === t);

describe('D. order-line preflight inside reconcile()', () => {
  it('FAILS ON RC4: a Submitted negative-quantity order is NOT clean', () => {
    const r = reconcile({ orders: [O('bad', 'Submitted', [{ qty: -5, desc: 'x', price: 5, total: -25, productId: 'p1' }])], invoices: [], ...FULL });
    expect(r.status).toBe('FINDINGS');
    const f = only(r, 'INVALID_ORDER_LINES');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'high', orderIds: ['bad'] });
    expect(f[0].detail).toMatch(/quantity/i);
    expect(f[0].recovery).toMatch(/edit|reject|cancel/i);
  });
  it('an oversized order (MAX_ORDER_LINES + 1 lines) is reported with the cap and the line count', () => {
    const r = reconcile({ orders: [O('big', 'Approved', ok(MAX_ORDER_LINES + 1), { stockApplied: true })], invoices: [], ...FULL });
    const f = only(r, 'INVALID_ORDER_LINES');
    expect(f).toHaveLength(1);
    expect(f[0].detail).toMatch(new RegExp(`at most ${MAX_ORDER_LINES}`));
    expect(r.preflight.oversizedOrders).toEqual(['big']);
    expect(r.preflight.maxLinesFound).toBe(MAX_ORDER_LINES + 1);
  });
  it('every reason class is detected: fractional tracked qty, total mismatch, aggregate mismatch, missing/unknown/malformed product', () => {
    const cases = {
      fractional: [{ qty: 1.5, desc: 'x', price: 2, total: 3, productId: 'p1' }],
      lineTotal: [{ qty: 2, desc: 'x', price: 5, total: 99, productId: 'p1' }],
      noProduct: [{ qty: 2, desc: 'x', price: 5, total: 10 }],
      malformedProduct: [{ qty: 2, desc: 'x', price: 5, total: 10, productId: 'a/b' }],
      negPrice: [{ qty: 2, desc: 'x', price: -5, total: -10, productId: 'p1' }],
      stringQty: [{ qty: '2', desc: 'x', price: 5, total: 10, productId: 'p1' }],
    };
    for (const [k, items] of Object.entries(cases)) {
      const r = reconcile({ orders: [O(k, 'Submitted', items)], invoices: [], ...FULL });
      expect(only(r, 'INVALID_ORDER_LINES'), k).toHaveLength(1);
    }
    const agg = reconcile({ orders: [O('agg', 'Submitted', ok(1), { grandTotal: 999 })], invoices: [], ...FULL });
    expect(only(agg, 'INVALID_ORDER_LINES')).toHaveLength(1);
    const unknown = reconcile({ orders: [O('unk', 'Submitted', [{ qty: 2, desc: 'x', price: 5, total: 10, productId: 'ghost' }])], invoices: [], ...FULL });
    expect(only(unknown, 'UNKNOWN_PRODUCT')).toHaveLength(1);
  });
  it('an Approved malformed order carries RECOVERY steps that use the ledger (no invented movements)', () => {
    const r = reconcile({ orders: [O('ap', 'Approved', [{ qty: 2.5, desc: 'x', price: 4, total: 10, productId: 'p1' }], { stockApplied: true })], invoices: [], ...FULL,
      stockMovements: [{ id: 'm1', type: 'order-approved', orderId: 'ap', productId: 'p1', delta: -2.5 }], products: [{ id: 'p1' }] });
    const f = only(r, 'INVALID_ORDER_LINES')[0];
    expect(f.recovery).toMatch(/ledger/i);
    expect(f.ledgerNet).toEqual({ p1: -2.5 });
    expect(f.recovery).toMatch(/cancel/i);
  });
  it('legacy invoices with malformed lines are listed (info: historical, blocked only if edited)', () => {
    const r = reconcile({ orders: [], invoices: [{ id: 'i1', invoiceNo: 'NF-INV-1', items: ok(14), grandTotal: 140 }, { id: 'i2', invoiceNo: 'NF-INV-2', items: [{ qty: -1, desc: 'x', price: 1, total: -1 }], grandTotal: -1 }], ...FULL, invoiceNumbers: [{ id: 'NF-INV-1' }, { id: 'NF-INV-2' }] });
    expect(only(r, 'INVALID_INVOICE_LINES').map(f => f.invoiceIds[0]).sort()).toEqual(['i1', 'i2']);
    expect(r.preflight.oversizedInvoices).toEqual(['i1']);
  });
  it('Invoiced/Delivered/Cancelled malformed orders are info (no operation is blocked), open ones are high', () => {
    const bad = [{ qty: -1, desc: 'x', price: 1, total: -1, productId: 'p1' }];
    const r = reconcile({ orders: ['Invoiced', 'Delivered', 'Cancelled', 'Rejected'].map(s => O('h' + s, s, bad, s === 'Invoiced' ? { invoiceId: 'i' } : {})), invoices: [{ id: 'i', invoiceNo: 'NF-INV-3' }], ...FULL, invoiceNumbers: [{ id: 'NF-INV-3' }], cancellations: [{ id: 'hCancelled', stockRestored: false }] });
    expect(only(r, 'INVALID_ORDER_LINES').every(f => f.severity === 'info')).toBe(true);
  });
  it('CONTROL: valid orders (including exactly MAX_ORDER_LINES lines and a custom freight line) stay clean', () => {
    const r = reconcile({ orders: [O('ok12', 'Approved', ok(MAX_ORDER_LINES), { stockApplied: true }), O('fr', 'Submitted', [...ok(1), { qty: 1.5, desc: 'Freight', price: 100, total: 150, custom: true }])],
      invoices: [], ...FULL, products: [{ id: 'p1' }, ...ok(MAX_ORDER_LINES).map(i => ({ id: i.productId }))] });
    expect(types(r).filter(t => /INVALID|UNKNOWN/.test(t))).toEqual([]);
    expect(r.status).toBe('CLEAN');
    expect(r.preflight.maxLinesFound).toBe(MAX_ORDER_LINES);
  });
  it('legacy orders without the explicit custom flag but without a product are reported (a manager must confirm them as custom lines)', () => {
    const r = reconcile({ orders: [O('leg', 'Approved', [{ qty: 1, desc: 'Freight', price: 100, total: 100 }], { stockApplied: true })], invoices: [], ...FULL });
    expect(only(r, 'INVALID_ORDER_LINES')[0].detail).toMatch(/no product/i);
  });
});

describe('D. completeness is reported separately from data readiness', () => {
  it('missing inputs: completeness INCOMPLETE and readiness NOT ASSESSED even if no finding exists', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', ok(1))], invoices: [] });
    expect(r.completeness).toBe('INCOMPLETE');
    expect(r.dataReadiness).toBe('NOT_ASSESSED');
    expect(r.status).toBe('INCOMPLETE');
  });
  it('all inputs and a malformed open order: completeness COMPLETE, readiness BLOCKED', () => {
    const r = reconcile({ orders: [O('bad', 'Submitted', [{ qty: -5, desc: 'x', price: 5, total: -25, productId: 'p1' }])], invoices: [], ...FULL });
    expect(r.completeness).toBe('COMPLETE');
    expect(r.dataReadiness).toBe('BLOCKED');
  });
  it('all inputs and clean data: COMPLETE + READY_FOR_RC5_DATA (this is NOT release readiness)', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', ok(1))], invoices: [], ...FULL, products: [{ id: 'p1' }] });
    expect(r.completeness).toBe('COMPLETE');
    expect(r.dataReadiness).toBe('READY');
    expect(r.releaseReadiness).toBe('NOT_ASSESSED_BY_THIS_TOOL');
  });
});

describe('D. the migration planner no longer gives a misleading clean assessment', () => {
  it('FAILS ON RC4: a malformed legacy order is reported and the assessment is BLOCKED, not clean', () => {
    const plan = planMigration({ orders: [O('bad', 'Approved', [{ qty: -1, desc: 'x', price: 1, total: -1, productId: 'p1' }], { stockApplied: true })], invoices: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, cancellations: [], scheduleConfig: { startedAt: 1 } });
    expect(plan.assessment).toBe('BLOCKED');
    expect(plan.report.some(r => r.type === 'INVALID_LINES' && r.orderIds.includes('bad'))).toBe(true);
  });
  it('CONTROL: valid data -> assessment CLEAN', () => {
    const plan = planMigration({ orders: [O('a', 'Submitted', ok(1))], invoices: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, cancellations: [], scheduleConfig: { startedAt: 1 }, products: ok(1).map(i => ({ id: i.productId })) });   // RC6: the catalogue is a required input
    expect(plan.assessment).toBe('CLEAN');
  });
});
