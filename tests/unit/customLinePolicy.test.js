// @vitest-environment jsdom
// RC6 priority 3: the ACTUAL custom-line policy, stated once and tested (client validator, the line-building code, and the rules text).
//   catalogue (rep order / manager-entered order creation): tracked lines ONLY
//   order (approve, edit, cancel-restore):                  tracked, or custom:true. A legacy untracked line (no `custom` key) is NOT accepted
//   invoice (create / update of lines):                     tracked, custom:true, OR (historical compatibility) a line with no productId and no `custom` key
// New invoice lines built by the app always carry custom:true (items.js getItems), so the legacy invoice allowance only serves stale clients and old data.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const { validateOrderLines: V } = await import('../../src/orderLines.js');
const { fillItemRows, getItems } = await import('../../src/items.js');
const rules = fs.readFileSync(path.resolve(process.cwd(), '../rules/firestore.rules'), 'utf8');

const tracked = { productId: 'p1', desc: 'Amanda', qty: 2, price: 100, total: 200 };
const custom = { desc: 'Freight', qty: 1.5, price: 100, total: 150, custom: true };
const legacy = { desc: 'Freight', qty: 1, price: 100, total: 100 };            // historical: no productId, no custom key
const sum = (a) => a.reduce((s, l) => s + l.total, 0);
const ok = (items, opts) => V(items, sum(items), opts).ok;

describe('RC6-P3 client validator: the three modes', () => {
  it('catalogue-only (rep orders): tracked yes; custom no; legacy untracked no', () => {
    expect([ok([tracked], { catalogueOnly: true }), ok([custom], { catalogueOnly: true }), ok([legacy], { catalogueOnly: true })]).toEqual([true, false, false]);
  });
  it('order mode (approve / edit): tracked yes; custom:true yes; legacy untracked NO (the legacy allowance does not extend to orders)', () => {
    expect([ok([tracked]), ok([tracked, custom]), ok([legacy])]).toEqual([true, true, false]);
  });
  it('invoice mode: tracked yes; custom:true yes; legacy untracked YES (historical compatibility)', () => {
    expect([ok([tracked], { invoice: true }), ok([custom], { invoice: true }), ok([legacy], { invoice: true })]).toEqual([true, true, true]);
  });
  it('malformed markers are rejected in every mode (custom:false, custom as string, custom together with a productId)', () => {
    for (const bad of [{ ...legacy, custom: false }, { ...legacy, custom: 'true' }, { ...tracked, custom: true }]) {
      for (const opts of [{ catalogueOnly: true }, {}, { invoice: true }]) expect(ok([bad], opts)).toBe(false);
    }
  });
  it('a tracked line still needs a whole-number quantity on invoices; custom lines may be fractional', () => {
    expect(ok([{ ...tracked, qty: 1.5, total: 150 }], { invoice: true })).toBe(false);
    expect(ok([custom], { invoice: true })).toBe(true);
  });
});

describe('RC6-P3 new invoice/order lines built by the app always carry the explicit flag', () => {
  it('a typed (no-product) row becomes custom:true; a catalogue row never has the flag', () => {
    document.body.innerHTML = '<table><tbody id="b"></tbody></table>';
    const body = document.getElementById('b');
    fillItemRows(body, [{ qty: 1, desc: 'Delivery', price: 500, total: 500 }, { qty: 2, desc: 'Amanda', price: 100, total: 200, productId: 'p1' }]);
    const out = getItems(body);
    expect(out[0]).toMatchObject({ custom: true }); expect(out[0].productId || null).toBeNull();
    expect('custom' in out[1]).toBe(false); expect(out[1].productId).toBe('p1');
  });
});

describe('RC6-P3 rules text agrees with the policy (static check; behaviour is covered by the emulator group RC6-P3)', () => {
  it('the legacy allowance exists only inside lineValid for mode "invoice"', () => {
    expect(rules).toContain("(mode == 'invoice' && l.get('productId', null) == null && !('custom' in l))");
    expect((rules.match(/mode == 'invoice'/g) || []).length).toBe(1);
    expect(rules).toContain("(mode != 'catalogue' && lineCustom(l))");
  });
  it('mode "invoice" is used only by the invoice rules; "catalogue" only by order creation; "order" only by approve/edit/restore', () => {
    const marker = rules.indexOf('// ---------- orders ----------');
    const uses = [...rules.matchAll(/linesAndTotalOk\([^,]+, '(\w+)'\)/g)].map(m => ({ mode: m[1], pos: m.index }));
    expect(uses.filter(u => u.mode === 'invoice')).toHaveLength(3);
    expect(uses.filter(u => u.mode === 'invoice').every(u => u.pos < marker)).toBe(true);
    expect(uses.filter(u => u.mode === 'catalogue')).toHaveLength(1);
    expect(uses.filter(u => u.mode === 'order')).toHaveLength(3);
    expect(uses.filter(u => u.mode !== 'invoice').every(u => u.pos > marker)).toBe(true);
  });
});
