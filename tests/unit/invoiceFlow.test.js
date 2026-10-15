import { describe, it, expect, beforeEach, vi } from 'vitest';
import { F, line, seedOrder, withId, invoices, seedCounter } from './_util.js';
const o = await import('../../src/orders.js');
const { invoiceOrderForBulk } = await import('../../src/invoiceFlow.js');
beforeEach(() => { F.reset(); seedCounter(370); vi.spyOn(console, 'error').mockImplementation(() => {}); });
const run = (id, makePdf) => invoiceOrderForBulk({ order: withId(id), today: '2026-10-15', uid: 'u1', issue: o.issueInvoiceForOrder, makePdf });

describe('PDF failure after a successful save', () => {
  it('reports saved + PDF failed; exactly one invoice; Download PDF never saves another', async () => {
    seedOrder('o1', 'Approved', { items: [line(2)] });
    const makePdf = vi.fn()
      .mockImplementationOnce(() => { throw new Error('jsPDF exploded'); })
      .mockImplementation(() => ({}));
    const res = await run('o1', makePdf);
    expect(res.state).toBe('done');
    expect(res.invoiceNo).toMatch(/0370$/);
    expect(res.text).toMatch(/saved/i); expect(res.text).toMatch(/PDF failed/i);
    expect(typeof res.retryPdf).toBe('function');
    expect(invoices()).toHaveLength(1);
    const counterBefore = F.store.get('counters/naisiInvoice').counter;
    res.retryPdf(); res.retryPdf();
    expect(makePdf).toHaveBeenCalledTimes(3);
    expect(makePdf.mock.calls[1][0].invoiceNo).toBe(res.invoiceNo);   // same saved invoice
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(counterBefore);
  });
  it('success path: no retryPdf', async () => {
    seedOrder('o1', 'Approved');
    const res = await run('o1', () => ({}));
    expect(res).toMatchObject({ state: 'done' }); expect(res.retryPdf).toBeUndefined();
  });
  it('already invoiced -> skipped; changed order -> failed with the reason', async () => {
    seedOrder('o1', 'Approved'); await run('o1', () => ({}));
    expect((await run('o1', () => ({}))).state).toBe('skipped');
    seedOrder('o2', 'Approved', { items: [line(1)] });
    const stale = withId('o2');
    F.store.set('orders/o2', { ...F.store.get('orders/o2'), items: [line(7)] });
    const res = await invoiceOrderForBulk({ order: stale, today: 'd', uid: 'u1', issue: o.issueInvoiceForOrder, makePdf: () => ({}) });
    expect(res.state).toBe('failed'); expect(res.text).toMatch(/changed/i);
    expect(invoices()).toHaveLength(1);
  });
});
