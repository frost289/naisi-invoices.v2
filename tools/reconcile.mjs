#!/usr/bin/env node
// Local JSON assessment only; never connects to Firestore and never writes.
// --manifest verifies every export and supplies all inputs from that bundle.
import { reconcile } from './reconcile-logic.js';
import { parseArgs, readJson, verifyManifest, singletonValue } from './export-manifest.mjs';

let options, positional;
try { ({ options, positional } = parseArgs(process.argv.slice(2), ['--stock', '--cancellations', '--numbers', '--counter', '--customers', '--schedule', '--history', '--products', '--manifest'])); }
catch (error) { console.error(error.message); process.exit(2); }
const [ordersPath, invoicesPath] = positional;
if (!ordersPath || !invoicesPath || positional.length !== 2) { console.error('Usage: node tools/reconcile.mjs orders.json invoices.json [--manifest manifest.json] [--stock f] [--cancellations f] [--numbers f] [--counter f] [--customers f] [--schedule f] [--history f] [--products f]'); process.exit(2); }
const optionKeys = { '--stock': 'stockMovements', '--cancellations': 'orderCancellations', '--numbers': 'invoiceNumbers', '--counter': 'counter', '--customers': 'customers', '--schedule': 'scheduleChanges', '--history': 'scheduleHistory', '--products': 'products' };
let bundle = {};
if (options['--manifest']) {
  const selectedFiles = { orders: ordersPath, invoices: invoicesPath };
  for (const [flag, key] of Object.entries(optionKeys)) if (options[flag]) selectedFiles[key] = options[flag];
  const verified = verifyManifest(options['--manifest'], { selectedFiles });
  if (!verified.ok) { console.error('INCOMPLETE: export manifest verification failed.'); verified.errors.forEach(error => console.error('  ' + error)); process.exit(3); }
  bundle = verified.data;
  console.log(`Manifest verified for project ${verified.manifest.projectId}; all required files, counts, and hashes match.`);
} else console.log('No manifest supplied: export completeness/integrity is UNVERIFIED. A CLEAN assessment does not establish complete exports.');
let data;
try {
  const load = (flag, key) => options['--manifest'] ? (bundle[key] ?? null) : (options[flag] ? readJson(options[flag]) : null);
  const orders = bundle.orders ?? readJson(ordersPath), invoices = bundle.invoices ?? readJson(invoicesPath);
  if (!Array.isArray(orders) || !Array.isArray(invoices)) throw new Error('orders and invoices must be JSON arrays.');
  for (const [flag, key] of Object.entries(optionKeys)) if (!['counter', 'scheduleHistory'].includes(key)) {
    const value = load(flag, key);
    if (value !== null && !Array.isArray(value)) throw new Error(`${flag} must be a JSON array (an empty array [] means no documents exist).`);
  }
  data = { orders, invoices, stockMovements: load('--stock', 'stockMovements'), cancellations: load('--cancellations', 'orderCancellations'), invoiceNumbers: load('--numbers', 'invoiceNumbers'), counter: singletonValue(load('--counter', 'counter')), customers: load('--customers', 'customers'), scheduleChanges: load('--schedule', 'scheduleChanges'), scheduleConfig: singletonValue(load('--history', 'scheduleHistory')), products: load('--products', 'products') };
} catch (error) { console.error(error.message); process.exit(2); }
const { findings, counts, status, skippedChecks, completeness, dataReadiness, releaseReadiness, preflight } = reconcile(data);
console.log(`Orders: ${data.orders.length}  Invoices: ${data.invoices.length}`);
console.log('Findings by type:', counts);
for (const f of findings.filter(f => f.severity !== 'info')) console.log(`[${f.severity.toUpperCase()}] ${f.type}  orders=${(f.orderIds || []).join(',')}  invoices=${(f.invoiceIds || []).join(',')}  customers=${(f.customerIds || []).join(',')}\n    ${f.detail}`);
console.log('\nStatus:', status);
console.log('completeness:', completeness);
console.log('dataReadiness:', dataReadiness);
console.log('maxLinesFound:', preflight.maxLinesFound);
console.log('releaseReadiness:', releaseReadiness);
if (skippedChecks.length) {
  console.log('These checks DID NOT RUN because their input was not supplied (the result is INCOMPLETE, not clean):');
  for (const c of skippedChecks) console.log(`  --${{ stockMovements: 'stock', cancellations: 'cancellations', invoiceNumbers: 'numbers', counter: 'counter', customers: 'customers', scheduleChanges: 'schedule', scheduleConfig: 'history', products: 'products' }[c.input]}  ${c.covers}`);
}
if (status === 'CLEAN') console.log('All checks ran. No high/medium findings. This is not release approval.');
else if (status === 'FINDINGS') console.log('High/medium findings exist: resolve them by hand BEFORE enabling resume.');
else console.log('Supply the missing files and run again. Do NOT treat this as safe.');
process.exit(status === 'CLEAN' ? 0 : status === 'FINDINGS' ? 1 : 3);
