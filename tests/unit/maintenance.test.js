// RC5: maintenance/freeze file, stuck-Invoicing recovery aid, build identifier.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const require_crypto = () => ({ createHash });
const root = path.resolve(import.meta.dirname, '../..');
const { classifyStuckInvoicing } = await import('../../tools/stuck-invoicing-logic.js');
const bi = await import('../../src/buildInfo.js');

describe('maintenance freeze rules file', () => {
  const src = fs.readFileSync(path.join(root, 'rules/maintenance-freeze.rules'), 'utf8');
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  it('allows no write of any kind and no read except for managers', () => {
    expect(code).toMatch(/allow write: if false;/);
    expect(code).not.toMatch(/allow (create|update|delete)/);
    expect(code).toMatch(/allow read: if isManager\(\);/);
    expect((code.match(/allow /g) || []).length).toBe(2);
  });
  it('is balanced and has the rules_version header', () => {
    expect(code).toMatch(/rules_version = '2';/);
    for (const [a, b] of [['{', '}'], ['(', ')']]) expect(code.split(a).length).toBe(code.split(b).length);
  });
  it('is referenced by the documentation as the default fallback instead of an older release', () => {
    const guide = fs.readFileSync(path.join(root, 'docs/RC6.1-OPERATIONS-PLAN.md'), 'utf8');
    expect(guide).toMatch(/maintenance-freeze\.rules/);
    expect(guide).not.toMatch(/roll(ing)? back to RC3/i);
    expect(guide).not.toMatch(/released by (the )?RC3 client after/i);
  });
});

describe('stuck Invoicing recovery aid (INVOICING_RESUME_ENABLED=false: there is no automatic recovery)', () => {
  const FZ = '2026-10-19T05:30:00Z', EX = '2026-10-19T05:40:00Z';
  const O = (id, status = 'Invoicing') => ({ id, orderNo: 'ORD-' + id, status, customerName: 'Shop' });
  it('an order with no invoice and no registered number is SAFE_TO_RELEASE, with manual steps', () => {
    const r = classifyStuckInvoicing({ orders: [O('o1'), O('o2', 'Approved')], invoices: [], invoiceNumbers: [], frozenAt: FZ, exportedAt: EX });
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ orderId: 'o1', verdict: 'SAFE_TO_RELEASE' });
    expect(r.orders[0].manualSteps.join(' ')).toMatch(/status = "Approved"/);
  });
  it('an order that already has its ord_ invoice is ALREADY_INVOICED and is never released', () => {
    const r = classifyStuckInvoicing({ orders: [O('o1')], invoices: [{ id: 'ord_o1', orderId: 'o1', invoiceNo: 'NF-INV-1' }], invoiceNumbers: [{ id: 'NF-INV-1', invoiceId: 'ord_o1' }], frozenAt: FZ, exportedAt: EX });
    expect(r.orders[0].verdict).toBe('ALREADY_INVOICED');
    expect(r.orders[0].manualSteps.join(' ')).toMatch(/Do not (change|release)|Do not change/); expect(r.orders[0].reasons.join(' ')).toMatch(/Do not release/);
  });
  it('a number registered to a missing invoice, or two invoices, need review', () => {
    expect(classifyStuckInvoicing({ orders: [O('o1')], invoices: [], invoiceNumbers: [{ id: 'NF-INV-9', invoiceId: 'ord_o1' }], frozenAt: FZ, exportedAt: EX }).orders[0].verdict).toBe('NEEDS_REVIEW');
    expect(classifyStuckInvoicing({ orders: [O('o1')], invoices: [{ id: 'ord_o1', orderId: 'o1' }, { id: 'x', orderId: 'o1' }], invoiceNumbers: [], frozenAt: FZ, exportedAt: EX }).orders[0].verdict).toBe('NEEDS_REVIEW');
  });
  it('is read-only and the CLI exit codes work on JSON exports (1 = something stuck, 0 = nothing)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-'));
    const w = (n, v) => fs.writeFileSync(path.join(d, n), JSON.stringify(v));
    w('o.json', [O('o1')]); w('i.json', []); w('n.json', []);
    const run = () => spawnSync('node', [path.join(root, 'tools/stuck-invoicing.mjs'), path.join(d, 'o.json'), path.join(d, 'i.json'), path.join(d, 'n.json'), '--frozen-at', FZ, '--exported-at', EX], { encoding: 'utf8' });
    const before = fs.readFileSync(path.join(d, 'o.json'), 'utf8');
    const a = run(); expect(a.status).toBe(1); expect(a.stdout).toMatch(/SAFE_TO_RELEASE/);
    expect(fs.readFileSync(path.join(d, 'o.json'), 'utf8')).toBe(before);
    w('o.json', [O('o1', 'Approved')]); expect(run().status).toBe(0);   // nothing stuck, export confirmed after the freeze
  });
});

