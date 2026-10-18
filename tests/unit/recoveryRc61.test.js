// RC6.1 regressions. These run the actual classifier and invoice flow against the in-memory backend.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { F, seedOrder, seedProduct, seedCounter, invoices, meta } from './_util.js';
import { classifyStuckInvoicing as classify } from '../../tools/stuck-invoicing-logic.js';
import { issueInvoiceForOrder } from '../../src/orders.js';

const FZ = '2026-10-19T05:30:00Z', EX = '2026-10-19T05:40:00Z';
const items = [{ productId: 'p1', desc: 'Amanda', qty: 2, price: 100, total: 200 }];
const order = (extra = {}) => ({ id: 'o1', status: 'Invoicing', customerId: 'c1', customerName: 'Shop', createdAt: '2026-10-15T08:00:00Z', items, grandTotal: 200, ...extra });
const invoice = (extra = {}) => ({ id: 'legacy', invoiceNo: 'NF-INV-2026-0369', customerId: 'c1', customer: 'Shop', date: '2026-10-15', createdAt: '2026-10-15T09:00:00Z', items, grandTotal: 200, ...extra });
const run = (oo = [order()], ii = [], extra = {}) => classify({ orders: oo, invoices: ii, invoiceNumbers: [], frozenAt: FZ, exportedAt: EX, ...extra });
const verdict = r => r.orders[0].verdict;
const evasions = [
  ['renamed customer with same customerId', { customer: 'Shop New Trading Name' }],
  ['discounted total', { grandTotal: 150, items: [{ ...items[0], price: 75, total: 150 }] }],
  ['extra line', { grandTotal: 250, items: [...items, { productId: 'p2', desc: 'Extra', qty: 1, price: 50, total: 50 }] }],
];

describe('RC6.1 P1 conservative orphan detection', () => {
  it.each(evasions)('blocks %s', (_name, extra) => {
    const r = run([order()], [invoice(extra)]);
    expect(verdict(r)).toBe('NEEDS_REVIEW');
    expect(r.orders[0].possibleOrphans).toEqual(['legacy']);
    expect(r.summary.safe).toBe(0);
  });
  it('normalises names and considers containment when an id is unavailable, regardless of lines/total', () => {
    const r = run([order({ customerId: null, customerName: '  Shop   Stores ' })], [invoice({ customerId: null, customer: 'SHOP STORES LIMITED', items: [], grandTotal: 999 })]);
    expect(verdict(r)).toBe('NEEDS_REVIEW');
  });
  it('flags a shared product even when customer ids and names differ', () => {
    expect(verdict(run([order()], [invoice({ customerId: 'c2', customer: 'Other shop', grandTotal: 999 })]))).toBe('NEEDS_REVIEW');
  });
  it('CONTROL: invoice dated before the order is not a candidate', () => {
    expect(verdict(run([order()], [invoice({ createdAt: '2026-10-14T09:00:00Z', date: '2026-10-14' })]))).toBe('SAFE_TO_RELEASE');
  });
  it('CONTROL: an invoice claimed by another order is not an orphan candidate', () => {
    expect(verdict(run([order(), order({ id: 'o2', status: 'Invoiced', invoiceId: 'legacy' })], [invoice()]))).toBe('SAFE_TO_RELEASE');
  });
  it('CONTROL: an entirely different customer and products stays safe', () => {
    expect(verdict(run([order()], [invoice({ customerId: 'c2', customer: 'Other shop', items: [{ productId: 'different' }], grandTotal: 999 })]))).toBe('SAFE_TO_RELEASE');
  });
  it('CONTROL: a genuinely clean attempt stays safe', () => { expect(verdict(run())).toBe('SAFE_TO_RELEASE'); });
  it('missing creation date cannot rule out a plausible orphan', () => {
    expect(verdict(run([order({ createdAt: undefined })], [invoice({ customer: 'Renamed', grandTotal: 123 })]))).toBe('NEEDS_REVIEW');
  });
  it('a second plausible unclaimed invoice blocks completion even if one invoice is already linked', () => {
    const r = run([order({ invoiceId: 'linked', invoiceNo: 'N-linked' })], [invoice({ id: 'linked', invoiceNo: 'N-linked' }), invoice({ customer: 'Renamed', grandTotal: 123 })], { invoiceNumbers: [{ id: 'N-linked', invoiceId: 'linked' }] });
    expect(verdict(r)).toBe('NEEDS_REVIEW'); expect(r.orders[0].possibleOrphans).toEqual(['legacy']);
  });
});

