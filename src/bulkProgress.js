import { mwk } from './items.js';
import { esc, showToast } from './ui.js';

// ============= BULK PROGRESS WINDOW =============
// One window used by both bulk actions (Approve Selected, Generate Invoices
// for Selected).
//
// What the manager sees:
//  - the list of selected orders BEFORE anything happens, with a Start button;
//  - a progress bar and a live status per order while it runs;
//  - a final summary that stays on screen until closed: each order's result,
//    invoice number, any failure reason, and the totals;
//  - "Retry failed" re-runs only the orders that failed;
//  - for an invoice that was SAVED but whose PDF failed, a per-row
//    "Download PDF" button that regenerates the PDF only — it never saves
//    another invoice.
//
// Safety rules enforced here:
//  - only ONE job can be open at a time (the window is a single shared
//    element; a second job cannot take over its buttons);
//  - starting/retrying while a run is in progress is ignored;
//  - the same order id selected twice is processed once;
//  - the buttons that opened the job (lockButtons) are disabled until it closes.
// These guard the UI only. The database operations behind runOne must be safe
// to repeat on their own (they are: see approveOrderWithStock and
// issueInvoiceForOrder), and that is the final protection.
//
// runOne(order) must resolve to:
//   { state: 'done' | 'skipped' | 'failed', text, invoiceNo?, amount?, isStockShortage?, retryPdf? }
// It should not throw; anything thrown is shown as a failure.
//
// followUp (optional): a second action offered at the end for some failed rows —
// used for "Force-approve orders short on stock".
//   { rows: row => boolean, label: n => string, confirmText: n => string, runOne }

const STATE_LABEL = { waiting: 'Waiting', working: 'Working…', done: 'Done', skipped: 'Already done', failed: 'Failed' };
const STATE_COLOR = { waiting: 'var(--muted)', working: 'var(--amber)', done: '#1f7a35', skipped: '#1f5c30', failed: '#b3261e' };

let modalEl = null;
let activeJob = false;

