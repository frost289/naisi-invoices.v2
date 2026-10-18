// RC4 finding 3: order lines and money are validated again on the stored order before approval, edit and cancellation.
import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, line, seedProduct, seedOrder, withId, ledger } from './_util.js';
const stock = await import('../../src/stock.js');
const { validateOrderLines, MAX_ORDER_LINES, round2 } = await import('../../src/orderLines.js');
beforeEach(() => F.reset());

const bad = {
  negative: [{ ...line(-5), total: -500 }],
  fractional: [{ ...line(1.5), total: 150 }],
  zero: [{ ...line(0), total: 0 }],
  nan: [{ ...line(2), qty: NaN }],
  stringQty: [{ ...line(2), qty: '2' }],
  negPrice: [{ qty: 2, desc: 'x', price: -100, total: -200, productId: 'p1' }],
  wrongTotal: [{ ...line(2), total: 999 }],
  noProductIdString: [{ ...line(2), productId: 7 }],
  tooMany: Array.from({ length: 13 }, () => line(1)),
  empty: [],
};

describe('validateOrderLines', () => {
  it('accepts valid stock-tracked and custom lines, with a fractional custom quantity', () => {
    const items = [line(2), { qty: 1.5, desc: 'Freight', price: 100, total: 150 }];
    expect(validateOrderLines(items, 350)).toEqual({ ok: true, problems: [] });
  });
  it.each(Object.keys(bad))('rejects %s', (k) => {
    expect(validateOrderLines(bad[k]).ok).toBe(false);
  });
  it('total mismatch beyond 0.01 rejected; within rounding accepted', () => {
    expect(validateOrderLines([{ qty: 3, desc: 'x', price: 33.33, total: 99.99, productId: 'p1' }]).ok).toBe(true);
    expect(validateOrderLines([line(2)], 250).ok).toBe(false);
  });
  it('MAX_ORDER_LINES is 12 and round2 rounds to 2 decimals', () => { expect(MAX_ORDER_LINES).toBe(12); expect(round2(1.005 + 1e-9)).toBe(1.01); });
});

describe('the stored order is revalidated (defense in depth)', () => {
  it('a negative-quantity order can never be approved and never increases stock', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: bad.negative });
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ code: 'invalid-order-lines' });
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
    expect(F.store.get('orders/o1').status).toBe('Submitted');
    expect(ledger()).toHaveLength(0);
  });
  it('a fractional quantity cannot be approved', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: bad.fractional });
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ code: 'invalid-order-lines' });
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
  });
  it('approval refuses a line whose product no longer exists', async () => {
    seedOrder('o1', 'Submitted', { items: [line(2, 'ghost')] });
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ code: 'unknown-product' });
    expect(F.store.get('orders/o1').status).toBe('Submitted');
  });
  it('cancelling an Approved order with invalid stored lines is refused: stock is not "restored"', async () => {
    seedProduct(10); seedOrder('o1', 'Approved', { items: bad.negative });
    await expect(stock.cancelOrder(withId('o1'), { reason: 'Mistake here', ...user })).rejects.toMatchObject({ code: 'invalid-order-lines' });
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
  it('cancelling a Submitted order with invalid lines is allowed (no stock involved)', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: bad.negative });
    const r = await stock.cancelOrder(withId('o1'), { reason: 'Mistake here', ...user });
    expect(r.stockRestored).toBe(false);
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
  });
  it('editing refuses invalid new lines', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: [line(2)] });
    const details = { customerName: 'Shop', customerPhone: '', customerLocation: '', notes: '' };
    await expect(stock.editOrderWithStock('o1', { details, items: bad.negative }, user)).rejects.toMatchObject({ code: 'invalid-order-lines' });
    expect(F.store.get('orders/o1').items[0].qty).toBe(2);
  });
  it('editing an Approved order whose stored lines are already invalid is refused (no stock movement)', async () => {
    seedProduct(10); seedOrder('o1', 'Approved', { items: bad.negative });
    const details = { customerName: 'Shop', customerPhone: '', customerLocation: '', notes: '' };
    await expect(stock.editOrderWithStock('o1', { details, items: [line(2)] }, user)).rejects.toMatchObject({ code: 'invalid-order-lines' });
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
  });
  it('custom lines stay allowed and are never stock-tracked', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: [line(2), { qty: 1.5, desc: 'Freight', price: 100, total: 150 }] });
    await stock.approveOrderWithStock(withId('o1'), user);
    expect(F.store.get('products/p1').stockOnHand).toBe(8);
    expect(ledger()).toHaveLength(1);
  });
});

describe('UI validator', () => {
  it('validateOrderItems refuses more than 12 lines', async () => {
    const { validateOrderItems } = await import('../../src/visits.js');
    expect(validateOrderItems(Array.from({ length: 13 }, () => line(1)))).toMatch(/at most 12/);
    expect(validateOrderItems(Array.from({ length: 12 }, () => line(1)))).toBe(null);
  });
});
