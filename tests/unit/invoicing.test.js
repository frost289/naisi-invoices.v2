import { describe, it, expect, beforeEach } from 'vitest';
import { F, user, line, seedOrder, withId, invoices, seedCounter, meta, isInvoiceWrite } from './_util.js';
const o = await import('../../src/orders.js');
const { orderRevisionKey } = await import('../../src/orderRevision.js');
const T0 = 1_800_000_000_000;
beforeEach(() => { F.reset(); F.setClock(T0); seedCounter(370); });
const order = (id = 'o1', over = {}) => seedOrder(id, 'Approved', over);

describe('single invoice per order', () => {
  it('issues one invoice, links the order, advances the counter once', async () => {
    order();
    const r = await o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' });
    expect(r.invoiceNo).toMatch(/0370$/);
    expect(invoices()).toHaveLength(1);
    expect(invoices()[0].path).toBe('invoices/ord_o1');
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Invoiced', invoiceId: 'ord_o1', invoicingAttempt: null });
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('re-running an invoiced order is refused with alreadyInvoiced', async () => {
    order(); await o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' });
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })).rejects.toMatchObject({ alreadyInvoiced: true });
    expect(invoices()).toHaveLength(1);
  });
  it('two tabs at once: one invoice', async () => {
    order();
    const r = await Promise.allSettled([1, 2].map(() => o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })));
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('nine orders get nine consecutive numbers, one each', async () => {
    for (let i = 1; i <= 9; i++) order('o' + i);
    const nos = [];
    for (let i = 1; i <= 9; i++) nos.push((await o.issueInvoiceForOrder({ orderId: 'o' + i, meta: meta(), uid: 'u1' })).invoiceNo);
    expect(new Set(nos).size).toBe(9);
    expect(invoices()).toHaveLength(9);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(379);
  });
});

describe('failure AT the invoice commit (after the lock was taken)', () => {
  it('nothing saved, number not consumed, lock released by its owner, retry works', async () => {
    order();
    let failed = 0;
    F.hooks.failCommit = (writes) => (isInvoiceWrite(writes) && failed++ === 0 ? new Error('network drop') : null);
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })).rejects.toThrow('network drop');
    expect(failed).toBe(1);                           // the failure really hit the invoice commit
    expect(invoices()).toHaveLength(0);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(370);
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Approved', invoicingAttempt: null });
    await o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' });
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('lost acknowledgement (commit applied, error thrown): revert is a no-op; retry says already invoiced', async () => {
    order();
    F.hooks.failAfterCommit = (writes) => (isInvoiceWrite(writes) ? new Error('ack lost') : null);
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })).rejects.toThrow('ack lost');
    expect(F.store.get('orders/o1').status).toBe('Invoiced');
    expect(invoices()).toHaveLength(1);
    F.hooks.failAfterCommit = null;
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })).rejects.toMatchObject({ alreadyInvoiced: true });
    expect(invoices()).toHaveLength(1);
  });
});

describe('contention / retries', () => {
  it('a competing write between read and commit makes the transaction re-run, and the result is still one invoice', async () => {
    order();
    const { attemptToken } = await o.beginInvoiceGeneration('o1');
    let bumped = false;
    F.hooks.beforeCommit = async ({ writes }) => {
      if (!bumped && isInvoiceWrite(writes)) {   // another client takes number 370 after we read the counter
        bumped = true;
        await F.setDoc(F.doc({}, 'counters', 'naisiInvoice'), { prefix: 'NF-INV', counter: 371 });
      }
    };
    const before = F.stats.txAttempts;
    const r = await o.commitInvoice({ orderId: 'o1', attemptToken, meta: meta(), uid: 'u1' });
    expect(F.stats.txAttempts - before).toBe(2);      // first run conflicted, second run committed
    expect(r.invoiceNo).toMatch(/0371$/);             // re-read the new counter, no duplicate number
    expect(F.store.get('counters/naisiInvoice').counter).toBe(372);
    expect(invoices()).toHaveLength(1);
  });
});

