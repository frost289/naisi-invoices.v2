// RC6 priority 2: the product catalogue is REQUIRED for a complete product-identity assessment.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const { reconcile } = await import('../../tools/reconcile-logic.js');
const { planMigration } = await import('../../tools/migrate-logic.js');
const root = path.resolve(import.meta.dirname, '../..');

const line = (pid, qty = 2, price = 100) => ({ productId: pid, desc: pid, qty, price, total: qty * price });
const O = (id, status, items, over = {}) => ({ id, orderNo: 'ORD-' + id, status, customerName: 'Shop', items, grandTotal: items.reduce((s, i) => s + i.total, 0), ...over });
const REST = { cancellations: [], stockMovements: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, customers: [], scheduleChanges: [], scheduleConfig: { startedAt: 1 } };

describe('RC6-P2 reconcile: catalogue required', () => {
  it('FAILS ON RC5: products omitted -> INCOMPLETE / NOT_ASSESSED, and the skipped check is named', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', [line('ghost')])], invoices: [], ...REST });
    expect(r.completeness).toBe('INCOMPLETE'); expect(r.dataReadiness).toBe('NOT_ASSESSED'); expect(r.status).toBe('INCOMPLETE');
    expect(r.skippedChecks.map(c => c.input)).toEqual(['products']);
    expect(r.skippedChecks[0].covers).toMatch(/UNKNOWN_PRODUCT/);
    expect(r.safeToEnableResume).toBe(false);
  });
  it('FAILS ON RC5: an explicitly empty catalogue flags every product reference (open orders: high, data BLOCKED)', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', [line('p1'), line('p2')])], invoices: [], ...REST, products: [] });
    const f = r.findings.find(x => x.type === 'UNKNOWN_PRODUCT');
    expect(f).toMatchObject({ severity: 'high', orderIds: ['a'], productIds: ['p1', 'p2'] });
    expect(r.completeness).toBe('COMPLETE'); expect(r.dataReadiness).toBe('BLOCKED'); expect(r.status).toBe('FINDINGS');
  });
  it('unknown product on a Cancelled (historical) order is info only; on Approved it is high', () => {
    const r = reconcile({ orders: [O('c', 'Cancelled', [line('gone')]), O('d', 'Approved', [line('gone2')])], invoices: [], ...REST, products: [{ id: 'p1' }] });
    const by = Object.fromEntries(r.findings.filter(x => x.type === 'UNKNOWN_PRODUCT').map(x => [x.orderIds[0], x.severity]));
    expect(by).toEqual({ c: 'info', d: 'high' });
  });
  it('CONTROL: every product in the catalogue and every input supplied -> COMPLETE / READY / CLEAN, release readiness still not assessed', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', [line('p1')])], invoices: [], ...REST, products: [{ id: 'p1' }, { id: 'p2' }] });
    expect(r).toMatchObject({ status: 'CLEAN', completeness: 'COMPLETE', dataReadiness: 'READY', releaseReadiness: 'NOT_ASSESSED_BY_THIS_TOOL', skippedChecks: [] });
  });
  it('a non-array catalogue is treated as NOT supplied (never as "all products known")', () => {
    const r = reconcile({ orders: [O('a', 'Submitted', [line('p1')])], invoices: [], ...REST, products: { id: 'p1' } });
    expect(r.skippedChecks.map(c => c.input)).toEqual(['products']);
  });
  it('malformed and oversized legacy records are still reported alongside the catalogue check', () => {
    const many = Array.from({ length: 13 }, (_, i) => line('p1', 1, 10 + i));
    const r = reconcile({ orders: [O('big', 'Submitted', many), O('neg', 'Submitted', [{ ...line('p1'), qty: -1, total: -100 }])], invoices: [], ...REST, products: [{ id: 'p1' }] });
    expect(r.preflight.oversizedOrders).toEqual(['big']); expect(r.preflight.invalidOrders).toEqual(expect.arrayContaining(['big', 'neg']));
    expect(r.dataReadiness).toBe('BLOCKED');
  });
});

