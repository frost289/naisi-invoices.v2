import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, seedProduct, ledger } from './_util.js';
const stock = await import('../../src/stock.js');
const products = await import('../../src/products.js');
const { wholeNumber } = await import('../../src/numbers.js');
beforeEach(() => F.reset());

describe('casesToPacks / wholeNumber', () => {
  it('valid', () => { expect(stock.casesToPacks(3, 14)).toBe(42); expect(stock.casesToPacks('2', '60')).toBe(120); });
  it.each([[0.5, 10], [1.5, 10], [1e-9, 10], [0, 10], [-1, 10], [NaN, 10], [Infinity, 10], [1e308, 1e308], [Number.MAX_SAFE_INTEGER, 2], [1000, 1001], ['abc', 5], ['1e3', 5], ['', 5], [null, 5], [3, 0], [3, 2.5], [3, null]])(
    'rejects cases=%s packs=%s', (c, u) => { expect(stock.casesToPacks(c, u)).toBeNull(); });
  it('wholeNumber', () => {
    expect(wholeNumber('12')).toBe(12); expect(wholeNumber(' 3 ')).toBe(3); expect(wholeNumber(12)).toBe(12);
    for (const bad of [0, -1, 1.2, '1.2', '1e2', '0x10', NaN, Infinity, 2 ** 60, null, undefined, '']) expect(wholeNumber(bad)).toBeNull();
  });
});

describe('receiveStockCases', () => {
  it('stock, ledger and unitsPerCase are written together', async () => {
    seedProduct(10);
    await stock.receiveStockCases('p1', 3, 14, { reason: 'Supplier delivery', ...user });
    expect(F.store.get('products/p1').stockOnHand).toBe(52);
    expect(F.store.get('products/p1').unitsPerCase).toBe(14);
    const l = ledger();
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ delta: 42, previousStock: 10, newStock: 52 });
    expect(l[0].reason).toMatch(/3/); expect(l[0].reason).toMatch(/14/);
  });
  it('failed commit: no stock, no ledger, unitsPerCase NOT changed', async () => {
    seedProduct(10);
    F.hooks.failCommit = () => new Error('network');
    await expect(stock.receiveStockCases('p1', 3, 14, { reason: '', ...user })).rejects.toThrow('network');
    expect(F.store.get('products/p1')).toMatchObject({ stockOnHand: 10 });
    expect(F.store.get('products/p1').unitsPerCase).toBeUndefined();
    expect(ledger()).toHaveLength(0);
  });
  it.each([[0.5, 10], [2, 1.5], [1e9, 1e9]])('invalid input %s x %s writes nothing', async (c, u) => {
    seedProduct(10);
    await expect(stock.receiveStockCases('p1', c, u, { reason: '', ...user })).rejects.toThrow();
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
    expect(ledger()).toHaveLength(0);
  });
  it('unitsPerCase is not rewritten when unchanged', async () => {
    F.store.set('products/p1', { productName: 'A', packLabel: 'S', stockOnHand: 0, unitsPerCase: 14 });
    await stock.receiveStockCases('p1', 1, 14, { reason: '', ...user });
    expect(F.store.get('products/p1').stockOnHand).toBe(14);
  });
});

describe('manual adjustment validation', () => {
  it.each([[0], [NaN], [Infinity], [1e12]])('rejects delta %s', async (d) => {
    seedProduct(10);
    await expect(stock.adjustStockManually('p1', d, { reason: 'x', ...user })).rejects.toThrow();
    expect(F.store.get('products/p1').stockOnHand).toBe(10);
  });
  it('accepts a normal adjustment', async () => {
    seedProduct(10); await stock.adjustStockManually('p1', -3, { reason: 'damaged', ...user });
    expect(F.store.get('products/p1').stockOnHand).toBe(7);
  });
});

describe('normaliseUnitsPerCase', () => {
  it('blank -> null; valid -> number', () => { expect(products.normaliseUnitsPerCase('')).toBeNull(); expect(products.normaliseUnitsPerCase(null)).toBeNull(); expect(products.normaliseUnitsPerCase('60')).toBe(60); });
  it.each([['0'], ['-3'], ['1.5'], ['abc'], ['1e400'], [Infinity], [NaN], [2 ** 60]])('throws for %s', (v) => { expect(() => products.normaliseUnitsPerCase(v)).toThrow(); });
});
