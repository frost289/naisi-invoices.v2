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
