#!/usr/bin/env node
// Usage: node tools/reconcile.mjs orders.json invoices.json
// Each file is a JSON array of documents, each with an "id" field (e.g. a Firestore export
// from a READ-ONLY service account or the console). This script only reads those two files
// and prints a report. It does not connect to Firestore and changes nothing.
import { readFileSync } from 'node:fs';
import { reconcile } from './reconcile-logic.js';

const [ordersPath, invoicesPath] = process.argv.slice(2);
if (!ordersPath || !invoicesPath) { console.error('Usage: node tools/reconcile.mjs orders.json invoices.json'); process.exit(2); }
const orders = JSON.parse(readFileSync(ordersPath, 'utf8'));
const invoices = JSON.parse(readFileSync(invoicesPath, 'utf8'));
const { findings, counts, safeToEnableResume } = reconcile({ orders, invoices });
console.log(`Orders: ${orders.length}  Invoices: ${invoices.length}`);
console.log('Findings by type:', counts);
for (const f of findings.filter(f => f.severity !== 'info')) {
  console.log(`[${f.severity.toUpperCase()}] ${f.type}  orders=${(f.orderIds || []).join(',')}  invoices=${(f.invoiceIds || []).join(',')}\n    ${f.detail}`);
}
console.log(safeToEnableResume ? '\nNo high/medium findings.' : '\nHigh/medium findings exist: resolve them by hand BEFORE enabling resume.');
process.exit(safeToEnableResume ? 0 : 1);