describe('RC6.1 P1 duplicate consequence and prevention', () => {
  beforeEach(() => { F.reset(); F.setClock(1_800_000_000_000); seedCounter(370); seedProduct(100); });
  const seed = extra => {
    const { id, ...o } = order({ invoicingAttempt: 'old' }); seedOrder(id, 'Invoicing', o);
    const { id: iid, ...i } = invoice(extra); F.store.set('invoices/' + iid, i);
  };
  it.each(evasions)('a manual release followed by issueInvoiceForOrder duplicates the invoice for %s (consequence control)', async (_name, extra) => {
    seed(extra);
    F.store.set('orders/o1', { ...F.store.get('orders/o1'), status: 'Approved', invoicingAttempt: null, invoicingLeaseStartedAt: null });
    await issueInvoiceForOrder({ orderId: 'o1', meta: meta(items), uid: 'u1' });
    expect(invoices()).toHaveLength(2);
  });
  it.each(evasions)('the revised classifier prevents the duplicate for %s', async (_name, extra) => {
    seed(extra);
    const r = run([{ id: 'o1', ...F.store.get('orders/o1') }], [{ id: 'legacy', ...F.store.get('invoices/legacy') }]);
    expect(verdict(r)).toBe('NEEDS_REVIEW'); expect(r.summary.safe).toBe(0);
    await expect(issueInvoiceForOrder({ orderId: 'o1', meta: meta(items), uid: 'u1' })).rejects.toThrow();
    expect(invoices()).toHaveLength(1);
  });
});

describe('RC6.1 P2 explicit and consistent freeze timestamps', () => {
  it.each([
    { frozenAt: '2026-10-19T05:30:00' },
    { exportedAt: '2026-10-19T05:40:00' },
    { frozenAt: '19 October 2026 05:30 UTC' },
    { frozenAt: '2026-10-19' },
    { frozenAt: '2026-02-30T05:30:00Z' },
  ])('rejects ambiguous or non-ISO stated times: %j', extra => {
    const r = run([order()], [], extra);
    expect(r.freezeConfirmed).toBe(false); expect(verdict(r)).toBe('NEEDS_REVIEW');
    expect(r.freezeNote).toMatch(/explicit.*(offset|zone)|ISO 8601/i);
  });
  it('CONTROL: explicit positive and negative offsets are accepted', () => {
    expect(run([order()], [], { frozenAt: '2026-10-19T07:30:00+02:00', exportedAt: '2026-10-19T00:40:00-05:00' }).freezeConfirmed).toBe(true);
  });
  it.each(['createdAt', 'updatedAt', 'approvedAt'])('rejects an exported document with %s later than exportedAt', field => {
    const r = run([order({ [field]: '2026-10-19T05:41:00Z' })]);
    expect(r.freezeConfirmed).toBe(false); expect(r.freezeNote).toMatch(/after.*export/i);
    expect(r.summary.safe).toBe(0);
  });
  it('checks timestamps in invoices and number-registry documents as well as orders', () => {
    for (const extra of [
      { invoices: [invoice({ updatedAt: '2026-10-19T05:41:00Z' })] },
      { invoiceNumbers: [{ id: 'N1', createdAt: '2026-10-19T05:41:00Z' }] },
    ]) expect(run([order()], [], extra).freezeConfirmed).toBe(false);
  });
  it('checks additional manifest collections and accepts plain JSON Firestore timestamps', () => {
    const secs = text => ({ seconds: Date.parse(text) / 1000, nanoseconds: 0 });
    expect(run([order({ updatedAt: secs('2026-10-19T05:29:00Z') })]).freezeConfirmed).toBe(true);
    const r = run([order()], [], { exportCollections: { customers: [{ id: 'c1', updatedAt: secs('2026-10-19T05:41:00Z') }] } });
    expect(r.freezeConfirmed).toBe(false); expect(r.freezeNote).toContain('customers/c1');
  });
  it('rejects a document timestamp later than freeze plus the named tolerance even if before the export', () => {
    const r = run([order({ updatedAt: '2026-10-19T05:31:00Z' })]);
    expect(r.freezeConfirmed).toBe(false); expect(r.freezeNote).toMatch(/tolerance/i);
  });
  it('rejects a malformed timestamp in an otherwise well-formed export', () => {
    const r = run([order({ approvedAt: 'not-a-timestamp' })]);
    expect(r.freezeConfirmed).toBe(false); expect(r.freezeNote).toMatch(/approvedAt|timestamp/i);
  });
  it('CONTROL: pre-freeze document timestamps are consistent, and the output states the tool cannot verify the freeze itself', () => {
    const r = run([order({ updatedAt: '2026-10-19T05:29:59Z' })]);
    expect(r.freezeConfirmed).toBe(true); expect(verdict(r)).toBe('SAFE_TO_RELEASE');
    expect(r.freezeNote).toMatch(/cannot verify.*freeze/i); expect(r.freezeNote).toMatch(/consistent/i);
  });
});

