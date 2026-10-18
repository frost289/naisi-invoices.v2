// RC6 priority 1: the stuck-Invoicing classifier must never call an order safe to release while ANY invoice, pointer, registry entry or look-alike exists.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { F, line, seedOrder, seedProduct, invoices, seedCounter, meta, withId } from './_util.js';
const { classifyStuckInvoicing: classify } = await import('../../tools/stuck-invoicing-logic.js');
const orders = await import('../../src/orders.js');
const root = path.resolve(process.cwd(), '..');   // tests are run from the tests/ folder
const FZ = '2026-10-19T05:30:00Z', EX = '2026-10-19T05:40:00Z';
const items = [{ productId: 'p1', desc: 'Amanda 100g', qty: 2, price: 100, total: 200 }];
const O = (over = {}) => ({ id: 'o1', orderNo: 'ORD-1', status: 'Invoicing', customerName: 'Shop', items, grandTotal: 200, invoicingAttempt: 't', ...over });
const I = (id, over = {}) => ({ id, invoiceNo: 'N-' + id, customer: 'Shop', items, grandTotal: 200, ...over });
const run = (orders, invoices, invoiceNumbers, extra = {}) => classify({ orders, invoices, invoiceNumbers, frozenAt: FZ, exportedAt: EX, ...extra });
const v = (r) => r.orders[0].verdict;

describe('RC6-P1 scenarios (1-6)', () => {
  it('1. FAILS ON RC5: Invoicing order explicitly pointing (order.invoiceId) to an existing LEGACY invoice with a registered number -> ALREADY_INVOICED, never SAFE', () => {
    const r = run([O({ invoiceId: 'legacy1', invoiceNo: 'N-legacy1' })], [I('legacy1')], [{ id: 'N-legacy1', invoiceId: 'legacy1' }]);
    expect(v(r)).toBe('ALREADY_INVOICED'); expect(r.orders[0].associatedInvoices.join(' ')).toMatch(/order.invoiceId/);
  });
  it('1b. order.invoiceNo only (no invoiceId) pointing at a legacy invoice -> not SAFE', () => {
    const r = run([O({ invoiceNo: 'N-legacy1' })], [I('legacy1')], [{ id: 'N-legacy1', invoiceId: 'legacy1' }]);
    expect(v(r)).not.toBe('SAFE_TO_RELEASE'); expect(r.orders[0].associatedInvoices.length).toBe(1);
  });
  it('2. FAILS ON RC5: no link, but a matching unlinked legacy invoice (same customer, items, total) -> NEEDS_REVIEW as a POSSIBLE orphan, not linked, not safe', () => {
    const r = run([O()], [I('legacy1')], [{ id: 'N-legacy1', invoiceId: 'legacy1' }]);
    expect(v(r)).toBe('NEEDS_REVIEW'); expect(r.orders[0].possibleOrphans).toEqual(['legacy1']);
    expect(r.orders[0].reasons.join(' ')).toMatch(/NOT proof/); expect(r.orders[0].manualSteps.join(' ')).toMatch(/never links or releases/);
  });
  it('2b. a look-alike with a DIFFERENT total or items is not flagged as an orphan (and the clean attempt stays safe)', () => {
    expect(v(run([O()], [I('x', { grandTotal: 300, items: [{ ...items[0], qty: 3, total: 300 }] })], []))).toBe('SAFE_TO_RELEASE');
  });
  it('3. FAILS ON RC5: a registered number pointing to a missing invoice -> NEEDS_REVIEW (both for ord_ and for a legacy id the order names)', () => {
    expect(v(run([O()], [], [{ id: 'N-9', invoiceId: 'ord_o1' }]))).toBe('NEEDS_REVIEW');
    const r = run([O({ invoiceId: 'legacy9', invoiceNo: 'N-9' })], [], [{ id: 'N-9', invoiceId: 'legacy9' }]);
    expect(v(r)).toBe('NEEDS_REVIEW'); expect(r.orders[0].reasons.join(' ')).toMatch(/does not exist|missing/);
  });
  it('4. conflicting links / multiple invoices -> NEEDS_REVIEW', () => {
    expect(v(run([O()], [I('ord_o1', { orderId: 'o1' }), I('legacy1', { orderId: 'o1' })], []))).toBe('NEEDS_REVIEW');           // two invoices for one order
    expect(v(run([O({ invoiceId: 'a' })], [I('a'), I('ord_o1', { orderId: 'o1' })], []))).toBe('NEEDS_REVIEW');                  // order.invoiceId disagrees with the deterministic invoice
    expect(v(run([O({ invoiceId: 'a' }), O({ id: 'o2', invoiceId: 'a' })], [I('a')], []))).toBe('NEEDS_REVIEW');                  // two orders claim one invoice
    expect(v(run([O({ invoiceNo: 'N-a' })], [I('a', { orderId: 'someone-else' })], [{ id: 'N-a', invoiceId: 'a' }]))).toBe('NEEDS_REVIEW');   // invoice says another order
    expect(v(run([O()], [I('ord_o1', { orderId: 'o1', invoiceNo: 'N-1' })], [{ id: 'N-1', invoiceId: 'other' }]))).toBe('NEEDS_REVIEW');      // registry points elsewhere
  });
  it('5. incomplete inputs never produce a safety claim (each missing/malformed input, in isolation)', () => {
    const ok = { orders: [O()], invoices: [], invoiceNumbers: [] };
    for (const bad of [{ invoices: undefined }, { invoices: null }, { invoiceNumbers: undefined }, { invoiceNumbers: 'x' }, { orders: undefined }, { invoices: [{ noId: 1 }] }]) {
      const r = classify({ ...ok, ...bad, frozenAt: FZ, exportedAt: EX });
      expect(r.inputsComplete).toBe(false); expect(r.summary.safe).toBe(0);
      expect(r.orders.every(x => x.verdict === 'INPUTS_INCOMPLETE')).toBe(true);
    }
  });
  it('6. CONTROL: a genuinely clean interrupted attempt (all inputs, post-freeze export, no invoice, no pointer, no registry, no look-alike) -> SAFE_TO_RELEASE with manual steps', () => {
    const r = run([O(), O({ id: 'o2', status: 'Approved' })], [I('other', { customer: 'Someone Else' })], [{ id: 'N-other', invoiceId: 'other' }]);
    expect(r.orders).toHaveLength(1); expect(v(r)).toBe('SAFE_TO_RELEASE');
    expect(r.orders[0].manualSteps.join(' ')).toMatch(/status = "Approved"/);
  });
});