describe('lock ownership and lease', () => {
  it('resume is OFF by default: an Invoicing order is never taken over', async () => {
    order();
    await o.beginInvoiceGeneration('o1');
    F.setClock(T0 + 3_600_000);
    await expect(o.beginInvoiceGeneration('o1')).rejects.toMatchObject({ code: 'invoicing-in-progress' });
  });
  it('resume enabled: not before the lease, yes after; the old attempt can no longer commit or release', async () => {
    order();
    const a = await o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() });
    F.setClock(T0 + 60_000);
    await expect(o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() })).rejects.toMatchObject({ code: 'invoicing-in-progress' });
    F.setClock(T0 + o.INVOICING_LEASE_MS + 1);
    const b = await o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() });
    expect(b.attemptToken).not.toBe(a.attemptToken);
    // A (stale) tries to commit and to release:
    await expect(o.commitInvoice({ orderId: 'o1', attemptToken: a.attemptToken, meta: meta(), uid: 'u1' })).rejects.toMatchObject({ code: 'lock-lost' });
    await o.revertInvoiceGeneration('o1', a.attemptToken);
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Invoicing', invoicingAttempt: b.attemptToken });
    // B commits fine, exactly one invoice:
    await o.commitInvoice({ orderId: 'o1', attemptToken: b.attemptToken, meta: meta(), uid: 'u1' });
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('orders/o1').status).toBe('Invoiced');
  });
  it('A commits while B holds the lock: rejected, no duplicate', async () => {
    order();
    const a = await o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() });
    F.setClock(T0 + o.INVOICING_LEASE_MS + 1);
    const b = await o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() });
    await expect(o.commitInvoice({ orderId: 'o1', attemptToken: a.attemptToken, meta: meta(), uid: 'u1' })).rejects.toMatchObject({ code: 'lock-lost' });
    expect(invoices()).toHaveLength(0);
    expect(F.store.get('orders/o1').invoicingAttempt).toBe(b.attemptToken);
  });
  it('RC4: ending an attempt writes its token (invoicingAttemptEnded) so the rules can check ownership', async () => {
    order();
    const a = await o.beginInvoiceGeneration('o1');
    await o.revertInvoiceGeneration('o1', a.attemptToken);
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Approved', invoicingAttempt: null, invoicingAttemptEnded: a.attemptToken });
    const b = await o.beginInvoiceGeneration('o1');
    await o.commitInvoice({ orderId: 'o1', attemptToken: b.attemptToken, meta: meta(), uid: 'u1' });
    expect(F.store.get('orders/o1')).toMatchObject({ status: 'Invoiced', invoicingAttemptEnded: b.attemptToken });
  });
  it('revert releases only a lock that is still ours', async () => {
    order();
    const a = await o.beginInvoiceGeneration('o1');
    await o.revertInvoiceGeneration('o1', 'someone-elses-token');
    expect(F.store.get('orders/o1').status).toBe('Invoicing');
    await o.revertInvoiceGeneration('o1', null);
    expect(F.store.get('orders/o1').status).toBe('Invoicing');
    await o.revertInvoiceGeneration('o1', a.attemptToken);
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
  it('lease start in the FUTURE (clock skew) is not treated as expired', () => {
    expect(o.isLeaseExpired(F.ts(T0 + 3_600_000), o.INVOICING_LEASE_MS, T0)).toBe(false);
    expect(o.isLeaseExpired(F.ts(T0), o.INVOICING_LEASE_MS, T0 + o.INVOICING_LEASE_MS)).toBe(false);
    expect(o.isLeaseExpired(F.ts(T0), o.INVOICING_LEASE_MS, T0 + o.INVOICING_LEASE_MS + 1)).toBe(true);
  });
  it('missing/unreadable lease timestamp is never expired', () => {
    expect(o.isLeaseExpired(null, 1, T0)).toBe(false);
    expect(o.isLeaseExpired(undefined, 1, T0)).toBe(false);
    expect(o.isLeaseExpired({}, 1, T0)).toBe(false);
  });
  it('legacy lock without a token (older app version) is NOT resumable even with resume on', async () => {
    seedOrder('o1', 'Invoicing', { invoicingLeaseStartedAt: F.ts(T0 - 99_999_999) });
    await expect(o.beginInvoiceGeneration('o1', { resume: true, now: () => F.now() })).rejects.toMatchObject({ code: 'invoicing-in-progress' });
  });
  it('INVOICING_RESUME_ENABLED ships false', () => { expect(o.INVOICING_RESUME_ENABLED).toBe(false); });
});

