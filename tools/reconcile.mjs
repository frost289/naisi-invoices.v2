#!/usr/bin/env node
// Usage: node tools/reconcile.mjs orders.json invoices.json [--stock stockMovements.json] [--cancellations orderCancellations.json]
//          [--numbers invoiceNumbers.json] [--counter counter.json] [--customers customers.json] [--schedule scheduleChanges.json] [--history config.json]
// Each file is a JSON array of documents, each with an "id" field (e.g. a Firestore export
// from a READ-ONLY service account or the console). This script only reads those two files
// and prints a report. It does not connect to Firestore and changes nothing.
import { readFileSync } from 'node:fs';
import { reconcile } from './reconcile-logic.js';

const args = process.argv.slice(2);
const [ordersPath, invoicesPath] = args;
if (!ordersPath || !invoicesPath) { console.error('Usage: node tools/reconcile.mjs orders.json invoices.json [--stock f] [--cancellations f] [--numbers f] [--counter f] [--customers f] [--schedule f] [--history f]'); process.exit(2); }
const opt = (name) => { const i = args.indexOf('--' + name); return i > 0 && args[i + 1] ? JSON.parse(readFileSync(args[i + 1], 'utf8')) : null; };
const orders = JSON.parse(readFileSync(ordersPath, 'utf8'));
const invoices = JSON.parse(readFileSync(invoicesPath, 'utf8'));
const { findings, counts, safeToEnableResume } = reconcile({ orders, invoices, stockMovements: opt('stock'), cancellations: opt('cancellations'), invoiceNumbers: opt('numbers'),
  counter: opt('counter'), customers: opt('customers'), scheduleChanges: opt('schedule'), scheduleConfig: opt('history') });
console.log(`Orders: ${orders.length}  Invoices: ${invoices.length}`);
console.log('Findings by type:', counts);
for (const f of findings.filter(f => f.severity !== 'info')) {
  console.log(`[${f.severity.toUpperCase()}] ${f.type}  orders=${(f.orderIds || []).join(',')}  invoices=${(f.invoiceIds || []).join(',')}  customers=${(f.customerIds || []).join(',')}\n    ${f.detail}`);
}
console.log(safeToEnableResume ? '\nNo high/medium findings.' : '\nHigh/medium findings exist: resolve them by hand BEFORE enabling resume.');
process.exit(safeToEnableResume ? 0 : 1);
