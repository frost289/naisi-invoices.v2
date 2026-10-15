import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, line, seedProduct, seedOrder, withId, ledger } from './_util.js';
const stock = await import('../../src/stock.js');
const { orderRevisionKey } = await import('../../src/orderRevision.js');
beforeEach(() => F.reset());

describe('approval with repeated product lines', () => {
  it('2 + 3 of one product deducts 5; ledger sums to -5 with running balances', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted', { items: [line(2), line(3)] });
    await stock.approveOrderWithStock(withId('o1'), user);
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
    const l = ledger();
    expect(l.reduce((s, m) => s + m.delta, 0)).toBe(-5);
    expect(l.map(m => m.newStock).sort((a, b) => b - a)).toEqual([98, 95]);
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
  it('shortage check uses combined demand (4 in stock, 3 + 3)', async () => {
    seedProduct(4); seedOrder('o1', 'Submitted', { items: [line(3), line(3)] });
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ isStockShortage: true });
    expect(F.store.get('products/p1').stockOnHand).toBe(4);
    expect(F.store.get('orders/o1').status).toBe('Submitted');
    expect(ledger()).toHaveLength(0);
  });
  it('double approval deducts once', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted', { items: [line(5)] });
    await Promise.allSettled([stock.approveOrderWithStock(withId('o1'), user), stock.approveOrderWithStock(withId('o1'), user)]);
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
  });
  it('cancel restores the combined quantity once', async () => {
    seedProduct(95); seedOrder('o1', 'Approved', { items: [line(2), line(3)] });
    await stock.cancelApprovedOrderAndDelete(withId('o1'), user);
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger().reduce((s, m) => s + m.delta, 0)).toBe(5);
  });
});

describe('stale cached order data', () => {
  it('a cached copy that differs from the stored order is rejected (order-changed); nothing is deducted', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted', { items: [line(5)] });
    await expect(stock.approveOrderWithStock({ id: 'o1', orderNo: 'ORD-o1', items: [line(1)] }, user))
      .rejects.toMatchObject({ code: 'order-changed' });
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(F.store.get('orders/o1').status).toBe('Submitted');
    expect(ledger()).toHaveLength(0);
  });
  it('quantities always come from the stored order, never from the caller', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted', { items: [line(5)] });
    await stock.approveOrderWithStock({ id: 'o1' }, user); // caller supplies no items
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
    expect(ledger()[0].orderNo).toBe('ORD-o1');
  });
});

describe('editing an order (editOrderWithStock)', () => {
  const details = { customerName: 'Shop', customerPhone: '', customerLocation: '', notes: '' };
  it('Approved: stock follows the difference, one ledger entry', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    const rev = orderRevisionKey(withId('o1'));
    await stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(5)] }, user);
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
    expect(ledger()).toHaveLength(1);
    expect(F.store.get('orders/o1').items[0].productId).toBe('p1');
  });
  it('saving identical content again (retry) does not adjust stock again', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    const rev = orderRevisionKey(withId('o1'));
    await stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(5)] }, user);
    const again = await stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(5)] }, user);
    expect(again.unchanged).toBe(true);
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
    expect(ledger()).toHaveLength(1);
  });
  it('a stale revision (someone else edited first) is rejected, nothing changes', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    const rev = orderRevisionKey(withId('o1'));
    await stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(4)] }, user);
    await expect(stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(9)] }, user))
      .rejects.toMatchObject({ code: 'order-changed' });
    expect(F.store.get('products/p1').stockOnHand).toBe(96);
  });
  it('two concurrent edits from the same revision: exactly one wins', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    const rev = orderRevisionKey(withId('o1'));
    const r = await Promise.allSettled([
      stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(4)] }, user),
      stock.editOrderWithStock('o1', { expectedRevision: rev, details, items: [line(7)] }, user),
    ]);
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const q = F.store.get('orders/o1').items[0].qty;
    expect(F.store.get('products/p1').stockOnHand).toBe(100 - q);
  });
  it('status changed to Invoicing/Invoiced meanwhile: rejected', async () => {
    seedProduct(98); seedOrder('o1', 'Invoiced', { items: [line(2)] });
    await expect(stock.editOrderWithStock('o1', { expectedRevision: null, details, items: [line(5)] }, user))
      .rejects.toMatchObject({ code: 'order-status-changed' });
    expect(F.store.get('products/p1').stockOnHand).toBe(98);
  });
  it('Submitted order: edit does not touch stock', async () => {
    seedProduct(100); seedOrder('o1', 'Submitted', { items: [line(2)] });
    await stock.editOrderWithStock('o1', { expectedRevision: null, details, items: [line(5)] }, user);
    expect(F.store.get('products/p1').stockOnHand).toBe(100);
    expect(ledger()).toHaveLength(0);
  });
  it('edit and stock change are atomic: a failed commit changes neither', async () => {
    seedProduct(98); seedOrder('o1', 'Approved', { items: [line(2)] });
    F.hooks.failCommit = () => new Error('network');
    await expect(stock.editOrderWithStock('o1', { expectedRevision: null, details, items: [line(5)] }, user)).rejects.toThrow('network');
    expect(F.store.get('orders/o1').items[0].qty).toBe(2);
    expect(F.store.get('products/p1').stockOnHand).toBe(98);
  });
  it('removing a line and adding the same product elsewhere nets out', async () => {
    seedProduct(95); seedOrder('o1', 'Approved', { items: [line(2), line(3)] });
    await stock.editOrderWithStock('o1', { expectedRevision: null, details, items: [line(5)] }, user);
    expect(F.store.get('products/p1').stockOnHand).toBe(95);
    expect(ledger()).toHaveLength(0);
  });
});
