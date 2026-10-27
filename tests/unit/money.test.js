// RC5 finding A (currency formatting + expense amounts) and the single currency policy (client == rules).
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { F, user } from './_util.js';
const M = await import('../../src/money.js');
const items = await import('../../src/items.js');
const orderLines = await import('../../src/orderLines.js');
const expenses = await import('../../src/expenses.js');
beforeEach(() => F.reset());

const EVIL = ['<img src=x onerror=alert(1)>', '"><script>1</script>', "' onmouseover='x", '&lt;b&gt;', '1e999', 'NaN', '12abc', '', ' ', '-5', null, undefined, {}, [], true, NaN, Infinity, -Infinity];

describe('A. mwk() can never return markup, whatever it is given', () => {
  it.each(EVIL.map((v, i) => [i, v]))('input #%i -> only safe characters', (_i, v) => {
    const out = M.mwk(v);
    expect(typeof out).toBe('string');
    expect(out).toMatch(/^[A-Za-z0-9 ,.\-–—]*$/);        // no < > & " ' ` = ( ) / ;
  });
  it('items.js re-exports the same function (no second, unsafe copy)', () => { expect(items.mwk).toBe(M.mwk); });
  it('positive control: real numbers keep their normal format', () => {
    expect(M.mwk(1234.5)).toBe('MWK 1,234.50');
    expect(M.mwk(0)).toBe('MWK 0.00');
    expect(M.mwk(1000000)).toBe('MWK 1,000,000.00');
  });
  it('malformed values are shown as "Invalid amount", NOT as MWK 0.00 (flagged, never silently zero)', () => {
    for (const v of ['<img>', 'abc', NaN, Infinity, {}, null, undefined]) expect(M.mwk(v)).toBe('Invalid amount');
  });
});

describe('A. expense summaries exclude and FLAG malformed amounts', () => {
  const E = (id, category, amount) => ({ id, category, amount, date: '2026-10-15' });
  it('totals count only valid numbers; invalid ones are listed by id', () => {
    const s = M.summarizeExpenses([E('e1', 'Fuel', 100), E('e2', 'Fuel', '<img src=x onerror=alert(1)>'), E('e3', 'Meals', 50.25), E('e4', 'Other', -5), E('e5', 'Other', null), E('e6', 'Other', Infinity)]);
    expect(s.total).toBe(150.25);
    expect(s.byCategory.Fuel).toBe(100);
    expect(s.invalid.map(x => x.id).sort()).toEqual(['e2', 'e4', 'e5', 'e6']);
    expect(s.validCount).toBe(2);
  });
  it('a string amount is never concatenated into a total', () => {
    const s = M.summarizeExpenses([E('e1', 'Fuel', '100'), E('e2', 'Fuel', 5)]);
    expect(s.total).toBe(5); expect(s.invalid.map(x => x.id)).toEqual(['e1']);
  });
  it('positive control: all valid', () => {
    const s = M.summarizeExpenses([E('e1', 'Fuel', 10), E('e2', 'Meals', 20)]);
    expect(s).toMatchObject({ total: 30, validCount: 2, invalid: [] });
  });
});

describe('A. the trusted write boundary requires a finite positive amount', () => {
  const { addExpense, updateExpense } = expenses;
  const base = { date: '2026-10-15', category: 'Fuel', notes: '', uid: 'u1', email: 'm@naisi' };
  const bad = ['<img src=x onerror=alert(1)>', '12abc', '', 'NaN', 'Infinity', NaN, Infinity, -1, 0, '0', '-3', null, undefined, '1e999', 1e13];
  it.each(bad.map((v, i) => [i, v]))('addExpense refuses invalid amount #%i and writes nothing', async (_i, v) => {
    await expect(addExpense({ ...base, amount: v })).rejects.toMatchObject({ code: 'invalid-amount' });
    expect([...F.store.keys()].filter(k => k.startsWith('expenses/'))).toEqual([]);
  });
  it('updateExpense refuses invalid amounts and leaves the record unchanged', async () => {
    F.store.set('expenses/e1', { ...base, amount: 10 });
    await expect(updateExpense('e1', { ...base, amount: '<b>' })).rejects.toMatchObject({ code: 'invalid-amount' });
    expect(F.store.get('expenses/e1').amount).toBe(10);
  });
  it('positive control: valid amounts (number or plain numeric text) are stored as numbers', async () => {
    await addExpense({ ...base, amount: '1500' });
    await addExpense({ ...base, amount: 99.5 });
    expect([...F.store].filter(([k]) => k.startsWith('expenses/')).map(([, d]) => d.amount).sort((a, b) => a - b)).toEqual([99.5, 1500]);
  });
});