function ensureModal() {
  if (modalEl && document.body.contains(modalEl)) return modalEl;
  modalEl = document.createElement('div');
  modalEl.id = 'bulkProgressModal';
  modalEl.className = 'modal-overlay';
  modalEl.style.display = 'none';
  modalEl.innerHTML = `
    <div class="modal-box card">
      <div class="modal-header">
        <h2><span class="dot"></span><span id="bpTitle">Bulk action</span></h2>
        <button type="button" class="modal-close-btn" id="bpCloseX" aria-label="Close">&times;</button>
      </div>
      <p class="numbering-hint" id="bpIntro"></p>
      <div style="background:var(--line); border-radius:6px; height:10px; overflow:hidden; margin:6px 0 4px;">
        <div id="bpBarFill" style="background:var(--leaf); height:100%; width:0%; transition:width .2s;"></div>
      </div>
      <p id="bpCounter" style="font-size:0.8rem; color:var(--muted); margin:0 0 8px;"></p>
      <div style="max-height:45vh; overflow:auto; margin-bottom:10px;">
        <table class="items-table" style="width:100%;">
          <thead><tr><th>Order No.</th><th>Customer</th><th class="num">Total</th><th>Result</th></tr></thead>
          <tbody id="bpBody"></tbody>
        </table>
      </div>
      <div id="bpSummary" style="display:none; background:#f7f6f2; border-radius:8px; padding:10px 12px; margin-bottom:10px; font-size:0.85rem;"></div>
      <div class="modal-actions">
        <button type="button" class="generate-btn" id="bpStartBtn" style="width:auto;">Start</button>
        <button type="button" class="list-action-btn" id="bpRetryBtn" style="display:none;">Retry failed</button>
        <button type="button" class="list-action-btn" id="bpFollowUpBtn" style="display:none;"></button>
        <button type="button" class="list-action-btn" id="bpCloseBtn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  return modalEl;
}

export function runBulkJob({ title, intro, startLabel, orders, runOne, followUp = null, lockButtons = [] }) {
  if (activeJob) {
    showToast('Another bulk job is already open. Finish or close it first.', 'error');
    return Promise.resolve({ started: false, rejected: true, rows: [] });
  }
  activeJob = true;
  const locked = lockButtons.filter(Boolean).map(btn => ({ btn, wasDisabled: btn.disabled }));
  locked.forEach(({ btn }) => { btn.disabled = true; });
  const release = () => {
    activeJob = false;
    locked.forEach(({ btn, wasDisabled }) => { btn.disabled = wasDisabled; });
  };

  try {
    const m = ensureModal();
    const $ = id => m.querySelector('#' + id);
    const bodyEl = $('bpBody'), barEl = $('bpBarFill'), counterEl = $('bpCounter'), summaryEl = $('bpSummary');
    const startBtn = $('bpStartBtn'), retryBtn = $('bpRetryBtn'), followBtn = $('bpFollowUpBtn');
    const closeBtn = $('bpCloseBtn'), closeX = $('bpCloseX');

    const seen = new Set();
    const unique = (orders || []).filter(o => (seen.has(o.id) ? false : (seen.add(o.id), true)));
    const rows = unique.map(order => ({ order, state: 'waiting', text: '', invoiceNo: null, amount: null, isStockShortage: false, retryPdf: null }));
    let running = false;
    let started = false;

    $('bpTitle').textContent = title;
    $('bpIntro').textContent = intro;
    startBtn.textContent = startLabel;
    startBtn.style.display = '';
    startBtn.disabled = false;
    retryBtn.style.display = 'none';
    followBtn.style.display = 'none';
    summaryEl.style.display = 'none';
    closeBtn.textContent = 'Cancel';
    closeBtn.disabled = false; closeX.disabled = false;

    function render() {
      bodyEl.innerHTML = rows.map((r, i) => `
        <tr>
          <td>${esc(r.order.orderNo || r.order.id)}</td>
          <td>${esc(r.order.customerName || '—')}</td>
          <td class="num">${esc(mwk(r.amount ?? r.order.grandTotal ?? 0))}</td>
          <td style="color:${esc(STATE_COLOR[r.state])}; font-weight:600;">
            ${esc(STATE_LABEL[r.state])}${r.invoiceNo ? ` · ${esc(r.invoiceNo)}` : ''}
            ${r.text ? `<div style="font-weight:400; font-size:0.75rem; color:var(--muted);">${esc(r.text)}</div>` : ''}
            ${r.retryPdf ? `<button type="button" class="list-action-btn" data-pdf="${esc(i)}" style="margin-top:4px;">Download PDF</button>` : ''}
          </td>
        </tr>`).join('');
      const finished = rows.filter(r => r.state !== 'waiting' && r.state !== 'working').length;
      barEl.style.width = rows.length ? `${Math.round((finished / rows.length) * 100)}%` : '0%';
      counterEl.textContent = started ? `${finished} of ${rows.length} processed` : `${rows.length} order(s) selected`;
    }

    bodyEl.onclick = (e) => {
      const btn = e.target.closest('button[data-pdf]');
      if (!btn) return;
      const r = rows[Number(btn.dataset.pdf)];
      if (!r || !r.retryPdf) return;
      try {
        r.retryPdf();            // regenerates the PDF from the saved invoice data; saves nothing
        r.retryPdf = null;
        r.text = 'Invoice saved · PDF downloaded';
      } catch (err) {
        r.text = 'Invoice saved · PDF failed again: ' + (err?.message || err);
      }
      render();
    };

    function renderSummary() {
      const done = rows.filter(r => r.state === 'done');
      const skipped = rows.filter(r => r.state === 'skipped');
      const failed = rows.filter(r => r.state === 'failed');
      const invoiced = rows.filter(r => r.invoiceNo && r.state === 'done');
      const noPdf = rows.filter(r => r.retryPdf);
      const lines = [
        `<strong>${esc(done.length)}</strong> done` +
          (skipped.length ? ` · <strong>${esc(skipped.length)}</strong> already done earlier` : '') +
          (failed.length ? ` · <strong style="color:#b3261e;">${esc(failed.length)} failed</strong>` : ''),
      ];
      if (invoiced.length) {
        const nos = invoiced.map(r => r.invoiceNo).sort();
        const total = invoiced.reduce((s, r) => s + (r.amount || 0), 0);
        lines.push(`Invoices issued: ${esc(nos[0])}${nos.length > 1 ? ` to ${esc(nos.at(-1))}` : ''} · Total ${esc(mwk(total))}`);
      }
      if (noPdf.length) lines.push(`<strong>${esc(noPdf.length)}</strong> invoice(s) saved but the PDF did not download — use "Download PDF" on those rows. They are NOT duplicated by doing so.`);
      if (failed.length) lines.push('Failed: ' + failed.map(r => `${esc(r.order.orderNo)} (${esc(r.text)})`).join('; '));
      summaryEl.innerHTML = lines.join('<br>');
      summaryEl.style.display = 'block';
    }

    async function processRows(targetRows, fn) {
      if (running) return; // re-entry guard: a second click while a run is active does nothing
      running = true;
      started = true;
      startBtn.style.display = 'none';
      retryBtn.style.display = 'none';
      followBtn.style.display = 'none';
      closeBtn.disabled = true; closeX.disabled = true;
      targetRows.forEach(r => { r.state = 'waiting'; r.text = ''; r.retryPdf = null; });
      render();
      try {
        for (const r of targetRows) {
          r.state = 'working';
          render();
          let res;
          try {
            res = await fn(r.order);
          } catch (err) {
            res = { state: 'failed', text: err?.message || String(err) };
          }
          Object.assign(r, { invoiceNo: null, amount: null, isStockShortage: false, retryPdf: null }, res || { state: 'failed', text: 'No result' });
          render();
        }
      } finally {
        running = false;
        closeBtn.disabled = false; closeX.disabled = false;
        closeBtn.textContent = 'Close';
        renderSummary();
        const failed = rows.filter(r => r.state === 'failed');
        if (failed.length) {
          retryBtn.textContent = `Retry failed (${failed.length})`;
          retryBtn.style.display = '';
        }
        const followRows = followUp ? failed.filter(followUp.rows) : [];
        if (followRows.length) {
          followBtn.textContent = followUp.label(followRows.length);
          followBtn.style.display = '';
        }
      }
    }

    const warnOnLeave = (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warnOnLeave);

    return new Promise(resolve => {
      function close() {
        if (running) return;
        m.style.display = 'none';
        window.removeEventListener('beforeunload', warnOnLeave);
        startBtn.onclick = retryBtn.onclick = followBtn.onclick = closeBtn.onclick = closeX.onclick = bodyEl.onclick = null;
        release();
        resolve({ started, rows });
      }
      startBtn.onclick = () => processRows(rows, runOne);
      retryBtn.onclick = () => processRows(rows.filter(r => r.state === 'failed'), runOne);
      followBtn.onclick = () => {
        const target = rows.filter(r => r.state === 'failed' && followUp.rows(r));
        if (!confirm(followUp.confirmText(target.length))) return;
        processRows(target, followUp.runOne);
      };
      closeBtn.onclick = close;
      closeX.onclick = close;

      render();
      m.style.display = 'flex';
    });
  } catch (err) {
    release();
    throw err;
  }
}