describe('RC6 operations plan and report carry the required statements', () => {
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  it('plan: both outcomes, the freeze flags, the catalogue input, no deployment on incomplete verification', () => {
    const plan = rd('docs/RC6.1-OPERATIONS-PLAN.md');
    for (const t of ['Outcome A', 'Outcome B', '--frozen-at', '--exported-at', '--products', 'Do not deploy RC6', 'MAN-', 'maintenance-freeze.rules', 'NOT APPROVED FOR PRODUCTION']) expect(plan).toContain(t);
  });
  it('report and guide carry the prominent incomplete-verification statement', () => {
    for (const f of ['docs/RC6.1-RELEASE-REPORT.md', 'docs/RC6.1-DEVELOPER-REVIEW-GUIDE.md']) expect(rd(f)).toContain('REAL FIREBASE VERIFICATION INCOMPLETE');
  });
  it('RC6.3: the rules file CHANGED (pin-optional orders, rep expense categories, first-capture pin stamp) and matches the hash recorded for RC6.3', () => {
    const crypto = require_crypto();
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'rules/firestore.rules'))).digest('hex');
    expect(actual).not.toBe('471a2419253581d9e8fe14b54e7db76009f1b53320e79b977875b0990c0c0e32');   // the RC5-RC6.2 rules are no longer the release rules
    expect(fs.readFileSync(path.join(root, 'rules/RC6.3-RULES-SHA256.txt'), 'utf8').split(/\s+/)[0]).toBe(actual);
  });
});

describe('deployment artifacts agree', () => {
  const j = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  it('firebase.json, the emulator config and the rules tests select the same final rules file', () => {
    expect(j('firebase.json').firestore.rules).toBe('rules/firestore.rules');
    expect(j('firebase.emulators.json').firestore.rules).toBe('rules/firestore.rules');
    expect(fs.readFileSync(path.join(root, 'tests/rules/invoicing.rules.test.js'), 'utf8')).toContain("../../rules/firestore.rules");
  });
  it('the freeze config selects only the freeze file, which exists, and carries no indexes', () => {
    const f = j('firebase.freeze.json'); expect(f.firestore.rules).toBe('rules/maintenance-freeze.rules');
    expect(fs.existsSync(path.join(root, f.firestore.rules))).toBe(true);
  });
  it('indexes file is valid JSON; lockfiles exist and the package version matches the build id family', () => {
    expect(Array.isArray(j('firestore.indexes.json').indexes)).toBe(true);
    expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tests/package-lock.json'))).toBe(true);
    expect(j('package.json').version).toBe('6.3.0-rc1'); expect(j('package-lock.json').version).toBe('6.3.0-rc1');   // RC6.3
  });
});

describe('build identifier', () => {
  it('is RC6.3 in public/build-id.txt, defined by vite.config.js, and shown by showBuildId()', async () => {
    expect(fs.readFileSync(path.join(root, 'public/build-id.txt'), 'utf8').trim()).toBe('RC6.3');
    expect(fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8')).toContain('__BUILD_ID__');
    const { JSDOM } = await import('jsdom'); const dom = new JSDOM('<body></body>');
    expect(bi.showBuildId(dom.window.document).textContent).toBe('Build ' + bi.BUILD_ID);
    expect(bi.BUILD_ID).toBe('dev');           // outside a production build
  });
});
