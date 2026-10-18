#!/usr/bin/env node
// Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json
// Reads JSON exports (arrays of documents with an "id"). Prints, for every order in "Invoicing", whether releasing it is safe and the exact manual steps.
// It never connects to Firestore and never writes. Exit code 0 = nothing stuck, 1 = at least one order needs attention, 2 = bad usage.
import { readFileSync } from 'node:fs';
import { classifyStuckInvoicing } from './stuck-invoicing-logic.js';
const [o, i, n] = process.argv.slice(2);
if (!o || !i || !n) { console.error('Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json'); process.exit(2); }
const r = classifyStuckInvoicing({ orders: JSON.parse(readFileSync(o, 'utf8')), invoices: JSON.parse(readFileSync(i, 'utf8')), invoiceNumbers: JSON.parse(readFileSync(n, 'utf8')) });
for (const x of r.orders) { console.log(`[${x.verdict}] ${x.orderNo || x.orderId} (${x.customer || '-'}): ${x.why}`); x.manualSteps.forEach((s, k) => console.log(`   ${k + 1}. ${s}`)); }
console.log(`\nIn Invoicing: ${r.summary.total}  safe to release: ${r.summary.safe}  already invoiced: ${r.summary.alreadyInvoiced}  needs review: ${r.summary.review}`);
process.exit(r.summary.total ? 1 : 0);
