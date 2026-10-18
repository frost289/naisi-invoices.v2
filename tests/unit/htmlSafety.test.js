// Finding 1 (stored HTML/script injection): regression tests.
// Static: no interpolation inside an HTML template may reach the page unescaped.
// Dynamic: the DOM builders that show saved customer/product/order text must not create elements from that text.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { analyze } from '../helpers/htmlAudit.js';

const srcDir = path.resolve(import.meta.dirname, '../../src');
const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js') && f !== 'logo.js');

describe('F1 static audit: every value placed in an HTML template is escaped', () => {
  for (const f of files) {
    it(`${f}: no unescaped interpolation in HTML templates`, () => {
      const { inserts, review } = analyze(fs.readFileSync(path.join(srcDir, f), 'utf8'));
      const offenders = review.filter(r => r.includes(': wrap ') || /^\d+: wrap /.test(r));
      expect(offenders, 'unescaped values:\n' + offenders.join('\n')).toEqual([]);
      expect(inserts.length).toBe(0);
    });
  }
  it('no code writes saved text with insertAdjacentHTML/outerHTML/document.write', () => {
    for (const f of files) expect(fs.readFileSync(path.join(srcDir, f), 'utf8'), f).not.toMatch(/insertAdjacentHTML|outerHTML|document\.write\(/);
  });
});

const EVIL = `"><img src=x onerror="window.__pwn=(window.__pwn||0)+1"><script>window.__pwn=99</script>`;
let dom;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
});
const noInjection = () => {
  expect(document.querySelectorAll('img[src="x"], script').length).toBe(0);
  expect(dom.window.__pwn).toBeUndefined();
};

describe('F1 dynamic: DOM builders keep saved text as text', () => {
  it('toast messages are text, not HTML', async () => {
    const { showToast } = await import('../../src/ui.js');
    showToast(EVIL, 'error');
    expect(document.querySelector('.toast-msg').textContent).toBe(EVIL);
    noInjection();
  });
  it('item rows keep saved names/descriptions as input VALUES (no attribute or element injection) and preview shows them as text', async () => {
    const { addItemRow, getItems } = await import('../../src/items.js');
    const { updatePreview } = await import('../../src/preview.js');
    document.body.innerHTML = '<table><tbody id="items"></tbody></table><table><tbody id="pv"></tbody></table>' +
      ['invoiceNo', 'invoiceDate', 'custName', 'custPhone', 'custLocation', 'terms', 'providerPhone'].map(n => `<input id="${n}">`).join('') +
      ['pvProviderPhone', 'pvInvoiceNo', 'pvDate', 'pvCustomer', 'pvPhone', 'pvLocation', 'pvTerms', 'pvGrandTotal'].map(n => `<span id="${n}"></span>`).join('');
    const els = {};
    document.querySelectorAll('[id]').forEach(e => { els[e.id] = e; });
    els.itemsBody = els.items; els.pvItemsBody = els.pv;
    const tricky = `O'Brien "Tea" & Co <500g>`;
    addItemRow(els.items, () => {}, 1, EVIL, 10, EVIL, EVIL, 4, EVIL, false);
    addItemRow(els.items, () => {}, 2, tricky, 5, tricky, tricky, 4, 'p1', false);
    noInjection();
    const rows = getItems(els.items);
    expect(rows.map(r => r.desc)).toEqual([EVIL, tricky]);
    expect(rows[0].productId).toBe(EVIL);
    updatePreview(els);
    noInjection();
    expect([...els.pv.querySelectorAll('tr td:nth-child(2)')].map(td => td.textContent)).toEqual([EVIL, tricky]);
  });
});
