// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
const { runBulkJob } = await import('../../src/bulkProgress.js');

const orders = (n, prefix = 'o') => Array.from({ length: n }, (_, i) => ({ id: prefix + (i + 1), orderNo: 'ORD-' + (i + 1), customerName: 'C' + i, grandTotal: 100 }));
const tick = () => new Promise(r => setTimeout(r, 0));
const $ = (id) => document.getElementById(id);
let confirmSpy;
beforeEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true); });
async function finish(job) { await tick(); $('bpCloseBtn').click(); return await job; }

describe('bulk progress window', () => {
  it('nothing runs until Start; rows are listed first', async () => {
    const runOne = vi.fn(async () => ({ state: 'done', text: 'ok' }));
    const job = runBulkJob({ title: 't', intro: 'i', startLabel: 'Go', orders: orders(3), runOne });
    expect(runOne).not.toHaveBeenCalled();
    expect($('bpBody').querySelectorAll('tr')).toHaveLength(3);
    $('bpStartBtn').click(); await tick(); await tick();
    expect(runOne).toHaveBeenCalledTimes(3);
    const res = await finish(job);
    expect(res.started).toBe(true);
  });
  it('a second job while one is open is rejected and cannot take over the window', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const first = vi.fn(async () => { await gate; return { state: 'done' }; });
    const second = vi.fn(async () => ({ state: 'done' }));
    const job1 = runBulkJob({ title: 'one', intro: '', startLabel: 'Go', orders: orders(2), runOne: first });
    $('bpStartBtn').click(); await tick();
    const res2 = await runBulkJob({ title: 'two', intro: '', startLabel: 'Go', orders: orders(2, 'x'), runOne: second });
    expect(res2).toMatchObject({ started: false, rejected: true });
    expect($('bpTitle').textContent).toBe('one');
    expect(second).not.toHaveBeenCalled();
    release(); await tick(); await tick(); await tick();
    await finish(job1);
    // after closing, a new job is allowed
    const job3 = runBulkJob({ title: 'three', intro: '', startLabel: 'Go', orders: orders(1), runOne: second });
    expect($('bpTitle').textContent).toBe('three');
    $('bpCloseBtn').click(); await job3;
  });
  it('clicking Start repeatedly while running does not re-enter', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const runOne = vi.fn(async () => { await gate; return { state: 'done' }; });
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(2), runOne });
    const start = $('bpStartBtn');
    start.click(); start.click(); start.click(); await tick();
    expect(runOne).toHaveBeenCalledTimes(1);   // first row only, one run loop
    release(); await tick(); await tick(); await tick();
    expect(runOne).toHaveBeenCalledTimes(2);
    await finish(job);
  });
  it('the same order id selected twice is processed once', async () => {
    const runOne = vi.fn(async () => ({ state: 'done' }));
    const list = [...orders(2), ...orders(2)];
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: list, runOne });
    $('bpStartBtn').click(); await tick(); await tick(); await tick();
    expect(runOne).toHaveBeenCalledTimes(2);
    await finish(job);
  });
  it('lockButtons are disabled while open and restored (to their previous state) on close', async () => {
    const a = document.createElement('button'); const b = document.createElement('button'); b.disabled = true;
    document.body.append(a, b);
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(1), runOne: async () => ({ state: 'done' }), lockButtons: [a, b] });
    expect(a.disabled).toBe(true); expect(b.disabled).toBe(true);
    $('bpStartBtn').click(); await tick(); await tick();
    await finish(job);
    expect(a.disabled).toBe(false); expect(b.disabled).toBe(true);
  });
  it('Retry failed re-runs only the failed rows', async () => {
    const calls = {};
    const runOne = async (order) => {
      calls[order.id] = (calls[order.id] || 0) + 1;
      if (order.id === 'o2' && calls.o2 === 1) return { state: 'failed', text: 'boom' };
      return { state: 'done' };
    };
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(3), runOne });
    $('bpStartBtn').click(); await tick(); await tick(); await tick(); await tick();
    expect($('bpRetryBtn').style.display).not.toBe('none');
    expect($('bpSummary').textContent).toMatch(/1 failed/);
    $('bpRetryBtn').click(); await tick(); await tick(); await tick();
    expect(calls).toEqual({ o1: 1, o2: 2, o3: 1 });
    await finish(job);
  });
  it('a thrown error is shown as a failure, not a crash; later rows still run', async () => {
    const runOne = async (order) => { if (order.id === 'o1') throw new Error('kaboom'); return { state: 'done' }; };
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(2), runOne });
    $('bpStartBtn').click(); await tick(); await tick(); await tick();
    const res = await finish(job);
    expect(res.rows.map(r => r.state)).toEqual(['failed', 'done']);
  });
  it('saved-but-no-PDF row offers Download PDF, which calls only the PDF function', async () => {
    const retryPdf = vi.fn();
    const runOne = async () => ({ state: 'done', invoiceNo: 'NF-1', text: 'Invoice saved · PDF failed', retryPdf });
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(1), runOne });
    $('bpStartBtn').click(); await tick(); await tick();
    expect($('bpSummary').textContent).toMatch(/PDF did not download/);
    $('bpBody').querySelector('button[data-pdf]').click();
    expect(retryPdf).toHaveBeenCalledTimes(1);
    expect($('bpBody').querySelector('button[data-pdf]')).toBeNull();
    await finish(job);
  });
  it('close is ignored while running', async () => {
    let release; const gate = new Promise(r => { release = r; });
    const job = runBulkJob({ title: 't', intro: '', startLabel: 'Go', orders: orders(1), runOne: async () => { await gate; return { state: 'done' }; } });
    $('bpStartBtn').click(); await tick();
    $('bpCloseX').dispatchEvent(new Event('click'));
    expect($('bulkProgressModal').style.display).toBe('flex');
    release(); await tick(); await tick();
    await finish(job);
  });
});