describe('RC6-P2 migration planner: missing inputs are never CLEAN', () => {
  const base = { orders: [O('a', 'Submitted', [line('p1')])], invoices: [], invoiceNumbers: [], counter: { prefix: 'NF-INV', counter: 1 }, cancellations: [], scheduleConfig: { startedAt: 1 } };
  it('FAILS ON RC5: no catalogue -> INCOMPLETE naming products', () => {
    const p = planMigration(base); expect(p.assessment).toBe('INCOMPLETE'); expect(p.missingInputs).toContain('products');
  });
  it('a missing export file is INCOMPLETE too', () => {
    expect(planMigration({ ...base, products: [{ id: 'p1' }], missingInputs: ['orders.json'] }).assessment).toBe('INCOMPLETE');
  });
  it('empty catalogue + open order with a product line -> BLOCKED with UNKNOWN_PRODUCT', () => {
    const p = planMigration({ ...base, products: [] }); expect(p.assessment).toBe('BLOCKED'); expect(p.report.some(r => r.type === 'UNKNOWN_PRODUCT' && r.open)).toBe(true);
  });
  it('CONTROL: complete and valid -> CLEAN', () => { expect(planMigration({ ...base, products: [{ id: 'p1' }] }).assessment).toBe('CLEAN'); });
});

describe('RC6-P2 CLI behaviour and exit codes (reconcile.mjs and migrate-rc3.mjs --files)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cat-'));
  const w = (n, v) => { fs.writeFileSync(path.join(d, n), JSON.stringify(v)); return path.join(d, n); };
  const files = {
    o: w('orders.json', [O('a', 'Submitted', [line('p1')])]), i: w('invoices.json', []),
    st: w('stock.json', []), ca: w('canc.json', []), nu: w('nums.json', []), co: w('counter.json', { prefix: 'NF-INV', counter: 1 }),
    cu: w('cust.json', []), sc: w('sched.json', []), hi: w('hist.json', { startedAt: 1 }),
    pOk: w('pOk.json', [{ id: 'p1' }]), pEmpty: w('pEmpty.json', []), pBad: w('pBad.json', { id: 'p1' }),
  };
  const run = (extra) => spawnSync('node', [path.join(root, 'tools/reconcile.mjs'), files.o, files.i, '--stock', files.st, '--cancellations', files.ca, '--numbers', files.nu, '--counter', files.co, '--customers', files.cu, '--schedule', files.sc, '--history', files.hi, ...extra], { encoding: 'utf8' });
  it('without --products: exit 3, INCOMPLETE, the skipped check names --products', () => {
    const r = run([]); expect(r.status).toBe(3); expect(r.stdout).toMatch(/INCOMPLETE/); expect(r.stdout).toMatch(/--products/); expect(r.stdout).not.toMatch(/All checks ran/);
  });
  it('with a valid catalogue: exit 0, all checks ran', () => { const r = run(['--products', files.pOk]); expect(r.status).toBe(0); expect(r.stdout).toMatch(/All checks ran/); });
  it('with an empty catalogue: exit 1 and UNKNOWN_PRODUCT is printed', () => { const r = run(['--products', files.pEmpty]); expect(r.status).toBe(1); expect(r.stdout).toMatch(/UNKNOWN_PRODUCT/); });
  it('with a non-array catalogue file: exit 2 and an explanation', () => { const r = run(['--products', files.pBad]); expect(r.status).toBe(2); expect(r.stderr).toMatch(/JSON array/); });
  it('migrate-rc3 --files without products.json: INCOMPLETE is printed; with it: CLEAN plus the not-release-approval notice', () => {
    for (const [n, v] of [['orders', [O('a', 'Submitted', [line('p1')])]], ['invoices', []], ['invoiceNumbers', []], ['orderCancellations', []], ['counter', { prefix: 'NF-INV', counter: 1 }], ['scheduleHistory', { startedAt: 1 }]]) w(n + '.json', v);
    const mig = () => spawnSync('node', [path.join(root, 'tools/migrate-rc3.mjs'), '--files', d], { encoding: 'utf8' });
    const a = mig(); expect(a.stdout).toMatch(/ASSESSMENT: INCOMPLETE/); expect(a.stdout).toMatch(/products/);
    w('products.json', [{ id: 'p1' }]);
    const b = mig(); expect(b.stdout).toMatch(/ASSESSMENT: CLEAN/); expect(b.stdout).toMatch(/NOT release approval/);
  });
});