describe('RC6.1 P3 ALREADY_INVOICED output', () => {
  it('contains the exact completion checks and steps, never an Approved/release instruction, and remains read-only', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rc61-recovery-'));
    try {
      const data = [[order({ invoiceId: 'legacy', invoiceNo: 'NF-INV-2026-0369' })], [invoice()], [{ id: 'NF-INV-2026-0369', invoiceId: 'legacy' }]];
      const files = data.map((value, i) => { const p = path.join(d, i + '.json'); fs.writeFileSync(p, JSON.stringify(value)); return p; });
      const before = files.map(p => fs.readFileSync(p, 'utf8'));
      const cli = path.resolve(process.cwd(), '../tools/stuck-invoicing.mjs');
      // Execute the actual CLI in process so sandbox child-process restrictions do not hide its output.
      const saved = { argv: process.argv, exit: process.exit, log: console.log, error: console.error };
      const r = { stdout: '', status: null };
      const exit = {};
      try {
        process.argv = [process.execPath, cli, ...files, '--frozen-at', FZ, '--exported-at', EX];
        process.exit = code => { r.status = code; throw exit; };
        console.log = (...values) => { r.stdout += values.join(' ') + '\n'; };
        console.error = (...values) => { r.stdout += values.join(' ') + '\n'; };
        try { await import(pathToFileURL(cli).href + '?rc61-already-output'); } catch (error) { if (error !== exit) throw error; }
      } finally {
        process.argv = saved.argv; process.exit = saved.exit; console.log = saved.log; console.error = saved.error;
      }
      expect(r.status).toBe(1); expect(r.stdout).toMatch(/ALREADY_INVOICED/);
      for (const text of ['invoiceNumbers', 'counters/naisiInvoice', 'status = "Invoiced"', 'invoiceId', 'invoiceNo', 'invoicingAttempt', 'invoicingLeaseStartedAt', 'audit', 're-run', 'RC6.1-OPERATIONS-PLAN']) expect(r.stdout).toContain(text);
      expect(r.stdout).not.toMatch(/status = "Approved"|release the lock/i);
      expect(files.map(p => fs.readFileSync(p, 'utf8'))).toEqual(before);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});
