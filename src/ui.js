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
  toast.innerHTML = `<span class="toast-icon">${ICONS[type] || ICONS.info}</span><span class="toast-msg">${message}</span>`;
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
  btn.innerHTML = `<span class="btn-spinner"></span><span>${loadingLabel || 'Working…'}</span>`;
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