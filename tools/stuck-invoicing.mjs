#!/usr/bin/env node
// Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json --frozen-at 2026-10-19T05:30:00Z --exported-at 2026-10-19T05:40:00Z
// Reads JSON exports (arrays of documents with an "id"). Prints, for every order in "Invoicing", a verdict and the reasons.
// It never connects to Firestore and never writes. A release is only ever recommended when all three exports are present and the export was
// taken AFTER writes were frozen (the two times you state). Exit codes: 0 = nothing in Invoicing and the export is confirmed post-freeze;
// 1 = at least one order needs attention; 2 = bad usage or unreadable file; 3 = inputs incomplete or freeze not confirmed (no conclusion).
import { readFileSync } from 'node:fs';
import { classifyStuckInvoicing } from './stuck-invoicing-logic.js';
const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const pos = []; for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) i++; else pos.push(args[i]); }
const [o, i, n] = pos;
if (!o || !i || !n) { console.error('Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json --frozen-at <ISO time> --exported-at <ISO time>'); process.exit(2); }
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`Cannot read ${p}: ${e.message}`); process.exit(2); } };
const r = classifyStuckInvoicing({ orders: read(o), invoices: read(i), invoiceNumbers: read(n), frozenAt: val('--frozen-at'), exportedAt: val('--exported-at') });
if (!r.inputsComplete) { console.log('INPUTS INCOMPLETE - no conclusion can be drawn:'); r.problems.forEach(p => console.log('  - ' + p)); }
console.log(r.freezeNote);
for (const x of r.orders) { console.log(`[${x.verdict}] ${x.orderNo || x.orderId} (${x.customer || '-'})`); x.reasons.forEach(s => console.log('   reason: ' + s)); x.manualSteps.forEach((s, k) => console.log(`   ${k + 1}. ${s}`)); }
console.log(`\nIn Invoicing: ${r.summary.total}  safe to release: ${r.summary.safe}  already invoiced: ${r.summary.alreadyInvoiced}  needs review: ${r.summary.review}  inputs incomplete: ${r.summary.incomplete}`);
process.exit(!r.inputsComplete ? 3 : r.summary.total ? (r.summary.total === r.summary.safe && !r.freezeConfirmed ? 3 : 1) : (r.freezeConfirmed ? 0 : 3));
