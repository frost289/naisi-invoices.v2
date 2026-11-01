// Phase 1, Stage 4 — Control Reports screen (manager): one picker, one date range, one renderer, Excel for every report.
// All values reach the page through esc() (tests/unit/htmlSafety.test.js audits this file).

import { esc, showToast } from './ui.js';
import { mwk } from './items.js';
import { malawiDate } from './malawiTime.js';
import { REPORTS, loadReportData, exportReportXlsx } from './controlReports.js';

const cell = (v, type) => {
  if (v == null || v === '') return '—';
  if (type === 'money') return mwk(v);
  if (type === 'pct') return Number(v).toFixed(1) + '%';
  return String(v);
};

export function initControlReportsView({ profiles }) {
  const sel = document.getElementById('crReport');
  const fromI = document.getElementById('crFrom');
  const toI = document.getElementById('crTo');
  const personSel = document.getElementById('crPerson');
  const runBtn = document.getElementById('crRunBtn');
  const xlsBtn = document.getElementById('crExportBtn');
  const out = document.getElementById('crOutput');
  if (sel.dataset.ready) return;   // wire once; the tab re-entering keeps the last result
  sel.dataset.ready = '1';

  const group = (p, label) => `<optgroup label="${esc(label)}">${REPORTS.filter(r => r.priority === p).map(r =>
    `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('')}</optgroup>`;
  sel.innerHTML = group(1, 'Core reports') + group(2, 'Analysis');
  const today = malawiDate();
  fromI.value = today.slice(0, 8) + '01';
  toI.value = today;

  let last = null;   // { def, report, from, to }
  const syncRange = () => {
    const def = REPORTS.find(r => r.id === sel.value);
    fromI.disabled = toI.disabled = !def.range;
  };
  sel.onchange = () => { syncRange(); out.innerHTML = ''; xlsBtn.disabled = true; last = null; personSel.innerHTML = `<option value="">${esc('Everyone')}</option>`; };
  syncRange();

  function render() {
    if (!last) return;
    const { report } = last;
    const who = personSel.value;
    const hasPerson = report.columns.some(c => c.key === 'person');
    const rows = who && hasPerson ? report.rows.filter(r => r.person === who) : report.rows;
    out.innerHTML = `
      ${report.note ? `<p style="font-size:0.8rem; color:var(--muted);">${esc(report.note)}</p>` : ''}
      <p style="font-size:0.85rem;">${esc(rows.length + ' row(s)' + (who ? ' for ' + who : '') + (last.def.range ? ', ' + last.from + ' to ' + last.to : '') + '.')}</p>
      ${rows.length ? `<div class="fp-scroll"><table class="items-table" style="width:100%;">
        <thead><tr>${report.columns.map(c => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr>${report.columns.map(c =>
          `<td style="${esc((c.type === 'money' && r[c.key] < 0 ? 'color:#b3261e;' : '') + (c.type === 'text' && String(r[c.key] || '').length > 40 ? 'white-space:normal; min-width:160px;' : ''))}">${esc(cell(r[c.key], c.type))}</td>`).join('')}</tr>`).join('')}</tbody>
        ${report.totals && !who ? `<tfoot><tr>${report.columns.map(c => `<th>${esc(report.totals[c.key] == null ? '' : cell(report.totals[c.key], c.type))}</th>`).join('')}</tr></tfoot>` : ''}
      </table></div>` : `<p style="color:var(--muted); font-size:0.85rem;">${esc('Nothing to show for this selection.')}</p>`}`;
  }
  personSel.onchange = render;

  runBtn.onclick = async () => {
    const def = REPORTS.find(r => r.id === sel.value);
    const from = fromI.value, to = toI.value;
    if (def.range && (!from || !to || from > to)) { showToast('Choose a valid date range (from must be on or before to).', 'error'); return; }
    runBtn.disabled = true; xlsBtn.disabled = true;
    out.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
    try {
      const data = await loadReportData(def.needs, { from, to });
      const report = def.build({ ...data, names: profiles, from, to });
      last = { def, report, from, to };
      const people = [...new Set(report.rows.map(r => r.person).filter(Boolean))].sort();
      personSel.innerHTML = `<option value="">${esc('Everyone')}</option>` + people.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
      personSel.disabled = !people.length;
      render();
      xlsBtn.disabled = false;
    } catch (err) {
      out.innerHTML = `<p style="color:#b3261e;">${esc('Could not build the report: ' + err.message)}</p>`;
    } finally { runBtn.disabled = false; }
  };

  xlsBtn.onclick = async () => {
    if (!last) return;
    const who = personSel.value;
    const report = who ? { ...last.report, title: last.report.title + ' - ' + who, rows: last.report.rows.filter(r => r.person === who), totals: null } : last.report;
    try { await exportReportXlsx(report, { from: last.from, to: last.to, rangeUsed: last.def.range }); }
    catch (err) { showToast('Export failed: ' + err.message, 'error'); }
  };
}
