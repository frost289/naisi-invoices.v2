#!/usr/bin/env node
// Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json --frozen-at 2026-10-19T05:30:00Z --exported-at 2026-10-19T05:40:00Z
// Reads JSON exports (arrays of documents with an "id"). Prints, for every order in "Invoicing", a verdict and the reasons.
// It never connects to Firestore and never writes. A release is only ever recommended when all three exports are present and the export was
// timestamp-consistent with the stated freeze (the tool cannot verify the freeze itself). Times require an explicit time-zone offset.
// Exit codes: 0 = nothing in Invoicing and the export is confirmed post-freeze;
// 1 = at least one order needs attention; 2 = bad usage or unreadable file; 3 = inputs incomplete or freeze not confirmed (no conclusion).
import { readFileSync } from 'node:fs';
import { classifyStuckInvoicing } from './stuck-invoicing-logic.js';
import { parseArgs, verifyManifest, explicitTime } from './export-manifest.mjs';
let options, pos;
try { ({ options, positional: pos } = parseArgs(process.argv.slice(2), ['--frozen-at', '--exported-at', '--manifest'])); }
catch (error) { console.error(error.message); process.exit(2); }
const [o, i, n] = pos;
if (!o || !i || !n || pos.length !== 3) { console.error('Usage: node tools/stuck-invoicing.mjs orders.json invoices.json invoiceNumbers.json --frozen-at <ISO time with offset> [--exported-at <ISO time with offset>] [--manifest manifest.json]'); process.exit(2); }
const read = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`Cannot read ${p}: ${e.message}`); process.exit(2); } };
let bundle = null, manifest = null;
if (options['--manifest']) {
  const verified = verifyManifest(options['--manifest'], { selectedFiles: { orders: o, invoices: i, invoiceNumbers: n } });
  if (!verified.ok) { console.error('INCOMPLETE: export manifest verification failed.'); verified.errors.forEach(error => console.error('  ' + error)); process.exit(3); }
  bundle = verified.data; manifest = verified.manifest;
  if (options['--exported-at'] && !explicitTime(options['--exported-at'])) { console.error('INCOMPLETE: --exported-at requires an ISO time with an explicit time-zone offset, even when a manifest is supplied.'); process.exit(3); }
  if (Number.isFinite(Date.parse(options['--frozen-at'])) && Date.parse(manifest.startedAt) < Date.parse(options['--frozen-at'])) { console.error('INCOMPLETE: export began before the stated freeze. Obtain fresh exports entirely after the freeze.'); process.exit(3); }
  if (options['--exported-at'] && Date.parse(options['--exported-at']) !== Date.parse(manifest.endedAt)) { console.error('INCOMPLETE: --exported-at must equal the verified manifest endedAt time; omit it to use that time.'); process.exit(3); }
  console.log(`Manifest verified for project ${manifest.projectId}; all required files, counts, and hashes match. Using endedAt as the stated export time.`);
} else console.log('No manifest supplied: export completeness/integrity is UNVERIFIED. Do not use a no-manifest assessment as rollout clearance.');
const r = classifyStuckInvoicing({ orders: bundle?.orders ?? read(o), invoices: bundle?.invoices ?? read(i), invoiceNumbers: bundle?.invoiceNumbers ?? read(n), frozenAt: options['--frozen-at'], exportedAt: manifest?.endedAt ?? options['--exported-at'], exportCollections: bundle || undefined });
if (!r.inputsComplete) { console.log('INPUTS INCOMPLETE - no conclusion can be drawn:'); r.problems.forEach(p => console.log('  - ' + p)); }
console.log(r.freezeNote);
if (r.summary.alreadyInvoiced) console.log('ALREADY_INVOICED completion procedure: docs/RC6.1-OPERATIONS-PLAN.md (verify invoice, registry and counter; complete the order under a freeze; audit and re-run).');
for (const x of r.orders) { console.log(`[${x.verdict}] ${x.orderNo || x.orderId} (${x.customer || '-'})`); x.reasons.forEach(s => console.log('   reason: ' + s)); x.manualSteps.forEach((s, k) => console.log(`   ${k + 1}. ${s}`)); }
console.log(`\nIn Invoicing: ${r.summary.total}  safe to release: ${r.summary.safe}  already invoiced: ${r.summary.alreadyInvoiced}  needs review: ${r.summary.review}  inputs incomplete: ${r.summary.incomplete}`);
process.exit(!r.inputsComplete || !r.freezeConfirmed ? 3 : r.summary.total ? 1 : 0);
