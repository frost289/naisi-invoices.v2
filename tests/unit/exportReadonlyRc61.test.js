import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { format } from 'node:util';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temps = [], servers = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'naisi-export-')); temps.push(d); return d; };
// Execute the actual CLI module in process: this sandbox denies child-process
// creation. Restore every intercepted global in finally; cases run sequentially.
let invocation = 0;
const run = async (script, args = [], env = {}) => {
  const saved = { argv: process.argv, exit: process.exit, log: console.log, error: console.error, token: process.env.FIRESTORE_ACCESS_TOKEN };
  const envBefore = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let code = 0, output = '';
  class CliExit extends Error { constructor(status) { super('CLI exit'); this.status = status; } }
  try {
    process.argv = [process.execPath, resolve(root, 'tools', script), ...args];
    process.env.FIRESTORE_ACCESS_TOKEN = ''; Object.assign(process.env, env);
    process.exit = status => { throw new CliExit(status); };
    console.log = console.error = (...values) => { output += format(...values) + '\n'; };
    await import(`${pathToFileURL(resolve(root, 'tools', script)).href}?regression=${++invocation}`);
  } catch (error) { if (error instanceof CliExit) code = error.status; else { code = 1; output += error.message; } }
  finally {
    process.argv = saved.argv; process.exit = saved.exit; console.log = saved.log; console.error = saved.error;
    if (saved.token === undefined) delete process.env.FIRESTORE_ACCESS_TOKEN; else process.env.FIRESTORE_ACCESS_TOKEN = saved.token;
    for (const [key, value] of Object.entries(envBefore)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  return { code, output };
};
const keys = ['orders', 'invoices', 'invoiceNumbers', 'orderCancellations', 'stockMovements', 'customers', 'products', 'scheduleChanges', 'counter', 'scheduleHistory'];
function fixture() {
  const dir = temp(); const collections = {};
  for (const key of keys) {
    const data = key === 'counter' ? [{ id: 'naisiInvoice', prefix: 'N', counter: 1 }] : key === 'scheduleHistory' ? [{ id: 'scheduleHistory', startedAt: { seconds: 1 } }] : [];
    const raw = JSON.stringify(data); writeFileSync(join(dir, key + '.json'), raw);
    collections[key] = { file: key + '.json', count: data.length, sha256: createHash('sha256').update(raw).digest('hex'), complete: true };
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, complete: true, projectId: 'demo-naisi', startedAt: '2026-10-18T10:00:00Z', endedAt: '2026-10-18T10:01:00Z', collections }));
  return dir;
}
async function server(handler) {
  const s = createServer(handler); servers.push(s);
  await new Promise(done => s.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${s.address().port}`;
}
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done)))); for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('RC6.1 read-only exports and input integrity', () => {
  it('paginates local REST using GET only, decodes timestamps, and records complete counts and file hashes', async () => {
    const requests = [];
    const host = await server((req, res) => {
      requests.push({ method: req.method, url: req.url }); res.setHeader('Content-Type', 'application/json');
      const u = new URL(req.url, 'http://local'); const path = u.pathname.split('/documents/')[1];
      if (path === 'orders') {
        const id = u.searchParams.has('pageToken') ? 'b' : 'a';
        res.end(JSON.stringify({ documents: [{ name: `projects/demo-naisi/databases/(default)/documents/orders/${id}`, fields: { createdAt: { timestampValue: '2026-10-18T10:00:00.123Z' }, qty: { integerValue: '2' } } }], ...(id === 'a' ? { nextPageToken: 'page two&x' } : {}) }));
      } else if (path.includes('/')) { res.statusCode = 404; res.end('{}'); }
      else res.end('{}');
    });
    const dir = temp();
    const result = await run('export-readonly.mjs', ['--project', 'demo-naisi', '--host', host, '--out', dir]);
    expect(result.code, result.output).toBe(0);
    expect(requests.every(r => r.method === 'GET')).toBe(true);
    expect(requests.some(r => r.url.includes('pageToken=page+two%26x'))).toBe(true);
    const orders = JSON.parse(readFileSync(join(dir, 'orders.json'), 'utf8'));
    expect(orders.map(x => x.id)).toEqual(['a', 'b']);
    expect(orders[0].createdAt).toEqual({ seconds: 1792317600, nanoseconds: 123000000 });
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.complete).toBe(true); expect(manifest.projectId).toBe('demo-naisi');
    expect(manifest.collections.orders.count).toBe(2);
    expect(manifest.collections.orders.sha256).toBe(createHash('sha256').update(readFileSync(join(dir, 'orders.json'))).digest('hex'));
    expect(Object.keys(manifest.collections)).toEqual(keys);
    expect(manifest.startedAt).toMatch(/Z$/); expect(manifest.endedAt).toMatch(/Z$/);
  });

  it('refuses a remote host unless both explicit flags confirm the project, without issuing requests', async () => {
    const result = await run('export-readonly.mjs', ['--project', 'demo-naisi', '--host', 'https://firestore.googleapis.com', '--out', temp()]);
    expect(result.code).toBe(2); expect(result.output).toMatch(/allow-remote.*confirm-project/i);
    const mismatch = await run('export-readonly.mjs', ['--project', 'demo-naisi', '--host', 'https://firestore.googleapis.com', '--out', temp(), '--allow-remote', '--confirm-project', 'other-project']);
    expect(mismatch.code).toBe(2); expect(mismatch.output).toMatch(/confirm-project/i);
  });

  it.each(['repeated token', 'duplicate document', 'HTTP failure', 'malformed page'])('fails closed without a complete manifest on %s', async mode => {
    const host = await server((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'HTTP failure') { res.statusCode = 503; res.end('{"error":{"message":"unavailable"}}'); }
      else if (mode === 'malformed page') res.end('{"documents":"truncated"}');
      else { const id = mode === 'repeated token' && req.url.includes('pageToken') ? 'b' : 'a'; res.end(JSON.stringify({ documents: [{ name: `projects/demo-naisi/databases/(default)/documents/orders/${id}`, fields: {} }], nextPageToken: mode === 'repeated token' ? 'repeat' : (req.url.includes('pageToken') ? 'next' : 'first') })); }
    });
    const dir = temp(); const result = await run('export-readonly.mjs', ['--project', 'demo-naisi', '--host', host, '--out', dir]);
    expect(result.code, result.output).toBe(3); expect(result.output).toMatch(/INCOMPLETE/);
    if (mode === 'repeated token') expect(result.output).toMatch(/Repeated pagination token/);
    if (mode === 'duplicate document') expect(result.output).toMatch(/Duplicate document/);
    expect(() => readFileSync(join(dir, 'manifest.json'))).toThrow();
  });

  it.each(['reconcile.mjs', 'migrate-rc3.mjs', 'stuck-invoicing.mjs'])('%s rejects a truncated file against its manifest with exit 3', async script => {
    const dir = fixture(); writeFileSync(join(dir, 'orders.json'), '[{"id":"unexpected"}]');
    const args = script === 'migrate-rc3.mjs' ? ['--files', dir] : [join(dir, 'orders.json'), join(dir, 'invoices.json'), ...(script === 'stuck-invoicing.mjs' ? [join(dir, 'invoiceNumbers.json')] : [])];
    const result = await run(script, [...args, '--manifest', join(dir, 'manifest.json')]);
    expect(result.code, result.output).toBe(3); expect(result.output).toMatch(/INCOMPLETE/); expect(result.output).toMatch(/orders.*(hash|count)/i);
  });

  it('rejects a missing manifest file, missing required export, and wrong document count', async () => {
    for (const change of ['manifest', 'file', 'count']) {
      const dir = fixture();
      if (change === 'manifest') rmSync(join(dir, 'manifest.json'));
      if (change === 'file') rmSync(join(dir, 'products.json'));
      if (change === 'count') { const p = join(dir, 'manifest.json'); const m = JSON.parse(readFileSync(p, 'utf8')); m.collections.orders.count = 2; writeFileSync(p, JSON.stringify(m)); }
      const result = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), '--manifest', join(dir, 'manifest.json')]);
      expect(result.code, `${change}: ${result.output}`).toBe(3); expect(result.output).toMatch(/INCOMPLETE/);
      expect(result.output).toMatch(change === 'manifest' ? /manifest\.json/ : change === 'file' ? /products.*required file products\.json.*missing/ : /orders: document count mismatch/);
    }
  });

  it('accepts verified clean exports in reconcile and migration as a positive control', async () => {
    const dir = fixture();
    const rec = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), '--manifest', join(dir, 'manifest.json')]);
    expect(rec.code, rec.output).toBe(0); expect(rec.output).toMatch(/Status: CLEAN/);
    const mig = await run('migrate-rc3.mjs', ['--files', dir, '--manifest', join(dir, 'manifest.json')]);
    expect(mig.code, mig.output).toBe(0); expect(mig.output).toMatch(/ASSESSMENT: CLEAN/);
    const recovery = await run('stuck-invoicing.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), join(dir, 'invoiceNumbers.json'), '--manifest', join(dir, 'manifest.json'), '--frozen-at', '2026-10-18T09:59:00Z']);
    expect(recovery.code, recovery.output).toBe(0); expect(recovery.output).toMatch(/Manifest verified/);
  });

  it('preserves the legitimate complete-file workflow without a manifest (baseline positive control)', async () => {
    const dir = fixture(); writeFileSync(join(dir, 'counter.json'), '{"prefix":"N","counter":1}'); writeFileSync(join(dir, 'scheduleHistory.json'), '{"startedAt":{"seconds":1}}');
    const args = [join(dir, 'orders.json'), join(dir, 'invoices.json')];
    for (const [flag, key] of [['--stock', 'stockMovements'], ['--cancellations', 'orderCancellations'], ['--numbers', 'invoiceNumbers'], ['--counter', 'counter'], ['--customers', 'customers'], ['--schedule', 'scheduleChanges'], ['--history', 'scheduleHistory'], ['--products', 'products']]) args.push(flag, join(dir, key + '.json'));
    const rec = await run('reconcile.mjs', args); expect(rec.code, rec.output).toBe(0); expect(rec.output).toMatch(/Status: CLEAN/);
    const migration = await run('migrate-rc3.mjs', ['--files', dir]); expect(migration.code, migration.output).toBe(0); expect(migration.output).toMatch(/ASSESSMENT: CLEAN/);
  });

  it('prints explicit completeness, data readiness and maximum observed line count', async () => {
    const dir = fixture();
    const result = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), '--manifest', join(dir, 'manifest.json')]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/completeness: COMPLETE/);
    expect(result.output).toMatch(/dataReadiness: READY/);
    expect(result.output).toMatch(/maxLinesFound: 0/);
    expect(result.output).toMatch(/releaseReadiness: NOT_ASSESSED_BY_THIS_TOOL/);
  });

  it('exits 3 for nonempty stuck orders without a confirmed freeze, and 1 for a confirmed clean attempt', async () => {
    const dir = fixture(); const raw = JSON.stringify([{ id: 'stuck', status: 'Invoicing', customer: 'Shop', items: [], createdAt: { seconds: Date.parse('2026-10-18T09:00:00Z') / 1000, nanoseconds: 0 } }]);
    writeFileSync(join(dir, 'orders.json'), raw); const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.collections.orders.count = 1; manifest.collections.orders.sha256 = createHash('sha256').update(raw).digest('hex'); writeFileSync(manifestPath, JSON.stringify(manifest));
    const args = [join(dir, 'orders.json'), join(dir, 'invoices.json'), join(dir, 'invoiceNumbers.json'), '--manifest', manifestPath];
    const unconfirmed = await run('stuck-invoicing.mjs', args); expect(unconfirmed.code, unconfirmed.output).toBe(3); expect(unconfirmed.output).toMatch(/Not confirmed/);
    const confirmed = await run('stuck-invoicing.mjs', [...args, '--frozen-at', '2026-10-18T09:59:00Z']); expect(confirmed.code, confirmed.output).toBe(1); expect(confirmed.output).toMatch(/safe to release: 1/);
  });

  it('rejects invalid calendar dates and malformed singleton documents as incomplete', async () => {
    for (const mode of ['date', 'singleton']) {
      const dir = fixture(); const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (mode === 'date') manifest.startedAt = '2026-02-30T10:00:00Z';
      else { const raw = '[null]'; writeFileSync(join(dir, 'counter.json'), raw); manifest.collections.counter.sha256 = createHash('sha256').update(raw).digest('hex'); }
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), '--manifest', manifestPath]);
      expect(result.code, result.output).toBe(3); expect(result.output).toMatch(/INCOMPLETE/);
      expect(result.output).toMatch(mode === 'date' ? /Manifest start\/end times/ : /counter: invalid singleton document export/);
    }
  });

  it('accepts empty singleton exports as valid files but marks missing required business records INCOMPLETE', async () => {
    const dir = fixture(); const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const key of ['counter', 'scheduleHistory']) { const raw = '[]'; writeFileSync(join(dir, key + '.json'), raw); manifest.collections[key].count = 0; manifest.collections[key].sha256 = createHash('sha256').update(raw).digest('hex'); }
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), '--manifest', manifestPath]);
    expect(result.code, result.output).toBe(3); expect(result.output).toMatch(/Manifest verified/); expect(result.output).toMatch(/Status: INCOMPLETE/);
  });

  it.each(['pre-freeze start', 'ambiguous export time', 'changed product after freeze'])('rejects %s in a manifest-backed recovery assessment', async mode => {
    const dir = fixture(); const args = [join(dir, 'orders.json'), join(dir, 'invoices.json'), join(dir, 'invoiceNumbers.json'), '--manifest', join(dir, 'manifest.json'), '--frozen-at', mode === 'pre-freeze start' ? '2026-10-18T10:00:30Z' : '2026-10-18T09:59:00Z'];
    if (mode === 'ambiguous export time') args.push('--exported-at', '2026-10-18T10:01:00');
    if (mode === 'changed product after freeze') {
      const raw = JSON.stringify([{ id: 'p', updatedAt: { seconds: Date.parse('2026-10-18T10:00:00Z') / 1000, nanoseconds: 0 } }]);
      writeFileSync(join(dir, 'products.json'), raw); const path = join(dir, 'manifest.json'); const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.collections.products.count = 1; manifest.collections.products.sha256 = createHash('sha256').update(raw).digest('hex'); writeFileSync(path, JSON.stringify(manifest));
    }
    const result = await run('stuck-invoicing.mjs', args);
    expect(result.code, result.output).toBe(3);
    expect(result.output).toMatch(mode === 'pre-freeze start' ? /began before/ : mode === 'ambiguous export time' ? /explicit time-zone offset/ : /products\/p.*after.*freeze/i);
  });

  it('reports orderCancellations.json by its real name when missing', async () => {
    const dir = fixture(); rmSync(join(dir, 'orderCancellations.json'));
    const result = await run('migrate-rc3.mjs', ['--files', dir]);
    expect(result.output).toMatch(/required inputs[^\n]*orderCancellations\.json/);
    expect(result.code).toBe(3);
  });

  it('prints migration scope exclusions even when its assessment is CLEAN', async () => {
    const result = await run('migrate-rc3.mjs', ['--files', fixture()]);
    expect(result.output).toMatch(/ASSESSMENT: CLEAN/);
    expect(result.output).toMatch(/NOT COVERED[^\n]*stock ledger[^\n]*customers[^\n]*schedule/i);
    expect(result.output).toMatch(/reconcile\.mjs/);
  });

  it.each(['--products', '--stock', '--cancellations', '--numbers', '--counter', '--customers', '--schedule', '--history', '--manifest'])('rejects %s without its value as usage error 2', async flag => {
    const dir = fixture(); const result = await run('reconcile.mjs', [join(dir, 'orders.json'), join(dir, 'invoices.json'), flag]);
    expect(result.code, result.output).toBe(2); expect(result.output).toMatch(new RegExp(`${flag} requires a value`));
  });
});