describe('durable order -> invoice identity', () => {
  it('a pre-existing invoice doc ord_<id> blocks a second invoice (invoice-conflict) and consumes no number', async () => {
    order();
    F.store.set('invoices/ord_o1', { invoiceNo: 'NF-INV-0001', orderId: 'o1' });
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), uid: 'u1' })).rejects.toMatchObject({ code: 'invoice-conflict' });
    expect(F.store.get('counters/naisiInvoice').counter).toBe(370);
    expect(F.store.get('orders/o1').status).toBe('Approved');   // lock released
  });
});

describe('stale bulk data', () => {
  it('order edited after the list was loaded: invoice refused (order-changed), nothing saved', async () => {
    order('o1', { items: [line(2)] });
    const cachedRevision = orderRevisionKey(withId('o1'));
    F.store.set('orders/o1', { ...F.store.get('orders/o1'), items: [line(9)] });
    await expect(o.issueInvoiceForOrder({ orderId: 'o1', meta: meta(), expectedRevision: cachedRevision, uid: 'u1' })).rejects.toMatchObject({ code: 'order-changed' });
    expect(invoices()).toHaveLength(0);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(370);
    expect(F.store.get('orders/o1').status).toBe('Approved');
  });
});

describe('standalone invoice idempotency (explicit identity, owner decision 4)', () => {
  const rid = () => o.newStandaloneRequestId();
  it('retry of the same click after a lost acknowledgement does not create a second invoice or number', async () => {
    const requestId = rid();
    F.hooks.failAfterCommit = (writes) => (isInvoiceWrite(writes) ? new Error('ack lost') : null);
    await expect(o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' })).rejects.toThrow('ack lost');
    F.hooks.failAfterCommit = null;
    const r = await o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' });
    expect(r.alreadySaved).toBe(true);
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('a different click (new request id) makes a new invoice with the next number', async () => {
    await o.issueStandaloneInvoice({ requestId: rid(), meta: meta(), uid: 'u1' });
    await o.issueStandaloneInvoice({ requestId: rid(), meta: meta(), uid: 'u1' });
    expect(invoices()).toHaveLength(2);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(372);
  });
  it('the saved invoice carries kind "standalone", orderId null, its request id and the id sa_<uid>_<requestId>', async () => {
    const requestId = rid();
    const r = await o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' });
    expect(r.invoiceId).toBe(`sa_u1_${requestId}`);
    expect(F.store.get('invoices/' + r.invoiceId)).toMatchObject({ kind: 'standalone', orderId: null, requestId });
  });
  it('double click (two overlapping saves with the same request id) creates one invoice and one number', async () => {
    const requestId = rid();
    await Promise.allSettled([o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' }), o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' })]);
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('a retry with DIFFERENT details is refused (invoice-conflict) and changes nothing', async () => {
    const requestId = rid();
    await o.issueStandaloneInvoice({ requestId, meta: meta(), uid: 'u1' });
    await expect(o.issueStandaloneInvoice({ requestId, meta: meta([line(7)]), uid: 'u1' })).rejects.toMatchObject({ code: 'invoice-conflict' });
    expect(invoices()).toHaveLength(1);
    expect(F.store.get('counters/naisiInvoice').counter).toBe(371);
  });
  it('an id that is not the caller\'s own sa_<uid>_ identity cannot be committed', async () => {
    await expect(o.commitInvoice({ invoiceId: 'auto123', meta: meta(), uid: 'u1' })).rejects.toThrow(/request id/);
    expect(invoices()).toHaveLength(0);
  });
});
