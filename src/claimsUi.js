// Phase 1, Stage 3 — expense report screens.
//   renderClaims(container, ...)     owner (rep in My Float; driver in delivery mode): draft, edit, submit, follow up.
//   loadApprovalsView(...)           manager (M4 Expense Approvals): queue of submitted reports, per-line decisions.
// All values reach the page through esc() (tests/unit/htmlSafety.test.js audits this file).

import { esc, showToast } from './ui.js';
import { mwk } from './items.js';
import { malawiDate } from './malawiTime.js';
import { fetchFloatSettings } from './floatAccounts.js';
import { fetchOpenPeriod } from './floatPeriods.js';
import { periodPosition, newRequestId } from './floatMath.js';
import { fetchActiveVehicles } from './vehicles.js';
import { claimCategoriesFor, categoryLabel, subcategoriesFor } from './expenseCategories.js';
import {
  fetchMyReports, fetchReport, fetchLines, fetchSubmittedReports, createReport, addLine, updateLine, removeLine,
  submitReport, decideLine, returnReport, summarizeLines, discardEmptyReport,
} from './expenseReports.js';

const fmtTs = (t) => (t && t.toDate ? t.toDate().toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');
const nameOf = (profiles, uid, fallback) => (profiles && profiles[uid] && (profiles[uid].name || profiles[uid].email)) || fallback || uid;

const STATUS = {
  draft: { label: 'Draft', color: '#6b6b6b' },
  returned: { label: 'Sent back', color: '#b45309' },
  submitted: { label: 'Waiting for approval', color: '#1a56a0' },
  reviewed: { label: 'Reviewed', color: '#16a34a' },
};
const statusKey = (r) => (r.status === 'draft' && r.returnNote ? 'returned' : r.status);
const LINE_STATUS = { pending: ['Pending', '#1a56a0'], approved: ['Approved', '#16a34a'], rejected: ['Rejected', '#b3261e'] };

// ===================================================================================================
// Owner: my expense reports
// ===================================================================================================
export async function renderClaims(container, { user, role }) {
  let settings = null, vehicles = [];
  try { settings = await fetchFloatSettings(user.uid); } catch (e) { /* shown below */ }
  if (!settings) {
    container.innerHTML = `<p style="color:var(--muted); font-size:0.85rem;">${esc('Expense claims open once your manager has set up your cash float.')}</p>`;
    return;
  }
  const categories = claimCategoriesFor(role, settings.allowedCategories);
  if (role === 'deliverer') { try { vehicles = await fetchActiveVehicles(); } catch (e) { vehicles = []; } }

  async function showList() {
    container.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
    let reports;
    try { reports = await fetchMyReports(user.uid); }
    catch (err) { container.innerHTML = `<p style="color:#b3261e;">${esc('Could not load your reports: ' + err.message)}</p>`; return; }
    const openDraft = reports.find(r => r.status === 'draft');
    container.innerHTML = `
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:flex-end; margin-bottom:0.75rem;">
        <div class="field" style="flex:1; min-width:180px; margin:0;"><label>${esc('New report name')}</label>
          <input type="text" id="clNewTitle" maxlength="80" value="${esc('Expenses ' + malawiDate())}"></div>
        <button type="button" class="generate-btn" id="clNewBtn" style="width:auto;">${esc('+ New report')}</button>
      </div>
      ${openDraft ? `<p style="font-size:0.8rem; color:var(--muted);">${esc('Tip: you already have a draft. Add to it rather than starting another.')}</p>` : ''}
      ${reports.length ? `<div class="fp-scroll"><table class="items-table" style="width:100%;">
        <thead><tr><th>Report</th><th>Status</th><th>Lines</th><th>Approved</th><th></th></tr></thead>
        <tbody>${reports.map(r => {
          const st = STATUS[statusKey(r)] || STATUS.draft;
          return `<tr>
            <td>${esc(r.title || 'Expenses')}<div style="font-size:0.72rem; color:var(--muted);">${esc(fmtTs(r.createdAt))}</div></td>
            <td><span style="color:${esc(st.color)}; font-weight:600; font-size:0.8rem;">${esc(st.label)}</span></td>
            <td>${esc(r.lineCount)}</td>
            <td>${esc(r.status === 'draft' ? '—' : mwk(r.approvedTotal || 0))}</td>
            <td><button type="button" class="list-action-btn cl-open-btn" data-id="${esc(r.id)}">${esc(r.status === 'draft' ? 'Open' : 'View')}</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : `<p style="color:var(--muted); font-size:0.85rem;">${esc('No expense reports yet. Start one, add each expense, then submit it for approval.')}</p>`}`;
    const req = newRequestId();
    const newBtn = container.querySelector('#clNewBtn');
    newBtn.onclick = async () => {
      newBtn.disabled = true;
      try {
        const { id } = await createReport({ uid: user.uid, email: user.email, role, title: container.querySelector('#clNewTitle').value, requestId: req });
        await showReport(id);
      } catch (err) { showToast(err.message, 'error'); newBtn.disabled = false; }
    };
    container.querySelectorAll('.cl-open-btn').forEach(b => { b.onclick = () => showReport(b.dataset.id); });
  }

  async function showReport(id, editingLineId = null) {
    container.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
    let report, lines;
    try { [report, lines] = await Promise.all([fetchReport(id), fetchLines(id, user.uid)]); }
    catch (err) { container.innerHTML = `<p style="color:#b3261e;">${esc('Could not load: ' + err.message)}</p>`; return; }
    if (!report) { await showList(); return; }
    const draft = report.status === 'draft';
    const sum = summarizeLines(lines);
    const st = STATUS[statusKey(report)] || STATUS.draft;
    const editing = editingLineId ? lines.find(l => l.id === editingLineId) : null;
    const v = editing || { date: malawiDate(), category: (categories[0] || {}).value || '', subcategory: '', amount: '', notes: '', payee: '', receiptRef: '', vehicleId: '' };

    container.innerHTML = `
      <button type="button" class="list-action-btn" id="clBackBtn">${esc('← All my reports')}</button>
      <h3 style="margin:0.75rem 0 0.25rem;">${esc(report.title || 'Expenses')}</h3>
      <p style="font-size:0.85rem; margin:0 0 0.5rem;"><span style="color:${esc(st.color)}; font-weight:700;">${esc(st.label)}</span></p>
      ${report.status === 'draft' && report.returnNote ? `<p style="background:#fff4e0; color:#7a5210; padding:0.6rem 0.8rem; border-radius:8px; font-size:0.85rem;">${esc('Sent back by your manager: ' + report.returnNote)}</p>` : ''}
      <div class="exp-summary-tiles fp-tiles">${[['Claimed', sum.claimed], ['Approved', sum.approved], ['Rejected', sum.rejected]].map(([l, a]) =>
        `<div class="exp-tile fp-tile"><span class="exp-tile-label">${esc(l)}</span><span class="exp-tile-amount">${esc(mwk(a))}</span></div>`).join('')}</div>

      ${lines.length ? `<div class="fp-scroll"><table class="items-table" style="width:100%;">
        <thead><tr><th>What</th><th>Amount</th><th>Status</th>${draft ? '<th></th>' : ''}<th>Date</th><th>Category</th></tr></thead>
        <tbody>${lines.map(l => {
          const [sl, sc] = LINE_STATUS[l.lineStatus] || LINE_STATUS.pending;
          return `<tr>
            <td style="font-size:0.8rem; white-space:normal; min-width:130px;">${esc(l.notes)}${l.decisionNote ? `<div style="color:${esc(sc)}; font-size:0.75rem;">${esc('Manager: ' + l.decisionNote)}</div>` : ''}</td>
            <td>${esc(mwk(l.amount))}</td>
            <td><span style="color:${esc(sc)}; font-size:0.8rem; font-weight:600;">${esc(draft ? '—' : sl)}</span></td>
            ${draft ? `<td><button type="button" class="list-action-btn cl-edit-btn" data-id="${esc(l.id)}">${esc('Edit')}</button><button type="button" class="list-action-btn cl-remove-btn" data-id="${esc(l.id)}">${esc('Remove')}</button></td>` : ''}
            <td style="font-size:0.8rem;">${esc(l.date)}</td>
            <td style="font-size:0.8rem;">${esc(categoryLabel(l.category) + (l.subcategory ? ' · ' + l.subcategory : ''))}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`
        : `<p style="color:var(--muted); font-size:0.85rem;">${esc('No expenses on this report yet.')}</p>`}

      ${draft ? `
      <div class="card" style="background:var(--surface2,#f7f7f5); margin-top:1rem;">
        <h3 style="margin-top:0;">${esc(editing ? 'Edit expense' : 'Add an expense')}</h3>
        <div class="field"><label>${esc('Date')}</label><input type="date" id="clDate" value="${esc(v.date)}" max="${esc(malawiDate())}"></div>
        <div class="field"><label>${esc('Category')}</label><select id="clCategory">${categories.map(c =>
          `<option value="${esc(c.value)}" ${esc(c.value === v.category ? 'selected' : '')}>${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field" id="clSubWrap"><label>${esc('Type')}</label><select id="clSub"></select></div>
        <div class="field" id="clVehicleWrap" style="display:none;"><label>${esc('Vehicle')}</label><select id="clVehicle"><option value="">${esc('— choose —')}</option>${vehicles.map(x =>
          `<option value="${esc(x.id)}" ${esc(x.id === v.vehicleId ? 'selected' : '')}>${esc(x.registration + (x.description ? ' · ' + x.description : ''))}</option>`).join('')}</select></div>
        <div class="field"><label>${esc('Amount (MWK)')}</label><input type="number" id="clAmount" min="0" step="1" inputmode="decimal" value="${esc(v.amount)}"></div>
        <div class="field"><label>${esc('What was it for?')}</label><input type="text" id="clNotes" maxlength="300" value="${esc(v.notes)}" placeholder="${esc('e.g. Minibus Area 25 to Kanengo, customer visits')}"></div>
        <div class="field"><label>${esc('Paid to (optional)')}</label><input type="text" id="clPayee" value="${esc(v.payee)}"></div>
        <div class="field"><label>${esc('Receipt number (optional)')}</label><input type="text" id="clReceipt" value="${esc(v.receiptRef)}"></div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button type="button" class="generate-btn" id="clSaveLineBtn" style="width:auto;">${esc(editing ? 'Save changes' : '+ Add to report')}</button>
          ${editing ? `<button type="button" class="list-action-btn" id="clCancelEditBtn">${esc('Cancel')}</button>` : ''}
        </div>
      </div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:1rem;">
        <button type="button" class="generate-btn" id="clSubmitBtn" ${esc(lines.length ? '' : 'disabled')}>${esc('Submit for approval (' + mwk(sum.claimed) + ')')}</button>
        ${lines.length ? '' : `<button type="button" class="list-action-btn" id="clDiscardBtn">${esc('Discard empty report')}</button>`}
      </div>
      <p style="font-size:0.78rem; color:var(--muted);">${esc('After you submit, the report is locked. Your manager approves or rejects each line; approved amounts come off your float balance.')}</p>` : ''}`;

    container.querySelector('#clBackBtn').onclick = showList;
    if (!draft) return;

    const catSel = container.querySelector('#clCategory');
    const subSel = container.querySelector('#clSub');
    const subWrap = container.querySelector('#clSubWrap');
    const vehWrap = container.querySelector('#clVehicleWrap');
    const syncCategory = (keepSub) => {
      const subs = subcategoriesFor(catSel.value);
      subWrap.style.display = subs.length ? 'block' : 'none';
      subSel.innerHTML = subs.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      if (keepSub && subs.includes(v.subcategory)) subSel.value = v.subcategory;
      vehWrap.style.display = catSel.value === 'VehicleMaintenance' && vehicles.length ? 'block' : 'none';
    };
    syncCategory(true);
    catSel.onchange = () => syncCategory(false);

    const lineReq = newRequestId();
    const saveBtn = container.querySelector('#clSaveLineBtn');
    saveBtn.onclick = async () => {
      const line = {
        date: container.querySelector('#clDate').value,
        category: catSel.value,
        subcategory: subWrap.style.display === 'none' ? '' : subSel.value,
        amount: container.querySelector('#clAmount').value,
        notes: container.querySelector('#clNotes').value,
        payee: container.querySelector('#clPayee').value,
        receiptRef: container.querySelector('#clReceipt').value,
        vehicleId: vehWrap.style.display === 'none' ? null : (container.querySelector('#clVehicle').value || null),
      };
      saveBtn.disabled = true;
      try {
        if (editing) await updateLine({ lineIdValue: editing.id, reportIdValue: id, uid: user.uid, role, line });
        else await addLine({ reportIdValue: id, uid: user.uid, role, line, requestId: lineReq });
        showToast(editing ? 'Expense updated.' : 'Expense added.', 'success');
        await showReport(id);
      } catch (err) { showToast(err.message, 'error'); saveBtn.disabled = false; }
    };
    const cancelEdit = container.querySelector('#clCancelEditBtn');
    if (cancelEdit) cancelEdit.onclick = () => showReport(id);
    container.querySelectorAll('.cl-edit-btn').forEach(b => { b.onclick = () => showReport(id, b.dataset.id); });
    container.querySelectorAll('.cl-remove-btn').forEach(b => {
      b.onclick = async () => {
        if (!confirm('Remove this expense from the report?')) return;
        b.disabled = true;
        try { await removeLine({ lineIdValue: b.dataset.id, reportIdValue: id, uid: user.uid }); await showReport(id); }
        catch (err) { showToast(err.message, 'error'); b.disabled = false; }
      };
    });
    const submitBtn = container.querySelector('#clSubmitBtn');
    submitBtn.onclick = async () => {
      if (!confirm('Submit ' + lines.length + ' expense(s) totalling ' + mwk(sum.claimed) + ' for approval? You cannot change them afterwards.')) return;
      submitBtn.disabled = true;
      try { await submitReport({ reportIdValue: id, uid: user.uid }); showToast('Submitted for approval.', 'success'); await showReport(id); }
      catch (err) { showToast(err.message, 'error'); submitBtn.disabled = false; }
    };
    const discard = container.querySelector('#clDiscardBtn');
    if (discard) discard.onclick = async () => {
      try { await discardEmptyReport({ reportIdValue: id, uid: user.uid }); await showList(); }
      catch (err) { showToast(err.message, 'error'); }
    };
  }

  await showList();
}

// ===================================================================================================
// Manager: Expense Approvals (M4)
// ===================================================================================================
export async function loadApprovalsView({ user, profiles }) {
  const body = document.getElementById('approvalsBody');
  const detail = document.getElementById('approvalsDetail');

  async function showQueue() {
    detail.style.display = 'none';
    body.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
    let reports;
    try { reports = await fetchSubmittedReports(); }
    catch (err) { body.innerHTML = `<p style="color:#b3261e;">${esc('Could not load: ' + err.message)}</p>`; return; }
    if (!reports.length) { body.innerHTML = `<p style="color:var(--muted); font-size:0.85rem;">${esc('Nothing waiting for approval.')}</p>`; return; }
    body.innerHTML = `<p style="font-size:0.85rem;">${esc(reports.length + ' report(s) waiting, oldest first.')}</p>
      <div class="fp-scroll"><table class="items-table" style="width:100%;">
      <thead><tr><th>Person</th><th>Report</th><th>Lines</th><th></th><th>Submitted</th></tr></thead>
      <tbody>${reports.map(r => `<tr>
        <td>${esc(nameOf(profiles, r.ownerUid, r.ownerEmail))}<div style="font-size:0.72rem; color:var(--muted);">${esc(r.ownerRole === 'deliverer' ? 'Driver' : 'Sales rep')}</div></td>
        <td style="font-size:0.85rem;">${esc(r.title || 'Expenses')}</td>
        <td>${esc(r.decidedCount + ' / ' + r.lineCount)}</td>
        <td><button type="button" class="list-action-btn ap-open-btn" data-id="${esc(r.id)}">${esc('Review')}</button></td>
        <td style="font-size:0.8rem;">${esc(fmtTs(r.submittedAt))}</td>
      </tr>`).join('')}</tbody></table></div>`;
    body.querySelectorAll('.ap-open-btn').forEach(b => { b.onclick = () => showReport(b.dataset.id); });
  }

  async function showReport(id) {
    detail.style.display = 'block';
    detail.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
    let report, lines, period;
    try {
      report = await fetchReport(id);
      [lines, period] = await Promise.all([fetchLines(id, report.ownerUid), fetchOpenPeriod(report.ownerUid)]);
    } catch (err) { detail.innerHTML = `<p style="color:#b3261e;">${esc('Could not load: ' + err.message)}</p>`; return; }
    const name = nameOf(profiles, report.ownerUid, report.ownerEmail);
    const sum = summarizeLines(lines);
    const pos = period ? periodPosition(period) : null;
    const pending = lines.filter(l => l.lineStatus === 'pending');
    const reviewing = report.status === 'submitted';

    detail.innerHTML = `<h2><span class="dot"></span>${esc(name + ' — ' + (report.title || 'Expenses'))}</h2>
      ${pos ? `<p style="font-size:0.85rem;">${esc('Float balance now ' + mwk(pos.balance) + ' (target ' + mwk(pos.target) + '). Approving the pending lines (' + mwk(sum.pending) + ') would leave ' + mwk(pos.balance - sum.pending) + '.')}</p>`
        : `<p style="background:#fde8e8; color:#b23b3b; padding:0.6rem 0.8rem; border-radius:8px; font-size:0.85rem;">${esc(name + ' has no open float period. Open one in Float Periods before approving; you can still reject or send back.')}</p>`}
      <div class="exp-summary-tiles fp-tiles">${[['Claimed', sum.claimed], ['Approved', sum.approved], ['Rejected', sum.rejected], ['Pending', sum.pending]].map(([l, a]) =>
        `<div class="exp-tile fp-tile"><span class="exp-tile-label">${esc(l)}</span><span class="exp-tile-amount">${esc(mwk(a))}</span></div>`).join('')}</div>
      <div class="fp-scroll"><table class="items-table" style="width:100%;">
        <thead><tr><th>What</th><th>Amount</th><th>Decision</th><th>Date</th><th>Category</th></tr></thead>
        <tbody>${lines.map(l => {
          const [sl, sc] = LINE_STATUS[l.lineStatus] || LINE_STATUS.pending;
          const extra = [l.payee ? 'Paid to ' + l.payee : '', l.receiptRef ? 'Receipt ' + l.receiptRef : '', l.vehicleId ? 'Vehicle on file' : ''].filter(Boolean).join(' · ');
          return `<tr>
            <td style="font-size:0.8rem; white-space:normal; min-width:130px;">${esc(l.notes)}${extra ? `<div style="font-size:0.72rem; color:var(--muted);">${esc(extra)}</div>` : ''}</td>
            <td>${esc(mwk(l.amount))}</td>
            <td>${l.lineStatus === 'pending' && reviewing
              ? `<button type="button" class="list-action-btn ap-approve-btn" data-id="${esc(l.id)}" ${esc(pos ? '' : 'disabled')}>${esc('Approve')}</button><button type="button" class="list-action-btn ap-reject-btn" data-id="${esc(l.id)}">${esc('Reject')}</button>`
              : `<span style="color:${esc(sc)}; font-weight:600; font-size:0.8rem;">${esc(sl)}</span>${l.decisionNote ? `<div style="font-size:0.72rem; color:var(--muted);">${esc(l.decisionNote)}</div>` : ''}`}</td>
            <td style="font-size:0.8rem;">${esc(l.date)}</td>
            <td style="font-size:0.8rem;">${esc(categoryLabel(l.category) + (l.subcategory ? ' · ' + l.subcategory : ''))}</td>
          </tr>`;
        }).join('')}</tbody></table></div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
        ${reviewing && pending.length > 1 && pos ? `<button type="button" class="generate-btn" id="apApproveAllBtn" style="width:auto;">${esc('Approve all ' + pending.length + ' pending (' + mwk(sum.pending) + ')')}</button>` : ''}
        ${reviewing && report.decidedCount === 0 ? `<button type="button" class="list-action-btn" id="apReturnBtn">${esc('Send back for correction')}</button>` : ''}
        <button type="button" class="list-action-btn" id="apBackBtn">${esc('← Back to queue')}</button>
      </div>`;

    detail.querySelector('#apBackBtn').onclick = showQueue;
    const after = async (res) => {
      if (res && res.complete) { showToast('Report fully reviewed.', 'success'); await showQueue(); }
      else await showReport(id);
    };
    detail.querySelectorAll('.ap-approve-btn').forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        try { await after(await decideLine({ reportIdValue: id, lineIdValue: b.dataset.id, decision: 'approved', managerUid: user.uid })); }
        catch (err) { showToast(err.message, 'error'); b.disabled = false; }
      };
    });
    detail.querySelectorAll('.ap-reject-btn').forEach(b => {
      b.onclick = async () => {
        const note = prompt('Reason for rejecting (the person will see this):');
        if (!note || !note.trim()) return;
        b.disabled = true;
        try { await after(await decideLine({ reportIdValue: id, lineIdValue: b.dataset.id, decision: 'rejected', note, managerUid: user.uid })); }
        catch (err) { showToast(err.message, 'error'); b.disabled = false; }
      };
    });
    const all = detail.querySelector('#apApproveAllBtn');
    if (all) all.onclick = async () => {
      if (!confirm('Approve all ' + pending.length + ' pending lines (' + mwk(sum.pending) + ')?')) return;
      all.disabled = true;
      let res = null, done = 0;
      try {
        for (const l of pending) { res = await decideLine({ reportIdValue: id, lineIdValue: l.id, decision: 'approved', managerUid: user.uid }); done++; }
        await after(res);
      } catch (err) { showToast('Stopped after ' + done + ' line(s): ' + err.message, 'error'); await showReport(id); }
    };
    const ret = detail.querySelector('#apReturnBtn');
    if (ret) ret.onclick = async () => {
      const note = prompt('What needs correcting? (the person will see this)');
      if (!note || !note.trim()) return;
      try { await returnReport({ reportIdValue: id, note }); showToast('Sent back.', 'success'); await showQueue(); }
      catch (err) { showToast(err.message, 'error'); }
    };
  }

  await showQueue();
}
