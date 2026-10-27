// RC3 data migration. DRY RUN BY DEFAULT. Works only against a LOCAL Firestore emulator (it refuses anything else) or on JSON files.
//   node tools/migrate-rc3.mjs                       dry run against the emulator at 127.0.0.1:8080: prints the plan, writes nothing
//   node tools/migrate-rc3.mjs --apply               applies the additive actions to the EMULATOR only
//   node tools/migrate-rc3.mjs --files dir           dry run on JSON exports in dir (orders.json, invoices.json, invoiceNumbers.json, counter.json, ...)
// A live migration is deliberately NOT possible with this tool: writing invoiceNumbers needs admin rights (the rules forbid clients from
// backfilling them). See docs/MIGRATION.md for how the owner authorises a live run.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { planMigration } from './migrate-logic.js';
import { parseArgs, verifyManifest, singletonValue } from './export-manifest.mjs';
let options;
try { const parsed = parseArgs(process.argv.slice(2), ['--files', '--manifest'], ['--apply']); options = parsed.options; if (parsed.positional.length) throw new Error('Unexpected positional argument. Use --files <directory> [--manifest manifest.json].'); }
catch (error) { console.error(error.message); process.exit(2); }
const apply = !!options['--apply'];
const filesDir = options['--files'] || null;
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.NAISI_PROJECT || 'naisi-invoices';
if (apply && filesDir) { console.error('--apply cannot be combined with --files.'); process.exit(2); }
if (options['--manifest'] && !filesDir) { console.error('--manifest requires --files and cannot be used with emulator apply mode.'); process.exit(2); }
let data = {};
if (filesDir) {
  let bundle = null;
  if (options['--manifest']) {
    const selectedFiles = Object.fromEntries(['orders', 'invoices', 'invoiceNumbers', 'orderCancellations', 'products', 'counter', 'scheduleHistory'].map(key => [key, join(filesDir, key + '.json')]));
    const verified = verifyManifest(options['--manifest'], { selectedFiles });
    if (!verified.ok) { console.error('INCOMPLETE: export manifest verification failed.'); verified.errors.forEach(error => console.error('  ' + error)); process.exit(3); }
    bundle = verified.data;
    console.log(`Manifest verified for project ${verified.manifest.projectId}; all required files, counts, and hashes match.`);
  } else console.log('No manifest supplied: export completeness/integrity is UNVERIFIED. A CLEAN assessment does not establish complete exports.');
  try {
    const rd = key => bundle ? bundle[key] : (existsSync(join(filesDir, key + '.json')) ? JSON.parse(readFileSync(join(filesDir, key + '.json'), 'utf8')) : null);
    const raw = { orders: rd('orders'), invoices: rd('invoices'), invoiceNumbers: rd('invoiceNumbers'), orderCancellations: rd('orderCancellations'), products: rd('products'), counter: singletonValue(rd('counter')) };
    const missingInputs = Object.entries(raw).filter(([key, value]) => key !== 'products' && value === null).map(([key]) => key + '.json');
    for (const key of ['orders', 'invoices', 'invoiceNumbers', 'orderCancellations', 'products']) if (raw[key] !== null && !Array.isArray(raw[key])) throw new Error(`${key}.json must contain a JSON array.`);
    data = { orders: raw.orders || [], invoices: raw.invoices || [], invoiceNumbers: raw.invoiceNumbers || [], counter: raw.counter, cancellations: raw.orderCancellations || [], products: raw.products, missingInputs, scheduleConfig: singletonValue(rd('scheduleHistory')) };
  } catch { console.error('Cannot read valid JSON array exports. Check the input files and run again.'); process.exit(2); }
} else {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) { console.error(`Refusing: ${HOST} is not a local emulator address.`); process.exit(1); }
  try { if (!/Ok/i.test(await (await fetch(`http://${HOST}/`)).text())) throw 0; } catch { console.error(`No Firestore emulator at ${HOST}. Nothing was read or written.`); process.exit(1); }
  const base = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`, H = { authorization: 'Bearer owner' };
  const dec = (v) => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
    : 'timestampValue' in v ? { ms: Date.parse(v.timestampValue) } : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries(v.mapValue?.fields || {}).map(([k, x]) => [k, dec(x)]));
  const list = async (c) => { const out = []; let tok = ''; do { const r = await (await fetch(`${base}/${c}?pageSize=300${tok ? '&pageToken=' + tok : ''}`, { headers: H })).json(); for (const d of r.documents || []) out.push({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])) }); tok = r.nextPageToken || ''; } while (tok); return out; };
  const one = async (p) => { const r = await fetch(`${base}/${p}`, { headers: H }); if (!r.ok) return null; const d = await r.json(); return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])); };
  data = { orders: await list('orders'), invoices: await list('invoices'), invoiceNumbers: await list('invoiceNumbers'), cancellations: await list('orderCancellations'), products: await list('products'), counter: await one('counters/naisiInvoice'), scheduleConfig: await one('config/scheduleHistory') };
}
const plan = planMigration(data);
console.log(`MODE: ${apply ? 'APPLY (emulator only)' : 'DRY RUN (nothing is written)'}`);
for (const a of plan.actions) console.log(`  ACTION  ${a.type}  ${a.path}  ${JSON.stringify(a.data)}`);
for (const r of plan.report) console.log(`  REVIEW  ${r.type}  ${(r.orderIds || r.invoiceIds || []).join(',')}  ${r.detail}`);
console.log(`Summary: ${plan.actions.length} additive action(s), ${plan.report.length} item(s) for a person to review.`);
console.log(`ASSESSMENT: ${plan.assessment}${plan.assessment === 'CLEAN' ? '' : ' (not a clean migration: resolve the REVIEW items above first)'}`);
if (plan.missingInputs.length) console.log(`INCOMPLETE: these required inputs were not supplied: ${plan.missingInputs.join(', ')}. No assessment of those checks was made.`);
console.log('A CLEAN assessment is data readiness only. It is NOT release approval.');
console.log(`NOT COVERED by this migration planner: ${plan.notCoveredChecks.join('; ')}. Run tools/reconcile.mjs with the complete verified manifest for those checks.`);
if (apply) {
  const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'string' ? { stringValue: v } : v.ms ? { timestampValue: new Date(v.ms).toISOString() } : { stringValue: JSON.stringify(v) };
  const base = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;
  for (const a of plan.actions) {
    // create-only for registry docs (never overwrites); kind label only fills a missing field
    const q = a.type === 'REGISTER_NUMBER' ? '?currentDocument.exists=false' : '?' + Object.keys(a.data).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const res = await fetch(`${base}/${a.path}${q}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer owner' }, body: JSON.stringify({ fields: Object.fromEntries(Object.entries(a.data).map(([k, v]) => [k, enc(v)])) }) });
    console.log(`  ${res.ok ? 'done ' : 'FAILED'} ${a.path} ${res.ok ? '' : res.status}`);
  }
}
if (!apply) process.exit(plan.assessment === 'INCOMPLETE' ? 3 : plan.assessment === 'CLEAN' ? 0 : 1);
