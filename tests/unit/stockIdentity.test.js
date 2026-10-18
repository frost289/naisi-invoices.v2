// RC5 finding B: goods orders need a real catalogue product; only EXPLICIT custom lines (freight etc.) may be untracked.
import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, line, seedProduct, seedOrder, withId, ledger } from './_util.js';
const stock = await import('../../src/stock.js');
const OL = await import('../../src/orderLines.js');
const { validateOrderItems } = await import('../../src/visits.js');
beforeEach(() => F.reset());

const untracked = (extra = {}) => ({ qty: 3, desc: 'Amanda 100g', price: 100, total: 300, ...extra });
const bad = {
  'no productId': [untracked()],
  'productId null': [untracked({ productId: null })],
  'productId empty': [untracked({ productId: '' })],
  'productId number': [untracked({ productId: 7 })],
  'productId path injection': [untracked({ productId: 'a/b' })],
  'productId whitespace': [untracked({ productId: ' p1 ' })],
  'custom flag false': [untracked({ custom: false })],
  'custom flag string': [untracked({ custom: 'true' })],
  'custom AND productId': [untracked({ productId: 'p1', custom: true })],
};

describe('B. approval: a goods line without stock identity can never be approved without stock deduction', () => {
  for (const [name, items] of Object.entries(bad)) {
    it(`refused: ${name}; stock untouched, order stays Submitted`, async () => {
      seedProduct(10); seedOrder('o1', 'Submitted', { items, grandTotal: 300 });
      await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ code: 'invalid-order-lines' });
      expect(F.store.get('products/p1').stockOnHand).toBe(10);
      expect(F.store.get('orders/o1').status).toBe('Submitted');
      expect(ledger()).toHaveLength(0);
    });
  }
  it('refused: unknown product id (not in the catalogue)', async () => {
    seedProduct(10); seedOrder('o1', 'Submitted', { items: [line(3, 'ghost')], grandTotal: 300 });
    await expect(stock.approveOrderWithStock(withId('o1'), user)).rejects.toMatchObject({ code: 'unknown-product' });
    expect(F.store.get('orders/o1').status).toBe('Submitted');
  });
  it('POSITIVE CONTROL: a tracked line is deducted; an explicit custom line (freight, fractional) is allowed and not tracked', async () => {
    seedProduct(10);
    seedOrder('o1', 'Submitted', { items: [line(3), { qty: 1.5, desc: 'Freight', price: 100, total: 150, custom: true }], grandTotal: 450 });
    await stock.approveOrderWithStock(withId('o1'), user);
    expect(F.store.get('products/p1').stockOnHand).toBe(7);
    expect(ledger()).toHaveLength(1);
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
  it('cancelling an Approved order restores only the tracked lines (custom lines never touch stock)', async () => {
    seedProduct(7); seedOrder('o1', 'Approved', { stockApplied: true, items: [line(3), { qty: 1.5, desc: 'Freight', price: 100, total: 150, custom: true }], grandTotal: 450 });
    await stock.cancelOrder(withId('o1'), { reason: 'Customer cancelled', ...user });
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
  });
});

describe('B. the same policy on the validators used by the screens', () => {
  it('rep / manager-entered orders (validateOrderItems) need a catalogue product on every line', () => {
    expect(validateOrderItems([untracked()])).toMatch(/product list/);
    expect(validateOrderItems([untracked({ custom: true })])).toMatch(/product list/);          // a rep cannot declare a custom line
    expect(validateOrderItems([line(3)])).toBe(null);
  });
  it('validateOrderLines(mode "order") accepts tracked or explicit custom; mode "catalogue" accepts tracked only', () => {
    const custom = { qty: 1.5, desc: 'Freight', price: 100, total: 150, custom: true };
    expect(OL.validateOrderLines([line(3), custom], 450).ok).toBe(true);
    expect(OL.validateOrderLines([line(3), custom], 450, { catalogueOnly: true }).ok).toBe(false);
    expect(OL.validateOrderLines([line(3)], 300, { catalogueOnly: true }).ok).toBe(true);
    expect(OL.validateOrderLines([untracked()], 300).ok).toBe(false);
  });
  it('editing an order: lines typed without a product are stored as explicit custom lines (getItems stamps custom:true)', async () => {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<table><tbody id="b"></tbody></table>'); globalThis.document = dom.window.document;
    const it = await import('../../src/items.js');
    const body = dom.window.document.getElementById('b');
    it.addItemRow(body, () => {}, 1, 'Freight', 100);
    it.addItemRow(body, () => {}, 2, 'Amanda', 50, 'Amanda', '100g', 1, 'p1');
    const got = it.getItems(body);
    expect(got[0]).toMatchObject({ desc: 'Freight', productId: null, custom: true });
    expect(got[1]).toMatchObject({ productId: 'p1' });
    expect(got[1].custom).toBeUndefined();
    delete globalThis.document;
  });
});