describe('RC6-P1 freeze confirmation', () => {
  it('a clean attempt WITHOUT a stated freeze, or with an export taken BEFORE the freeze, is never SAFE_TO_RELEASE', () => {
    for (const t of [{ frozenAt: null, exportedAt: null }, { frozenAt: FZ, exportedAt: '2026-10-19T05:00:00Z' }, { frozenAt: 'garbage', exportedAt: EX }]) {
      const r = classify({ orders: [O()], invoices: [], invoiceNumbers: [], ...t });
      expect(r.freezeConfirmed).toBe(false); expect(v(r)).toBe('NEEDS_REVIEW'); expect(r.orders[0].reasons.join(' ')).toMatch(/freeze/i);
    }
  });
  it('CLI exit codes: 0 nothing stuck + confirmed freeze; 1 something stuck; 3 incomplete or freeze unconfirmed; 2 bad file', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'));
    const w = (n, x) => { fs.writeFileSync(path.join(d, n), JSON.stringify(x)); return path.join(d, n); };
    const f = { o: w('o.json', [O()]), i: w('i.json', []), n: w('n.json', []), none: w('none.json', []) };
    const cli = (args) => spawnSync('node', [path.join(root, 'tools/stuck-invoicing.mjs'), ...args], { encoding: 'utf8' });
    const fz = ['--frozen-at', FZ, '--exported-at', EX];
    let r = cli([f.o, f.i, f.n, ...fz]); expect(r.status).toBe(1); expect(r.stdout).toMatch(/SAFE_TO_RELEASE/);
    r = cli([f.o, f.i, f.n]); expect(r.status).toBe(1); expect(r.stdout).toMatch(/NEEDS_REVIEW/); expect(r.stdout).not.toMatch(/\[SAFE_TO_RELEASE\]/);
    r = cli([f.none, f.i, f.n]); expect(r.status).toBe(3);
    r = cli([f.none, f.i, f.n, ...fz]); expect(r.status).toBe(0);
    r = cli([f.o, path.join(d, 'missing.json'), f.n, ...fz]); expect(r.status).toBe(2);
    fs.writeFileSync(path.join(d, 'bad.json'), '{not json'); r = cli([f.o, path.join(d, 'bad.json'), f.n, ...fz]); expect(r.status).toBe(2);
    r = cli([f.o, f.i]); expect(r.status).toBe(2);
    const before = fs.readFileSync(f.o, 'utf8'); cli([f.o, f.i, f.n, ...fz]); expect(fs.readFileSync(f.o, 'utf8')).toBe(before);   // read-only
  });
});

