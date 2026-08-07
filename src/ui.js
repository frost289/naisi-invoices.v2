let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

export function showToast(message, type = 'info', duration = 3500) {
  const c = ensureContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  c.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('toast-visible'));

  setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// Disables a button and swaps its label while an async action runs,
// so the user gets immediate feedback instead of a silent gap.
export function setButtonLoading(btn, loadingLabel) {
  if (!btn.dataset.originalLabel) btn.dataset.originalLabel = btn.textContent;
  btn.textContent = loadingLabel || 'Working…';
  btn.disabled = true;
  btn.classList.add('btn-loading');
}

export function clearButtonLoading(btn) {
  if (btn.dataset.originalLabel) btn.textContent = btn.dataset.originalLabel;
  btn.disabled = false;
  btn.classList.remove('btn-loading');
}

export function initOfflineBanner() {
  const banner = document.getElementById('offlineBanner');
  if (!banner) return;

  function update() {
    const offline = !navigator.onLine;
    banner.classList.toggle('visible', offline);
  }

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