describe('Currency policy: client validation uses EXACTLY the formula and limits the rules use', () => {
  const L = (o = {}) => ({ qty: 1, desc: 'x', price: 10, total: 10, custom: true, ...o });
  it('a total is accepted when |total - qty*price| <= 0.01 (unrounded product, as in the rules)', () => {
    expect(orderLines.validateOrderLines([L({ price: 10.006, total: 10.02 })]).ok).toBe(false);   // RC4 accepted this, the rules refuse it
    expect(orderLines.validateOrderLines([L({ price: 10.006, total: 10.01 })]).ok).toBe(true);
    expect(orderLines.validateOrderLines([L({ price: 10.006, total: 10.0 })]).ok).toBe(true);
  });
  it('rounding boundaries', () => {
    expect(orderLines.validateOrderLines([{ qty: 3, desc: 'x', price: 33.33, total: 99.99, productId: 'p1' }]).ok).toBe(true);
    expect(orderLines.validateOrderLines([{ qty: 1.005, desc: 'Freight', price: 100, total: 100.5, custom: true }]).ok).toBe(true);
    expect(orderLines.validateOrderLines([{ qty: 0.333, desc: 'Freight', price: 3, total: 1, custom: true }]).ok).toBe(true);     // 0.999 vs 1.00
    expect(orderLines.validateOrderLines([{ qty: 0.333, desc: 'Freight', price: 3, total: 1.02, custom: true }]).ok).toBe(false);
  });
  it('fractional custom quantities pass; fractional tracked quantities fail', () => {
    expect(orderLines.validateOrderLines([{ qty: 2.5, desc: 'Freight', price: 4, total: 10, custom: true }]).ok).toBe(true);
    expect(orderLines.validateOrderLines([{ qty: 2.5, desc: 'Amanda', price: 4, total: 10, productId: 'p1' }]).ok).toBe(false);
  });
  it('aggregate: sum of line totals within 0.01; above 1e12 refused', () => {
    const lines = Array.from({ length: 12 }, (_, i) => ({ qty: 1, desc: 'x', price: 0.1 + i / 100, total: 0.1 + i / 100, productId: 'p' + i }));
    const sum = lines.reduce((s, l) => s + l.total, 0);
    expect(orderLines.validateOrderLines(lines, sum).ok).toBe(true);
    expect(orderLines.validateOrderLines(lines, sum + 0.02).ok).toBe(false);
    expect(orderLines.validateOrderLines([{ qty: 1000000, desc: 'x', price: 1e9, total: 1e15, custom: true }], 1e15).ok).toBe(false);
  });
  it('the constants in money.js are the ones written in rules/firestore.rules', () => {
    const rules = fs.readFileSync(new URL('../../rules/firestore.rules', import.meta.url), 'utf8');
    expect(rules).toContain(`<= ${M.MONEY_TOLERANCE}`);
    expect(rules).toContain(`items.size() <= ${M.MAX_ORDER_LINES}`);
    expect(rules).toContain(`l.qty <= ${M.MAX_QTY}`);
    expect(rules).toContain(`l.price <= ${M.MAX_PRICE}`);
    expect(rules).toContain(`d.grandTotal <= ${M.MAX_TOTAL}`);
    expect(rules).toContain(`d.amount <= ${M.MAX_EXPENSE}`);
  });
});
