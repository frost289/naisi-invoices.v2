import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import * as F from '../helpers/fakeFirestore.js';
import * as stock from '../../src/stock.js';

const user = { uid: 'manager-1', email: 'manager@example.test' };
const line = (price = 100) => ({ productId: 'p1', desc: 'Amanda', qty: 2, price, total: price * 2 });
const order = () => ({ id: 'o1', ...F.store.get('orders/o1') });
const movements = () => [...F.store].filter(([p]) => p.startsWith('stockMovements/')).map(([, v]) => v);
function seed(price = 100, catalogue = 100) {
  F.store.set('products/p1', { productName: 'Amanda', packLabel: 'Strip', stockOnHand: 10, ...(catalogue === undefined ? {} : { price: catalogue }) });
  F.store.set('orders/o1', { orderNo: 'ORD-1', status: 'Submitted', items: [line(price)], grandTotal: price * 2 });
}
async function warning() {
  try { await stock.approveOrderWithStock(order(), user); } catch (e) { return e; }
  throw new Error('A differing catalogue price was approved without acknowledgement.');
}
beforeEach(() => F.reset());
describe('RC6.1 catalogue price review at manager approval (mock Firestore)', () => {
  it('POSITIVE CONTROL equal price approves without acknowledgement and deducts stock once', async () => {
    seed(); await stock.approveOrderWithStock(order(), user);
    assert.equal(F.store.get('products/p1').stockOnHand, 8);
    await assert.rejects(stock.approveOrderWithStock(order(), user));
    assert.equal(movements().length, 1);
  });
  for (const [label, price] of [['lower', 75], ['higher', 125]]) {
    it(`${label} price requires explicit acknowledgement before any write`, async () => {
      seed(price); const e = await warning();
      assert.equal(e.code, 'price-acknowledgement-required');
      assert.deepEqual(e.priceReview.differences, [{ line: 1, productId: 'p1', description: 'Amanda', orderPrice: price, cataloguePrice: 100 }]);
      assert.equal(F.store.get('orders/o1').status, 'Submitted');
      assert.equal(F.store.get('products/p1').stockOnHand, 10);
      assert.equal(movements().length, 0);
    });
  }
  it('acknowledgement preserves the submitted price and records actor, server time and both prices', async () => {
    seed(75); const e = await warning();
    await stock.approveOrderWithStock(order(), { ...user, priceAcknowledgement: { reviewKey: e.priceReview.key } });
    const audit = movements()[0];
    assert.equal(audit.priceAcknowledgedBy, user.uid);
    assert.equal(audit.priceAcknowledgedByEmail, user.email);
    assert.equal(typeof audit.priceAcknowledgedAt.toMillis, 'function');
    assert.deepEqual(audit.priceDifferences, e.priceReview.differences);
    assert.equal(F.store.get('orders/o1').items[0].price, 75);
    assert.equal(F.store.get('products/p1').stockOnHand, 8);
  });
  it('acknowledged concurrent approvals deduct stock exactly once', async () => {
    seed(125); const e = await warning(); const opts = { ...user, priceAcknowledgement: { reviewKey: e.priceReview.key } };
    const settled = await Promise.allSettled([stock.approveOrderWithStock(order(), opts), stock.approveOrderWithStock(order(), opts)]);
    assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(F.store.get('products/p1').stockOnHand, 8);
    assert.equal(movements().length, 1);
  });
  it('catalogue changed after acknowledgement requires a fresh acknowledgement and writes nothing', async () => {
    seed(75); const e = await warning();
    await F.updateDoc(F.doc(null, 'products', 'p1'), { price: 110 });
    await assert.rejects(stock.approveOrderWithStock(order(), { ...user, priceAcknowledgement: { reviewKey: e.priceReview.key } }), err => err.code === 'price-acknowledgement-required' && err.priceReview.differences[0].cataloguePrice === 110);
    assert.equal(F.store.get('products/p1').stockOnHand, 10);
    assert.equal(movements().length, 0);
  });
  it('a transaction retry after a catalogue change also refuses stale acknowledgement', async () => {
    seed(75); const e = await warning();
    F.hooks.beforeCommit = async ({ attempt }) => { if (attempt === 1) await F.updateDoc(F.doc(null, 'products', 'p1'), { price: 120 }); };
    await assert.rejects(stock.approveOrderWithStock(order(), { ...user, priceAcknowledgement: { reviewKey: e.priceReview.key } }), err => err.code === 'price-acknowledgement-required');
    assert.equal(F.store.get('orders/o1').status, 'Submitted');
    assert.equal(F.store.get('products/p1').stockOnHand, 10);
  });
  it('catalogue with no price is visibly skipped and approval remains possible', async () => {
    seed(); delete F.store.get('products/p1').price;
    const review = stock.reviewOrderPrices(order().items, [{ id: 'p1', ...F.store.get('products/p1') }]);
    assert.equal(review.differences.length, 0);
    assert.equal(review.missingPrices.length, 1);
    assert.match(stock.orderPriceReviewText(review), /Amanda.*no valid catalogue price.*comparison skipped/i);
    await stock.approveOrderWithStock(order(), user);
    assert.equal(F.store.get('products/p1').stockOnHand, 8);
  });
  it('equal price has no warning; numeric zero is a real price; custom lines are not compared', () => {
    const same = stock.reviewOrderPrices([line()], [{ id: 'p1', price: 100 }]);
    assert.equal(same.differences.length, 0); assert.equal(same.missingPrices.length, 0);
    assert.match(stock.orderPriceReviewText(same), /match/i);
    const zero = stock.reviewOrderPrices([line(1), { desc: 'Freight', qty: 1, price: 50, total: 50, custom: true }], [{ id: 'p1', price: 0 }]);
    assert.equal(zero.differences.length, 1); assert.equal(zero.differences[0].cataloguePrice, 0);
  });
  it('manager order text lists every differing line and both prices without silently repricing', () => {
    const review = stock.reviewOrderPrices([line(75), { ...line(125), desc: 'Second line' }], [{ id: 'p1', price: 100 }]);
    const text = stock.orderPriceReviewText(review);
    assert.match(text, /Amanda/); assert.match(text, /Second line/);
    assert.match(text, /75/); assert.match(text, /125/); assert.match(text, /100/);
    assert.match(text, /acknowledge/i);
  });
});
