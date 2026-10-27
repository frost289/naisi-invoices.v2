let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

const ICONS = { success: '✓', error: '✕', info: 'ℹ' };

export function showToast(message, type = 'info', duration = 3500) {
  const c = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  // Built with textContent: a message can contain saved names or server error text and must never be parsed as HTML.
  const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.textContent = ICONS[type] || ICONS.info;
  const msg = document.createElement('span'); msg.className = 'toast-msg'; msg.textContent = String(message ?? '');
  toast.append(icon, msg);
  c.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('toast-visible');
    if (type === 'error') toast.classList.add('toast-shake');
  });

  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

export function setButtonLoading(btn, loadingLabel) {
  if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
  btn.replaceChildren();
  const spin = document.createElement('span'); spin.className = 'btn-spinner';
  const label = document.createElement('span'); label.textContent = loadingLabel || 'Working…';
  btn.append(spin, label);
  btn.disabled = true;
  btn.classList.add('btn-loading');
}

export function clearButtonLoading(btn) {
  if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
  btn.disabled = false;
  btn.classList.remove('btn-loading');
}

export function showAppOverlay(message) {
  const overlay = document.getElementById('appLoadingOverlay');
  if (!overlay) return;
  const p = overlay.querySelector('p');
  if (p) p.textContent = message || 'Loading…';
  overlay.classList.add('visible');
}

export function hideAppOverlay() {
  document.getElementById('appLoadingOverlay')?.classList.remove('visible');
}

export function fadeInView(el) {
  el.classList.remove('view-fade');
  void el.offsetWidth; // force reflow so the animation restarts every time
  el.classList.add('view-fade');
}

export function initOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;

  function update() { banner.classList.toggle('visible', !navigator.onLine); }

  window.addEventListener('online', () => {
    update();
    showToast('Back online — any pending changes will sync now.', 'success');
  });
  window.addEventListener('offline', () => {
    update();
    showToast('You are offline. Changes will be saved and synced once reconnected.', 'info', 5000);
  });
  update();
}

// Escapes text before it is placed into innerHTML, so names/notes typed
// by one user can never run as HTML/JS in another user's browser.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Appends a freshly fetched page onto an already-loaded list, skipping
// any record whose id is already present. Paged lists can otherwise
// show the same row twice when two loads overlap (e.g. a filter change
// while "Load more" is still in flight, or a refresh fired right after
// a bulk action). This only affects what's displayed — it never touches
// the database.
export function mergeById(existing, incoming) {
  const seen = new Set(existing.map(r => r.id));
  const merged = existing.slice();
  for (const r of incoming) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}


// ---- Paged lists: guard against overlapping / out-of-date loads ----
// Every resettable "Load more" list (orders, invoices, products, stock
// movements, customers, expenses, visits, deliveries) uses one of these.
//
//   guard.reset()   call whenever the list is cleared or its query changes
//                   (filter, search, refresh after an action). Anything still
//                   in flight from before is now obsolete.
//   guard.run({fetch, apply, onError, setLoading})
//       fetch()  is called immediately and synchronously, so it captures the
//                CURRENT cursor and filter before anything is awaited.
//       apply(result)  is only called if no reset happened meanwhile — an
//                obsolete response never touches rows, cursor or hasMore.
//       Only one load per list state runs at a time (a second click on
//       "Load more" while one is loading is ignored).
//       An obsolete request never changes the loading indicator or reports
//       an error; reset() itself switches the indicator off so a new load
//       starts from a clean state.
export function createPagedLoadGuard() {
  let generation = 0;
  let runningGeneration = null;
  let activeSetLoading = null;
  return {
    reset() {
      generation++;
      runningGeneration = null;
      if (activeSetLoading) { activeSetLoading(false); activeSetLoading = null; }
    },
    async run({ fetch, apply, onError, setLoading }) {
      if (runningGeneration === generation) return false;
      const gen = generation;
      runningGeneration = gen;
      activeSetLoading = setLoading || null;
      if (setLoading) setLoading(true);
      try {
        const result = await fetch();
        if (gen !== generation) return false;
        apply(result);
        return true;
      } catch (err) {
        if (gen === generation && onError) onError(err);
        return false;
      } finally {
        if (gen === generation) {
          runningGeneration = null;
          activeSetLoading = null;
          if (setLoading) setLoading(false);
        }
      }
    },
  };
}

// ---- A notice that stays on screen until dismissed ----
// Toasts disappear after a few seconds; "your invoice WAS saved but the PDF
// failed" must not. actions: [{ label, onClick(api) }]; api = { setMessage, close }.
export function showPersistentNotice({ message, actions = [] }) {
  const box = document.createElement('div');
  box.className = 'persist-notice';
  box.setAttribute('role', 'alert');
  const msg = document.createElement('div');
  msg.className = 'persist-notice-msg';
  msg.textContent = message;
  const bar = document.createElement('div');
  bar.className = 'persist-notice-actions';
  const api = { setMessage(t) { msg.textContent = t; }, close() { box.remove(); } };
  [...actions, { label: 'Dismiss', onClick: (a) => a.close() }].forEach(a => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'list-action-btn';
    b.textContent = a.label;
    b.addEventListener('click', () => a.onClick(api));
    bar.appendChild(b);
  });
  box.append(msg, bar);
  document.body.appendChild(box);
  return api;
}
