// Phase 1, Stage 2 — screens:
//   M3 Float Periods board (manager) with M2 Issue Money, reversals and period close built into the person's panel.
//   R1 My Float (rep): own target, current period position and money received.
// All values reach the page through esc() (tests/unit/htmlSafety.test.js audits this file).

import { esc, showToast } from './ui.js';
import { mwk } from './items.js';
import { fetchAllFloatSettings, fetchFloatSettings } from './floatAccounts.js';
import {
  fetchOpenPeriods, fetchOpenPeriod, fetchPeriodsForStaff, fetchMovementsForPeriod, verifyPeriodTotals,
  openPeriod, issueMoney, reverseIssue, closePeriod,
} from './floatPeriods.js';
import { periodPosition, newRequestId, ISSUE_METHODS } from './floatMath.js';
import { fetchPendingReportsFor } from './expenseReports.js';
import { renderClaims } from './claimsUi.js';

const fmtTs = (t) => (t && t.toDate ? t.toDate().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (t) => (t && t.toDate ? t.toDate().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const methodLabel = (m) => (ISSUE_METHODS.find(x => x.value === m) || { label: m || '—' }).label;
const nameOf = (profiles, uid, fallback) => (profiles[uid] && (profiles[uid].name || profiles[uid].email)) || fallback || uid;

function tilesHtml(pos, { forRep = false } = {}) {
  const tiles = [
    ['Opening', pos.opening, ''],
    [forRep ? 'Received' : 'Issued', pos.issued, ''],
    ['Approved expenses', pos.approved, ''],
    ['Balance', pos.balance, pos.balance < 0 ? 'color:#b3261e;' : ''],
    ['Target', pos.target, ''],
    ['Top-up to target', pos.topUp, ''],
  ];
  return `<div class="exp-summary-tiles fp-tiles">${tiles.map(([label, value, style]) =>
    `<div class="exp-tile fp-tile"><span class="exp-tile-label">${esc(label)}</span><span class="exp-tile-amount" style="${esc(style)}">${esc(mwk(value))}</span></div>`
  ).join('')}</div>`;
}

function movementsTableHtml(rows, profiles, { canReverse }) {
  if (!rows.length) return `<p style="color:var(--muted); font-size:0.85rem;">${esc('No money issued in this period yet.')}</p>`;
  return `<div class="fp-scroll"><table class="items-table" style="width:100%;">
    <thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Method</th><th>Reference</th><th>By</th><th>Notes</th>${canReverse ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map(r => {
      const isRev = r.kind === 'reversal';
      const struck = !isRev && r.reversedById;
      return `<tr style="${esc(struck ? 'opacity:0.55;' : '')}">
        <td style="font-size:0.78rem;">${esc(fmtTs(r.issuedAt))}</td>
        <td>${esc(isRev ? 'Reversal' : (struck ? 'Issue (reversed)' : 'Issue'))}</td>
        <td style="${esc(isRev ? 'color:#b3261e;' : '')}">${esc((isRev ? '− ' : '') + mwk(r.amount))}</td>
        <td style="font-size:0.78rem;">${esc(methodLabel(r.method))}</td>
        <td style="font-size:0.78rem;">${esc(r.reference || '—')}</td>
        <td style="font-size:0.78rem;">${esc(nameOf(profiles, r.issuedBy, r.issuedByEmail))}</td>
        <td style="font-size:0.78rem;">${esc(r.notes || '')}</td>
        ${canReverse ? `<td>${!isRev && !r.reversedById ? `<button type="button" class="list-action-btn fp-reverse-btn" style="font-size:0.75rem;" data-id="${esc(r.id)}">Reverse</button>` : ''}</td>` : ''}
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

// ===================================================================================================
// M3 + M2 — manager Float Periods board
// ===================================================================================================
export async function loadFloatPeriodsView({ user, profiles }) {
  const board = document.getElementById('fpBoard');
  const detail = document.getElementById('fpDetail');
  board.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;

  let settings, openPeriods;
  try {
    [settings, openPeriods] = await Promise.all([fetchAllFloatSettings(), fetchOpenPeriods()]);
  } catch (err) {
    board.innerHTML = `<p style="color:#b3261e;">${esc('Could not load floats: ' + err.message)}</p>`;
    return;
  }
  const openBy = Object.fromEntries(openPeriods.map(p => [p.staffUid, p]));

  if (!settings.length) {
    board.innerHTML = `<p style="color:var(--muted); font-size:0.85rem;">${esc('No floats yet. Set a float target for each person in Float Settings first.')}</p>`;
    detail.style.display = 'none';
    return;
  }

  let totalBalance = 0, totalTopUp = 0;
  const rows = settings
    .map(s => ({ s, p: openBy[s.staffUid] || null, name: nameOf(profiles, s.staffUid, s.staffEmail) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  board.innerHTML = `<div class="fp-scroll"><table class="items-table" style="width:100%;">
    <thead><tr><th>Person</th><th>Balance</th><th>Top-up</th><th></th><th>Target</th><th>Period</th></tr></thead>
    <tbody>${rows.map(({ s, p, name }) => {
      const pos = p ? periodPosition(p) : null;
      if (pos) { totalBalance += pos.balance; totalTopUp += pos.topUp; }
      return `<tr>
        <td>${esc(name)}</td>
        <td style="${esc(pos && pos.balance < 0 ? 'color:#b3261e;' : '')}">${esc(pos ? mwk(pos.balance) : '—')}</td>
        <td>${esc(pos ? mwk(pos.topUp) : '—')}</td>
        <td><button type="button" class="list-action-btn fp-manage-btn" style="font-size:0.78rem;" data-uid="${esc(s.staffUid)}">Manage</button></td>
        <td>${esc(mwk(s.floatTarget || 0))}</td>
        <td style="font-size:0.8rem;">${esc(p ? 'Open since ' + (p.startDate || '') : 'No open period')}</td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot><tr><th>${esc('Total')}</th><th>${esc(mwk(totalBalance))}</th><th>${esc(mwk(totalTopUp))}</th><th></th><th></th><th></th></tr></tfoot>
  </table></div>`;

  board.querySelectorAll('.fp-manage-btn').forEach(b => {
    b.onclick = () => {
      const s = settings.find(x => x.staffUid === b.dataset.uid);
      showPersonPanel(s);
    };
  });

  async function refresh(uid) {
    await loadFloatPeriodsView({ user, profiles });
    const s = (await fetchAllFloatSettings()).find(x => x.staffUid === uid);
    if (s) await showPersonPanel(s);
  }

  async function showPersonPanel(s) {
    const uid = s.staffUid;
    const name = nameOf(profiles, uid, s.staffEmail);
    detail.style.display = 'block';
    detail.innerHTML = `<p style="color:var(--muted);">${esc('Loading ' + name + '…')}</p>`;
    let period, history;
    try {
      [period, history] = await Promise.all([fetchOpenPeriod(uid), fetchPeriodsForStaff(uid)]);
    } catch (err) {
      detail.innerHTML = `<p style="color:#b3261e;">${esc('Could not load: ' + err.message)}</p>`;
      return;
    }
    const closed = history.filter(h => h.status === 'closed');
    const historyHtml = closed.length ? `<h3 style="margin-top:1.25rem;">${esc('Closed periods')}</h3>
      <div class="fp-scroll"><table class="items-table" style="width:100%;">
        <thead><tr><th>Started</th><th>Closed</th><th>Opening</th><th>Issued</th><th>Approved</th><th>Closing</th><th>Proposed top-up</th></tr></thead>
        <tbody>${closed.map(h => `<tr>
          <td>${esc(h.startDate || '—')}</td><td>${esc(fmtDay(h.closedAt))}</td>
          <td>${esc(mwk(h.openingBalance || 0))}</td><td>${esc(mwk(h.totalIssued || 0))}</td><td>${esc(mwk(h.totalApproved || 0))}</td>
          <td>${esc(mwk(h.closingBalance || 0))}</td><td>${esc(mwk(h.proposedTopUp || 0))}</td>
        </tr>`).join('')}</tbody></table></div>` : '';

    // ---------- no open period: open one ----------
    if (!period) {
      const suggested = s.lastClosingBalance != null ? s.lastClosingBalance : 0;
      detail.innerHTML = `<h2><span class="dot"></span>${esc(name)}</h2>
        <p style="font-size:0.85rem; color:var(--muted);">${esc('No open float period. Target: ' + mwk(s.floatTarget || 0) + '.')}</p>
        <div class="field"><label>${esc('Opening balance (MWK) — cash the person is holding now')}</label>
          <input type="number" id="fpOpeningInput" step="0.01" value="${esc(suggested)}"></div>
        <p style="font-size:0.78rem; color:var(--muted);">${esc(s.lastClosingBalance != null
          ? 'Pre-filled with the closing balance of the last period. Change it only if a cash count shows a different amount.'
          : 'First period for this person: enter the cash they hold now (0 if none).')}</p>
        <button type="button" class="generate-btn" id="fpOpenBtn">${esc('Open period')}</button>
        ${historyHtml}`;
      const reqId = newRequestId();
      const btn = document.getElementById('fpOpenBtn');
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await openPeriod({ staffUid: uid, staffEmail: s.staffEmail, openingBalance: document.getElementById('fpOpeningInput').value || 0, requestId: reqId, managerUid: user.uid });
          showToast('Period opened for ' + name + '.', 'success');
          await refresh(uid);
        } catch (err) { showToast(err.message, 'error'); btn.disabled = false; }
      };
      return;
    }

    // ---------- open period ----------
    const pos = periodPosition(period);
    let movements = [];
    try { movements = await fetchMovementsForPeriod(period.id, uid); } catch (err) { showToast('Could not load money issued: ' + err.message, 'error'); }

    detail.innerHTML = `<h2><span class="dot"></span>${esc(name)}</h2>
      <p style="font-size:0.85rem; color:var(--muted);">${esc('Period open since ' + (period.startDate || '') + '.')}</p>
      ${tilesHtml(pos)}
      <p id="fpVerifyMsg" style="font-size:0.8rem;"></p>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin:0.75rem 0;">
        <button type="button" class="generate-btn" id="fpShowIssueBtn">${esc('Issue money')}</button>
        <button type="button" class="list-action-btn" id="fpShowCloseBtn">${esc('Close period')}</button>
      </div>

      <div id="fpIssueForm" class="card" style="display:none; background:var(--surface2,#f7f7f5);">
        <h3>${esc('Issue money to ' + name)}</h3>
        <div class="field"><label>${esc('Amount (MWK)')}</label><input type="number" id="fpIssueAmount" min="0" step="0.01" value="${esc(pos.topUp > 0 ? pos.topUp : '')}"></div>
        <p style="font-size:0.78rem; color:var(--muted); margin-top:-0.4rem;">${esc(pos.topUp > 0 ? 'Pre-filled with the top-up that brings the float back to target.' : 'The float is at or above target.')}</p>
        <div class="field"><label>${esc('Method')}</label><select id="fpIssueMethod">${ISSUE_METHODS.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('')}</select></div>
        <div class="field"><label>${esc('Reference (mobile money / bank ref, optional)')}</label><input type="text" id="fpIssueRef"></div>
        <div class="field"><label>${esc('Notes (optional)')}</label><input type="text" id="fpIssueNotes"></div>
        <button type="button" class="generate-btn" id="fpIssueBtn">${esc('Record issue')}</button>
      </div>

      <div id="fpCloseForm" class="card" style="display:none; background:var(--surface2,#f7f7f5);">
        <h3>${esc('Close this period')}</h3>
        <p style="font-size:0.85rem;">${esc('Closing balance will be ' + mwk(pos.balance) + '. Proposed top-up: ' + mwk(pos.topUp) + '.')}</p>
        <p style="font-size:0.78rem; color:var(--muted);">${esc('Count the cash with the person first. Once closed, nothing in this period can change; the next period opens with this closing balance.')}</p>
        <div class="field"><label>${esc('Notes (optional, e.g. cash count result)')}</label><input type="text" id="fpCloseNotes"></div>
        <button type="button" class="generate-btn" id="fpCloseBtn">${esc('Confirm close')}</button>
      </div>

      <h3 style="margin-top:1rem;">${esc('Money issued this period')}</h3>
      ${movementsTableHtml(movements, profiles, { canReverse: true })}
      ${historyHtml}`;

    // Integrity check: the running total must equal the sum of the records.
    verifyPeriodTotals(period).then(v => {
      const el = document.getElementById('fpVerifyMsg');
      if (!el) return;
      el.style.color = v.ok ? 'var(--muted)' : '#b3261e';
      el.textContent = v.ok ? '✓ Issued total matches ' + v.count + ' record(s).'
        : 'Warning: the period shows ' + mwk(v.recorded) + ' issued but the records add up to ' + mwk(v.derived) + '. Do not close; report this.';
    }).catch(() => {});

    const issueForm = document.getElementById('fpIssueForm');
    const closeForm = document.getElementById('fpCloseForm');
    document.getElementById('fpShowIssueBtn').onclick = () => { issueForm.style.display = 'block'; closeForm.style.display = 'none'; };
    document.getElementById('fpShowCloseBtn').onclick = () => { closeForm.style.display = 'block'; issueForm.style.display = 'none'; };

    const issueReq = newRequestId();   // one id per opened form: a double click or retry writes the same record
    const issueBtn = document.getElementById('fpIssueBtn');
    issueBtn.onclick = async () => {
      const amount = document.getElementById('fpIssueAmount').value;
      if (!confirm('Record ' + mwk(Number(amount) || 0) + ' issued to ' + name + '?')) return;
      issueBtn.disabled = true;
      try {
        await issueMoney({
          recipientUid: uid, recipientEmail: s.staffEmail, amount,
          method: document.getElementById('fpIssueMethod').value,
          reference: document.getElementById('fpIssueRef').value,
          notes: document.getElementById('fpIssueNotes').value,
          requestId: issueReq, managerUid: user.uid, managerEmail: user.email,
        });
        showToast('Issue recorded.', 'success');
        await refresh(uid);
      } catch (err) { showToast(err.message, 'error'); issueBtn.disabled = false; }
    };

    const closeBtn = document.getElementById('fpCloseBtn');
    closeBtn.onclick = async () => {
      closeBtn.disabled = true;
      try {
        // Approvals land in the open period, so a person's waiting claims must be decided before it closes.
        const waiting = await fetchPendingReportsFor(uid);
        if (waiting.length) {
          showToast(name + ' has ' + waiting.length + ' expense report(s) waiting for approval. Review them in Expense Approvals first.', 'error', 6000);
          closeBtn.disabled = false;
          return;
        }
        if (!confirm('Close ' + name + '\'s period with a closing balance of ' + mwk(pos.balance) + '? This cannot be undone.')) { closeBtn.disabled = false; return; }
        const res = await closePeriod({ periodIdValue: period.id, notes: document.getElementById('fpCloseNotes').value, managerUid: user.uid });
        showToast('Closed. Closing balance ' + mwk(res.closingBalance) + ', proposed top-up ' + mwk(res.proposedTopUp) + '.', 'success', 6000);
        await refresh(uid);
      } catch (err) { showToast(err.message, 'error'); closeBtn.disabled = false; }
    };

    detail.querySelectorAll('.fp-reverse-btn').forEach(b => {
      b.onclick = async () => {
        const reason = prompt('Reason for reversing this issue (required):');
        if (!reason || !reason.trim()) return;
        b.disabled = true;
        try {
          await reverseIssue({ issuedId: b.dataset.id, reason, managerUid: user.uid, managerEmail: user.email });
          showToast('Issue reversed.', 'success');
          await refresh(uid);
        } catch (err) { showToast(err.message, 'error'); b.disabled = false; }
      };
    });
  }
}

// ===================================================================================================
// R1 — My Float (rep; and driver inside delivery mode): float position, money received, expense claims.
// ===================================================================================================
export async function loadMyFloatView({ user, profiles = {}, role = 'rep', body = document.getElementById('myFloatBody') }) {
  body.innerHTML = `<p style="color:var(--muted);">${esc('Loading…')}</p>`;
  let floatHtml;
  try {
    const s = await fetchFloatSettings(user.uid);
    if (!s) {
      body.innerHTML = `<p style="color:var(--muted); font-size:0.85rem;">${esc('No cash float has been set up for you yet. Speak to your manager.')}</p>`;
      return;
    }
    const period = await fetchOpenPeriod(user.uid);
    if (!period) {
      floatHtml = `<p style="font-size:0.85rem;">${esc('Float target: ' + mwk(s.floatTarget || 0) + '.')}</p>
        <p style="color:var(--muted); font-size:0.85rem;">${esc(s.lastClosingBalance != null
          ? 'Your last period closed with a balance of ' + mwk(s.lastClosingBalance) + '. A new period has not been opened yet.'
          : 'Your float period has not been opened yet.')}</p>`;
    } else {
      const pos = periodPosition(period);
      const movements = await fetchMovementsForPeriod(period.id, user.uid);
      floatHtml = `<p style="font-size:0.85rem; color:var(--muted);">${esc('Current period since ' + (period.startDate || '') + '.')}</p>
        ${tilesHtml(pos, { forRep: true })}
        <p style="font-size:0.8rem; color:var(--muted);">${esc('Balance = opening + money received − approved expenses. This is the cash you should be holding.')}</p>
        <h3 style="margin-top:1rem;">${esc('Money received this period')}</h3>
        ${movementsTableHtml(movements, profiles, { canReverse: false })}`;
    }
  } catch (err) {
    body.innerHTML = `<p style="color:#b3261e;">${esc('Could not load your float: ' + err.message)}</p>`;
    return;
  }
  body.innerHTML = floatHtml;
  const heading = document.createElement('h3');
  heading.style.marginTop = '1.5rem';
  heading.textContent = 'My expense claims';
  const claims = document.createElement('div');
  body.append(heading, claims);
  await renderClaims(claims, { user, role });
}
