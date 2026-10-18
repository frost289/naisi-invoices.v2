#!/usr/bin/env node
// Usage: node tools/reconcile.mjs orders.json invoices.json [--stock stockMovements.json] [--cancellations orderCancellations.json]
//          [--numbers invoiceNumbers.json] [--counter counter.json] [--customers customers.json] [--schedule scheduleChanges.json] [--history config.json] [--products products.json]
// Each file is a JSON array of documents, each with an "id" field (e.g. a Firestore export
// from a READ-ONLY service account or the console). This script only reads those two files
// and prints a report. It does not connect to Firestore and changes nothing.
import { readFileSync } from 'node:fs';
import { reconcile } from './reconcile-logic.js';

const args = process.argv.slice(2);
const [ordersPath, invoicesPath] = args;
if (!ordersPath || !invoicesPath) { console.error('Usage: node tools/reconcile.mjs orders.json invoices.json [--stock f] [--cancellations f] [--numbers f] [--counter f] [--customers f] [--schedule f] [--history f] [--products f]'); process.exit(2); }
const opt = (name) => { const i = args.indexOf('--' + name); return i > 0 && args[i + 1] ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : null; };
const productsFile = opt('products');
if (productsFile !== null && !Array.isArray(productsFile)) { console.error('--products must be a JSON array of product documents (an empty array [] is allowed and means "no products exist").'); process.exit(2); }
const orders = JSON.parse(readFileSync(ordersPath, 'utf8'));
const invoices = JSON.parse(readFileSync(invoicesPath, 'utf8'));
const { findings, counts, safeToEnableResume, status, skippedChecks } = reconcile({ orders, invoices, stockMovements: opt('stock'), cancellations: opt('cancellations'), invoiceNumbers: opt('numbers'),
  counter: opt('counter'), customers: opt('customers'), scheduleChanges: opt('schedule'), scheduleConfig: opt('history'), products: productsFile });
console.log(`Orders: ${orders.length}  Invoices: ${invoices.length}`);
console.log('Findings by type:', counts);
for (const f of findings.filter(f => f.severity !== 'info')) {
  console.log(`[${f.severity.toUpperCase()}] ${f.type}  orders=${(f.orderIds || []).join(',')}  invoices=${(f.invoiceIds || []).join(',')}  customers=${(f.customerIds || []).join(',')}\n    ${f.detail}`);
}
console.log('\nStatus:', status);
if (skippedChecks.length) {
  console.log('These checks DID NOT RUN because their input was not supplied (the result is INCOMPLETE, not clean):');
  for (const c of skippedChecks) console.log(`  --${{ stockMovements: 'stock', cancellations: 'cancellations', invoiceNumbers: 'numbers', counter: 'counter', customers: 'customers', scheduleChanges: 'schedule', scheduleConfig: 'history', products: 'products' }[c.input]}  ${c.covers}`);
}
if (status === 'CLEAN') console.log('All checks ran. No high/medium findings.');
else if (status === 'FINDINGS') console.log('High/medium findings exist: resolve them by hand BEFORE enabling resume.');
else console.log('Supply the missing files and run again. Do NOT treat this as safe.');
// RC6: --products is REQUIRED for a complete assessment (the product catalogue export).
// exit code: 0 = CLEAN, 1 = findings, 3 = incomplete
process.exit(status === 'CLEAN' ? 0 : status === 'FINDINGS' ? 1 : 3);