describe('RC6-P1 the duplicate-invoice consequence (isolated test data, in-memory backend)', () => {
  beforeEach(() => { F.reset(); F.setClock(1_800_000_000_000); seedCounter(370); seedProduct(100); });
  const exportAll = () => {
    const pick = (pre) => [...F.store].filter(([p]) => p.startsWith(pre + '/')).map(([p, d]) => ({ id: p.slice(pre.length + 1), ...d }));
    return { orders: pick('orders'), invoices: pick('invoices'), invoiceNumbers: pick('invoiceNumbers') };
  };
  // a legacy interrupted attempt: the invoice was written, the order was never linked and stayed in Invoicing
  const seedLegacyInterruption = () => {
    seedOrder('o1', 'Invoicing', { invoicingAttempt: 'old', customerName: 'Shop', items, grandTotal: 200 });
    F.store.set('invoices/legacy1', { invoiceNo: 'NF-INV-2026-0369', customer: 'Shop', items, grandTotal: 200, date: '2026-10-15' });
  };
  it('what the RC5 recommendation would have caused: releasing the order lets the app issue a SECOND invoice for the same sale (documented consequence)', async () => {
    seedLegacyInterruption();
    F.store.set('orders/o1', { ...F.store.get('orders/o1'), status: 'Approved', invoicingAttempt: null, invoicingLeaseStartedAt: null });   // the RC5 "SAFE_TO_RELEASE" manual step
    await orders.issueInvoiceForOrder({ orderId: 'o1', meta: meta(items), uid: 'u1' });
    expect(invoices()).toHaveLength(2);                                                                                                         // legacy1 + ord_o1: duplicate invoice for one order
  });
  it('RC6 workflow: the classifier blocks that recommendation, so the unsafe release is not offered and no duplicate arises', async () => {
    seedLegacyInterruption();
    const r = classify({ ...exportAll(), frozenAt: FZ, exportedAt: EX });
    expect(r.orders[0].verdict).toBe('NEEDS_REVIEW'); expect(r.orders[0].possibleOrphans).toEqual(['legacy1']);
    expect(r.summary.safe).toBe(0);
    // following the tool: nothing is released. The app itself still refuses to start a second attempt:
    await expect(orders.issueInvoiceForOrder({ orderId: 'o1', meta: meta(items), uid: 'u1' })).rejects.toThrow();
    expect(invoices()).toHaveLength(1); expect(withId('o1').status).toBe('Invoicing');
  });
  it('POSITIVE CONTROL: a truly clean interrupted attempt is SAFE_TO_RELEASE and, after the manual release, invoicing works once', async () => {
    seedOrder('o1', 'Invoicing', { invoicingAttempt: 'old', customerName: 'Shop', items, grandTotal: 200 });
    const r = classify({ ...exportAll(), frozenAt: FZ, exportedAt: EX });
    expect(r.orders[0].verdict).toBe('SAFE_TO_RELEASE');
    F.store.set('orders/o1', { ...F.store.get('orders/o1'), status: 'Approved', invoicingAttempt: null, invoicingLeaseStartedAt: null });
    await orders.issueInvoiceForOrder({ orderId: 'o1', meta: meta(items), uid: 'u1' });
    expect(invoices()).toHaveLength(1);
  });
});
