// RC3 data migration. DRY RUN BY DEFAULT. Works only against a LOCAL Firestore emulator (it refuses anything else) or on JSON files.
//   node tools/migrate-rc3.mjs                       dry run against the emulator at 127.0.0.1:8080: prints the plan, writes nothing
//   node tools/migrate-rc3.mjs --apply               applies the additive actions to the EMULATOR only
//   node tools/migrate-rc3.mjs --files dir           dry run on JSON exports in dir (orders.json, invoices.json, invoiceNumbers.json, counter.json, ...)
// A live migration is deliberately NOT possible with this tool: writing invoiceNumbers needs admin rights (the rules forbid clients from
// backfilling them). See docs/MIGRATION.md for how the owner authorises a live run.
import { readFileSync, existsSync } from 'node:fs';
import { planMigration } from './migrate-logic.js';
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const filesDir = args.includes('--files') ? args[args.indexOf('--files') + 1] : null;
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const PROJECT = process.env.NAISI_PROJECT || 'naisi-invoices';
if (apply && filesDir) { console.error('--apply cannot be combined with --files.'); process.exit(2); }
let data = {};
if (filesDir) {
  const rd = (n) => existsSync(`${filesDir}/${n}.json`) ? JSON.parse(readFileSync(`${filesDir}/${n}.json`, 'utf8')) : null;
  data = { orders: rd('orders') || [], invoices: rd('invoices') || [], invoiceNumbers: rd('invoiceNumbers') || [], counter: rd('counter'), cancellations: rd('orderCancellations') || [], scheduleConfig: rd('scheduleHistory') };
} else {
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(HOST)) { console.error(`Refusing: ${HOST} is not a local emulator address.`); process.exit(1); }
  try { if (!/Ok/i.test(await (await fetch(`http://${HOST}/`)).text())) throw 0; } catch { console.error(`No Firestore emulator at ${HOST}. Nothing was read or written.`); process.exit(1); }
  const base = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`, H = { authorization: 'Bearer owner' };
  const dec = (v) => 'stringValue' in v ? v.stringValue : 'integerValue' in v ? Number(v.integerValue) : 'doubleValue' in v ? v.doubleValue : 'booleanValue' in v ? v.booleanValue : 'nullValue' in v ? null
    : 'timestampValue' in v ? { ms: Date.parse(v.timestampValue) } : 'arrayValue' in v ? (v.arrayValue.values || []).map(dec) : Object.fromEntries(Object.entries(v.mapValue?.fields || {}).map(([k, x]) => [k, dec(x)]));
  const list = async (c) => { const out = []; let tok = ''; do { const r = await (await fetch(`${base}/${c}?pageSize=300${tok ? '&pageToken=' + tok : ''}`, { headers: H })).json(); for (const d of r.documents || []) out.push({ id: d.name.split('/').pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])) }); tok = r.nextPageToken || ''; } while (tok); return out; };
  const one = async (p) => { const r = await fetch(`${base}/${p}`, { headers: H }); if (!r.ok) return null; const d = await r.json(); return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, dec(v)])); };
  data = { orders: await list('orders'), invoices: await list('invoices'), invoiceNumbers: await list('invoiceNumbers'), cancellations: await list('orderCancellations'), counter: await one('counters/naisiInvoice'), scheduleConfig: await one('config/scheduleHistory') };
}
const plan = planMigration(data);
console.log(`MODE: ${apply ? 'APPLY (emulator only)' : 'DRY RUN (nothing is written)'}`);
for (const a of plan.actions) console.log(`  ACTION  ${a.type}  ${a.path}  ${JSON.stringify(a.data)}`);
for (const r of plan.report) console.log(`  REVIEW  ${r.type}  ${(r.orderIds || r.invoiceIds || []).join(',')}  ${r.detail}`);
console.log(`Summary: ${plan.actions.length} additive action(s), ${plan.report.length} item(s) for a person to review.`);
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
