import { describe, it, expect } from 'vitest';
const { planMigration } = await import('../../tools/migrate-logic.js');
const LINES = { items: [{ qty: 1, desc: 'x', price: 10, total: 10, custom: true }], grandTotal: 10 };   // RC5: the planner now also checks lines, so fixtures carry valid ones
const inv = (id, over = {}) => ({ id, invoiceNo: 'NF-INV-2026-' + id, createdBy: 'u1', createdAt: { ms: 5 }, ...LINES, ...over });
describe('RC3 migration planner (pure, additive, invents nothing)', () => {
  it('registers unregistered numbers and never touches registered ones', () => {
    const p = planMigration({ invoices: [inv('0001'), inv('0002')], invoiceNumbers: [{ id: 'NF-INV-2026-0001' }], scheduleConfig: {} });
    expect(p.actions.filter(a => a.type === 'REGISTER_NUMBER').map(a => a.path)).toEqual(['invoiceNumbers/NF-INV-2026-0002']);
    expect(p.actions[0].data).toMatchObject({ invoiceId: '0002', issuedBy: 'u1', migrated: true });
  });
  it('a duplicated number is reported and registered for nobody', () => {
    const p = planMigration({ invoices: [inv('0001'), { ...inv('0009'), invoiceNo: 'NF-INV-2026-0001' }], scheduleConfig: {} });
    expect(p.actions.filter(a => a.type === 'REGISTER_NUMBER')).toEqual([]);
    expect(p.report[0]).toMatchObject({ type: 'NEEDS_REVIEW', invoiceIds: ['0001', '0009'] });
  });
  it('labels only invoices an order demonstrably points to; others are left for review', () => {
    const p = planMigration({ invoices: [inv('a', { kind: undefined }), inv('b'), inv('c', { orderId: 'o9' }), inv('d', { kind: 'standalone' })], orders: [{ id: 'o1', invoiceId: 'a', status: 'Invoiced', ...LINES }], invoiceNumbers: ['a', 'b', 'c', 'd'].map(x => ({ id: 'NF-INV-2026-' + x })), scheduleConfig: {} });
    expect(p.actions.map(a => a.path).sort()).toEqual(['invoices/a', 'invoices/c']);
    expect(p.report.map(r => r.invoiceIds[0])).toEqual(['b']);
  });
  it('old cancelled orders get no invented record; counter and history are reported only', () => {
    const p = planMigration({ invoices: [inv('0005')], invoiceNumbers: [{ id: 'NF-INV-2026-0005' }], orders: [{ id: 'o1', status: 'Cancelled', ...LINES }], counter: { prefix: 'NF-INV', counter: 5 } });
    expect(p.actions.filter(a => a.path.startsWith('orderCancellations'))).toEqual([]);
    expect(p.report.map(r => r.type).sort()).toEqual(['COUNTER_BEHIND', 'HISTORY_NOT_STARTED', 'NEEDS_REVIEW', 'NEEDS_REVIEW']);
  });
  it('is pure and idempotent: a second plan after applying is empty', () => {
    const input = { invoices: [inv('0001')], scheduleConfig: {} }; const copy = JSON.stringify(input);
    expect(planMigration(input).actions).toHaveLength(1); expect(JSON.stringify(input)).toBe(copy);
    expect(planMigration({ ...input, invoiceNumbers: [{ id: 'NF-INV-2026-0001' }] }).actions).toEqual([]);
  });
});
