import './style.css';
import { LOGO_DATA_URI } from './logo.js';
import { auth, db } from './firebase.js';
import { watchAuth, login, logout } from './auth.js';
import { getUserRole } from './roles.js';
import { addItemRow, fillItemRows, buildQuickAddGrid, getItems, mwk } from './items.js';
import { updatePreview, formatDate } from './preview.js';
import {
  loadCounterState, watchCounterState, fetchCounterAdjustments,
  buildInvoiceNo, currentYear, adjustInvoiceCounter, validateCounterAdjustment
} from './numbering.js';
import { generatePdf } from './pdf.js';
import {
  fetchMyInvoicesPage, fetchAllInvoicesPage, fetchInvoicesByDateRangePage,
  fetchInvoicesByDateRange, fetchInvoiceById, updateInvoice
} from './invoices.js';
import { buildAndDownloadInvoiceReport, buildAndDownloadExpenseReport, buildAndDownloadCustomerReport } from './export.js';
import {
  fetchAllCustomers, fetchCustomersPage, addCustomer, updateCustomer, updateCustomerLocation,
  fetchCustomerById, deactivateCustomer, reactivateCustomer, setCustomerVisitDay, hasPin, isValidPin,
  normalizeText, normalizePhone, formatPhoneForDisplay, toWhatsAppNumber, findPossibleDuplicates, countCustomerActivity, mergeCustomers, cancelMergeLock
} from './customers.js';
import {
  fetchAllLocations, addLocation, deleteLocation, markLocationReviewed, findLocationByName, googleMapsSearchUrlForLocation
} from './locations.js';
import {
  fetchMyProfile, saveMyProfile, fetchAllProfiles, resolveNameByEmail
} from './userProfiles.js';
import {
  fetchAllExpensesPage, fetchMyExpensesPage, addExpense, updateExpense, deleteExpense
} from './expenses.js';
import {
  fetchAllProducts, fetchProductsPage, watchAllProducts, addProduct, updateProduct, deleteProduct,
  seedDefaultProductsIfEmpty
} from './products.js';
import {
  fetchMyOrdersPage, fetchOrdersByStatusPage, fetchAllOrdersPage,
  fetchOrderById, rejectOrder,
  issueInvoiceForOrder, issueStandaloneInvoice, newStandaloneRequestId,
  fetchOrdersReadyToDeliverPage, markOrderDelivered
} from './orders.js';
import { orderRevisionKey } from './orderRevision.js';
import { invoiceOrderForBulk } from './invoiceFlow.js';
import { wholeNumber } from './numbers.js';
import { validateOrderLines } from './orderLines.js';
import { reviewOrderPrices, orderPriceReviewText } from './orderPriceReview.js';
import { showBuildId } from './buildInfo.js';
import { summarizeExpenses, isMoney } from './money.js';
import {
  adjustStockManually, approveOrderWithStock, cancelOrder, validateCancelReason,
  editOrderWithStock, receiveStockCases, fetchAllStockMovementsPage, fetchStockMovementsForProduct, casesToPacks
} from './stock.js';
import {
  fetchOrdersInRange, fetchExpensesInRange, fetchVisitsInRange, buildIntervalSummary
} from './reports.js';
import {
  fetchMyVisitsPage, fetchMyVisitsForDate, recordNoOrderVisit, submitOrderWithVisit,
  validateNoOrderInput, validateOrderItems, newRequestId
} from './visits.js';
import { requestReport } from './reportLoader.js';
import { malawiDate, malawiWeekday, weekdayOfDate, addDays } from './malawiTime.js';
import { repDayProgress, scheduledForDate, buildPerformanceReport } from './visitSchedule.js';
import { buildScheduleIndex, awaitingScheduling, findScheduleMismatches } from './scheduleHistory.js';
import { fetchScheduleHistory, startScheduleHistory } from './scheduleStore.js';
import { submitOrderAsManager } from './managerOrders.js';
import { fetchRepEmails } from './roles.js';
import {
  showToast, setButtonLoading, clearButtonLoading,
  initOfflineBanner, showAppOverlay, hideAppOverlay, fadeInView, esc, mergeById,
  createPagedLoadGuard, showPersistentNotice
} from './ui.js';
import {
  FAIL_REASONS, OVERDUE_HOUR_OPTIONS, DEFAULT_OVERDUE_HOURS, markOrderDeliveryFailed,
  fetchPendingDeliveries, fetchDeliveredSince, fetchFailedAttemptsSince,
  earliestNeededStart, buildDeliveryStats, toDate, formatAge
} from './deliveries.js';
import { orderStops, getStartPoint, startLabel, formatKm } from './routing.js';
import { suggestSchedule, applySuggestions, DEFAULT_DAYS } from './scheduleSuggest.js';
import { readTable, parseCsv, rowsFromWorksheet, planImport, buildMoves } from './scheduleImport.js';
import ExcelJS from 'exceljs';
import { runBulkJob } from './bulkProgress.js';

initOfflineBanner();

function formatItemsSummary(items) {
  if (!items || items.length === 0) return '—';
  return items.map(it => `${it.qty}× ${it.desc || '—'}`).join(', ');
}

// Malformed stored amounts are never counted and never shown as 0: the screen says how many there are and which records (ids) to correct.
function invalidAmountNote(invalid) {
  if (!invalid.length) return '';
  const ids = invalid.slice(0, 5).map(x => String(x.id || '?')).join(', ') + (invalid.length > 5 ? ', …' : '');
  return `<p class="exp-invalid-note" style="color:#b3261e; font-size:0.8rem; margin-top:6px;">${esc(invalid.length)} expense record${esc(invalid.length === 1 ? '' : 's')} with an invalid amount ${esc(invalid.length === 1 ? 'is' : 'are')} NOT included in these totals (record ${esc(ids)}). Open and correct the amount.</p>`;
}
showBuildId();

function googleMapsUrl(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return '#';
  return `https://www.google.com/maps/search/?api=1&query=${la},${ln}`;
}

const loginScreen = document.getElementById('loginScreen');
const noAccessScreen = document.getElementById('noAccessScreen');
const appRoot = document.getElementById('appRoot');
const deliveryRoot = document.getElementById('deliveryRoot');

watchAuth(
  async (user) => {
    loginScreen.style.display = 'none';
    const role = await getUserRole(user.email);
    if (role === 'manager' || role === 'submitter') {
      noAccessScreen.style.display = 'none';
      appRoot.style.display = 'block';
      await initApp(user, role);
    } else if (role === 'delivery') {
      noAccessScreen.style.display = 'none';
      deliveryRoot.style.display = 'block';
      await initDeliveryApp(user);
    } else {
      appRoot.style.display = 'none';
      deliveryRoot.style.display = 'none';
      noAccessScreen.style.display = 'block';
      hideAppOverlay();
    }
  },
  () => {
    loginScreen.style.display = 'block';
    appRoot.style.display = 'none';
    deliveryRoot.style.display = 'none';
    noAccessScreen.style.display = 'none';
    hideAppOverlay();
  }
);

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  setButtonLoading(btn, 'Signing in…');
  try {
    await login(email, password);
    showAppOverlay('Loading your workspace…');
  } catch (e) {
    document.getElementById('loginError').textContent = e.message;
    showToast('Sign-in failed: ' + e.message, 'error');
  } finally {
    clearButtonLoading(btn);
  }
});

// An invoice that WAS saved but whose PDF could not be produced. Stays on
// screen until dismissed. "Try PDF again" only regenerates the PDF from the
// saved invoice data — it never saves another invoice or uses another number.
function notifyInvoiceSavedPdfFailed(invoiceNo, pdfArgs, err) {
  showPersistentNotice({
    message: `Invoice ${invoiceNo} was saved, but its PDF could not be created (${err?.message || err}). Nothing was duplicated. Try the PDF again here, or use Invoices → Download later.`,
    actions: [{
      label: 'Try PDF again',
      onClick: (api) => {
        try {
          generatePdf(pdfArgs);
          api.close();
          showToast(`PDF for ${invoiceNo} downloaded.`, 'success');
        } catch (e) {
          api.setMessage(`Invoice ${invoiceNo} is saved, but the PDF failed again (${e?.message || e}). Use Invoices → Download later.`);
        }
      },
    }],
  });
}

async function handleLogoutClick() {
  const confirmed = confirm('Log out of Naisi Foods?');
  if (!confirmed) return;
  try {
    await logout();
  } catch (e) {
    showToast('Could not log out: ' + e.message, 'error');
    return;
  }
  // initApp()/initDeliveryApp() only ever wire up their event listeners
  // ONCE per page load — a full reload is the simplest way to guarantee
  // whoever logs in next (possibly a different role entirely) gets a
  // completely clean app instead of stale listeners still pointed at
  // the previous user.
  window.location.reload();
}
document.getElementById('logoutBtn').addEventListener('click', handleLogoutClick);
document.getElementById('deliveryLogoutBtn').addEventListener('click', handleLogoutClick);

let appInitialized = false;

async function initApp(user, role) {
  if (appInitialized) { hideAppOverlay(); return; }
  appInitialized = true;

  // realRole is the actual Firestore-verified role and never changes —
  // Firestore security rules check config/roles server-side regardless
  // of anything below, so this override can't grant real permissions,
  // only hide/show manager-only UI for a manager who wants to see what
  // a rep's screen looks like without needing a second test account.
  const realRole = role;
  const isManager = (realRole === 'manager') && (localStorage.getItem('naisi_previewAsRole') !== 'submitter');

  document.getElementById('topbarLogo').src = LOGO_DATA_URI;
  document.getElementById('previewLogo').src = LOGO_DATA_URI;
  document.getElementById('appTitle').textContent = 'Naisi Foods';
  document.getElementById('appSubtitle').textContent = isManager ? 'Management' : 'Sales Rep';
  if (realRole === 'manager' && !isManager) {
    document.getElementById('appSubtitle').textContent = 'Sales Rep (Preview)';
  }

  const itemsBody = document.getElementById('itemsBody');
  const quickAddGrid = document.getElementById('quickAddGrid');

  const els = {
    invoiceNo: document.getElementById('invoiceNo'),
    invoiceDate: document.getElementById('invoiceDate'),
    custName: document.getElementById('custName'),
    custPhone: document.getElementById('custPhone'),
    custLocation: document.getElementById('custLocation'),
    terms: document.getElementById('terms'),
    providerPhone: document.getElementById('providerPhone'),
    notes: document.getElementById('notes'),
    itemsBody,
    pvProviderPhone: document.getElementById('pv-providerPhone'),
    pvInvoiceNo: document.getElementById('pv-invoiceNo'),
    pvDate: document.getElementById('pv-date'),
    pvCustomer: document.getElementById('pv-customer'),
    pvPhone: document.getElementById('pv-phone'),
    pvLocation: document.getElementById('pv-location'),
    pvTerms: document.getElementById('pv-terms'),
    pvItemsBody: document.getElementById('pv-itemsBody'),
    pvGrandTotal: document.getElementById('pv-grandTotal'),
  };

  const generateBtn = document.getElementById('generateBtn');
  const generateNote = document.getElementById('generateNote');
  const editingBanner = document.getElementById('editingBanner');
  const editingInvoiceNoLabel = document.getElementById('editingInvoiceNoLabel');
  const cancelEditBtn = document.getElementById('cancelEditBtn');
  const fromOrderBanner = document.getElementById('fromOrderBanner');
  const fromOrderNoLabel = document.getElementById('fromOrderNoLabel');
  const cancelFromOrderBtn = document.getElementById('cancelFromOrderBtn');
  let editingInvoiceId = null;
  let generatingFromOrder = null; // { id, orderNo } or null

  // ============= VIEW SWITCHING (role-gated nav) =============
  const views = {
    form: document.getElementById('formView'),
    invoices: document.getElementById('invoicesView'),
    customers: document.getElementById('customersView'),
    expenses: document.getElementById('expensesView'),
    products: document.getElementById('productsView'),
    orders: document.getElementById('ordersView'),
    performance: document.getElementById('performanceView'),
    summary: document.getElementById('summaryView'),
    deliveries: document.getElementById('deliveriesView'),
    logvisit: document.getElementById('logvisitView'),
    myvisits: document.getElementById('myvisitsView'),
  };
  const navBtns = {
    form: document.getElementById('navFormBtn'),
    invoices: document.getElementById('navInvoicesBtn'),
    customers: document.getElementById('navCustomersBtn'),
    expenses: document.getElementById('navExpensesBtn'),
    products: document.getElementById('navProductsBtn'),
    orders: document.getElementById('navOrdersBtn'),
    performance: document.getElementById('navPerformanceBtn'),
    summary: document.getElementById('navSummaryBtn'),
    deliveries: document.getElementById('navDeliveriesBtn'),
    logvisit: document.getElementById('navLogVisitBtn'),
    myvisits: document.getElementById('navMyVisitsBtn'),
  };

  const managerOnlyNav = ['invoices', 'products', 'performance', 'summary', 'deliveries'];
  const submitterOnlyNav = ['logvisit', 'myvisits'];

  managerOnlyNav.forEach(k => { navBtns[k].style.display = isManager ? 'inline-flex' : 'none'; });
  submitterOnlyNav.forEach(k => { navBtns[k].style.display = isManager ? 'none' : 'inline-flex'; });

  // Managers get a "Walk-in Invoice" tab (decision 4: stand-alone invoices from the same number sequence). Invoices for an
  // order are still reached from the Orders list, and editing from the Invoices list. Reps never see this tab.
  navBtns.form.style.display = isManager ? 'inline-flex' : 'none';
  navBtns.form.textContent = 'Walk-in Invoice';

  navBtns.orders.textContent = isManager ? 'Orders' : 'My Orders';
  document.getElementById('orderFilterCard').style.display = isManager ? 'block' : 'none';
  document.getElementById('addProductCard').style.display = isManager ? 'block' : 'none';

  const viewLoaders = {
    invoices: resetAndLoadInvoices,
    customers: resetAndLoadCustomers,
    expenses: resetAndLoadExpenses,
    products: resetAndLoadProducts,
    orders: resetAndLoadOrders,
    performance: loadPerformanceView,
    summary: loadSummaryView,
    deliveries: loadDeliveriesView,
    myvisits: resetAndLoadMyVisits,
    logvisit: async () => { if (window.__loadTodaysVisits) await window.__loadTodaysVisits(); },
  };

  async function showView(view) {
    Object.entries(views).forEach(([k, el]) => { if (el) el.style.display = k === view ? 'block' : 'none'; });
    Object.entries(navBtns).forEach(([k, btn]) => btn.classList.toggle('active', k === view));
    if (views[view]) fadeInView(views[view]);
    if (viewLoaders[view]) await viewLoaders[view]();
  }

  Object.keys(navBtns).forEach(k => {
    navBtns[k].addEventListener('click', () => showView(k));
  });


  // ============= NUMBERING (invoice numbers are automatic; managers can change the next number with a reason) =============
  const invPrefixInput = document.getElementById('invPrefix');
  const invCounterInput = document.getElementById('invCounter');
  const invYearDisplay = document.getElementById('invYearDisplay');
  invYearDisplay.value = currentYear();
  let counterStateNow = null;

  if (isManager) {
    try {
      await loadCounterState(true);
      watchCounterState((data) => {
        counterStateNow = data;
        invPrefixInput.value = data.prefix;
        invCounterInput.value = data.counter;
        invYearDisplay.value = currentYear();
        if (!editingInvoiceId) els.invoiceNo.value = buildInvoiceNo(data.prefix, data.counter);
      });
    } catch (err) {
      showToast(err.message, 'error');
    }

    const adjustBtn = document.getElementById('adjustNumberingBtn');
    const adjustModal = document.getElementById('adjustNumberModal');
    const adjustErr = document.getElementById('adjustNumberError');
    const adjustSaveBtn = document.getElementById('adjustNumberSaveBtn');
    const adjustPrefix = document.getElementById('adjustPrefix');
    const adjustCounter = document.getElementById('adjustCounter');
    const adjustReason = document.getElementById('adjustReason');
    let adjustRequestId = null, adjustSaving = false;
    adjustBtn.style.display = 'inline-block';
    const closeAdjust = () => { adjustModal.style.display = 'none'; };

    adjustBtn.addEventListener('click', () => {
      if (!counterStateNow) { showToast('Numbering is still loading.', 'info'); return; }
      adjustRequestId = newRequestId();                     // one id per opened dialog: a retry cannot apply twice
      adjustPrefix.value = counterStateNow.prefix;
      adjustCounter.value = counterStateNow.counter;
      adjustReason.value = '';
      adjustErr.style.display = 'none';
      document.getElementById('adjustNumberCurrent').textContent = `${counterStateNow.prefix}-${currentYear()}-${String(counterStateNow.counter).padStart(4, '0')}`;
      adjustModal.style.display = 'flex';
    });
    document.getElementById('adjustNumberCloseBtn').addEventListener('click', closeAdjust);
    document.getElementById('adjustNumberBackBtn').addEventListener('click', closeAdjust);

    async function loadNumberingAudit() {
      const wrap = document.getElementById('numberingAuditWrap');
      const body = document.getElementById('numberingAuditBody');
      try {
        const rows = await fetchCounterAdjustments(20);
        wrap.style.display = rows.length ? 'block' : 'none';
        body.innerHTML = rows.map(r => `<tr>
          <td>${esc(r.adjustedAt && r.adjustedAt.toDate ? r.adjustedAt.toDate().toLocaleString('en-GB', { timeZone: 'Africa/Blantyre' }) : '')}</td>
          <td>${esc(r.adjustedByEmail || '')}</td>
          <td>${esc(r.previousPrefix)} / ${esc(r.previousCounter)}</td>
          <td>${esc(r.newPrefix)} / ${esc(r.newCounter)}</td>
          <td>${esc(r.reason || '')}</td></tr>`).join('');
      } catch (err) { wrap.style.display = 'none'; }
    }

    adjustSaveBtn.addEventListener('click', async () => {
      if (adjustSaving) return;
      const prefix = adjustPrefix.value.trim();
      const counter = Number(adjustCounter.value);
      const problem = validateCounterAdjustment({ prefix, counter, reason: adjustReason.value });
      if (problem) { adjustErr.textContent = problem; adjustErr.style.display = 'block'; return; }
      if (counterStateNow && prefix === counterStateNow.prefix && counter < counterStateNow.counter &&
          !confirm(`The new number (${counter}) is LOWER than the current next number (${counterStateNow.counter}).\n\nThe system refuses any number that was already issued, but check the invoice list first. Continue?`)) return;
      adjustSaving = true;
      setButtonLoading(adjustSaveBtn, 'Saving…');
      try {
        const res = await adjustInvoiceCounter({ prefix, counter, reason: adjustReason.value, requestId: adjustRequestId, uid: user.uid, email: user.email });
        showToast(res.alreadyApplied ? 'That change had already been saved.' : `Next invoice number changed to ${prefix}-${currentYear()}-${String(counter).padStart(4, '0')}.`, 'success');
        closeAdjust();
        await loadNumberingAudit();
      } catch (err) {
        adjustErr.textContent = 'Could not change the numbering: ' + err.message;
        adjustErr.style.display = 'block';
      } finally {
        adjustSaving = false;
        clearButtonLoading(adjustSaveBtn);
      }
    });
    loadNumberingAudit();
  }


  function refreshPreview() { updatePreview(els); }

  // ============= PRODUCTS: catalog cache (used by quick-add grids) =============
  let productsCache = [];
  async function loadProductsCache() {
    productsCache = await fetchAllProducts();
    if (isManager) buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview, productsCache);
    buildQuickAddGrid(lvQuickAddGrid, lvOrderItemsBody, () => {}, productsCache, true);
  }

  // Live sync: stock changes made on ANY device (a manager adjusting
  // stock, an approval/cancellation elsewhere) update every connected
  // screen's quick-add grid within moments — this is what makes stock
  // tracking "live" rather than "accurate only after you refresh".
  // loadProductsCache() above is left in place and still called after
  // local mutations elsewhere in this file; it's now a harmless,
  // redundant read on top of this listener, not the only source of truth.
  function startProductsLiveSync() {
    watchAllProducts((products) => {
      productsCache = products;
      if (isManager) buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview, productsCache);
      buildQuickAddGrid(lvQuickAddGrid, lvOrderItemsBody, () => {}, productsCache, true);
    });
  }

  if (isManager) {
    try {
      const seeded = await seedDefaultProductsIfEmpty(user.uid);
      if (seeded) showToast('Loaded the default product catalog.', 'info');
    } catch (err) { console.error(err); }
  }

  // ============= CUSTOMERS: autocomplete cache (shared) =============
  let customersCache = [];
  async function loadCustomersCache() { customersCache = await fetchAllCustomers(); }
  await loadCustomersCache();

  // New customers are NOT given a weekday automatically. A manager chooses the visit day; until then the customer
  // is listed as "awaiting scheduling" for managers and is not on any rep's list.
  const VISIT_DAY_FULL_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };

  // ============= LOCATIONS: approved list cache (shared) =============
  let locationsCache = [];
  async function loadLocationsCache() { locationsCache = await fetchAllLocations(); }
  await loadLocationsCache();

  // ============= USER PROFILES: email -> display name (shared) =============
  // Used to show names instead of emails in reports (Rep Performance,
  // Stock Movement History, Order Preview, Expenses "By" column).
  let profilesByUid = {};
  async function loadProfilesCache() { profilesByUid = await fetchAllProfiles(); }
  await loadProfilesCache();
  function displayNameForEmail(email) { return resolveNameByEmail(profilesByUid, email); }

  // === references used by both roles ===
  const lvQuickAddGrid = document.getElementById('lvQuickAddGrid');
  const lvOrderItemsBody = document.getElementById('lvOrderItemsBody');

  await loadProductsCache();
  startProductsLiveSync();

  // ============= LOCATION PICKER (shared — used by both roles) =============
  // Uses Leaflet + OpenStreetMap tiles for the in-app pin-drop map (free,
  // no API key needed) and a plain Google Maps search-by-coordinate URL
  // for "view on map" (also free, no API key — a real embedded Google
  // Maps JS API widget would need a billing-enabled key from you).
  let lpMap = null, lpMarker = null, lpOnSave = null, lpCurrentLatLng = null;
  const locationPickerModal = document.getElementById('locationPickerModal');
  const lpCustomerLabel = document.getElementById('lpCustomerLabel');
  const lpCoordsLabel = document.getElementById('lpCoordsLabel');
  const lpErrorNote = document.getElementById('lpErrorNote');
  const lpCloseBtn = document.getElementById('lpCloseBtn');
  const lpCancelBtn = document.getElementById('lpCancelBtn');
  const lpSaveBtn = document.getElementById('lpSaveBtn');
  const lpUseMyLocationBtn = document.getElementById('lpUseMyLocationBtn');

  function lpUpdateCoordsLabel() {
    lpCoordsLabel.textContent = lpCurrentLatLng
      ? `Pinned at ${lpCurrentLatLng.lat.toFixed(6)}, ${lpCurrentLatLng.lng.toFixed(6)}`
      : 'No location set yet — tap the map to place a pin.';
  }

  function lpSetMarker(lat, lng) {
    lpCurrentLatLng = { lat, lng };
    if (!lpMarker) {
      lpMarker = window.L.marker([lat, lng], { draggable: true }).addTo(lpMap);
      lpMarker.on('dragend', () => {
        const pos = lpMarker.getLatLng();
        lpCurrentLatLng = { lat: pos.lat, lng: pos.lng };
        lpUpdateCoordsLabel();
      });
    } else {
      lpMarker.setLatLng([lat, lng]);
    }
    lpUpdateCoordsLabel();
  }

  // label: shown in the modal title. lat/lng: existing coordinates, if
  // any (null for a brand-new customer). onSave: async (latLng) => {}
  // called with the chosen {lat, lng} when the manager/rep hits Save.
  function openLocationPicker({ label, lat, lng, onSave }) {
    lpCustomerLabel.textContent = label || 'Customer';
    lpOnSave = onSave;
    lpErrorNote.style.display = 'none';
    locationPickerModal.style.display = 'flex';

    // Default center when there's no existing pin: Lilongwe, Malawi —
    // this app's home market — just so the map opens somewhere useful
    // instead of the middle of the ocean at (0,0).
    const startLat = (typeof lat === 'number') ? lat : -13.9626;
    const startLng = (typeof lng === 'number') ? lng : 33.7741;

    if (!lpMap) {
      lpMap = window.L.map('lpMap').setView([startLat, startLng], 14);
      window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      }).addTo(lpMap);
      lpMap.on('click', (e) => { lpSetMarker(e.latlng.lat, e.latlng.lng); });
    } else {
      lpMap.setView([startLat, startLng], 14);
    }

    if (typeof lat === 'number' && typeof lng === 'number') {
      lpSetMarker(lat, lng);
    } else {
      lpCurrentLatLng = null;
      if (lpMarker) { lpMap.removeLayer(lpMarker); lpMarker = null; }
      lpUpdateCoordsLabel();
    }

    // Leaflet can't measure a hidden container's size, so nudge it once
    // the modal is actually visible on screen.
    setTimeout(() => { if (lpMap) lpMap.invalidateSize(); }, 100);
  }

  function closeLocationPicker() {
    locationPickerModal.style.display = 'none';
    lpOnSave = null;
  }

  lpCloseBtn.addEventListener('click', closeLocationPicker);
  lpCancelBtn.addEventListener('click', closeLocationPicker);

  lpUseMyLocationBtn.addEventListener('click', () => {
    if (!navigator.geolocation) { showToast('Your browser does not support location services.', 'error'); return; }
    setButtonLoading(lpUseMyLocationBtn, 'Locating…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearButtonLoading(lpUseMyLocationBtn);
        lpMap.setView([pos.coords.latitude, pos.coords.longitude], 16);
        lpSetMarker(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        clearButtonLoading(lpUseMyLocationBtn);
        showToast('Could not get your current location: ' + err.message, 'error');
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });

  lpSaveBtn.addEventListener('click', async () => {
    if (!lpCurrentLatLng) {
      lpErrorNote.textContent = 'Tap the map (or use your current location) to place a pin first.';
      lpErrorNote.style.display = 'block';
      return;
    }
    if (typeof lpOnSave === 'function') {
      setButtonLoading(lpSaveBtn, 'Saving…');
      try {
        await lpOnSave(lpCurrentLatLng);
        closeLocationPicker();
      } catch (err) {
        lpErrorNote.textContent = 'Could not save: ' + err.message;
        lpErrorNote.style.display = 'block';
      } finally {
        clearButtonLoading(lpSaveBtn);
      }
    } else {
      closeLocationPicker();
    }
  });

  // ============= PROFILE MODAL (shared) =============
  const profileModal = document.getElementById('profileModal');
  const profileBtn = document.getElementById('profileBtn');
  const profileCloseBtn = document.getElementById('profileCloseBtn');
  const profileCancelBtn = document.getElementById('profileCancelBtn');
  const profileSaveBtn = document.getElementById('profileSaveBtn');
  const profileEmail = document.getElementById('profileEmail');
  const profileName = document.getElementById('profileName');
  const profileErrorNote = document.getElementById('profileErrorNote');
  const previewAsWrap = document.getElementById('previewAsWrap');
  const previewAsSelect = document.getElementById('previewAsSelect');

  function openProfileModal() {
    profileEmail.value = user.email;
    profileName.value = (profilesByUid[user.uid] && profilesByUid[user.uid].name) || '';
    profileErrorNote.style.display = 'none';
    if (realRole === 'manager') {
      previewAsWrap.style.display = 'block';
      previewAsSelect.value = localStorage.getItem('naisi_previewAsRole') === 'submitter' ? 'submitter' : 'manager';
    } else {
      previewAsWrap.style.display = 'none';
    }
    profileModal.style.display = 'flex';
  }
  function closeProfileModal() { profileModal.style.display = 'none'; }

  profileBtn.addEventListener('click', openProfileModal);
  profileCloseBtn.addEventListener('click', closeProfileModal);
  profileCancelBtn.addEventListener('click', closeProfileModal);
  profileModal.addEventListener('click', (e) => { if (e.target === profileModal) closeProfileModal(); });

  profileSaveBtn.addEventListener('click', async () => {
    setButtonLoading(profileSaveBtn, 'Saving…');
    try {
      await saveMyProfile(user.uid, { name: profileName.value, email: user.email });
      await loadProfilesCache();

      if (realRole === 'manager') {
        const currentOverride = localStorage.getItem('naisi_previewAsRole') === 'submitter' ? 'submitter' : 'manager';
        if (previewAsSelect.value !== currentOverride) {
          if (previewAsSelect.value === 'submitter') localStorage.setItem('naisi_previewAsRole', 'submitter');
          else localStorage.removeItem('naisi_previewAsRole');
          showToast('Switching preview mode…', 'info');
          window.location.reload();
          return;
        }
      }
      showToast('Profile saved.', 'success');
      closeProfileModal();
    } catch (err) {
      profileErrorNote.textContent = 'Could not save: ' + err.message;
      profileErrorNote.style.display = 'block';
    } finally {
      clearButtonLoading(profileSaveBtn);
    }
  });

  // ============= LOCATION SEARCH-SELECT (shared helper) =============
  // Wires a text input + suggestions dropdown to the approved locations
  // list only — this is what "standardizes locations" instead of free
  // text. Reps can only pick an existing entry; managers get offered an
  // inline "add this as a new standard location" option when what they
  // typed doesn't match anything yet.
  function initLocationSearchSelect(inputEl, suggestionsEl) {
    function render(matches) {
      if (!matches.length) { suggestionsEl.style.display = 'none'; suggestionsEl.innerHTML = ''; return; }
      suggestionsEl.innerHTML = matches.slice(0, 8).map(l => `
        <div class="suggestion-item" data-name="${esc(l.name)}"><span class="sug-name">${esc(l.name)}</span></div>
      `).join('');
      suggestionsEl.style.display = 'block';
    }
    inputEl.addEventListener('input', () => {
      const q = inputEl.value.trim().toLowerCase();
      if (!q) { suggestionsEl.style.display = 'none'; return; }
      render(locationsCache.filter(l => l.name.toLowerCase().includes(q)));
    });
    inputEl.addEventListener('focus', () => {
      if (inputEl.value.trim()) render(locationsCache.filter(l => l.name.toLowerCase().includes(inputEl.value.trim().toLowerCase())));
    });
    inputEl.addEventListener('blur', () => { setTimeout(() => { suggestionsEl.style.display = 'none'; }, 150); });
    suggestionsEl.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      inputEl.value = item.dataset.name;
      suggestionsEl.style.display = 'none';
    });
  }

  // Validates a typed location against the approved list before a
  // customer/invoice save proceeds. Returns the standardized name to
  // save, or null if the save should be blocked (error already shown).
  async function resolveLocationForSave(rawLocation) {
    const typed = normalizeText(rawLocation);
    if (!typed) return ''; // location is optional
    const existing = findLocationByName(locationsCache, typed);
    if (existing) return existing.name;

    // Reps are out in the field creating customers at genuinely new
    // locations all the time — blocking the whole customer save until
    // a manager pre-approves that location string would defeat the
    // point of their job. So a rep's new location is added right away
    // (flagged pendingReview so the manager can spot and clean up any
    // typos/duplicates later), never blocked.
    if (!isManager) {
      try {
        const added = await addLocation(typed, user.uid, { pendingReview: true });
        locationsCache.push(added);
        locationsCache.sort((a, b) => a.name.localeCompare(b.name));
        showToast(`New location "${added.name}" added.`, 'info');
        return added.name;
      } catch (err) {
        showToast('Could not save the location: ' + err.message, 'error');
        return null;
      }
    }

    const confirmed = confirm(`"${typed}" isn't in the approved locations list yet.\n\nAdd it as a new standard location and continue?`);
    if (!confirmed) return null;
    try {
      const added = await addLocation(typed, user.uid);
      locationsCache.push(added);
      locationsCache.sort((a, b) => a.name.localeCompare(b.name));
      return added.name;
    } catch (err) {
      showToast('Could not add the location: ' + err.message, 'error');
      return null;
    }
  }

  // ============= DUPLICATE CUSTOMER CHECK (shared helper) =============
  const duplicateCustomerModal = document.getElementById('duplicateCustomerModal');
  const dupMatchesList = document.getElementById('dupMatchesList');
  const dupCreateAnywayBtn = document.getElementById('dupCreateAnywayBtn');
  const dupCancelBtn = document.getElementById('dupCancelBtn');
  const dupCloseBtn = document.getElementById('dupCloseBtn');
  const dupManagerOnlyNote = document.getElementById('dupManagerOnlyNote');

  // Shows the duplicate modal if matches exist. Resolves to:
  //   { action: 'use', customer }   — user picked an existing record
  //   { action: 'create' }          — proceed with a new record anyway
  //   { action: 'cancel' }          — abort the save entirely
  // If there are no matches at all, resolves immediately to 'create'
  // without showing anything, so normal saves are never interrupted.
  function checkForDuplicateCustomer(candidate, excludeId = null) {
    const matches = findPossibleDuplicates(customersCache, candidate, excludeId);
    if (matches.length === 0) return Promise.resolve({ action: 'create' });

    return new Promise((resolve) => {
      dupMatchesList.innerHTML = matches.map(m => `
        <div class="suggestion-item" data-id="${esc(m.customer.id)}" style="border:1px solid var(--line); border-radius:8px; margin-bottom:8px; padding:10px 12px;">
          <div style="font-weight:700;">${esc(m.customer.name)}</div>
          <div style="font-size:0.78rem; color:var(--muted);">${esc(m.customer.phone || 'No phone')} · ${esc(m.customer.location || 'No location')}</div>
          <div style="font-size:0.72rem; color:#b3261e; margin-top:4px;">Matches on: ${esc(m.reasons.join(', '))}</div>
          <button type="button" class="list-action-btn" data-action="use-existing" style="margin-top:6px;">Use This Customer</button>
        </div>
      `).join('');
      dupManagerOnlyNote.style.display = isManager ? 'none' : 'block';
      dupCreateAnywayBtn.style.display = isManager ? 'block' : 'none';
      duplicateCustomerModal.style.display = 'flex';

      function cleanup() {
        duplicateCustomerModal.style.display = 'none';
        dupMatchesList.removeEventListener('click', onListClick);
        dupCreateAnywayBtn.removeEventListener('click', onCreateAnyway);
        dupCancelBtn.removeEventListener('click', onCancel);
        dupCloseBtn.removeEventListener('click', onCancel);
      }
      function onListClick(e) {
        const btn = e.target.closest('button[data-action="use-existing"]');
        if (!btn) return;
        const id = btn.closest('[data-id]').dataset.id;
        const customer = matches.find(m => m.customer.id === id).customer;
        cleanup();
        resolve({ action: 'use', customer });
      }
      function onCreateAnyway() {
        cleanup();
        resolve({ action: 'create' });
      }
      function onCancel() {
        cleanup();
        resolve({ action: 'cancel' });
      }
      dupMatchesList.addEventListener('click', onListClick);
      dupCreateAnywayBtn.addEventListener('click', onCreateAnyway);
      dupCancelBtn.addEventListener('click', onCancel);
      dupCloseBtn.addEventListener('click', onCancel);
    });
  }

  if (isManager) {
    document.getElementById('addItemBtn').addEventListener('click', () => {
      addItemRow(itemsBody, refreshPreview, 1, '', '');
      refreshPreview();
    });

    const custSuggestions = document.getElementById('custSuggestions');
    const saveCustomerBtn = document.getElementById('saveCustomerBtn');
    const customerSaveNote = document.getElementById('customerSaveNote');
    const custPinBtn = document.getElementById('custPinBtn');
    const custLatInput = document.getElementById('custLat');
    const custLngInput = document.getElementById('custLng');
    const custPinNote = document.getElementById('custPinNote');
    const custCustomerIdInput = document.getElementById('custCustomerId');
    const custPhoneError = document.getElementById('custPhoneError');

    initLocationSearchSelect(els.custLocation, document.getElementById('custLocationSuggestions'));

    custPinBtn.addEventListener('click', () => {
      const existingLat = custLatInput.value ? parseFloat(custLatInput.value) : null;
      const existingLng = custLngInput.value ? parseFloat(custLngInput.value) : null;
      openLocationPicker({
        label: els.custName.value.trim() || 'New Customer',
        lat: existingLat, lng: existingLng,
        onSave: async ({ lat, lng }) => {
          custLatInput.value = lat; custLngInput.value = lng;
          custPinNote.style.color = '';
          custPinNote.textContent = `Location pinned ✓ (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
        },
      });
    });

    function renderSuggestions(matches) {
      if (!matches.length) { custSuggestions.style.display = 'none'; custSuggestions.innerHTML = ''; return; }
      custSuggestions.innerHTML = matches.slice(0, 8).map(c => `
        <div class="suggestion-item" data-id="${esc(c.id)}">
          <span class="sug-name">${esc(c.name)}</span>
          <span class="sug-meta">${esc(c.phone || '')}${esc(c.phone && c.location ? ' · ' : '')}${esc(c.location || '')}</span>
        </div>
      `).join('');
      custSuggestions.style.display = 'block';
    }

    els.custName.addEventListener('input', () => {
      const q = els.custName.value.trim().toLowerCase();
      customerSaveNote.textContent = '';
      custCustomerIdInput.value = ''; // typing manually means this is no longer a confirmed existing-customer match
      if (!q) { custSuggestions.style.display = 'none'; return; }
      renderSuggestions(customersCache.filter(c => (c.name || '').toLowerCase().includes(q)));
    });
    els.custName.addEventListener('blur', () => { setTimeout(() => { custSuggestions.style.display = 'none'; }, 150); });
    custSuggestions.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      const customer = customersCache.find(c => c.id === item.dataset.id);
      if (!customer) return;
      els.custName.value = customer.name;
      els.custPhone.value = customer.phone ? formatPhoneForDisplay(customer.phone) : '';
      els.custLocation.value = customer.location || '';
      custCustomerIdInput.value = customer.id;
      custSuggestions.style.display = 'none';
      updatePreview(els);
    });

    saveCustomerBtn.addEventListener('click', async () => {
      const name = els.custName.value.trim();
      if (!name) { showToast('Enter a customer name first.', 'error'); return; }

      const pinLatValue = custLatInput.value ? parseFloat(custLatInput.value) : null;
      const pinLngValue = custLngInput.value ? parseFloat(custLngInput.value) : null;
      if (!isValidPin(pinLatValue, pinLngValue)) {
        custPinNote.textContent = '📍 A pinned location is required — tap "Pin Location on Map".';
        custPinNote.style.color = '#b3261e';
        showToast('Pin the customer\'s location on the map first.', 'error');
        return;
      }

      custPhoneError.style.display = 'none';
      const phoneResult = normalizePhone(els.custPhone.value);
      if (!phoneResult.valid) {
        custPhoneError.textContent = phoneResult.error;
        custPhoneError.style.display = 'block';
        return;
      }

      const resolvedLocation = await resolveLocationForSave(els.custLocation.value);
      if (resolvedLocation === null) return; // blocked or cancelled — message already shown
      els.custLocation.value = resolvedLocation;

      const dup = await checkForDuplicateCustomer(
        { name, phone: phoneResult.value, location: resolvedLocation }
      );
      if (dup.action === 'cancel') return;
      if (dup.action === 'use') {
        els.custName.value = dup.customer.name;
        els.custPhone.value = dup.customer.phone ? formatPhoneForDisplay(dup.customer.phone) : '';
        els.custLocation.value = dup.customer.location || '';
        custCustomerIdInput.value = dup.customer.id;
        updatePreview(els);
        showToast('Using existing customer.', 'info');
        return;
      }

      setButtonLoading(saveCustomerBtn, 'Saving…');
      try {
        const lat = custLatInput.value ? parseFloat(custLatInput.value) : null;
        const lng = custLngInput.value ? parseFloat(custLngInput.value) : null;
        const newId = await addCustomer({ name, phone: phoneResult.value, location: resolvedLocation, lat, lng, uid: user.uid });
        custCustomerIdInput.value = newId;
        customerSaveNote.textContent = 'Saved to customer list. Awaiting scheduling: choose a visit day under Customers.';
        showToast('Customer saved. Awaiting scheduling.', 'success');
        custLatInput.value = ''; custLngInput.value = ''; custPinNote.textContent = '';
        await loadCustomersCache();
      } catch (err) {
        showToast('Could not save the customer: ' + err.message, 'error');
      } finally {
        clearButtonLoading(saveCustomerBtn);
      }
    });
  }

  // ============= Add Customer (shared — both roles) =============
  const newCustName = document.getElementById('newCustName');
  const newCustPhone = document.getElementById('newCustPhone');
  const newCustPhoneError = document.getElementById('newCustPhoneError');
  const newCustLocation = document.getElementById('newCustLocation');
  const newCustLat = document.getElementById('newCustLat');
  const newCustLng = document.getElementById('newCustLng');
  const newCustPinBtn = document.getElementById('newCustPinBtn');
  const newCustPinNote = document.getElementById('newCustPinNote');
  const addCustomerBtn = document.getElementById('addCustomerBtn');
  const addCustomerNote = document.getElementById('addCustomerNote');

  initLocationSearchSelect(newCustLocation, document.getElementById('newCustLocationSuggestions'));

  newCustPinBtn.addEventListener('click', () => {
    const existingLat = newCustLat.value ? parseFloat(newCustLat.value) : null;
    const existingLng = newCustLng.value ? parseFloat(newCustLng.value) : null;
    openLocationPicker({
      label: newCustName.value.trim() || 'New Customer',
      lat: existingLat, lng: existingLng,
      onSave: async ({ lat, lng }) => {
        newCustLat.value = lat; newCustLng.value = lng;
        newCustPinNote.style.color = '';
        newCustPinNote.textContent = `Location pinned ✓ (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
      },
    });
  });

  addCustomerBtn.addEventListener('click', async () => {
    const name = newCustName.value.trim();
    if (!name) { showToast('Enter a customer name.', 'error'); return; }

    const pinLatValue = newCustLat.value ? parseFloat(newCustLat.value) : null;
    const pinLngValue = newCustLng.value ? parseFloat(newCustLng.value) : null;
    if (!isValidPin(pinLatValue, pinLngValue)) {
      newCustPinNote.textContent = '📍 A pinned location is required — tap "Pin Location on Map".';
      newCustPinNote.style.color = '#b3261e';
      showToast('Pin the customer\'s location on the map first.', 'error');
      return;
    }

    newCustPhoneError.style.display = 'none';
    const phoneResult = normalizePhone(newCustPhone.value);
    if (!phoneResult.valid) {
      newCustPhoneError.textContent = phoneResult.error;
      newCustPhoneError.style.display = 'block';
      return;
    }

    const resolvedLocation = await resolveLocationForSave(newCustLocation.value);
    if (resolvedLocation === null) return;
    newCustLocation.value = resolvedLocation;

    const dup = await checkForDuplicateCustomer({ name, phone: phoneResult.value, location: resolvedLocation });
    if (dup.action === 'cancel') return;
    if (dup.action === 'use') {
      showToast(`"${dup.customer.name}" already exists — no new record created.`, 'info');
      newCustName.value = ''; newCustPhone.value = ''; newCustLocation.value = '';
      newCustLat.value = ''; newCustLng.value = ''; newCustPinNote.textContent = '';
      return;
    }

    setButtonLoading(addCustomerBtn, 'Saving…');
    try {
      const lat = newCustLat.value ? parseFloat(newCustLat.value) : null;
      const lng = newCustLng.value ? parseFloat(newCustLng.value) : null;
      await addCustomer({ name, phone: phoneResult.value, location: resolvedLocation, lat, lng, uid: user.uid });
      newCustName.value = ''; newCustPhone.value = ''; newCustLocation.value = '';
      newCustLat.value = ''; newCustLng.value = ''; newCustPinNote.textContent = '';
      addCustomerNote.textContent = 'Customer added. Awaiting scheduling: a manager chooses the visit day.';
      showToast('Customer added. Awaiting scheduling.', 'success');
      await loadCustomersCache();
      await resetAndLoadCustomers();
      if (window.__refreshWeeklySchedule) window.__refreshWeeklySchedule();
    } catch (err) {
      showToast('Could not add customer: ' + err.message, 'error');
    } finally {
      clearButtonLoading(addCustomerBtn);
    }
  });

  const exportCustomersBtn = document.getElementById('exportCustomersBtn');
  exportCustomersBtn.addEventListener('click', async () => {
    setButtonLoading(exportCustomersBtn, 'Building report…');
    try {
      // customersCache is already the full, unpaginated customer list
      // (kept in sync by loadCustomersCache()) — no need for another read.
      if (!customersCache.length) { showToast('No customers to export yet.', 'info'); return; }
      await buildAndDownloadCustomerReport(customersCache);
      showToast('Customer list downloaded.', 'success');
    } catch (err) {
      showToast('Could not build the customer report: ' + err.message, 'error');
    } finally {
      clearButtonLoading(exportCustomersBtn);
    }
  });

  // ============= CUSTOMERS: manage list (shared — both roles can add/edit, read below) =============
  const customerListBody = document.getElementById('customerListBody');
  const customerListEmpty = document.getElementById('customerListEmpty');
  const loadMoreCustomersBtn = document.getElementById('loadMoreCustomersBtn');
  const customerSearchInput = document.getElementById('customerSearchInput');
  const customerSearchHint = document.getElementById('customerSearchHint');
  let loadedCustomers = [], customersCursor = null, customersHasMore = true;
  const customersGuard = createPagedLoadGuard();

  const VISIT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function customerDayCellHtml(c) {
    // Only managers choose or change a visit day. Reps (and a manager previewing the rep screen) see it as text.
    if (!isManager) return c.assignedDay ? esc(VISIT_DAY_FULL_NAMES[c.assignedDay] || c.assignedDay) : '<span style="color:var(--muted);">Awaiting scheduling</span>';
    const options = ['<option value="">—</option>'].concat(
      VISIT_DAYS.map(d => `<option value="${esc(d)}" ${esc(c.assignedDay === d ? 'selected' : '')}>${esc(d)}</option>`)
    ).join('');
    return `<select class="customer-day-select" data-id="${esc(c.id)}" style="min-width:68px; padding:4px; font-size:0.78rem; border:1.5px solid var(--line); border-radius:6px;">${options}</select>`;
  }

  function customerStatusCellHtml(c) {
    return (c.active !== false)
      ? `<span class="order-status-badge order-status-Approved">Active</span>`
      : `<span class="order-status-badge" style="background:#eee; color:var(--muted);">Inactive</span>`;
  }

  function customerMapCellHtml(c) {
    const hasPin = typeof c.lat === 'number' && typeof c.lng === 'number';
    if (hasPin) {
      return `<a href="${esc(googleMapsUrl(c.lat, c.lng))}" target="_blank" rel="noopener" class="map-link-btn">View on Map</a>
         <button type="button" class="map-pin-btn-small" data-action="set-location" style="margin-left:6px;">📍</button>`;
    }
    // No pin yet. A location NAME is not a delivery point, so there is
    // deliberately no "search by name" fallback any more — the only
    // action offered is to pin the customer.
    return `<span class="no-pin-tag">⚠ No pin</span><button type="button" class="map-pin-btn-small" data-action="set-location" style="margin-left:6px;">📍 Set Location</button>`;
  }

  function renderCustomerRows(list) {
    customerListBody.innerHTML = '';
    customerListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(c => {
      const isActive = c.active !== false;
      const tr = document.createElement('tr');
      tr.dataset.id = c.id;
      tr.innerHTML = `
        <td>${esc(c.name)}</td><td>${esc(c.phone ? formatPhoneForDisplay(c.phone) : '')}</td><td>${esc(c.location || '')}</td>
        <td>${customerDayCellHtml(c)}</td>
        <td>${customerMapCellHtml(c)}</td>
        <td>${customerStatusCellHtml(c)}</td>
        <td>
          <button type="button" class="list-action-btn" data-action="edit">Edit</button>
          ${isManager ? `<button type="button" class="list-action-btn ${esc(isActive ? 'exp-delete-btn' : '')}" data-action="${esc(isActive ? 'deactivate' : 'reactivate')}">${esc(isActive ? 'Deactivate' : 'Reactivate')}</button>` : ''}
        </td>
      `;
      customerListBody.appendChild(tr);
    });
  }

  function applyCustomerSearchAndRender() {
    const term = customerSearchInput.value.trim().toLowerCase();
    const showInactive = document.getElementById('showInactiveCustomersToggle').checked;
    const noPinOnly = document.getElementById('showNoPinOnlyToggle').checked;
    // "No pin" filter works on the FULL customer list (not just the pages
    // loaded so far) so nobody is missed.
    const source = noPinOnly ? customersCache : loadedCustomers;
    let filtered = showInactive ? source : source.filter(c => c.active !== false);
    if (noPinOnly) filtered = filtered.filter(c => !hasPin(c));
    if (term) filtered = filtered.filter(c => (c.name || '').toLowerCase().includes(term));
    renderCustomerRows(filtered);
    loadMoreCustomersBtn.style.display = (customersHasMore && !noPinOnly) ? 'block' : 'none';
    const missing = customersCache.filter(c => c.active !== false && !hasPin(c)).length;
    const banner = document.getElementById('customersNoPinBanner');
    banner.style.display = missing > 0 ? 'block' : 'none';
    banner.innerHTML = missing > 0
      ? `<strong>📍 ${esc(missing)} active customer${esc(missing === 1 ? '' : 's')} still ${esc(missing === 1 ? 'has' : 'have')} no pinned location.</strong><p>Deliveries need a pin. Tick the box below to list them, then tap "Set Location" on each.</p>`
      : '';
    customerSearchHint.textContent = term ? `Searching ${loadedCustomers.length} loaded customer${loadedCustomers.length === 1 ? '' : 's'}.` : '';
  }

  document.getElementById('showInactiveCustomersToggle').addEventListener('change', applyCustomerSearchAndRender);
  document.getElementById('showNoPinOnlyToggle').addEventListener('change', applyCustomerSearchAndRender);

  async function resetAndLoadCustomers() {
    customersGuard.reset();
    loadedCustomers = []; customersCursor = null; customersHasMore = true;
    customerSearchInput.value = '';
    await loadNextCustomerPage();
  }

  async function loadNextCustomerPage() {
    if (!customersHasMore) return;
    const cursor = customersCursor;
    await customersGuard.run({
      setLoading: (on) => (on ? setButtonLoading(loadMoreCustomersBtn, 'Loading…') : clearButtonLoading(loadMoreCustomersBtn)),
      fetch: () => fetchCustomersPage(cursor),
      apply: (result) => {
        loadedCustomers = mergeById(loadedCustomers, result.items);
        customersCursor = result.lastDoc;
        customersHasMore = result.hasMore;
        applyCustomerSearchAndRender();
        loadMoreCustomersBtn.style.display = customersHasMore ? 'block' : 'none';
      },
      onError: (err) => showToast('Could not load customers: ' + err.message, 'error'),
    });
  }

  loadMoreCustomersBtn.addEventListener('click', loadNextCustomerPage);
  customerSearchInput.addEventListener('input', applyCustomerSearchAndRender);

  customerListBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    if (btn.dataset.action === 'edit') {
      const c = loadedCustomers.find(c => c.id === id);
      if (!c) return;
      tr.innerHTML = `
        <td><input class="customer-edit-input" data-field="name" value="${esc(c.name || '')}"></td>
        <td>
          <input class="customer-edit-input" data-field="phone" value="${esc(c.phone ? formatPhoneForDisplay(c.phone) : '')}">
          <p class="customer-edit-phone-error" style="color:#b3261e; font-size:0.7rem; display:none; margin-top:2px;"></p>
        </td>
        <td style="position:relative;">
          <input class="customer-edit-input customer-edit-location" data-field="location" value="${esc(c.location || '')}" autocomplete="off">
          <div class="suggestions-dropdown customer-edit-location-suggestions" style="display:none;"></div>
        </td>
        <td>${customerDayCellHtml(c)}</td>
        <td>${customerMapCellHtml(c)}</td>
        <td>${customerStatusCellHtml(c)}</td>
        <td>
          <button type="button" class="list-action-btn" data-action="save">Save</button>
          <button type="button" class="list-action-btn" data-action="cancel">Cancel</button>
        </td>`;
      const locInput = tr.querySelector('.customer-edit-location');
      const locSuggestions = tr.querySelector('.customer-edit-location-suggestions');
      initLocationSearchSelect(locInput, locSuggestions);
    } else if (btn.dataset.action === 'cancel') {
      applyCustomerSearchAndRender();
    } else if (btn.dataset.action === 'deactivate') {
      const c = loadedCustomers.find(c => c.id === id);
      const confirmed = confirm(`Mark "${c?.name}" as inactive?\n\nThey'll be hidden from new orders and the weekly visit schedule, but every past order, visit, and invoice stays exactly as it is. You can reactivate any time.`);
      if (!confirmed) return;
      setButtonLoading(btn, '…');
      try {
        await deactivateCustomer(id, { uid: user.uid, email: user.email });
        const idx = loadedCustomers.findIndex(cc => cc.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], active: false, assignedDay: null };
        await loadCustomersCache();
        applyCustomerSearchAndRender();
        showToast('Customer marked inactive.', 'success');
        if (window.__refreshWeeklySchedule) window.__refreshWeeklySchedule();
      } catch (err) {
        showToast('Could not deactivate: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'reactivate') {
      setButtonLoading(btn, '…');
      try {
        await reactivateCustomer(id, { uid: user.uid, email: user.email });
        const idx = loadedCustomers.findIndex(cc => cc.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], active: true, assignedDay: null };
        await loadCustomersCache();
        applyCustomerSearchAndRender();
        showToast('Customer reactivated. It is awaiting scheduling: choose a visit day.', 'success');
        if (window.__refreshWeeklySchedule) window.__refreshWeeklySchedule();
      } catch (err) {
        showToast('Could not reactivate: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'set-location') {
      const c = loadedCustomers.find(c => c.id === id);
      if (!c) return;
      openLocationPicker({
        label: c.name,
        lat: typeof c.lat === 'number' ? c.lat : null,
        lng: typeof c.lng === 'number' ? c.lng : null,
        onSave: async ({ lat, lng }) => {
          await updateCustomerLocation(id, { lat, lng });
          const idx = loadedCustomers.findIndex(cc => cc.id === id);
          if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], lat, lng };
          await loadCustomersCache();
          applyCustomerSearchAndRender();
          showToast('Location saved.', 'success');
        },
      });
    } else if (btn.dataset.action === 'save') {
      const name = tr.querySelector('[data-field="name"]').value.trim();
      const rawPhone = tr.querySelector('[data-field="phone"]').value;
      const rawLocation = tr.querySelector('[data-field="location"]').value;
      if (!name) { showToast('Name cannot be empty.', 'error'); return; }

      const phoneErrorEl = tr.querySelector('.customer-edit-phone-error');
      phoneErrorEl.style.display = 'none';
      const phoneResult = normalizePhone(rawPhone);
      if (!phoneResult.valid) {
        phoneErrorEl.textContent = phoneResult.error;
        phoneErrorEl.style.display = 'block';
        return;
      }

      const resolvedLocation = await resolveLocationForSave(rawLocation);
      if (resolvedLocation === null) return;

      const dup = await checkForDuplicateCustomer({ name, phone: phoneResult.value, location: resolvedLocation }, id);
      if (dup.action === 'cancel') return;
      if (dup.action === 'use') {
        showToast(`That matches "${dup.customer.name}" — edit cancelled to avoid creating a duplicate.`, 'info');
        applyCustomerSearchAndRender();
        return;
      }

      setButtonLoading(btn, 'Saving…');
      try {
        await updateCustomer(id, { name, phone: phoneResult.value, location: resolvedLocation });
        const idx = loadedCustomers.findIndex(c => c.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], name, phone: phoneResult.value, location: resolvedLocation };
        await loadCustomersCache();
        applyCustomerSearchAndRender();
        showToast('Customer updated.', 'success');
      } catch (err) {
        showToast('Could not update: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    }
  });

  customerListBody.addEventListener('change', async (e) => {
    const select = e.target.closest('.customer-day-select');
    if (!select || !isManager) return;
    const id = select.dataset.id;
    const day = select.value || null;
    select.disabled = true;
    try {
      await setCustomerVisitDay(id, day, { uid: user.uid, email: user.email });
      const idx = loadedCustomers.findIndex(c => c.id === id);
      if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], assignedDay: day };
      await loadCustomersCache();
      showToast('Visit day updated.', 'success');
      if (window.__refreshWeeklySchedule) window.__refreshWeeklySchedule();
    } catch (err) {
      showToast('Could not update visit day: ' + err.message, 'error');
    } finally {
      select.disabled = false;
    }
  });

  // ============= WEEKLY VISIT SCHEDULE (manager only) =============
  if (isManager) {
    document.getElementById('weeklyScheduleCard').style.display = 'block';
    const scheduleDayTabs = document.getElementById('scheduleDayTabs');
    const scheduleDayList = document.getElementById('scheduleDayList');
    const scheduleDayLabels = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
    let currentScheduleDay = VISIT_DAYS.includes(malawiWeekday()) ? malawiWeekday() : 'Mon';

    function renderScheduleDayTabs() {
      scheduleDayTabs.innerHTML = VISIT_DAYS.map(d => `
        <button type="button" class="list-action-btn schedule-day-tab" data-day="${esc(d)}" style="${esc(d === currentScheduleDay ? 'background:var(--leaf); color:#fff; border-color:var(--leaf);' : '')}">${esc(scheduleDayLabels[d])}</button>
      `).join('');
    }

    function renderScheduleDayList() {
      const customersForDay = customersCache.filter(c => c.active !== false && c.assignedDay === currentScheduleDay);
      scheduleDayList.innerHTML = customersForDay.length
        ? `<p style="font-size:0.78rem; color:var(--muted); margin-bottom:8px;">${esc(customersForDay.length)} customer${esc(customersForDay.length === 1 ? '' : 's')} on ${esc(scheduleDayLabels[currentScheduleDay])}</p>` +
          customersForDay.map(c => `
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--line);">
              <span>${esc(c.name)}${c.location ? ` <span style="color:var(--muted); font-size:0.8rem;">— ${esc(c.location)}</span>` : ''}</span>
              ${customerDayCellHtml(c)}
            </div>
          `).join('')
        : `<p style="color:var(--muted); font-size:0.85rem;">No customers assigned to ${esc(scheduleDayLabels[currentScheduleDay])} yet — set a day per customer in the Manage Customers table above.</p>`;
    }

    // Customers with no visit day yet: shown to managers so none is forgotten. They are not on any rep's list and not targets.
    const awaitingBox = document.getElementById('awaitingSchedulingBox');
    const awaitingList = document.getElementById('awaitingSchedulingList');
    function renderAwaitingScheduling() {
      const list = awaitingScheduling(customersCache);
      awaitingBox.style.display = list.length ? 'block' : 'none';
      document.getElementById('awaitingSchedulingTitle').textContent = `Awaiting scheduling (${list.length})`;
      awaitingList.innerHTML = list.map(c => `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--line);">
          <span>${esc(c.name)}${c.location ? ` <span style="color:var(--muted); font-size:0.8rem;">— ${esc(c.location)}</span>` : ''}</span>
          ${customerDayCellHtml(c)}
        </div>`).join('');
    }
    awaitingList.addEventListener('change', async (e) => {
      const select = e.target.closest('.customer-day-select');
      if (!select) return;
      const id = select.dataset.id, day = select.value || null;
      if (!day) return;
      select.disabled = true;
      try {
        await setCustomerVisitDay(id, day, { uid: user.uid, email: user.email });
        await loadCustomersCache();
        const idx = loadedCustomers.findIndex(c => c.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], assignedDay: day };
        applyCustomerSearchAndRender();
        showToast('Visit day set.', 'success');
      } catch (err) {
        showToast('Could not set the visit day: ' + err.message, 'error');
      } finally {
        refreshWeeklySchedule();
      }
    });

    function refreshWeeklySchedule() {
      renderScheduleDayTabs();
      renderScheduleDayList();
      renderAwaitingScheduling();
    }

    scheduleDayTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.schedule-day-tab');
      if (!btn) return;
      currentScheduleDay = btn.dataset.day;
      refreshWeeklySchedule();
    });

    // Managers can change a customer's weekly day right here too (same save as the Manage Customers table).
    scheduleDayList.addEventListener('change', async (e) => {
      const select = e.target.closest('.customer-day-select');
      if (!select) return;
      const id = select.dataset.id, day = select.value || null;
      select.disabled = true;
      try {
        await setCustomerVisitDay(id, day, { uid: user.uid, email: user.email });
        await loadCustomersCache();
        const idx = loadedCustomers.findIndex(c => c.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], assignedDay: day };
        applyCustomerSearchAndRender();
        showToast('Visit day updated.', 'success');
      } catch (err) {
        showToast('Could not update visit day: ' + err.message, 'error');
      } finally {
        refreshWeeklySchedule();
      }
    });

    // ---- Import planned days from a spreadsheet (manager). Reviewed rows are applied through the same guarded, dated schedule change. ----
    const importPanel = document.getElementById('importDaysPanel');
    const importResult = document.getElementById('importDaysResult');
    document.getElementById('importDaysToggleBtn').addEventListener('click', () => {
      importPanel.style.display = importPanel.style.display === 'none' ? 'block' : 'none';
    });
    let importState = null;     // { rows, choices: {line: customerId}, off: Set(line) }
    const importDayLabel = (d) => d ? scheduleDayLabels[d] : 'no day';
    function renderImport() {
      const { rows, choices, off } = importState;
      const { moves, notes } = buildMoves(rows, customersCache, choices);
      const moveByLine = new Map(moves.map(m => [m.line, m]));
      const noteByLine = new Map(notes.map(n => [n.line, n]));
      const need = rows.filter(r => r.status === 'choose' && !choices[r.line]).length;
      const missing = rows.filter(r => r.status === 'missing');
      const skipped = rows.filter(r => r.status === 'skip');
      const optionsFor = (r) => `<option value="">- choose the right customer -</option>` + r.candidates.map(id => {
        const c = customersCache.find(x => x.id === id);
        return c ? `<option value="${esc(id)}" ${esc(choices[r.line] === id ? 'selected' : '')}>${esc(c.name)}${c.location ? ' - ' + esc(c.location) : ''} (now: ${esc(importDayLabel(c.assignedDay))})</option>` : '';
      }).join('');
      const line = (r) => {
        const m = moveByLine.get(r.line), n = noteByLine.get(r.line);
        if (r.status === 'matched' || (r.status === 'choose' && choices[r.line])) {
          const c = customersCache.find(x => x.id === (r.customerId || choices[r.line]));
          if (m) return `<label style="display:flex; gap:8px; align-items:center; padding:4px 0; border-bottom:1px solid var(--line); font-size:0.85rem;"><input type="checkbox" class="import-move" data-line="${esc(r.line)}" ${esc(off.has(r.line) ? '' : 'checked')}> <span style="flex:1;">${esc(m.name)}${r.status === 'choose' ? ' <em>(you chose)</em>' : ''}</span><span style="color:var(--muted);">${esc(importDayLabel(m.from))} → <strong>${esc(scheduleDayLabels[m.to])}</strong></span></label>`;
          return `<div class="import-note" style="padding:4px 0; border-bottom:1px solid var(--line); font-size:0.85rem; color:var(--muted);">${esc(c ? c.name : r.planName)}: ${esc(n ? n.why : 'no change')}</div>`;
        }
        if (r.status === 'choose') return `<div style="padding:6px 0; border-bottom:1px solid var(--line); font-size:0.85rem;"><strong>${esc(r.planName)}</strong> → ${esc(scheduleDayLabels[r.day])} <span style="color:var(--muted);">(${esc(r.how)})</span><br><select class="import-choice" data-line="${esc(r.line)}" style="max-width:100%;">${optionsFor(r)}</select></div>`;
        return '';
      };
      importResult.innerHTML = `
        <p class="numbering-hint" id="importSummary">${esc(rows.length)} rows read: ${esc(moves.length)} change${esc(moves.length === 1 ? '' : 's')} ready, ${esc(notes.length)} already correct or not possible, ${esc(need)} need your choice, ${esc(missing.length)} not found in the app, ${esc(skipped.length)} skipped.</p>
        ${rows.map(line).join('')}
        ${missing.length ? `<p class="numbering-hint" id="importMissing" style="margin-top:8px;"><strong>Not found in the app</strong> (add each with a map pin first, then import again): ${missing.map(r => esc(r.planName)).join(', ')}.</p>` : ''}
        ${skipped.length ? `<p class="numbering-hint" style="margin-top:8px;">Skipped (not existing customers or no valid day): ${skipped.map(r => esc(r.planName) + ' (' + esc(r.note) + ')').join('; ')}</p>` : ''}
        ${moves.length ? '<button type="button" class="list-action-btn" id="importApplyBtn" style="margin-top:10px; background:var(--leaf); color:#fff; border-color:var(--leaf);">Apply ticked changes</button> <span id="importProgress" style="font-size:0.82rem; margin-left:8px;"></span>' : ''}`;
    }
    document.getElementById('importDaysFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        let table;
        if (/\.csv$/i.test(file.name)) table = parseCsv(await file.text());
        else { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await file.arrayBuffer()); table = rowsFromWorksheet(wb.worksheets[0]); }
        await loadCustomersCache();                      // match against the latest saved customers
        importState = { rows: planImport(readTable(table), customersCache), choices: {}, off: new Set() };
        renderImport();
      } catch (err) { importState = null; importResult.innerHTML = ''; showToast('Could not read the file: ' + err.message, 'error'); }
    });
    importResult.addEventListener('change', (e) => {
      if (!importState) return;
      const sel = e.target.closest('.import-choice');
      if (sel) { if (sel.value) importState.choices[sel.dataset.line] = sel.value; else delete importState.choices[sel.dataset.line]; importState.choices = { ...importState.choices }; renderImport(); return; }
      const cb = e.target.closest('.import-move');
      if (cb) { const l = Number(cb.dataset.line); if (cb.checked) importState.off.delete(l); else importState.off.add(l); }
    });
    importResult.addEventListener('click', async (e) => {
      const btn = e.target.closest('#importApplyBtn');
      if (!btn || !importState) return;
      const chosen = buildMoves(importState.rows, customersCache, Object.fromEntries(Object.entries(importState.choices).map(([k, v]) => [Number(k), v]))).moves.filter(m => !importState.off.has(m.line));
      if (!chosen.length) { showToast('Nothing is ticked.', 'error'); return; }
      if (!confirm(`Change the visit day of ${chosen.length} shop${chosen.length === 1 ? '' : 's'}? This takes effect from today and is saved in the schedule history.`)) return;
      btn.disabled = true;
      const prog = document.getElementById('importProgress');
      const res = await applySuggestions(chosen, {
        setDay: (id, to, from) => setCustomerVisitDay(id, to, { uid: user.uid, email: user.email, expectedDay: from }),
        onProgress: (d, t) => { prog.textContent = `${d} of ${t}...`; },
      });
      await loadCustomersCache(); applyCustomerSearchAndRender(); refreshWeeklySchedule();
      importState = null; document.getElementById('importDaysFile').value = '';
      importResult.innerHTML = `<p id="importDone" style="font-size:0.9rem;"><strong>${esc(res.applied.length)} changed.</strong>` +
        (res.stale.length ? ` ${res.stale.length} skipped because someone changed them meanwhile: ${res.stale.map(m => esc(m.name)).join(', ')}.` : '') +
        (res.failed.length ? ` ${res.failed.length} failed: ${res.failed.map(m => esc(m.name) + ' (' + esc(m.error) + ')').join('; ')}.` : '') + '</p>';
      showToast(`${res.applied.length} visit day${res.applied.length === 1 ? '' : 's'} updated.`, res.failed.length ? 'error' : 'success');
    });


    // ---- Suggest schedule by distance (manager). Proposes only; applying goes through setCustomerVisitDay (dated history). ----
    const suggestPanel = document.getElementById('suggestSchedulePanel');
    const suggestResult = document.getElementById('suggestResult');
    document.getElementById('suggestDayChecks').innerHTML = DEFAULT_DAYS.map(d =>
      `<label style="font-size:0.85rem; display:flex; align-items:center; gap:4px;"><input type="checkbox" class="suggest-day" value="${esc(d)}" checked> ${esc(scheduleDayLabels[d])}</label>`).join('');
    document.getElementById('suggestScheduleToggleBtn').addEventListener('click', () => {
      suggestPanel.style.display = suggestPanel.style.display === 'none' ? 'block' : 'none';
    });
    let currentSuggestion = null;
    const kmText = (k) => (k === null || k === undefined) ? 'n/a' : formatKm(k);
    function renderSuggestion(r) {
      const dayRows = DEFAULT_DAYS.map(d => {
        const b = r.before.perDay.find(x => x.day === d), a = r.after.perDay.find(x => x.day === d);
        return (b || a) ? `<tr><td>${esc(scheduleDayLabels[d])}</td><td>${esc(b ? b.count : 0)} → ${esc(a ? a.count : 0)}</td><td>${esc(b ? kmText(b.km) : '-')} → ${esc(a ? kmText(a.km) : '-')}</td></tr>` : '';
      }).join('');
      const moveRows = r.moves.map((m, i) => `<label style="display:flex; gap:8px; align-items:center; padding:4px 0; border-bottom:1px solid var(--line); font-size:0.85rem;">
          <input type="checkbox" class="suggest-move" data-i="${esc(i)}" checked> <span style="flex:1;">${esc(m.name)}</span>
          <span style="color:var(--muted);">${esc(m.from ? scheduleDayLabels[m.from] : 'no day')} → <strong>${esc(scheduleDayLabels[m.to])}</strong></span></label>`).join('');
      const skipped = r.skipped.length ? `<p class="numbering-hint" id="suggestSkipped" style="margin-top:8px;">${esc(r.skipped.length)} shop${esc(r.skipped.length === 1 ? '' : 's')} could not be placed because there is no map pin (they are left as they are): ${r.skipped.map(x => esc(x.name)).join(', ')}.</p>` : '';
      suggestResult.innerHTML = `
        <table style="width:100%; font-size:0.82rem; border-collapse:collapse; margin-bottom:8px;"><thead><tr style="text-align:left; color:var(--muted);"><th>Day</th><th>Shops (now → suggested)</th><th>Approx. route (now → suggested)</th></tr></thead><tbody>${dayRows}</tbody></table>
        <p class="numbering-hint" id="suggestTotals">Total approx. route (straight-line): ${esc(kmText(r.before.totalKm))} now → ${esc(kmText(r.after.totalKm))} suggested.</p>
        ${r.moves.length ? `<div style="max-height:260px; overflow:auto; margin:8px 0;">${moveRows}</div>
          <button type="button" class="list-action-btn" id="suggestApplyBtn" style="background:var(--leaf); color:#fff; border-color:var(--leaf);">Apply ticked changes</button>
          <span id="suggestProgress" style="font-size:0.82rem; margin-left:8px;"></span>`
        : '<p style="font-size:0.9rem;">No changes suggested: the current plan already fits the shop locations (or there is nothing to place).</p>'}
        ${skipped}`;
    }
    document.getElementById('suggestCalcBtn').addEventListener('click', async () => {
      const btn = document.getElementById('suggestCalcBtn');
      const days = [...document.querySelectorAll('.suggest-day:checked')].map(x => x.value);
      if (!days.length) { showToast('Tick at least one visit day.', 'error'); return; }
      const scope = document.querySelector('input[name="suggestScope"]:checked').value;
      btn.disabled = true;
      try {
        await loadCustomersCache();                    // always plan from the latest saved schedule
        currentSuggestion = suggestSchedule(customersCache, { days, scope });
        renderSuggestion(currentSuggestion);
      } catch (err) { showToast('Could not calculate: ' + err.message, 'error'); }
      finally { btn.disabled = false; }
    });
    suggestResult.addEventListener('click', async (e) => {
      const btn = e.target.closest('#suggestApplyBtn');
      if (!btn || !currentSuggestion) return;
      const chosen = [...suggestResult.querySelectorAll('.suggest-move:checked')].map(x => currentSuggestion.moves[Number(x.dataset.i)]);
      if (!chosen.length) { showToast('Nothing is ticked.', 'error'); return; }
      if (!confirm(`Change the visit day of ${chosen.length} shop${chosen.length === 1 ? '' : 's'}? This takes effect from today and is saved in the schedule history.`)) return;
      btn.disabled = true;
      const prog = document.getElementById('suggestProgress');
      const res = await applySuggestions(chosen, {
        setDay: (id, to, from) => setCustomerVisitDay(id, to, { uid: user.uid, email: user.email, expectedDay: from }),
        onProgress: (d, t) => { prog.textContent = `${d} of ${t}...`; },
      });
      await loadCustomersCache(); applyCustomerSearchAndRender(); refreshWeeklySchedule();
      currentSuggestion = null;
      suggestResult.innerHTML = `<p id="suggestSummary" style="font-size:0.9rem;"><strong>${esc(res.applied.length)} changed.</strong>` +
        (res.stale.length ? ` ${res.stale.length} skipped because someone changed them meanwhile: ${res.stale.map(m => esc(m.name)).join(', ')}.` : '') +
        (res.failed.length ? ` ${res.failed.length} failed: ${res.failed.map(m => esc(m.name) + ' (' + esc(m.error) + ')').join('; ')}.` : '') + '</p>';
      showToast(`${res.applied.length} visit day${res.applied.length === 1 ? '' : 's'} updated.`, res.failed.length ? 'error' : 'success');
    });


    refreshWeeklySchedule();
    window.__refreshWeeklySchedule = refreshWeeklySchedule;
  }

  // ============= MANAGE LOCATIONS (manager only) =============
  if (isManager) {
    document.getElementById('manageLocationsCard').style.display = 'block';
    const newLocationName = document.getElementById('newLocationName');
    const addLocationBtn = document.getElementById('addLocationBtn');
    const locationsList = document.getElementById('locationsList');

    function renderLocationsList() {
      locationsList.innerHTML = locationsCache.length
        ? locationsCache.map(l => `
            <span style="display:inline-flex; align-items:center; gap:6px; background:${esc(l.pendingReview ? '#fff4e0' : '#f7f6f2')}; border-radius:20px; padding:6px 8px 6px 14px; font-size:0.82rem;">
              ${esc(l.name)}
              ${l.pendingReview ? `<span style="color:#7a5210; font-weight:700; font-size:0.68rem; text-transform:uppercase;">New</span>
                <button type="button" class="map-pin-btn-small" data-action="review-location" data-id="${esc(l.id)}" style="border:none; background:none; color:var(--forest-2); padding:2px 6px;" title="Mark reviewed">✓</button>` : ''}
              <button type="button" class="map-pin-btn-small" data-action="delete-location" data-id="${esc(l.id)}" style="border:none; background:none; color:#b3261e; padding:2px 6px;">✕</button>
            </span>
          `).join('')
        : `<p style="color:var(--muted); font-size:0.82rem;">No approved locations yet — add your first one above.</p>`;
    }
    renderLocationsList();

    addLocationBtn.addEventListener('click', async () => {
      const name = newLocationName.value.trim();
      if (!name) { showToast('Enter a location name.', 'error'); return; }
      if (findLocationByName(locationsCache, name)) { showToast('That location is already in the list.', 'info'); return; }
      setButtonLoading(addLocationBtn, 'Adding…');
      try {
        const added = await addLocation(name, user.uid);
        locationsCache.push(added);
        locationsCache.sort((a, b) => a.name.localeCompare(b.name));
        renderLocationsList();
        newLocationName.value = '';
        showToast('Location added.', 'success');
      } catch (err) {
        showToast('Could not add location: ' + err.message, 'error');
      } finally {
        clearButtonLoading(addLocationBtn);
      }
    });

    locationsList.addEventListener('click', async (e) => {
      const reviewBtn = e.target.closest('button[data-action="review-location"]');
      if (reviewBtn) {
        const loc = locationsCache.find(l => l.id === reviewBtn.dataset.id);
        if (!loc) return;
        try {
          await markLocationReviewed(loc.id);
          loc.pendingReview = false;
          renderLocationsList();
          showToast('Marked as reviewed.', 'success');
        } catch (err) {
          showToast('Could not update: ' + err.message, 'error');
        }
        return;
      }
      const btn = e.target.closest('button[data-action="delete-location"]');
      if (!btn) return;
      const loc = locationsCache.find(l => l.id === btn.dataset.id);
      if (!loc) return;
      const confirmed = confirm(`Remove "${loc.name}" from the approved locations list?\n\nExisting customers already using it are unaffected — this only stops it appearing as a suggestion for new entries.`);
      if (!confirmed) return;
      try {
        await deleteLocation(loc.id);
        locationsCache = locationsCache.filter(l => l.id !== loc.id);
        renderLocationsList();
        showToast('Location removed.', 'success');
      } catch (err) {
        showToast('Could not remove location: ' + err.message, 'error');
      }
    });
  }

  // ============= MERGE CUSTOMERS (manager only) =============
  if (isManager) {
    document.getElementById('mergeCustomersCard').style.display = 'block';
    const mergeKeepSearch = document.getElementById('mergeKeepSearch');
    const mergeKeepSuggestions = document.getElementById('mergeKeepSuggestions');
    const mergeAwaySearch = document.getElementById('mergeAwaySearch');
    const mergeAwaySuggestions = document.getElementById('mergeAwaySuggestions');
    const mergePreview = document.getElementById('mergePreview');
    const mergeConfirmBtn = document.getElementById('mergeConfirmBtn');
    let mergeKeepCustomer = null, mergeAwayCustomer = null;

    function wireMergeSearch(inputEl, suggestionsEl, onPick) {
      inputEl.addEventListener('input', () => {
        const q = inputEl.value.trim().toLowerCase();
        if (!q) { suggestionsEl.style.display = 'none'; return; }
        const matches = customersCache.filter(c => (c.name || '').toLowerCase().includes(q)).slice(0, 8);
        if (!matches.length) { suggestionsEl.style.display = 'none'; return; }
        suggestionsEl.innerHTML = matches.map(c => `
          <div class="suggestion-item" data-id="${esc(c.id)}">
            <span class="sug-name">${esc(c.name)}</span>
            <span class="sug-meta">${esc(c.phone ? formatPhoneForDisplay(c.phone) : '')}${esc(c.phone && c.location ? ' · ' : '')}${esc(c.location || '')}</span>
          </div>
        `).join('');
        suggestionsEl.style.display = 'block';
      });
      inputEl.addEventListener('blur', () => setTimeout(() => { suggestionsEl.style.display = 'none'; }, 150));
      suggestionsEl.addEventListener('mousedown', (e) => {
        const item = e.target.closest('.suggestion-item');
        if (!item) return;
        const customer = customersCache.find(c => c.id === item.dataset.id);
        if (!customer) return;
        inputEl.value = customer.name;
        suggestionsEl.style.display = 'none';
        onPick(customer);
      });
    }

    async function updateMergePreview() {
      mergeConfirmBtn.style.display = 'none';
      mergePreview.style.display = 'none';
      if (!mergeKeepCustomer || !mergeAwayCustomer) return;
      if (mergeKeepCustomer.id === mergeAwayCustomer.id) {
        mergePreview.style.display = 'block';
        mergePreview.innerHTML = `<span style="color:#b3261e;">Choose two different customers.</span>`;
        return;
      }
      mergePreview.style.display = 'block';
      mergePreview.innerHTML = 'Checking activity to move…';
      try {
        const counts = await countCustomerActivity(mergeAwayCustomer.id);
        const blockedNote = counts.invoicing.length
          ? `<br><span style="color:#b3261e;"><strong>Cannot merge yet:</strong> order(s) ${counts.invoicing.map(esc).join(', ')} are being invoiced right now. Wait until invoicing finishes, then try again.</span>`
          : '';
        mergePreview.innerHTML = `
          <strong>${esc(mergeAwayCustomer.name)}</strong> will be removed as a customer. Its
          <strong>${esc(counts.orders)}</strong> order(s), <strong>${esc(counts.visits)}</strong> visit(s), and
          <strong>${esc(counts.invoices)}</strong> invoice(s) will move onto <strong>${esc(mergeKeepCustomer.name)}</strong>
          (amounts, numbers, statuses and invoice links are not changed; its schedule history is kept).
          ${blockedNote}
          <br><span style="color:var(--muted); font-size:0.78rem;">Note: only invoices created since this merge feature shipped carry the link needed to move — older invoices won't be found by this count.</span>
        `;
        mergeConfirmBtn.style.display = 'block';
      } catch (err) {
        mergePreview.innerHTML = `<span style="color:#b3261e;">Could not check activity: ${esc(err.message)}</span>`;
      }
    }

    wireMergeSearch(mergeKeepSearch, mergeKeepSuggestions, (c) => { mergeKeepCustomer = c; updateMergePreview(); });
    wireMergeSearch(mergeAwaySearch, mergeAwaySuggestions, (c) => { mergeAwayCustomer = c; updateMergePreview(); });

    mergeConfirmBtn.addEventListener('click', async () => {
      if (!mergeKeepCustomer || !mergeAwayCustomer) return;
      const confirmed = confirm(`Merge "${mergeAwayCustomer.name}" into "${mergeKeepCustomer.name}"?\n\nThis cannot be undone.`);
      if (!confirmed) return;
      setButtonLoading(mergeConfirmBtn, 'Merging…');
      try {
        const result = await mergeCustomers(mergeKeepCustomer.id, mergeAwayCustomer.id, { uid: user.uid, email: user.email });
        showToast(`Merged. Moved ${result.orders} order(s), ${result.visits} visit(s), ${result.invoices} invoice(s).`, 'success');
        mergeKeepSearch.value = ''; mergeAwaySearch.value = '';
        mergeKeepCustomer = null; mergeAwayCustomer = null;
        mergePreview.style.display = 'none'; mergeConfirmBtn.style.display = 'none';
        await loadCustomersCache();
        await resetAndLoadCustomers();
        if (window.__refreshWeeklySchedule) window.__refreshWeeklySchedule();
      } catch (err) {
        if (err.code === 'merge-blocked-invoicing') {
          // Clear message; nothing was moved or deleted; the manager simply tries again later (no automatic queue).
          mergePreview.style.display = 'block';
          mergePreview.innerHTML = `<span style="color:#b3261e;" role="alert">${esc(err.message)}</span>`;
          showToast('The merge was not done: an order is being invoiced. Try again after invoicing finishes.', 'error', 8000);
        } else {
          mergePreview.style.display = 'block';
          mergePreview.innerHTML = `<span style="color:#b3261e;" role="alert">${esc(err.message)}</span>
            <br><span style="font-size:0.8rem;">If the merge stopped part-way, press Confirm Merge again to finish it, or
            <button type="button" class="list-action-btn" id="mergeCancelLockBtn">Cancel the unfinished merge</button></span>`;
          const cancelBtn = document.getElementById('mergeCancelLockBtn');
          if (cancelBtn) cancelBtn.addEventListener('click', async () => {
            try { await cancelMergeLock(mergeAwayCustomer.id); showToast('The unfinished merge was cancelled.', 'success'); mergePreview.style.display = 'none'; }
            catch (e2) { showToast('Could not cancel: ' + e2.message, 'error'); }
          });
          showToast('Could not merge: ' + err.message, 'error', 8000);
        }
      } finally {
        clearButtonLoading(mergeConfirmBtn);
      }
    });
  }

  // ============= PRODUCTS: manage catalog (manager only) =============
  if (isManager) {
    const productListBody = document.getElementById('productListBody');
    const productListEmpty = document.getElementById('productListEmpty');
    const loadMoreProductsBtn = document.getElementById('loadMoreProductsBtn');
    const addProductBtn = document.getElementById('addProductBtn');
    const prodName = document.getElementById('prodName');
    const prodPack = document.getElementById('prodPack');
    const prodQuantity = document.getElementById('prodQuantity');
    const prodPrice = document.getElementById('prodPrice');
    const prodStock = document.getElementById('prodStock');
    const prodUnitsPerCase = document.getElementById('prodUnitsPerCase');
    let loadedProducts = [], productsCursor = null, productsHasMore = true;
    const productsGuard = createPagedLoadGuard();

    function renderProductRows(list) {
      productListBody.innerHTML = '';
      productListEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(p => {
        const stock = p.stockOnHand ?? 0;
        const tr = document.createElement('tr');
        tr.dataset.id = p.id;
        tr.innerHTML = `
          <td>${esc(p.productName)}</td>
          <td>${esc(p.packLabel)}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${esc(p.quantity ?? '—')}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${esc(p.unitsPerCase ?? '—')}</td>
          <td style="font-family:'JetBrains Mono',monospace; ${esc(stock <= 0 ? 'color:#b3261e; font-weight:700;' : '')}">${esc(stock)}</td>
          <td style="font-family:'JetBrains Mono',monospace; white-space:nowrap;">${esc(mwk(p.price))}</td>
          <td>
            <button type="button" class="list-action-btn" data-action="edit">Edit</button>
            <button type="button" class="list-action-btn" data-action="adjust-stock">Adjust Stock</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="delete">Delete</button>
          </td>`;
        productListBody.appendChild(tr);
      });
    }

    async function resetAndLoadProducts() {
      productsGuard.reset();
      loadedProducts = []; productsCursor = null; productsHasMore = true;
      await loadNextProductPage();
    }

    async function loadNextProductPage() {
      if (!productsHasMore) return;
      const cursor = productsCursor;
      await productsGuard.run({
        setLoading: (on) => (on ? setButtonLoading(loadMoreProductsBtn, 'Loading…') : clearButtonLoading(loadMoreProductsBtn)),
        fetch: () => fetchProductsPage(cursor),
        apply: (result) => {
          loadedProducts = mergeById(loadedProducts, result.items);
          productsCursor = result.lastDoc; productsHasMore = result.hasMore;
          renderProductRows(loadedProducts);
          loadMoreProductsBtn.style.display = productsHasMore ? 'block' : 'none';
        },
        onError: (err) => showToast('Could not load products: ' + err.message, 'error'),
      });
    }

    loadMoreProductsBtn.addEventListener('click', loadNextProductPage);

    addProductBtn.addEventListener('click', async () => {
      const name = prodName.value.trim();
      const pack = prodPack.value.trim();
      const quantity = parseFloat(prodQuantity.value);
      const price = parseFloat(prodPrice.value);
      const stockOnHand = parseFloat(prodStock.value) || 0;
      const unitsPerCase = prodUnitsPerCase.value;
      if (!name || !pack) { showToast('Enter both a product name and a pack.', 'error'); return; }
      if (!quantity || quantity <= 0) { showToast('Enter the contents per pack (1 if the pack is a single item).', 'error'); return; }
      if (!price || price <= 0) { showToast('Enter a price greater than 0.', 'error'); return; }
      setButtonLoading(addProductBtn, 'Saving…');
      try {
        await addProduct({ productName: name, packLabel: pack, quantity, price, stockOnHand, unitsPerCase, uid: user.uid });
        prodName.value = ''; prodPack.value = ''; prodQuantity.value = ''; prodPrice.value = ''; prodStock.value = ''; prodUnitsPerCase.value = '';
        showToast('Product added to catalog.', 'success');
        await resetAndLoadProducts();
        await loadProductsCache();
      } catch (err) {
        showToast('Could not add product: ' + err.message, 'error');
      } finally {
        clearButtonLoading(addProductBtn);
      }
    });

    productListBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      const p = loadedProducts.find(p => p.id === id);

      if (btn.dataset.action === 'edit') {
        if (!p) return;
        tr.innerHTML = `
          <td><input class="customer-edit-input" data-field="productName" value="${esc(p.productName)}"></td>
          <td><input class="customer-edit-input" data-field="packLabel" value="${esc(p.packLabel)}"></td>
          <td><input class="customer-edit-input" data-field="quantity" type="number" min="0" step="1" value="${esc(p.quantity ?? 0)}"></td>
          <td><input class="customer-edit-input" data-field="unitsPerCase" type="number" min="0" step="1" value="${esc(p.unitsPerCase ?? '')}" placeholder="—"></td>
          <td style="font-family:'JetBrains Mono',monospace;">${esc(p.stockOnHand ?? 0)}</td>
          <td><input class="customer-edit-input" data-field="price" type="number" min="0" step="1" value="${esc(p.price)}"></td>
          <td>
            <button type="button" class="list-action-btn" data-action="save">Save</button>
            <button type="button" class="list-action-btn" data-action="cancel">Cancel</button>
          </td>`;
      } else if (btn.dataset.action === 'cancel') {
        renderProductRows(loadedProducts);
      } else if (btn.dataset.action === 'save') {
        const productName = tr.querySelector('[data-field="productName"]').value.trim();
        const packLabel = tr.querySelector('[data-field="packLabel"]').value.trim();
        const quantity = parseFloat(tr.querySelector('[data-field="quantity"]').value) || 0;
        const price = parseFloat(tr.querySelector('[data-field="price"]').value) || 0;
        // Packs per case is only sent when it was actually changed, so nothing
        // new is written for products that do not use it. Validated (whole
        // number above 0, or blank to clear) inside updateProduct.
        const enteredPerCase = tr.querySelector('[data-field="unitsPerCase"]').value.trim();
        const existingPerCase = p?.unitsPerCase ?? null;
        const perCaseChanged = String(enteredPerCase) !== String(existingPerCase ?? '');
        if (!productName || !packLabel) { showToast('Name and pack cannot be empty.', 'error'); return; }
        setButtonLoading(btn, 'Saving…');
        try {
          await updateProduct(id, { productName, packLabel, quantity, price, ...(perCaseChanged ? { unitsPerCase: enteredPerCase } : {}) });
          const idx = loadedProducts.findIndex(p => p.id === id);
          const newPerCase = perCaseChanged ? (enteredPerCase === '' ? null : wholeNumber(enteredPerCase)) : existingPerCase;
          if (idx !== -1) loadedProducts[idx] = { ...loadedProducts[idx], productName, packLabel, quantity, price, unitsPerCase: newPerCase ?? undefined };
          renderProductRows(loadedProducts);
          await loadProductsCache();
          showToast('Product updated.', 'success');
        } catch (err) {
          showToast('Could not update product: ' + err.message, 'error');
          clearButtonLoading(btn);
        }
      } else if (btn.dataset.action === 'delete') {
        const confirmed = confirm(`Delete "${p?.productName} — ${p?.packLabel}" from the catalog?\n\nThis cannot be undone.`);
        if (!confirmed) return;
        setButtonLoading(btn, '…');
        try {
          await deleteProduct(id);
          loadedProducts = loadedProducts.filter(p => p.id !== id);
          renderProductRows(loadedProducts);
          await loadProductsCache();
          showToast('Product deleted.', 'success');
        } catch (err) {
          showToast('Could not delete product: ' + err.message, 'error');
          clearButtonLoading(btn);
        }
      } else if (btn.dataset.action === 'adjust-stock') {
        if (window.__openStockAdjustModal) window.__openStockAdjustModal(p);
      }
    });

    // ============= STOCK ADJUSTMENT MODAL (manager only) =============
    const stockAdjustModal = document.getElementById('stockAdjustModal');
    const saProductLabel = document.getElementById('saProductLabel');
    const saCurrentStock = document.getElementById('saCurrentStock');
    const saDelta = document.getElementById('saDelta');
    const saReason = document.getElementById('saReason');
    const saErrorNote = document.getElementById('saErrorNote');
    const saSaveBtn = document.getElementById('saSaveBtn');
    const saCancelBtn = document.getElementById('saCancelBtn');
    const saCloseBtn = document.getElementById('saCloseBtn');
    const saMode = document.getElementById('saMode');
    const saCasesWrap = document.getElementById('saCasesWrap');
    const saDeltaWrap = document.getElementById('saDeltaWrap');
    const saCases = document.getElementById('saCases');
    const saUnitsPerCase = document.getElementById('saUnitsPerCase');
    const saCasePreview = document.getElementById('saCasePreview');
    const saPackUnit = document.getElementById('saPackUnit');

    let adjustingProduct = null;

    function applyStockAdjustMode() {
      const cases = saMode.value === 'cases';
      saCasesWrap.style.display = cases ? 'block' : 'none';
      saDeltaWrap.style.display = cases ? 'none' : 'block';
      updateCasePreview();
    }

    function updateCasePreview() {
      if (!adjustingProduct) return;
      const packs = casesToPacks(saCases.value, saUnitsPerCase.value);
      saCasePreview.textContent = packs === null
        ? 'Enter whole numbers: cases received, and packs in one case.'
        : `${saCases.value} case(s) × ${saUnitsPerCase.value} = adds ${packs} × ${adjustingProduct.packLabel} · new stock ${(adjustingProduct.stockOnHand || 0) + packs}`;
    }

    saMode.addEventListener('change', applyStockAdjustMode);
    saCases.addEventListener('input', updateCasePreview);
    saUnitsPerCase.addEventListener('input', updateCasePreview);

    function openStockAdjustModal(product) {
      adjustingProduct = product;
      saErrorNote.style.display = 'none';
      saProductLabel.textContent = `${product.productName} — ${product.packLabel}`;
      saCurrentStock.textContent = product.stockOnHand ?? 0;
      saPackUnit.textContent = `× ${product.packLabel}`;
      saDelta.value = '';
      saReason.value = '';
      saCases.value = '';
      saUnitsPerCase.value = product.unitsPerCase ?? '';
      saMode.value = 'cases';
      applyStockAdjustMode();
      stockAdjustModal.style.display = 'flex';
    }

    function closeStockAdjustModal() {
      stockAdjustModal.style.display = 'none';
      adjustingProduct = null;
    }

    saCancelBtn.addEventListener('click', closeStockAdjustModal);
    saCloseBtn.addEventListener('click', closeStockAdjustModal);
    stockAdjustModal.addEventListener('click', (e) => {
      if (e.target === stockAdjustModal) closeStockAdjustModal();
    });

    saSaveBtn.addEventListener('click', async () => {
      if (!adjustingProduct) return;
      const receivingCases = saMode.value === 'cases';
      const reason = saReason.value.trim();
      let delta = null;
      if (receivingCases) {
        delta = casesToPacks(saCases.value, saUnitsPerCase.value);
        if (delta === null) {
          saErrorNote.textContent = 'Enter whole numbers above 0 for the cases received and the packs per case.';
          saErrorNote.style.display = 'block';
          return;
        }
      } else {
        delta = parseFloat(saDelta.value);
        if (!delta || !Number.isFinite(delta)) {
          saErrorNote.textContent = 'Enter a non-zero adjustment.';
          saErrorNote.style.display = 'block';
          return;
        }
      }
      if (!reason) {
        saErrorNote.textContent = 'Enter a reason for this adjustment.';
        saErrorNote.style.display = 'block';
        return;
      }
      saErrorNote.style.display = 'none';
      setButtonLoading(saSaveBtn, 'Saving…');
      try {
        let newUnitsPerCase = adjustingProduct.unitsPerCase ?? null;
        if (receivingCases) {
          // ONE transaction: stock balance, ledger entry (the conversion is
          // spelled out in its reason) and packs-per-case are saved together.
          await receiveStockCases(adjustingProduct.id, saCases.value, saUnitsPerCase.value, { reason, uid: user.uid, email: user.email });
          newUnitsPerCase = wholeNumber(saUnitsPerCase.value);
        } else {
          await adjustStockManually(adjustingProduct.id, delta, { reason, uid: user.uid, email: user.email });
        }
        const idx = loadedProducts.findIndex(p => p.id === adjustingProduct.id);
        if (idx !== -1) loadedProducts[idx] = { ...loadedProducts[idx], unitsPerCase: newUnitsPerCase ?? undefined, stockOnHand: (loadedProducts[idx].stockOnHand || 0) + delta };
        renderProductRows(loadedProducts);
        await loadProductsCache();
        showToast(receivingCases ? `Added ${delta} × ${adjustingProduct.packLabel} to stock.` : 'Stock adjusted.', 'success');
        closeStockAdjustModal();
      } catch (err) {
        saErrorNote.textContent = 'Could not save: ' + err.message;
        saErrorNote.style.display = 'block';
      } finally {
        clearButtonLoading(saSaveBtn);
      }
    });

    window.__openStockAdjustModal = openStockAdjustModal;

    // ---- Stock Movement History (audit ledger) ----
    const stockMovementTypeLabels = {
      manual: 'Manual Adjustment',
      'order-approved': 'Order Approved',
      'order-cancelled': 'Order Cancelled (stock restored)',
      'order-cancelled-deleted': 'Order Cancelled',   // older entries from when cancelling deleted the order
      'order-edited': 'Order Edited',
    };
    const stockMovementBody = document.getElementById('stockMovementBody');
    const stockMovementEmpty = document.getElementById('stockMovementEmpty');
    const loadMoreStockMovementsBtn = document.getElementById('loadMoreStockMovementsBtn');
    const stockMovementProductFilter = document.getElementById('stockMovementProductFilter');
    let loadedMovements = [], movementsCursor = null, movementsHasMore = true, currentMovementProductFilter = 'all';
    const movementsGuard = createPagedLoadGuard();

    function formatMovementTimestamp(ts) {
      if (!ts || typeof ts.toDate !== 'function') return '—';
      const d = ts.toDate();
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function renderMovementRows(list) {
      stockMovementBody.innerHTML = '';
      stockMovementEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(m => {
        const tr = document.createElement('tr');
        const changeText = m.delta > 0 ? `+${m.delta}` : `${m.delta}`;
        const reasonOrOrder = m.orderNo ? `Order ${m.orderNo}` : (m.reason || '—');
        tr.innerHTML = `
          <td style="font-size:0.78rem; white-space:nowrap;">${esc(formatMovementTimestamp(m.createdAt))}</td>
          <td>${esc(m.productName || '—')}${esc(m.packLabel ? ' — ' + m.packLabel : '')}</td>
          <td>${esc(stockMovementTypeLabels[m.type] || m.type || '—')}</td>
          <td style="font-family:'JetBrains Mono',monospace; ${esc(m.delta < 0 ? 'color:#b3261e;' : 'color:var(--forest-2);')}">${esc(changeText)}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${esc(m.newStock ?? '—')}</td>
          <td style="font-size:0.78rem; color:var(--muted);">${esc(reasonOrOrder)}</td>
          <td style="font-size:0.72rem; color:var(--muted);">${esc(displayNameForEmail(m.createdByEmail))}</td>
        `;
        stockMovementBody.appendChild(tr);
      });
    }

    async function resetAndLoadMovements() {
      movementsGuard.reset();
      loadedMovements = []; movementsCursor = null; movementsHasMore = true;
      await loadNextMovementPage();
    }

    async function loadNextMovementPage() {
      if (!movementsHasMore) return;
      // filter and cursor are captured together, synchronously, so a response can never be
      // applied under a different filter than the one it was requested for.
      const cursor = movementsCursor, filter = currentMovementProductFilter;
      await movementsGuard.run({
        setLoading: (on) => (on ? setButtonLoading(loadMoreStockMovementsBtn, 'Loading…') : clearButtonLoading(loadMoreStockMovementsBtn)),
        fetch: () => (filter === 'all' ? fetchAllStockMovementsPage(cursor) : fetchStockMovementsForProduct(filter, cursor)),
        apply: (result) => {
          loadedMovements = mergeById(loadedMovements, result.items);
          movementsCursor = result.lastDoc; movementsHasMore = result.hasMore;
          renderMovementRows(loadedMovements);
          loadMoreStockMovementsBtn.style.display = movementsHasMore ? 'block' : 'none';
        },
        onError: (err) => showToast('Could not load stock movements: ' + err.message, 'error'),
      });
    }

    function refreshMovementProductFilterOptions() {
      const current = stockMovementProductFilter.value;
      stockMovementProductFilter.innerHTML = `<option value="all">All products</option>` +
        loadedProducts.map(p => `<option value="${esc(p.id)}">${esc(p.productName)} — ${esc(p.packLabel)}</option>`).join('');
      if ([...stockMovementProductFilter.options].some(o => o.value === current)) {
        stockMovementProductFilter.value = current;
      }
    }

    stockMovementProductFilter.addEventListener('change', async () => {
      currentMovementProductFilter = stockMovementProductFilter.value;
      await resetAndLoadMovements();
    });
    loadMoreStockMovementsBtn.addEventListener('click', loadNextMovementPage);

    window.__loadStockMovements = async function __loadStockMovements() {
      refreshMovementProductFilterOptions();
      await resetAndLoadMovements();
    };

    var resetAndLoadProductsRef = resetAndLoadProducts; // exposed to viewLoaders closure below
  }
  async function resetAndLoadProducts() {
    if (typeof resetAndLoadProductsRef === 'function') await resetAndLoadProductsRef();
    if (window.__loadStockMovements) await window.__loadStockMovements();
  }

  // ============= NEW INVOICE FORM (manager only) =============
  if (isManager) {
    generateBtn.textContent = 'Download PDF Invoice';
    generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';

    // ---- Send an invoice via WhatsApp ----
    // There is no way for a website to auto-attach a file to a SPECIFIC
    // WhatsApp contact without Meta's paid Business API and a backend
    // server — that's out of reach here. So this picks the best
    // available option automatically:
    //  1) Native share sheet with the actual PDF attached (works on
    //     most mobile Chrome/Safari) — the file goes straight into
    //     whichever app is picked, but the CONTACT is chosen by
    //     whoever uses the share sheet, not by this code.
    //  2) A wa.me link that opens the CORRECT customer's chat directly
    //     with a message ready — but click-to-chat links only support
    //     pre-filled text, never a file, so the already-downloaded PDF
    //     has to be attached by hand.
    // Never both at once (auto-contact AND auto-attach) — that
    // combination genuinely isn't possible from a plain website.
    async function sendInvoiceViaWhatsApp({ pdfDoc, filename, phone, customerName, invoiceNo, grandTotal }) {
      const message = `Hi ${customerName}, here is your invoice ${invoiceNo} from Naisi Foods for ${esc(mwk(grandTotal))}. The PDF is attached.`;

      if (pdfDoc && navigator.share && navigator.canShare) {
        try {
          const blob = pdfDoc.output('blob');
          const file = new File([blob], filename, { type: 'application/pdf' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], text: message, title: `Invoice ${invoiceNo}` });
            showToast('Share sheet opened — pick WhatsApp and the customer to send the PDF.', 'success');
            return;
          }
        } catch (err) {
          if (err && err.name === 'AbortError') return; // user cancelled the share sheet — don't fall back
          console.warn('Web Share failed, falling back to a WhatsApp chat link:', err);
        }
      }

      const waNumber = toWhatsAppNumber(phone);
      if (!waNumber) {
        showToast('No valid phone number on file for this customer — cannot open WhatsApp automatically.', 'error');
        return;
      }
      window.open(`https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`, '_blank');
      showToast('WhatsApp opened with a message ready — attach the downloaded PDF before sending.', 'info');
    }

    const today = new Date();
    els.invoiceDate.value = today.toISOString().slice(0, 10);
    refreshPreview();

    ['invoiceDate', 'custName', 'custPhone', 'custLocation', 'terms', 'providerPhone', 'notes'].forEach(id => {
      document.getElementById(id).addEventListener('input', refreshPreview);
      document.getElementById(id).addEventListener('change', refreshPreview);
    });

    function populateFormFromInvoice(inv) {
      invPrefixInput.disabled = true;
      invCounterInput.disabled = true;
      els.invoiceNo.value = inv.invoiceNo;
      els.invoiceDate.value = inv.date || '';
      els.custName.value = inv.customer === '-' ? '' : inv.customer;
      els.custPhone.value = inv.phone === '-' ? '' : inv.phone;
      els.custLocation.value = inv.location === '-' ? '' : inv.location;
      document.getElementById('custCustomerId').value = inv.customerId || '';
      els.terms.value = inv.terms || 'CASH ON DELIVERY (COD)';
      els.providerPhone.value = inv.providerPhone || '';
      els.notes.value = inv.notes || '';
      itemsBody.innerHTML = '';
      fillItemRows(itemsBody, inv.items, refreshPreview);
      editingInvoiceId = inv.id;
      editingInvoiceNoLabel.textContent = inv.invoiceNo;
      editingBanner.style.display = 'block';
      generateBtn.textContent = 'Save Changes';
      generateNote.textContent = 'Updates this invoice in place. Does not touch invoice numbering.';
      showView('form');
      refreshPreview();
    }

    function exitEditMode() {
      editingInvoiceId = null;
      editingBanner.style.display = 'none';
      generateBtn.textContent = 'Download PDF Invoice';
      generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
      invPrefixInput.disabled = false;
      invCounterInput.disabled = false;
      itemsBody.innerHTML = '';
      els.custName.value = ''; els.custPhone.value = ''; els.custLocation.value = '';
      document.getElementById('custCustomerId').value = '';
      els.notes.value = ''; els.providerPhone.value = '';
      els.invoiceDate.value = new Date().toISOString().slice(0, 10);
      refreshPreview();
    }

    cancelEditBtn.addEventListener('click', (e) => {
      e.preventDefault();
      exitEditMode();
      showView('invoices');
    });

    // ---- Generate invoice from an approved order ----
    function loadOrderIntoInvoiceForm(order) {
      exitEditMode();
      generatingFromOrder = { id: order.id, orderNo: order.orderNo, revision: orderRevisionKey(order) };
      fromOrderNoLabel.textContent = order.orderNo;
      fromOrderBanner.style.display = 'block';

      els.custName.value = order.customerName || '';
      els.custPhone.value = order.customerPhone === '-' ? '' : (order.customerPhone || '');
      els.custLocation.value = order.customerLocation === '-' ? '' : (order.customerLocation || '');
      document.getElementById('custCustomerId').value = order.customerId || '';
      els.notes.value = order.notes || '';

      itemsBody.innerHTML = '';
      fillItemRows(itemsBody, order.items, refreshPreview);

      showView('form');
      refreshPreview();
      showToast(`Loaded order ${order.orderNo} — review and download.`, 'info');
    }

    function exitFromOrderMode() {
      generatingFromOrder = null;
      fromOrderBanner.style.display = 'none';
    }

    // Opening the tab by hand always starts a blank walk-in invoice (never half of an order or an edit).
    navBtns.form.addEventListener('click', () => { exitFromOrderMode(); exitEditMode(); }, true);

    cancelFromOrderBtn.addEventListener('click', (e) => {
      e.preventDefault();
      exitFromOrderMode();
      exitEditMode();
      showView('orders');
    });

    // A stand-alone invoice gets a client-chosen id, kept until a save is
    // confirmed. Pressing Generate again after a lost acknowledgement then
    // finds the invoice that was already saved instead of creating another.
    let pendingStandaloneInvoiceId = null;

    generateBtn.addEventListener('click', async () => {
      const wasEditing = !!editingInvoiceId;
      const fromOrder = generatingFromOrder; // capture now — cleared partway through on success
      setButtonLoading(generateBtn, wasEditing ? 'Saving…' : 'Generating…');

      try {
        const items = getItems(itemsBody);
        { const lv = validateOrderLines(items); if (!lv.ok) { showToast(lv.problems[0], 'error'); return; } }
        const meta = {
          date: els.invoiceDate.value,
          customer: els.custName.value || '-',
          customerId: document.getElementById('custCustomerId').value || null,
          phone: els.custPhone.value || '-',
          location: els.custLocation.value || '-',
          terms: els.terms.value,
          providerPhone: els.providerPhone.value.trim(),
          notes: els.notes.value.trim(),
          items,
        };

        if (wasEditing) {
          try {
            const invoiceNo = els.invoiceNo.value;
            const { grandTotal } = generatePdf({ ...meta, invoiceNo });
            await updateInvoice(editingInvoiceId, { ...meta, invoiceNo, grandTotal });
            exitEditMode();
            showToast('Invoice updated.', 'success');
            showView('invoices');
          } catch (err) {
            console.error(err);
            showToast('Could not save the invoice: ' + err.message, 'error');
          }
          return;
        }

        // ---- Step 1: save. Only a failure HERE means "not saved". ----
        // Lock + number + invoice + order status are saved together (see
        // issueInvoiceForOrder in orders.js); nothing is written on failure.
        let committed;
        try {
          if (fromOrder) {
            committed = await issueInvoiceForOrder({ orderId: fromOrder.id, meta, expectedRevision: fromOrder.revision ?? null, uid: user.uid });
          } else {
            pendingStandaloneInvoiceId = pendingStandaloneInvoiceId || newStandaloneRequestId();
            committed = await issueStandaloneInvoice({ requestId: pendingStandaloneInvoiceId, meta, uid: user.uid });
          }
        } catch (err) {
          console.error(err);
          if (!fromOrder && err.code === 'invoice-conflict') pendingStandaloneInvoiceId = null;   // the next save is a NEW invoice
          if (err.alreadyInvoiced) {
            showToast(`This order was already invoiced as ${err.invoiceNo}. Nothing new was created — use Invoices → Download if you need the PDF.`, 'error');
            exitFromOrderMode();
            showView('orders');
          } else {
            showToast('Could not save the invoice: ' + err.message, 'error');
          }
          return;
        }

        // ---- Step 2: the invoice IS saved. Nothing below may report a save
        // failure or create another invoice. ----
        pendingStandaloneInvoiceId = null;
        const invoiceNo = committed.invoiceNo;
        const pdfArgs = { ...meta, invoiceNo };
        els.invoiceNo.value = buildInvoiceNo(committed.next.prefix, committed.next.counter);

        let pdfError = null, refreshError = null;
        try { generatePdf(pdfArgs); } catch (err) { pdfError = err; console.error(err); }

        try {
          if (fromOrder) {
            exitFromOrderMode();
            if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
          }
        } catch (err) { refreshError = err; console.error(err); }
        if (fromOrder) showView('orders');

        if (pdfError) notifyInvoiceSavedPdfFailed(invoiceNo, pdfArgs, pdfError);
        if (refreshError) {
          showToast(`Invoice ${invoiceNo} was saved, but the list could not refresh (${refreshError.message}). Reload the page to see it. Nothing was duplicated.`, 'info', 8000);
        } else if (!pdfError) {
          if (committed.alreadySaved) showToast(`Invoice ${invoiceNo} had already been saved — no new invoice was created.`, 'info');
          else showToast(fromOrder ? `Invoice ${invoiceNo} saved. Order ${fromOrder.orderNo} marked as Invoiced.` : 'Invoice saved and downloaded.', 'success');
        }
      } finally {
        clearButtonLoading(generateBtn);
      }
    });

    // ============= INVOICES LIST (manager only) =============
    var listTitle = document.getElementById('listTitle');
    var listHead = document.getElementById('invoiceListHead');
    var listBody = document.getElementById('invoiceListBody');
    var listEmpty = document.getElementById('invoiceListEmpty');
    var loadMoreInvoicesBtn = document.getElementById('loadMoreInvoicesBtn');
    var invoiceSearchInput = document.getElementById('invoiceSearchInput');
    var invoiceSearchHint = document.getElementById('invoiceSearchHint');
    var invoiceListMode = 'default', invoiceRangeFrom = null, invoiceRangeTo = null;
    var loadedInvoices = [], invoicesCursor = null, invoicesHasMore = true;
    var invoicesGuard = createPagedLoadGuard();

    function renderInvoiceRows(list) {
      listBody.innerHTML = '';
      listEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(inv => {
        const tr = document.createElement('tr');
        const productsSummary = formatItemsSummary(inv.items);
        const hasWhatsApp = !!toWhatsAppNumber(inv.phone);
        tr.innerHTML = `
          <td>${esc(inv.invoiceNo)}</td>
          <td>${esc(formatDate(inv.date))}</td>
          <td>${esc(inv.customer)}</td>
          <td class="inv-products-cell" title="${esc(productsSummary)}">${esc(productsSummary)}</td>
          <td>${esc(mwk(inv.grandTotal || 0))}</td>
          <td>
            <button type="button" class="list-action-btn" data-action="edit" data-id="${esc(inv.id)}">Edit</button>
            <button type="button" class="list-action-btn" data-action="download" data-id="${esc(inv.id)}">Download</button>
            ${hasWhatsApp ? `<button type="button" class="list-action-btn" data-action="whatsapp" data-id="${esc(inv.id)}">WhatsApp</button>` : ''}
          </td>
        `;
        listBody.appendChild(tr);
      });
    }

    function applyInvoiceSearchAndRender() {
      const term = invoiceSearchInput.value.trim().toLowerCase();
      const filtered = term
        ? loadedInvoices.filter(inv => (inv.invoiceNo || '').toLowerCase().includes(term) || (inv.customer || '').toLowerCase().includes(term))
        : loadedInvoices;
      renderInvoiceRows(filtered);
      invoiceSearchHint.textContent = term ? `Searching ${loadedInvoices.length} loaded invoices.` : '';
    }

    window.resetAndLoadInvoices = async function resetAndLoadInvoices() {
      invoicesGuard.reset();
      invoiceListMode = 'default'; loadedInvoices = []; invoicesCursor = null; invoicesHasMore = true;
      invoiceSearchInput.value = '';
      listTitle.textContent = 'All Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Products</th><th>Total</th><th></th></tr>`;
      await loadNextInvoicePage();
      if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
    };

    async function loadNextInvoicePage() {
      if (!invoicesHasMore) return;
      const cursor = invoicesCursor, mode = invoiceListMode, from = invoiceRangeFrom, to = invoiceRangeTo;
      await invoicesGuard.run({
        setLoading: (on) => (on ? setButtonLoading(loadMoreInvoicesBtn, 'Loading…') : clearButtonLoading(loadMoreInvoicesBtn)),
        fetch: () => (mode === 'range' ? fetchInvoicesByDateRangePage(from, to, cursor) : fetchAllInvoicesPage(cursor)),
        apply: (result) => {
          loadedInvoices = mergeById(loadedInvoices, result.items);
          invoicesCursor = result.lastDoc; invoicesHasMore = result.hasMore;
          applyInvoiceSearchAndRender();
          loadMoreInvoicesBtn.style.display = invoicesHasMore ? 'block' : 'none';
        },
        onError: (err) => showToast('Could not load invoices: ' + err.message, 'error'),
      });
    }

    loadMoreInvoicesBtn.addEventListener('click', loadNextInvoicePage);
    invoiceSearchInput.addEventListener('input', applyInvoiceSearchAndRender);

    document.getElementById('applyFilterBtn').addEventListener('click', async () => {
      const from = document.getElementById('filterFrom').value;
      const to = document.getElementById('filterTo').value;
      if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }
      invoiceListMode = 'range'; invoiceRangeFrom = from; invoiceRangeTo = to;
      invoicesGuard.reset();
      loadedInvoices = []; invoicesCursor = null; invoicesHasMore = true; invoiceSearchInput.value = '';
      listTitle.textContent = `Invoices: ${from} to ${to}`;
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Products</th><th>Total</th><th></th></tr>`;
      await loadNextInvoicePage();
    });

    document.getElementById('clearFilterBtn').addEventListener('click', async () => {
      document.getElementById('filterFrom').value = '';
      document.getElementById('filterTo').value = '';
      await window.resetAndLoadInvoices();
    });

    document.getElementById('exportBtn').addEventListener('click', async () => {
      const from = document.getElementById('filterFrom').value;
      const to = document.getElementById('filterTo').value;
      if (!from || !to) { showToast('Pick both a From and To date to export.', 'error'); return; }
      const exportBtn = document.getElementById('exportBtn');
      setButtonLoading(exportBtn, 'Building report…');
      try {
        const all = await fetchInvoicesByDateRange(from, to);
        if (!all.length) { showToast('No invoices found in that range.', 'info'); return; }
        await buildAndDownloadInvoiceReport(all, from, to);
        showToast('Report downloaded.', 'success');
      } catch (err) {
        showToast('Could not build the report: ' + err.message, 'error');
      } finally {
        clearButtonLoading(exportBtn);
      }
    });

    listBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      setButtonLoading(btn, '…');
      try {
        const inv = await fetchInvoiceById(btn.dataset.id);
        if (!inv) return;
        if (btn.dataset.action === 'edit') {
          populateFormFromInvoice(inv);
        } else if (btn.dataset.action === 'download') {
          generatePdf({ invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer, phone: inv.phone, location: inv.location, terms: inv.terms, providerPhone: inv.providerPhone, notes: inv.notes, items: inv.items || [] });
          showToast('PDF downloaded.', 'success');
        } else if (btn.dataset.action === 'whatsapp') {
          // Re-generates the PDF fresh from the saved invoice data (same
          // as Download does) so there's a real file to attach if the
          // device's share sheet supports it.
          const { filename, doc: pdfDoc } = generatePdf({ invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer, phone: inv.phone, location: inv.location, terms: inv.terms, providerPhone: inv.providerPhone, notes: inv.notes, items: inv.items || [] });
          await sendInvoiceViaWhatsApp({
            pdfDoc, filename, phone: inv.phone, customerName: inv.customer,
            invoiceNo: inv.invoiceNo, grandTotal: inv.grandTotal || 0,
          });
        }
      } catch (err) {
        showToast('Something went wrong: ' + err.message, 'error');
      } finally {
        clearButtonLoading(btn);
      }
    });

    // ---- Generate Invoice modal (popup, no page navigation) ----
    // Replaces the old flow of navigating to the full New Invoice form
    // for the specific case of turning an Approved order into an
    // invoice: same editable fields (customer info, items, notes), but
    // as a popup — matches the Order Preview modal's pattern, and
    // downloading the PDF here never leaves this page.
    const generateInvoiceModal = document.getElementById('generateInvoiceModal');
    const giOrderNoLabel = document.getElementById('giOrderNoLabel');
    const giDate = document.getElementById('giDate');
    const giTerms = document.getElementById('giTerms');
    const giProviderPhone = document.getElementById('giProviderPhone');
    const giCustName = document.getElementById('giCustName');
    const giCustPhone = document.getElementById('giCustPhone');
    const giCustLocation = document.getElementById('giCustLocation');
    const giQuickAddGrid = document.getElementById('giQuickAddGrid');
    const giItemsBody = document.getElementById('giItemsBody');
    const giAddItemBtn = document.getElementById('giAddItemBtn');
    const giNotes = document.getElementById('giNotes');
    const giErrorNote = document.getElementById('giErrorNote');
    const giMainActions = document.getElementById('giMainActions');
    const giMainHint = document.getElementById('giMainHint');
    const giGenerateBtn = document.getElementById('giGenerateBtn');
    const giCancelBtn = document.getElementById('giCancelBtn');
    const giCloseBtn = document.getElementById('giCloseBtn');
    const giPostGenerateActions = document.getElementById('giPostGenerateActions');
    const giSendWhatsAppBtn = document.getElementById('giSendWhatsAppBtn');
    const giNoPhoneNote = document.getElementById('giNoPhoneNote');
    const giDoneBtn = document.getElementById('giDoneBtn');
    let generatingOrder = null;
    let generatingOrderRevision = null; // what the manager saw when this window opened
    let lastGeneratedInvoice = null; // { pdfDoc, filename, phone, customerName, invoiceNo, grandTotal }

    function openGenerateInvoiceModal(order) {
      generatingOrder = order;
      generatingOrderRevision = orderRevisionKey(order);
      giErrorNote.style.display = 'none';
      giMainActions.style.display = 'flex';
      giMainHint.style.display = 'block';
      giPostGenerateActions.style.display = 'none';
      giOrderNoLabel.textContent = order.orderNo;
      giDate.value = new Date().toISOString().slice(0, 10);
      giTerms.value = 'CASH ON DELIVERY (COD)';
      giProviderPhone.value = '';
      giCustName.value = order.customerName || '';
      giCustPhone.value = order.customerPhone === '-' ? '' : (order.customerPhone || '');
      giCustLocation.value = order.customerLocation === '-' ? '' : (order.customerLocation || '');
      giNotes.value = order.notes || '';
      giItemsBody.innerHTML = '';
      fillItemRows(giItemsBody, order.items);
      buildQuickAddGrid(giQuickAddGrid, giItemsBody, () => {}, productsCache);
      generateInvoiceModal.style.display = 'flex';
    }

    function closeGenerateInvoiceModal() {
      generateInvoiceModal.style.display = 'none';
      generatingOrder = null;
      lastGeneratedInvoice = null;
      giItemsBody.innerHTML = '';
    }

    giAddItemBtn.addEventListener('click', () => addItemRow(giItemsBody, () => {}));
    giCancelBtn.addEventListener('click', closeGenerateInvoiceModal);
    giCloseBtn.addEventListener('click', closeGenerateInvoiceModal);
    giDoneBtn.addEventListener('click', closeGenerateInvoiceModal);
    generateInvoiceModal.addEventListener('click', (e) => { if (e.target === generateInvoiceModal) closeGenerateInvoiceModal(); });

    giSendWhatsAppBtn.addEventListener('click', async () => {
      if (!lastGeneratedInvoice) return;
      setButtonLoading(giSendWhatsAppBtn, 'Opening…');
      try {
        await sendInvoiceViaWhatsApp(lastGeneratedInvoice);
      } finally {
        clearButtonLoading(giSendWhatsAppBtn);
      }
    });

    giGenerateBtn.addEventListener('click', async () => {
      if (!generatingOrder) return;
      const order = generatingOrder;
      const expectedRevision = generatingOrderRevision;
      const customerName = giCustName.value.trim();
      const items = getItems(giItemsBody);
      giErrorNote.style.display = 'none';
      { const lv = validateOrderLines(items); if (!lv.ok) { giErrorNote.textContent = lv.problems[0]; giErrorNote.style.display = 'block'; return; } }

      if (!customerName) {
        giErrorNote.textContent = 'Customer name cannot be empty.';
        giErrorNote.style.display = 'block';
        return;
      }
      if (items.length === 0) {
        giErrorNote.textContent = 'Add at least one item.';
        giErrorNote.style.display = 'block';
        return;
      }

      setButtonLoading(giGenerateBtn, 'Generating…');
      try {
        const custPhone = giCustPhone.value.trim();
        const meta = {
          date: giDate.value,
          customer: customerName,
          customerId: order.customerId || null,
          phone: custPhone || '-',
          location: giCustLocation.value.trim() || '-',
          terms: giTerms.value,
          providerPhone: giProviderPhone.value.trim(),
          notes: giNotes.value.trim(),
          items,
        };

        // ---- Step 1: save. Only a failure HERE means "not saved". ----
        // A double-click, a second tab or a retry after a dropped connection
        // fails here instead of creating a second invoice (see
        // issueInvoiceForOrder in orders.js). Nothing is written on failure.
        let committed;
        try {
          committed = await issueInvoiceForOrder({ orderId: order.id, meta, expectedRevision, uid: user.uid });
        } catch (err) {
          console.error(err);
          giErrorNote.textContent = err.alreadyInvoiced
            ? `This order was already invoiced as ${err.invoiceNo}. Nothing new was created.`
            : 'Could not generate the invoice: ' + err.message;
          giErrorNote.style.display = 'block';
          return;
        }

        // ---- Step 2: the invoice IS saved. Nothing below may report a save
        // failure or create another invoice. ----
        const invoiceNo = committed.invoiceNo;
        const pdfArgs = { ...meta, invoiceNo };
        // generatePdf() triggers a normal browser download (no navigation) and
        // hands back the jsPDF doc object (aliased pdfDoc — 'doc' is already the
        // imported Firestore doc() function in this file) so it can be re-packaged
        // for WhatsApp without generating the PDF a second time.
        let pdf = null, pdfError = null, refreshError = null;
        try { pdf = generatePdf(pdfArgs); } catch (err) { pdfError = err; console.error(err); }
        try {
          await resetAndLoadOrders();
          if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
        } catch (err) { refreshError = err; console.error(err); }

        if (pdfError) notifyInvoiceSavedPdfFailed(invoiceNo, pdfArgs, pdfError);
        if (refreshError) {
          showToast(`Invoice ${invoiceNo} was saved, but the list could not refresh (${refreshError.message}). Reload the page to see it. Nothing was duplicated.`, 'info', 8000);
        } else if (!pdfError) {
          showToast(`Invoice ${invoiceNo} downloaded. Order ${order.orderNo} marked as Invoiced.`, 'success');
        }

        // Switch to the post-generate state instead of closing — offering
        // WhatsApp only when the PDF exists and the phone number resolves to
        // a valid Malawi WhatsApp number.
        const hasValidPhone = !!toWhatsAppNumber(custPhone);
        if (pdf) lastGeneratedInvoice = { pdfDoc: pdf.doc, filename: pdf.filename, phone: custPhone, customerName, invoiceNo, grandTotal: pdf.grandTotal };
        else lastGeneratedInvoice = null;
        giSendWhatsAppBtn.style.display = (pdf && hasValidPhone) ? 'block' : 'none';
        giNoPhoneNote.style.display = (pdf && !hasValidPhone) ? 'block' : 'none';
        giMainActions.style.display = 'none';
        giMainHint.style.display = 'none';
        giPostGenerateActions.style.display = 'block';
      } finally {
        clearButtonLoading(giGenerateBtn);
      }
    });

    window.__openGenerateInvoiceModal = openGenerateInvoiceModal;
    window.__loadOrderIntoInvoiceForm = loadOrderIntoInvoiceForm;

    // ---- Orders Ready to Invoice (Approved orders, shown in the Invoices tab) ----
    const pendingInvoiceOrdersBody = document.getElementById('pendingInvoiceOrdersBody');
    const pendingInvoiceOrdersEmpty = document.getElementById('pendingInvoiceOrdersEmpty');
    const pendingBulkGenerateBar = document.getElementById('pendingBulkGenerateBar');
    const pendingBulkGenerateBtn = document.getElementById('pendingBulkGenerateBtn');
    let loadedPendingInvoiceOrders = [];
    const pendingSelectedIds = new Set();

    function updatePendingBulkBar() {
      pendingBulkGenerateBar.style.display = 'flex';
      pendingBulkGenerateBtn.textContent = `Generate Invoices for Selected (${pendingSelectedIds.size})`;
      pendingBulkGenerateBtn.disabled = pendingSelectedIds.size === 0;
    }

    window.loadPendingInvoiceOrders = async function loadPendingInvoiceOrders() {
      try {
        const result = await fetchOrdersByStatusPage('Approved', null);
        loadedPendingInvoiceOrders = result.items;
        pendingSelectedIds.clear();
        updatePendingBulkBar();
        const list = loadedPendingInvoiceOrders;
        pendingInvoiceOrdersEmpty.style.display = list.length === 0 ? 'block' : 'none';
        pendingInvoiceOrdersBody.innerHTML = list.map(o => {
          const itemsSummary = (o.items || []).map(it => `${it.qty}× ${it.desc}`).join(', ') || '—';
          return `
            <tr>
              <td><input type="checkbox" class="pending-bulk-checkbox" data-id="${esc(o.id)}"></td>
              <td>${esc(o.orderNo)}</td>
              <td>${esc(o.customerName)}</td>
              <td class="inv-products-cell" title="${esc(itemsSummary)}">${esc(itemsSummary)}</td>
              <td>${esc(mwk(o.grandTotal || 0))}</td>
              <td><button type="button" class="list-action-btn" data-action="generate-invoice" data-id="${esc(o.id)}">Generate Invoice</button></td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        showToast('Could not load approved orders: ' + err.message, 'error');
      }
    };

    pendingInvoiceOrdersBody.addEventListener('change', (e) => {
      const cb = e.target.closest('.pending-bulk-checkbox');
      if (!cb) return;
      if (cb.checked) pendingSelectedIds.add(cb.dataset.id);
      else pendingSelectedIds.delete(cb.dataset.id);
      updatePendingBulkBar();
    });

    pendingBulkGenerateBtn.addEventListener('click', async () => {
      const orders = [...pendingSelectedIds].map(id => loadedPendingInvoiceOrders.find(o => o.id === id)).filter(Boolean);
      if (!orders.length || !window.__generateInvoicesForOrders) return;
      await window.__generateInvoicesForOrders(orders, pendingBulkGenerateBtn);
    });

    pendingInvoiceOrdersBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="generate-invoice"]');
      if (!btn) return;
      setButtonLoading(btn, '…');
      try {
        const order = await fetchOrderById(btn.dataset.id);
        if (order) openGenerateInvoiceModal(order);
      } catch (err) {
        showToast('Could not load order: ' + err.message, 'error');
      } finally {
        clearButtonLoading(btn);
      }
    });
  }
  async function resetAndLoadInvoices() { if (window.resetAndLoadInvoices) await window.resetAndLoadInvoices(); }

  // ============= EXPENSES (shared) =============
  const addExpenseBtn = document.getElementById('addExpenseBtn');
  const expDate = document.getElementById('expDate');
  const expCategory = document.getElementById('expCategory');
  const expAmount = document.getElementById('expAmount');
  const expNotes = document.getElementById('expNotes');
  const expListTitle = document.getElementById('expListTitle');
  const expenseListHead = document.getElementById('expenseListHead');
  const expenseListBody = document.getElementById('expenseListBody');
  const expenseListEmpty = document.getElementById('expenseListEmpty');
  const loadMoreExpensesBtn = document.getElementById('loadMoreExpensesBtn');
  const expenseSearchInput = document.getElementById('expenseSearchInput');
  const expenseSearchHint = document.getElementById('expenseSearchHint');

  expDate.value = new Date().toISOString().slice(0, 10);
  expListTitle.textContent = isManager ? 'All Expenses' : 'My Expenses';
  expenseListHead.innerHTML = isManager
    ? `<tr><th>Date</th><th>Category</th><th>Amount</th><th>Notes</th><th>By</th><th></th></tr>`
    : `<tr><th>Date</th><th>Category</th><th>Amount</th><th>Notes</th><th></th></tr>`;

  // Exporting pulls the FULL date range from Firestore directly (not
  // just what's paginated on screen), which for a submitter would query
  // across everyone's expenses — something the security rules correctly
  // block (submitters can only read their own). So this stays manager-only,
  // consistent with the Invoices export already being manager-only.
  const expenseExportCard = document.getElementById('expenseExportCard');
  if (isManager) {
    expenseExportCard.style.display = 'block';
    const expExportFrom = document.getElementById('expExportFrom');
    const expExportTo = document.getElementById('expExportTo');
    const expExportBtn = document.getElementById('expExportBtn');
    expExportBtn.addEventListener('click', async () => {
      const from = expExportFrom.value, to = expExportTo.value;
      if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }
      if (from > to) { showToast('The From date must be before the To date.', 'error'); return; }
      setButtonLoading(expExportBtn, 'Building report…');
      try {
        const all = await fetchExpensesInRange(from, to);
        if (!all.length) { showToast('No expenses found in that range.', 'info'); return; }
        await loadProfilesCache();
        const withNames = all.map(e => ({ ...e, createdByName: displayNameForEmail(e.createdByEmail) }));
        await buildAndDownloadExpenseReport(withNames, from, to);
        showToast('Report downloaded.', 'success');
      } catch (err) {
        showToast('Could not build the report: ' + err.message, 'error');
      } finally {
        clearButtonLoading(expExportBtn);
      }
    });
  }

  let loadedExpenses = [], expensesCursor = null, expensesHasMore = true;
  const expensesGuard = createPagedLoadGuard();

  function badgeHtml(cat) { return `<span class="exp-badge exp-badge-${esc(cat)}">${esc(cat)}</span>`; }

  function renderExpenseSummary() {
    const el = document.getElementById('expenseSummary');
    if (!el) return;
    const sum = summarizeExpenses(loadedExpenses);
    const totals = sum.byCategory, grand = sum.total;
    el.innerHTML = `
      <div class="exp-summary-tiles">
        <div class="exp-tile exp-tile-transport"><span class="exp-tile-label">Transport</span><span class="exp-tile-amount">${esc(mwk(totals.Transport))}</span></div>
        <div class="exp-tile exp-tile-meals"><span class="exp-tile-label">Meals</span><span class="exp-tile-amount">${esc(mwk(totals.Meals))}</span></div>
        <div class="exp-tile exp-tile-fuel"><span class="exp-tile-label">Fuel</span><span class="exp-tile-amount">${esc(mwk(totals.Fuel))}</span></div>
        <div class="exp-tile exp-tile-stock"><span class="exp-tile-label">Stock</span><span class="exp-tile-amount">${esc(mwk(totals.Stock))}</span></div>
        <div class="exp-tile exp-tile-other"><span class="exp-tile-label">Other</span><span class="exp-tile-amount">${esc(mwk(totals.Other))}</span></div>
      </div>
      <div class="exp-grand-total">
        <span>Grand Total (${esc(loadedExpenses.length)} record${esc(loadedExpenses.length !== 1 ? 's' : '')} loaded)</span>
        <span class="exp-grand-amount">${esc(mwk(grand))}</span>
      </div>
      ${invalidAmountNote(sum.invalid)}
    `;
  }

  function renderExpenseRows(list) {
    expenseListBody.innerHTML = '';
    expenseListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(exp => {
      const tr = document.createElement('tr');
      tr.dataset.id = exp.id;
      const notesShort = exp.notes ? (exp.notes.length > 40 ? exp.notes.substring(0, 40) + '…' : exp.notes) : '—';
      const byCell = isManager ? `<td style="font-size:0.72rem; color:var(--muted);">${esc(displayNameForEmail(exp.createdByEmail))}</td>` : '';
      const canEdit = isManager || exp.createdBy === user.uid;
      const actions = `
        ${canEdit ? `<button type="button" class="list-action-btn" data-action="edit">Edit</button>` : ''}
        ${isManager ? `<button type="button" class="list-action-btn exp-delete-btn" data-action="delete">Delete</button>` : ''}
      `;
      tr.innerHTML = `
        <td>${esc(formatDate(exp.date))}</td>
        <td>${badgeHtml(exp.category)}</td>
        <td style="font-family:'JetBrains Mono',monospace; white-space:nowrap;">${esc(mwk(exp.amount))}</td>
        <td style="color:var(--muted); font-size:0.78rem;">${esc(notesShort)}</td>
        ${byCell}
        <td>${actions}</td>
      `;
      expenseListBody.appendChild(tr);
    });
  }

  function applyExpenseSearchAndRender() {
    const term = expenseSearchInput.value.trim().toLowerCase();
    const filtered = term
      ? loadedExpenses.filter(e => (e.category || '').toLowerCase().includes(term) || (e.notes || '').toLowerCase().includes(term))
      : loadedExpenses;
    renderExpenseRows(filtered);
    renderExpenseSummary();
    expenseSearchHint.textContent = term ? `Searching ${loadedExpenses.length} loaded record${loadedExpenses.length === 1 ? '' : 's'}.` : '';
  }

  async function resetAndLoadExpenses() {
    expensesGuard.reset();
    loadedExpenses = []; expensesCursor = null; expensesHasMore = true;
    expenseSearchInput.value = '';
    await loadNextExpensePage();
    if (window.__refreshExpensePeriodSummary) await window.__refreshExpensePeriodSummary();
  }

  // ============= EXPENSE PERIOD SUMMARY (manager only) =============
  // A quick Today / This Week / This Month breakdown, same idea as the
  // Business Summary tab's shortcuts but scoped to expenses only and
  // right here on the Expenses page — no need to jump to the other tab
  // just to see how much has gone out this week. Manager-only because
  // fetchExpensesInRange() queries the full collection with no
  // createdBy filter, same reasoning as the existing Export card.
  if (isManager) {
    document.getElementById('expensePeriodSummaryCard').style.display = 'block';
    const expPeriodSummaryBody = document.getElementById('expPeriodSummaryBody');
    let currentPeriod = { from: null, to: null, label: 'Today' };

    function isoDateLocal(d) { return d.toISOString().slice(0, 10); }

    async function renderExpensePeriodSummary() {
      const { from, to, label } = currentPeriod;
      expPeriodSummaryBody.innerHTML = '<p style="color:var(--muted); font-size:0.82rem;">Loading…</p>';
      try {
        const expenses = await fetchExpensesInRange(from, to);
        const sum = summarizeExpenses(expenses);
        const totals = sum.byCategory, grand = sum.total;
        expPeriodSummaryBody.innerHTML = `
          <p style="font-size:0.78rem; color:var(--muted); margin-bottom:8px;">${esc(label)} — ${esc(expenses.length)} record${esc(expenses.length === 1 ? '' : 's')}</p>
          <div class="exp-summary-tiles">
            <div class="exp-tile exp-tile-transport"><span class="exp-tile-label">Transport</span><span class="exp-tile-amount">${esc(mwk(totals.Transport))}</span></div>
            <div class="exp-tile exp-tile-meals"><span class="exp-tile-label">Meals</span><span class="exp-tile-amount">${esc(mwk(totals.Meals))}</span></div>
            <div class="exp-tile exp-tile-fuel"><span class="exp-tile-label">Fuel</span><span class="exp-tile-amount">${esc(mwk(totals.Fuel))}</span></div>
            <div class="exp-tile exp-tile-stock"><span class="exp-tile-label">Stock</span><span class="exp-tile-amount">${esc(mwk(totals.Stock))}</span></div>
            <div class="exp-tile exp-tile-other"><span class="exp-tile-label">Other</span><span class="exp-tile-amount">${esc(mwk(totals.Other))}</span></div>
          </div>
          <div class="exp-grand-total">
            <span>Total</span>
            <span class="exp-grand-amount">${esc(mwk(grand))}</span>
          </div>
          ${invalidAmountNote(sum.invalid)}
        `;
      } catch (err) {
        expPeriodSummaryBody.innerHTML = `<p style="color:#b3261e; font-size:0.82rem;">Could not load: ${esc(err.message)}</p>`;
      }
    }

    function setPeriodAndRender(from, to, label) {
      currentPeriod = { from, to, label };
      renderExpensePeriodSummary();
    }

    document.getElementById('expPeriodTodayBtn').addEventListener('click', () => {
      const t = isoDateLocal(new Date());
      setPeriodAndRender(t, t, 'Today');
    });
    document.getElementById('expPeriodWeekBtn').addEventListener('click', () => {
      const now = new Date();
      const day = now.getDay(); // 0 = Sunday
      const diffToMonday = (day === 0 ? 6 : day - 1);
      const monday = new Date(now);
      monday.setDate(now.getDate() - diffToMonday);
      setPeriodAndRender(isoDateLocal(monday), isoDateLocal(now), 'This Week');
    });
    document.getElementById('expPeriodMonthBtn').addEventListener('click', () => {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      setPeriodAndRender(isoDateLocal(first), isoDateLocal(now), 'This Month');
    });

    // Default to Today, and re-fetch fresh numbers every time the
    // Expenses tab is opened (called from resetAndLoadExpenses above).
    const today = isoDateLocal(new Date());
    currentPeriod = { from: today, to: today, label: 'Today' };
    window.__refreshExpensePeriodSummary = renderExpensePeriodSummary;
  }

  async function loadNextExpensePage() {
    if (!expensesHasMore) return;
    const cursor = expensesCursor, manager = isManager;
    await expensesGuard.run({
      setLoading: (on) => (on ? setButtonLoading(loadMoreExpensesBtn, 'Loading…') : clearButtonLoading(loadMoreExpensesBtn)),
      fetch: () => (manager ? fetchAllExpensesPage(cursor) : fetchMyExpensesPage(user.uid, cursor)),
      apply: (result) => {
        loadedExpenses = mergeById(loadedExpenses, result.items);
        expensesCursor = result.lastDoc; expensesHasMore = result.hasMore;
        applyExpenseSearchAndRender();
        loadMoreExpensesBtn.style.display = expensesHasMore ? 'block' : 'none';
      },
      onError: (err) => showToast('Could not load expenses: ' + err.message, 'error'),
    });
  }

  loadMoreExpensesBtn.addEventListener('click', loadNextExpensePage);
  expenseSearchInput.addEventListener('input', applyExpenseSearchAndRender);

  addExpenseBtn.addEventListener('click', async () => {
    const date = expDate.value;
    const category = expCategory.value;
    const amount = parseFloat(expAmount.value);
    const notes = expNotes.value.trim();
    if (!date) { showToast('Pick a date.', 'error'); return; }
    if (!amount || amount <= 0) { showToast('Enter an amount greater than 0.', 'error'); return; }
    setButtonLoading(addExpenseBtn, 'Saving…');
    try {
      await addExpense({ date, category, amount, notes, uid: user.uid, email: user.email });
      expAmount.value = ''; expNotes.value = '';
      expDate.value = new Date().toISOString().slice(0, 10);
      showToast('Expense logged.', 'success');
      await resetAndLoadExpenses();
    } catch (err) {
      showToast('Could not log expense: ' + err.message, 'error');
    } finally {
      clearButtonLoading(addExpenseBtn);
    }
  });

  expenseListBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const exp = loadedExpenses.find(e => e.id === id);

    if (btn.dataset.action === 'edit') {
      if (!exp) return;
      if (!isManager && exp.createdBy !== user.uid) return;
      const byEditCell = isManager ? `<td></td>` : '';
      tr.innerHTML = `
        <td><input class="customer-edit-input" data-field="date" type="date" value="${esc(exp.date || '')}"></td>
        <td>
          <select class="customer-edit-input" data-field="category">
            <option ${esc(exp.category === 'Transport' ? 'selected' : '')}>Transport</option>
            <option ${esc(exp.category === 'Meals' ? 'selected' : '')}>Meals</option>
            <option value="Fuel" ${esc(exp.category === 'Fuel' ? 'selected' : '')}>Fuel</option>
            <option value="Stock" ${esc(exp.category === 'Stock' ? 'selected' : '')}>Stock Purchase</option>
            <option ${esc(exp.category === 'Other' ? 'selected' : '')}>Other</option>
          </select>
        </td>
        <td><input class="customer-edit-input" data-field="amount" type="number" min="0" step="1" value="${esc(isMoney(exp.amount) ? exp.amount : '')}" placeholder="enter amount"></td>
        <td><input class="customer-edit-input" data-field="notes" value="${esc(exp.notes || '')}"></td>
        ${byEditCell}
        <td>
          <button type="button" class="list-action-btn" data-action="save">Save</button>
          <button type="button" class="list-action-btn" data-action="cancel">Cancel</button>
        </td>
      `;
    } else if (btn.dataset.action === 'cancel') {
      applyExpenseSearchAndRender();
    } else if (btn.dataset.action === 'save') {
      const date = tr.querySelector('[data-field="date"]').value;
      const category = tr.querySelector('[data-field="category"]').value;
      const amount = parseFloat(tr.querySelector('[data-field="amount"]').value) || 0;
      const notes = tr.querySelector('[data-field="notes"]').value.trim();
      if (!date) { showToast('Pick a date.', 'error'); return; }
      if (amount <= 0) { showToast('Enter an amount greater than 0.', 'error'); return; }
      setButtonLoading(btn, 'Saving…');
      try {
        await updateExpense(id, { date, category, amount, notes });
        const idx = loadedExpenses.findIndex(e => e.id === id);
        if (idx !== -1) loadedExpenses[idx] = { ...loadedExpenses[idx], date, category, amount, notes };
        applyExpenseSearchAndRender();
        showToast('Expense updated.', 'success');
      } catch (err) {
        showToast('Could not update expense: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'delete') {
      if (!isManager) return;
      const confirmed = confirm(`Delete this ${exp?.category || ''} expense of ${esc(mwk(exp?.amount))}?\n\nThis cannot be undone.`);
      if (!confirmed) return;
      setButtonLoading(btn, '…');
      try {
        await deleteExpense(id);
        loadedExpenses = loadedExpenses.filter(e => e.id !== id);
        applyExpenseSearchAndRender();
        showToast('Expense deleted.', 'success');
      } catch (err) {
        showToast('Could not delete expense: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    }
  });

  // ============= ORDERS (shared list; actions differ by role) =============
  const orderListTitle = document.getElementById('orderListTitle');
  const orderListHead = document.getElementById('orderListHead');
  const orderListBody = document.getElementById('orderListBody');
  const orderListEmpty = document.getElementById('orderListEmpty');
  const loadMoreOrdersBtn = document.getElementById('loadMoreOrdersBtn');
  const orderStatusFilter = document.getElementById('orderStatusFilter');

  let loadedOrders = [], ordersCursor = null, ordersHasMore = true;
  // Every paged list uses createPagedLoadGuard: reset() on each filter change /
  // refresh; a page that arrives after a reset is discarded before it touches rows,
  // cursor or hasMore; only one "Load more" per list state runs at a time.
  const ordersGuard = createPagedLoadGuard();
  let currentOrderStatusFilter = 'Submitted';
  const selectedOrderIds = new Set();
  const bulkApproveBar = document.getElementById('bulkApproveBar');
  const bulkApproveBtn = document.getElementById('bulkApproveBtn');
  const bulkApproveHint = document.getElementById('bulkApproveHint');
  let bulkMode = null; // 'approve' | 'generate' | 'mixed' | null

  function updateBulkApproveBar() {
    if (!isManager) return;
    bulkApproveBar.style.display = 'flex';

    if (selectedOrderIds.size === 0) {
      bulkMode = null;
      bulkApproveBtn.textContent = 'Approve Selected (0)';
      bulkApproveBtn.disabled = true;
      bulkApproveHint.textContent = 'Tick orders (Submitted or Approved) to process them all at once.';
      return;
    }

    const statuses = new Set([...selectedOrderIds].map(id => {
      const o = loadedOrders.find(oo => oo.id === id);
      // 'Invoicing' = left mid-invoice by an interrupted run; it is
      // processed exactly like Approved so a retry resumes it.
      return o ? (o.status === 'Invoicing' ? 'Approved' : o.status) : null;
    }));

    if (statuses.size === 1 && statuses.has('Submitted')) {
      bulkMode = 'approve';
      bulkApproveBtn.textContent = `Approve Selected (${selectedOrderIds.size})`;
      bulkApproveBtn.disabled = false;
      bulkApproveHint.textContent = 'Approves every selected order — any short on stock are skipped and reported.';
    } else if (statuses.size === 1 && statuses.has('Approved')) {
      bulkMode = 'generate';
      bulkApproveBtn.textContent = `Generate Invoices for Selected (${selectedOrderIds.size})`;
      bulkApproveBtn.disabled = false;
      bulkApproveHint.textContent = 'Generates and downloads an invoice for each selected order exactly as submitted — no per-invoice editing.';
    } else {
      bulkMode = 'mixed';
      bulkApproveBtn.textContent = `Approve Selected (${selectedOrderIds.size})`;
      bulkApproveBtn.disabled = true;
      bulkApproveHint.textContent = 'Select orders that are all Submitted (to approve) or all Approved (to generate invoices) — not a mix of both.';
    }
  }

  // ---- Order Preview modal (manager reviews an order before approving) ----
  const orderPreviewModal = document.getElementById('orderPreviewModal');
  const opOrderNoLabel = document.getElementById('opOrderNoLabel');
  const opCustomerName = document.getElementById('opCustomerName');
  const opCustomerPhone = document.getElementById('opCustomerPhone');
  const opCustomerLocation = document.getElementById('opCustomerLocation');
  const opSubmittedBy = document.getElementById('opSubmittedBy');
  const opItemsBody = document.getElementById('opItemsBody');
  const opGrandTotal = document.getElementById('opGrandTotal');
  const opNotesWrap = document.getElementById('opNotesWrap');
  const opNotes = document.getElementById('opNotes');
  const opShortageWarning = document.getElementById('opShortageWarning');
  const opPriceReview = document.createElement('div');
  opPriceReview.id = 'opPriceReview';
  opPriceReview.setAttribute('role', 'status');
  opPriceReview.style.cssText = 'white-space:pre-line; border:1px solid var(--amber); border-radius:8px; padding:10px 14px; margin-top:14px; font-size:0.82rem;';
  opShortageWarning.insertAdjacentElement('beforebegin', opPriceReview);
  const opMainActions = document.getElementById('opMainActions');
  const opConfirmBtn = document.getElementById('opConfirmBtn');
  const opCancelBtn = document.getElementById('opCancelBtn');
  const opCloseBtn = document.getElementById('opCloseBtn');
  const opEditBeforeApproveBtn = document.getElementById('opEditBeforeApproveBtn');
  const opOverrideBtn = document.getElementById('opOverrideBtn');
  const opPostApproveActions = document.getElementById('opPostApproveActions');
  const opEditNowBtn = document.getElementById('opEditNowBtn');
  const opPrintNowBtn = document.getElementById('opPrintNowBtn');
  const opDoneBtn = document.getElementById('opDoneBtn');
  let opOnConfirm = null;
  let opOnApproveWithOverride = null;
  let opCurrentOrder = null;

  // order: the order doc. options.shortages: stock shortfalls to warn
  // about upfront (a client-side hint only — the real check happens
  // server-side inside approveOrderWithStock's transaction, since
  // productsCache here could be stale). options.onConfirm: async () =>
  // {} run when the manager clicks the primary action button; return
  // { approved: true } from it to switch the modal into the
  // post-approval Edit/Print chooser instead of just closing.
  // options.onApproveWithOverride: shown only if onConfirm throws a
  // stock-shortage error — lets a manager push through anyway.
  function openOrderPreviewModal(order, { confirmLabel = 'Approve Order', shortages = [], onConfirm, onApproveWithOverride } = {}) {
    opCurrentOrder = order;
    opOnApproveWithOverride = onApproveWithOverride || null;
    opOrderNoLabel.textContent = order.orderNo;
    opCustomerName.textContent = order.customerName || '—';
    opCustomerPhone.textContent = (order.customerPhone && order.customerPhone !== '-') ? order.customerPhone : '—';
    opCustomerLocation.textContent = (order.customerLocation && order.customerLocation !== '-') ? order.customerLocation : '—';
    opSubmittedBy.textContent = displayNameForEmail(order.createdByEmail);

    const items = order.items || [];
    opItemsBody.innerHTML = items.map(it => `
      <tr>
        <td>${esc(it.qty)}</td>
        <td>${esc(it.desc || '—')}</td>
        <td class="num">${esc(mwk(it.price || 0))}</td>
        <td class="num">${esc(mwk((it.qty || 0) * (it.price || 0)))}</td>
      </tr>
    `).join('') || `<tr><td colspan="4" style="color:var(--muted);">No items on this order.</td></tr>`;
    opGrandTotal.textContent = mwk(order.grandTotal || 0);
    opPriceReview.textContent = 'Current catalogue (checked again at approval):\n' + orderPriceReviewText(reviewOrderPrices(items, productsCache));
    opPriceReview.style.display = isManager ? 'block' : 'none';

    if (order.notes && order.notes.trim()) {
      opNotes.textContent = order.notes;
      opNotesWrap.style.display = 'block';
    } else {
      opNotesWrap.style.display = 'none';
    }

    if (shortages.length > 0) {
      opShortageWarning.innerHTML = '<strong>Stock is short for:</strong><br>' +
        shortages.map(s => `${esc(s.desc)}: need ${s.needed}, have ${s.available}`).join('<br>');
      opShortageWarning.style.display = 'block';
    } else {
      opShortageWarning.style.display = 'none';
    }

    opMainActions.style.display = 'flex';
    opOverrideBtn.style.display = 'none';
    opPostApproveActions.style.display = 'none';
    opConfirmBtn.textContent = confirmLabel;
    opConfirmBtn.style.display = onConfirm ? 'block' : 'none';
    opOnConfirm = onConfirm || null;
    orderPreviewModal.style.display = 'flex';
  }

  function closeOrderPreviewModal() {
    orderPreviewModal.style.display = 'none';
    opOnConfirm = null;
    opOnApproveWithOverride = null;
    opCurrentOrder = null;
    opMainActions.style.display = 'flex';
    opOverrideBtn.style.display = 'none';
    opPostApproveActions.style.display = 'none';
  }

  // Every approval path, including bulk and stock override, uses the same
  // transaction warning. Confirmed prices are checked again inside that
  // transaction, so a changed catalogue cannot reuse an old acknowledgement.
  async function approveWithPriceReview(order, allowNegativeStock = false) {
    let priceAcknowledgement = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await approveOrderWithStock(order, { uid: user.uid, email: user.email, allowNegativeStock, priceAcknowledgement });
      } catch (err) {
        if (err.code !== 'price-acknowledgement-required') throw err;
        const text = orderPriceReviewText(err.priceReview);
        if (opCurrentOrder?.id === order.id) {
          opPriceReview.textContent = text;
          opPriceReview.style.display = 'block';
        }
        if (!confirm(`Order ${order.orderNo || order.id}\n\n${text}\n\nI acknowledge these differences and approve at the ORDER prices. Continue?`)) {
          throw new Error('Approval cancelled. Price differences were not acknowledged; no stock was deducted.');
        }
        priceAcknowledgement = { reviewKey: err.priceReview.key };
      }
    }
    throw new Error('Catalogue prices keep changing. Refresh and review this order before approving.');
  }

  opCloseBtn.addEventListener('click', closeOrderPreviewModal);
  opCancelBtn.addEventListener('click', closeOrderPreviewModal);
  opDoneBtn.addEventListener('click', closeOrderPreviewModal);
  orderPreviewModal.addEventListener('click', (e) => { if (e.target === orderPreviewModal) closeOrderPreviewModal(); });

  function showPostApproveActions() {
    opMainActions.style.display = 'none';
    opOverrideBtn.style.display = 'none';
    opShortageWarning.style.display = 'none';
    opPostApproveActions.style.display = 'block';
  }

  opConfirmBtn.addEventListener('click', async () => {
    if (typeof opOnConfirm !== 'function') return;
    setButtonLoading(opConfirmBtn, 'Working…');
    try {
      const result = await opOnConfirm();
      if (result && result.approved) showPostApproveActions();
      else closeOrderPreviewModal();
    } catch (err) {
      if (err.isStockShortage && opOnApproveWithOverride) {
        opShortageWarning.innerHTML = '<strong>Stock is short for:</strong><br>' +
          err.shortages.map(s => `${esc(s.desc)}: need ${s.needed}, have ${s.available}`).join('<br>');
        opShortageWarning.style.display = 'block';
        opOverrideBtn.style.display = 'block';
      } else {
        showToast(err.message, 'error');
      }
    } finally {
      clearButtonLoading(opConfirmBtn);
    }
  });

  opOverrideBtn.addEventListener('click', async () => {
    if (typeof opOnApproveWithOverride !== 'function') return;
    const confirmed = confirm('Approve anyway even though stock is insufficient?\n\nStock will go negative for the short item(s) and will need reconciling later.');
    if (!confirmed) return;
    setButtonLoading(opOverrideBtn, 'Approving…');
    try {
      await opOnApproveWithOverride();
      showPostApproveActions();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      clearButtonLoading(opOverrideBtn);
    }
  });

  opEditBeforeApproveBtn.addEventListener('click', () => {
    const order = opCurrentOrder;
    closeOrderPreviewModal();
    if (order && window.__openEditOrderModal) window.__openEditOrderModal(order);
  });

  opEditNowBtn.addEventListener('click', () => {
    const order = opCurrentOrder;
    closeOrderPreviewModal();
    if (order && window.__openEditOrderModal) window.__openEditOrderModal(order);
  });

  opPrintNowBtn.addEventListener('click', () => {
    const order = opCurrentOrder;
    closeOrderPreviewModal();
    if (order && window.__openGenerateInvoiceModal) window.__openGenerateInvoiceModal(order);
  });

  function orderStatusBadge(status) {
    return `<span class="order-status-badge order-status-${esc(status)}">${esc(status)}</span>`;
  }

  // Today / Yesterday / full-date section headers, same idea as a chat
  // app's date dividers — makes it obvious at a glance which orders are
  // most recent without having to read timestamps row by row. The list
  // itself is already sorted newest-first (orderBy('createdAt','desc')
  // in orders.js), so this only needs to detect when the date changes
  // between consecutive rows, not re-sort anything.
  function orderDateGroupLabel(ts) {
    if (!ts || typeof ts.toDate !== 'function') return 'Date unknown';
    const d = ts.toDate();
    const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function renderOrderRows(list) {
    orderListBody.innerHTML = '';
    orderListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    const groupColspan = isManager ? 7 : 6;
    let lastGroupLabel = null;
    list.forEach(o => {
      const groupLabel = orderDateGroupLabel(o.createdAt);
      if (groupLabel !== lastGroupLabel) {
        lastGroupLabel = groupLabel;
        const groupTr = document.createElement('tr');
        groupTr.innerHTML = `<td colspan="${esc(groupColspan)}" class="order-date-group-row">${esc(groupLabel)}</td>`;
        orderListBody.appendChild(groupTr);
      }
      const tr = document.createElement('tr');
      tr.dataset.id = o.id;
      const itemsSummary = (o.items || []).map(it => `${it.qty}× ${it.desc}`).join(', ') || '—';
      const priceReview = isManager ? reviewOrderPrices(o.items, productsCache) : null;
      const checkboxCell = isManager
        ? `<td>${(o.status === 'Submitted' || o.status === 'Approved' || o.status === 'Invoicing') ? `<input type="checkbox" class="bulk-approve-checkbox" data-id="${esc(o.id)}" ${esc(selectedOrderIds.has(o.id) ? 'checked' : '')}>` : ''}</td>`
        : '';
      const baseCells = `
        ${checkboxCell}
        <td>${esc(o.orderNo)}</td>
        <td>${esc(o.customerName)}</td>
        <td class="inv-products-cell" title="${esc(itemsSummary)}">${esc(itemsSummary)}</td>
        <td>${esc(mwk(o.grandTotal || 0))}</td>
        <td>${orderStatusBadge(o.status)}</td>
      `;
      let actions = '';
      if (isManager) {
        if (o.status === 'Submitted') {
          actions = `
            <button type="button" class="list-action-btn" data-action="edit">Edit</button>
            <button type="button" class="list-action-btn" data-action="approve">Approve</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="reject">Reject</button>
          `;
        } else if (o.status === 'Approved') {
          actions = `
            <button type="button" class="list-action-btn" data-action="edit">Edit</button>
            <button type="button" class="list-action-btn" data-action="generate-invoice">Generate Invoice</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="cancel">Cancel order</button>
          `;
        } else if (o.status === 'Cancelled') {
          actions = `<span style="font-size:0.75rem; color:var(--muted);">Cancelled${o.cancelledByEmail ? ' by ' + esc(o.cancelledByEmail) : ''}${o.cancelReason ? ': ' + esc(o.cancelReason) : ''}</span>`;
        }
      } else if (o.status === 'Cancelled') {
        actions = `<span style="font-size:0.75rem; color:var(--muted);">Cancelled${o.cancelReason ? ': ' + esc(o.cancelReason) : ''}</span>`;
      }
      // Reps: no actions — only managers change order status now.
      tr.innerHTML = baseCells + `<td>${actions}</td>`;
      if (priceReview && (priceReview.differences.length || priceReview.missingPrices.length)) {
        const priceNote = document.createElement('div');
        priceNote.className = 'order-price-note';
        priceNote.style.cssText = 'white-space:pre-line; font-size:0.75rem; color:#7a5210; margin-top:5px;';
        priceNote.textContent = orderPriceReviewText(priceReview);
        tr.querySelector('.inv-products-cell').appendChild(priceNote);
      }
      orderListBody.appendChild(tr);
    });
  }

  async function resetAndLoadOrders() {
    ordersGuard.reset();
    loadedOrders = []; ordersCursor = null; ordersHasMore = true;
    selectedOrderIds.clear();
    updateBulkApproveBar();
    orderListTitle.textContent = isManager
      ? (currentOrderStatusFilter === 'all' ? 'All Orders' : `Orders: ${currentOrderStatusFilter}`)
      : 'My Orders';
    orderListHead.innerHTML = isManager
      ? `<tr><th></th><th>Order No.</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr>`
      : `<tr><th>Order No.</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr>`;
    await loadNextOrderPage();
  }

  async function loadNextOrderPage() {
    if (!ordersHasMore) return;
    // Query inputs are captured synchronously, before any await.
    const cursor = ordersCursor, status = currentOrderStatusFilter, manager = isManager;
    await ordersGuard.run({
      setLoading: (on) => (on ? setButtonLoading(loadMoreOrdersBtn, 'Loading…') : clearButtonLoading(loadMoreOrdersBtn)),
      fetch: () => (manager
        ? (status === 'all' ? fetchAllOrdersPage(cursor) : fetchOrdersByStatusPage(status, cursor))
        : fetchMyOrdersPage(user.uid, cursor)),
      apply: (result) => {
        loadedOrders = mergeById(loadedOrders, result.items);
        ordersCursor = result.lastDoc; ordersHasMore = result.hasMore;
        renderOrderRows(loadedOrders);
        loadMoreOrdersBtn.style.display = ordersHasMore ? 'block' : 'none';
      },
      onError: (err) => showToast('Could not load orders: ' + err.message, 'error'),
    });
  }

  loadMoreOrdersBtn.addEventListener('click', loadNextOrderPage);

  if (isManager) {
    orderStatusFilter.addEventListener('change', async () => {
      currentOrderStatusFilter = orderStatusFilter.value;
      await resetAndLoadOrders();
    });

    orderListBody.addEventListener('change', (e) => {
      const cb = e.target.closest('.bulk-approve-checkbox');
      if (!cb) return;
      if (cb.checked) selectedOrderIds.add(cb.dataset.id);
      else selectedOrderIds.delete(cb.dataset.id);
      updateBulkApproveBar();
    });

    // Approves every selected Submitted order, one at a time — not in
    // parallel, so each one gets its own clean Firestore transaction
    // and a clear individual result instead of a pile of racing writes.
    // Orders short on stock are skipped (not force-approved) and
    // reported at the end; use the single-order Approve flow with its
    // manager override if one of those genuinely needs pushing through.
    async function runBulkApprove(ids) {
      const orders = ids.map(id => loadedOrders.find(o => o.id === id)).filter(Boolean);
      if (!orders.length) return;

      // Safe to repeat: approveOrderWithStock reads the order INSIDE its
      // transaction and only acts while it is still Submitted, so a retry (or a
      // second tab) can never deduct stock twice, and it refuses an order whose
      // items changed since this list was loaded.
      async function approveOne(order, allowNegativeStock) {
        try {
          await approveWithPriceReview(order, allowNegativeStock);
          return { state: 'done', text: allowNegativeStock ? 'Approved with stock override' : 'Approved · stock deducted' };
        } catch (err) {
          if (err.isStockShortage) {
            return { state: 'failed', isStockShortage: true, text: 'Short on stock: ' + err.shortages.map(s => `${s.desc} (need ${s.needed}, have ${s.available})`).join(', ') };
          }
          const fresh = await fetchOrderById(order.id).catch(() => null);
          if (fresh && fresh.status !== 'Submitted' && err.code !== 'order-changed') return { state: 'skipped', text: `Already ${fresh.status}` };
          return { state: 'failed', text: err.message };
        }
      }

      const result = await runBulkJob({
        title: `Approve ${orders.length} order(s)`,
        intro: 'Each order is approved one at a time and its stock deducted once. Orders short on stock are skipped and listed — you can force them through at the end if needed.',
        startLabel: `Approve ${orders.length} order(s)`,
        orders,
        lockButtons: [bulkApproveBtn],
        runOne: order => approveOne(order, false),
        followUp: {
          rows: r => r.isStockShortage,
          label: n => `Force-approve ${n} short on stock`,
          confirmText: n => `Force-approve ${n} order(s) anyway?\n\nStock will go negative for the short items — set correct stock afterwards (Products → Adjust Stock) to reconcile it.`,
          runOne: order => approveOne(order, true),
        },
      });

      if (!result.started) return;
      selectedOrderIds.clear();
      await resetAndLoadOrders();
      await loadProductsCache();
    }

    // Generates and downloads an invoice for each selected Approved order —
    // no per-invoice editing popup. Shared by the Orders tab (selected
    // Approved orders) and the Invoices tab's "Orders Ready to Invoice" list,
    // so it takes order objects; progressBtn is whichever button opened it.
    async function generateInvoicesForOrders(orders, progressBtn) {
      if (!orders.length) return;
      const today = new Date().toISOString().slice(0, 10);

      // Safe to repeat (see invoiceFlow.js): the invoice content comes from the order exactly
      // as it was when this list was loaded; if the order changed since, the commit is refused
      // (order-changed). A PDF problem after saving is "saved, PDF failed", never a failed
      // invoice, and "Download PDF" never saves another.
      const invoiceOne = (order) => invoiceOrderForBulk({ order, today, uid: user.uid, issue: issueInvoiceForOrder, makePdf: generatePdf });

      const result = await runBulkJob({
        title: `Generate ${orders.length} invoice(s)`,
        intro: 'Each invoice is saved and downloaded as its own PDF. If your browser asks to allow multiple downloads, choose Allow. Keep this page open until it finishes.',
        startLabel: `Generate ${orders.length} invoice(s)`,
        orders,
        lockButtons: [progressBtn],
        runOne: invoiceOne,
      });

      if (!result.started) return;
      try {
        await resetAndLoadOrders();
        if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
      } catch (err) {
        console.error(err);
        showToast('The invoices were saved, but the list could not refresh. Reload the page to see them.', 'info', 8000);
      }
    }
    window.__generateInvoicesForOrders = generateInvoicesForOrders;

    bulkApproveBtn.addEventListener('click', async () => {
      const ids = [...selectedOrderIds];
      if (!ids.length || !bulkMode || bulkMode === 'mixed') return;
      if (bulkMode === 'approve') {
        await runBulkApprove(ids);
      } else if (bulkMode === 'generate') {
        const orders = ids.map(id => loadedOrders.find(o => o.id === id)).filter(Boolean);
        await generateInvoicesForOrders(orders, bulkApproveBtn);
      }
    });
  }

  orderListBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;
    const order = loadedOrders.find(o => o.id === id);
    if (!order) return;

    if (btn.dataset.action === 'approve') {
      const shortages = (order.items || [])
        .filter(it => it.productId)
        .map(it => {
          const p = productsCache.find(pp => pp.id === it.productId);
          const available = p ? (p.stockOnHand ?? 0) : 0;
          return { desc: it.desc, needed: it.qty, available };
        })
        .filter(s => s.needed > s.available);

      openOrderPreviewModal(order, {
        confirmLabel: 'Approve Order',
        shortages,
        onConfirm: async () => {
          // approveOrderWithStock throws an error with .isStockShortage
          // if stock turns out to be insufficient (checked fresh, inside
          // its own transaction — not just against this possibly-stale
          // shortages array). The modal catches that and offers the
          // override button below instead of a dead-end error toast.
          await approveWithPriceReview(order);
          showToast(`Order ${order.orderNo} approved.`, 'success');
          await resetAndLoadOrders();
          await loadProductsCache();
          return { approved: true };
        },
        onApproveWithOverride: async () => {
          await approveWithPriceReview(order, true);
          showToast(`Order ${order.orderNo} approved (stock override).`, 'success');
          await resetAndLoadOrders();
          await loadProductsCache();
        },
      });
    } else if (btn.dataset.action === 'reject') {
      // Submitted orders never touched stock, so rejecting one is just
      // a status change — kept (not deleted) so there's a record of
      // why it didn't go through.
      const reason = prompt(`Reason for rejecting order ${order.orderNo} (optional):`) || '';
      setButtonLoading(btn, '…');
      try {
        await rejectOrder(id, reason);
        showToast(`Order ${order.orderNo} rejected.`, 'success');
        await resetAndLoadOrders();
      } catch (err) {
        showToast('Could not reject: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'cancel') {
      // Cancelling KEEPS the order (status Cancelled, reason, who, server time). An Approved order's stock is
      // restored exactly once (stock.js cancelOrder). Invoiced / delivered orders are refused there.
      openCancelOrderModal(order, btn);
    } else if (btn.dataset.action === 'generate-invoice') {
      if (window.__openGenerateInvoiceModal) window.__openGenerateInvoiceModal(order);
    } else if (btn.dataset.action === 'edit') {
      if (window.__openEditOrderModal) window.__openEditOrderModal(order);
    }
  });

  // ============= CANCEL ORDER MODAL (manager only) =============
  function openCancelOrderModal(order, triggerBtn) {
    const modal = document.getElementById('cancelOrderModal');
    const reason = document.getElementById('cancelOrderReason');
    const err = document.getElementById('cancelOrderError');
    const confirmBtn = document.getElementById('cancelOrderConfirmBtn');
    document.getElementById('cancelOrderNoLabel').textContent = order.orderNo || '';
    document.getElementById('cancelOrderHint').textContent = order.status === 'Approved'
      ? 'The order is kept (marked Cancelled). The stock reserved when it was approved is returned to stock once, and the stock history records it.'
      : 'The order is kept (marked Cancelled). No stock was reserved, so stock does not change.';
    reason.value = ''; err.style.display = 'none';
    // Recovery row (built with DOM nodes): shown only after the normal cancel was refused because the stored lines are not valid.
    modal.querySelectorAll('.cancel-recovery-row').forEach(n => n.remove());
    let recoveryBox = null;
    modal.style.display = 'flex';
    const close = () => { modal.style.display = 'none'; confirmBtn.onclick = null; modal.querySelectorAll('.cancel-recovery-row').forEach(n => n.remove()); };
    document.getElementById('cancelOrderCloseBtn').onclick = close;
    document.getElementById('cancelOrderBackBtn').onclick = close;
    let busy = false;
    confirmBtn.onclick = async () => {
      if (busy) return;                                            // repeated clicks do nothing
      const problem = validateCancelReason(reason.value);
      if (problem) { err.textContent = problem; err.style.display = 'block'; reason.focus(); return; }
      busy = true;
      setButtonLoading(confirmBtn, 'Cancelling…');
      try {
        const res = await cancelOrder(order, { reason: reason.value, uid: user.uid, email: user.email, recoverWithoutRestore: !!(recoveryBox && recoveryBox.checked) });
        close();
        showToast(res.alreadyCancelled
          ? `Order ${order.orderNo} was already cancelled. Nothing changed; stock was not restored again.`
          : (res.stockRestored ? `Order ${order.orderNo} cancelled. Stock restored.` : `Order ${order.orderNo} cancelled.`), res.alreadyCancelled ? 'info' : 'success');
        await resetAndLoadOrders();
        await loadProductsCache();
      } catch (e) {
        err.textContent = e.message; err.style.display = 'block';
        if (e.code === 'invalid-order-lines' && order.status === 'Approved' && !recoveryBox) {
          const row = document.createElement('label'); row.className = 'cancel-recovery-row'; row.style.cssText = 'display:block; margin-top:8px; font-size:0.82rem;';
          recoveryBox = document.createElement('input'); recoveryBox.type = 'checkbox'; recoveryBox.id = 'cancelRecoveryBox';
          row.appendChild(recoveryBox);
          row.appendChild(document.createTextNode(' Cancel WITHOUT restoring stock (recovery). I will correct stock with manual adjustments from the stock history.'));
          err.insertAdjacentElement('afterend', row);
        }
      } finally {
        busy = false;
        clearButtonLoading(confirmBtn);
      }
    };
  }

  // ============= EDIT ORDER MODAL (manager only) =============
  if (isManager) {
    const editOrderModal = document.getElementById('editOrderModal');
    const editOrderNoLabel = document.getElementById('editOrderNoLabel');
    const eoCustName = document.getElementById('eoCustName');
    const eoCustPhone = document.getElementById('eoCustPhone');
    const eoCustLocation = document.getElementById('eoCustLocation');
    const eoQuickAddGrid = document.getElementById('eoQuickAddGrid');
    const eoItemsBody = document.getElementById('eoItemsBody');
    const eoAddItemBtn = document.getElementById('eoAddItemBtn');
    const eoNotes = document.getElementById('eoNotes');
    const eoErrorNote = document.getElementById('eoErrorNote');
    const eoSaveBtn = document.getElementById('eoSaveBtn');
    const eoCancelBtn = document.getElementById('eoCancelBtn');
    const eoCloseBtn = document.getElementById('eoCloseBtn');

    let editingOrder = null;
    let editingOrderRevision = null; // content fingerprint captured when the modal opened

    function openEditOrderModal(order) {
      editingOrder = order;
      editingOrderRevision = orderRevisionKey(order);
      eoErrorNote.style.display = 'none';
      editOrderNoLabel.textContent = order.orderNo;
      eoCustName.value = order.customerName || '';
      eoCustPhone.value = order.customerPhone || '';
      eoCustLocation.value = order.customerLocation || '';
      eoNotes.value = order.notes || '';
      eoItemsBody.innerHTML = '';
      fillItemRows(eoItemsBody, order.items); // keeps productId, so stock tracking survives an edit
      // Quick-add grid uses whatever's currently in productsCache (loaded on app init).
      buildQuickAddGrid(eoQuickAddGrid, eoItemsBody, () => {}, productsCache);
      editOrderModal.style.display = 'flex';
    }

    function closeEditOrderModal() {
      editOrderModal.style.display = 'none';
      editingOrder = null;
      editingOrderRevision = null;
      eoItemsBody.innerHTML = '';
    }

    eoAddItemBtn.addEventListener('click', () => addItemRow(eoItemsBody, () => {}));
    eoCancelBtn.addEventListener('click', closeEditOrderModal);
    eoCloseBtn.addEventListener('click', closeEditOrderModal);
    editOrderModal.addEventListener('click', (e) => {
      if (e.target === editOrderModal) closeEditOrderModal();
    });

    eoSaveBtn.addEventListener('click', async () => {
      if (!editingOrder) return;
      const customerName = eoCustName.value.trim();
      const customerPhone = eoCustPhone.value.trim();
      const customerLocation = eoCustLocation.value.trim();
      const notes = eoNotes.value.trim();
      const items = getItems(eoItemsBody);
      { const lv = validateOrderLines(items); if (!lv.ok) { eoErrorNote.textContent = lv.problems[0]; eoErrorNote.style.display = 'block'; return; } }

      if (!customerName) {
        eoErrorNote.textContent = 'Customer name cannot be empty.';
        eoErrorNote.style.display = 'block';
        return;
      }
      if (items.length === 0) {
        eoErrorNote.textContent = 'Add at least one item.';
        eoErrorNote.style.display = 'block';
        return;
      }
      eoErrorNote.style.display = 'none';
      setButtonLoading(eoSaveBtn, 'Saving…');
      try {
        // One transaction: reads the CURRENT order, checks status and revision, writes the
        // order, the product balances and the ledger together. Saving identical content
        // again (retry) changes nothing.
        await editOrderWithStock(editingOrder.id, {
          expectedRevision: editingOrderRevision,
          details: { customerId: editingOrder.customerId || null, customerName, customerPhone, customerLocation, notes },
          items,
        }, { uid: user.uid, email: user.email });
        if (editingOrder.status === 'Approved') await loadProductsCache();
        const idx = loadedOrders.findIndex(o => o.id === editingOrder.id);
        if (idx !== -1) {
          const grandTotal = items.reduce((sum, it) => sum + (it.total || 0), 0);
          loadedOrders[idx] = {
            ...loadedOrders[idx],
            customerName, customerPhone, customerLocation, items, notes, grandTotal,
          };
        }
        renderOrderRows(loadedOrders);
        showToast(`Order ${editingOrder.orderNo} updated.`, 'success');
        closeEditOrderModal();
      } catch (err) {
        eoErrorNote.textContent = 'Could not save: ' + err.message;
        eoErrorNote.style.display = 'block';
      } finally {
        clearButtonLoading(eoSaveBtn);
      }
    });

    window.__openEditOrderModal = openEditOrderModal;
  }

  // ============= ENTER AN ORDER FOR A SALES REP (manager only) =============
  // The order is credited to the chosen rep and recorded as entered by the manager. It creates NO visit and is not a
  // completed shop visit (reports show it in its own column). Numbering and retries: managerOrders.js.
  if (isManager) {
    const moBtn = document.getElementById('enterOrderForRepBtn');
    const moModal = document.getElementById('managerOrderModal');
    const moRep = document.getElementById('moRep');
    const moCustSearch = document.getElementById('moCustSearch');
    const moCustSuggestions = document.getElementById('moCustSuggestions');
    const moCustSelected = document.getElementById('moCustSelected');
    const moItemsBody = document.getElementById('moItemsBody');
    const moNotes = document.getElementById('moNotes');
    const moError = document.getElementById('moError');
    const moSaveBtn = document.getElementById('moSaveBtn');
    let moCustomer = null, moRequestId = null, moSaving = false;
    moBtn.style.display = 'inline-block';

    const moClose = () => { moModal.style.display = 'none'; };
    async function moOpen() {
      let reps = [];
      try { reps = await fetchRepEmails(); } catch (err) { showToast('Could not load the sales reps: ' + err.message, 'error'); return; }
      if (!reps.length) { showToast('There are no sales reps set up.', 'error'); return; }
      moRep.innerHTML = '<option value="">Choose a sales rep…</option>' + reps.map(r => `<option value="${esc(r)}">${esc(displayNameForEmail(r))}</option>`).join('');
      moCustomer = null; moCustSearch.value = ''; moCustSelected.textContent = ''; moNotes.value = ''; moError.style.display = 'none';
      moItemsBody.innerHTML = '';
      buildQuickAddGrid(document.getElementById('moQuickAddGrid'), moItemsBody, () => {}, productsCache);
      moRequestId = newRequestId();          // kept until the save succeeds or the dialog is reopened: a retry cannot create a second order
      moModal.style.display = 'flex';
    }
    moBtn.addEventListener('click', moOpen);
    document.getElementById('moCloseBtn').addEventListener('click', moClose);
    document.getElementById('moBackBtn').addEventListener('click', moClose);

    moCustSearch.addEventListener('input', () => {
      const q = moCustSearch.value.trim().toLowerCase();
      if (!q) { moCustSuggestions.style.display = 'none'; return; }
      const matches = customersCache.filter(c => c.active !== false && !c.mergeLock && (c.name || '').toLowerCase().includes(q)).slice(0, 8);
      moCustSuggestions.innerHTML = matches.map(c => `<div class="suggestion-item" data-id="${esc(c.id)}"><span class="sug-name">${esc(c.name)}</span><span class="sug-meta">${esc(c.location || '')}${esc(hasPin(c) ? '' : ' · ⚠ no pin')}</span></div>`).join('');
      moCustSuggestions.style.display = matches.length ? 'block' : 'none';
    });
    moCustSuggestions.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      const c = customersCache.find(cc => cc.id === item.dataset.id);
      if (!c) return;
      moCustomer = c; moCustSearch.value = c.name; moCustSuggestions.style.display = 'none';
      moCustSelected.textContent = hasPin(c) ? `Selected: ${c.name}` : `Selected: ${c.name} — this customer has no pinned location; pin it first.`;
    });

    moSaveBtn.addEventListener('click', async () => {
      if (moSaving) return;
      const rep = moRep.value;
      if (!rep) { moError.textContent = 'Choose the sales rep this order is for.'; moError.style.display = 'block'; return; }
      if (!moCustomer) { moError.textContent = 'Choose a customer.'; moError.style.display = 'block'; return; }
      if (!hasPin(moCustomer)) { moError.textContent = 'This customer has no pinned location. Pin it first.'; moError.style.display = 'block'; return; }
      const items = getItems(moItemsBody);
      const problem = validateOrderItems(items);
      if (problem) { moError.textContent = problem; moError.style.display = 'block'; return; }
      moError.style.display = 'none';
      moSaving = true;
      setButtonLoading(moSaveBtn, 'Saving…');
      try {
        const res = await submitOrderAsManager({ customerId: moCustomer.id, items, notes: moNotes.value, attributedRepEmail: rep, requestId: moRequestId, uid: user.uid, email: user.email });
        showToast(res.alreadySaved ? `Order ${res.orderNo} had already been saved. No duplicate was created.` : `Order ${res.orderNo} saved for ${displayNameForEmail(rep)}. No visit was recorded.`, res.alreadySaved ? 'info' : 'success');
        moClose();
        await resetAndLoadOrders();
      } catch (err) {
        moError.textContent = (err.code === 'order-conflict' ? err.message : 'Could not save the order: ' + err.message + ' You can press Save again; it will not create a duplicate.');
        moError.style.display = 'block';
        if (err.code === 'order-conflict') moRequestId = newRequestId();   // the next Save is deliberately a NEW order
      } finally {
        moSaving = false;
        clearButtonLoading(moSaveBtn);
      }
    });
  }

  // ============= TODAY'S VISITS (sales rep) =============
  // Opens automatically for a rep. Everyone shares one list (active customers whose weekly
  // day matches today in MALAWI time); each rep's visits and progress are recorded separately.
  if (!isManager) {
    const lvCustSearch = document.getElementById('lvCustSearch');
    const lvCustSuggestions = document.getElementById('lvCustSuggestions');
    const lvSelectedCustomer = document.getElementById('lvSelectedCustomer');
    const lvCustName = document.getElementById('lvCustName');
    const lvCustPhone = document.getElementById('lvCustPhone');
    const lvCustLocation = document.getElementById('lvCustLocation');
    const lvClearCustomer = document.getElementById('lvClearCustomer');
    const lvOutcomeCard = document.getElementById('lvOutcomeCard');
    const lvOutcomeYes = document.getElementById('lvOutcomeYes');
    const lvOutcomeNo = document.getElementById('lvOutcomeNo');
    const lvNoOrderFields = document.getElementById('lvNoOrderFields');
    const lvReason = document.getElementById('lvReason');
    const lvReasonNotes = document.getElementById('lvReasonNotes');
    const lvReasonNotesLabel = document.getElementById('lvReasonNotesLabel');
    const lvNoOrderError = document.getElementById('lvNoOrderError');
    const lvRepeatNote = document.getElementById('lvRepeatNote');
    const lvConflictBox = document.getElementById('lvConflictBox');
    const lvConflictText = document.getElementById('lvConflictText');
    let lvConflict = false;   // true while the rep has to choose between the saved visit and a new one
    const lvSubmitNoOrderBtn = document.getElementById('lvSubmitNoOrderBtn');
    const lvOrderFormWrap = document.getElementById('lvOrderFormWrap');
    const lvOrderNotes = document.getElementById('lvOrderNotes');
    const lvSubmitOrderBtn = document.getElementById('lvSubmitOrderBtn');
    const lvCustPinStatus = document.getElementById('lvCustPinStatus');
    const lvPinRequired = document.getElementById('lvPinRequired');
    const lvPinNowBtn = document.getElementById('lvPinNowBtn');

    let lvSelected = null;
    let lvRequestId = null;   // one per shop selection; kept across failed/ambiguous saves so a retry cannot duplicate
    let lvSaving = false;     // blocks double-clicks while a save is in flight

    // ---- Pinned-location gate ----
    // A rep can log a "No Order" visit for any customer, but cannot place
    // an order for a customer without a pin: they are prompted to pin the
    // location first, and the order form only appears once it is saved.
    function lvRefreshPinStatus() {
      const ok = !!lvSelected && hasPin(lvSelected);
      lvCustPinStatus.textContent = lvSelected ? (ok ? '📍 Pinned ✓' : '⚠ No pinned location') : '';
      lvCustPinStatus.style.color = ok ? '#3a7d2c' : '#b3261e';
    }

    function lvApplyPinGate() {
      lvRefreshPinStatus();
      const wantsOrder = lvOutcomeYes.classList.contains('active');
      const ok = !!lvSelected && hasPin(lvSelected);
      lvPinRequired.style.display = (wantsOrder && !ok) ? 'block' : 'none';
      lvOrderFormWrap.style.display = (wantsOrder && ok) ? 'block' : 'none';
    }

    function lvPromptForPin() {
      if (!lvSelected) return;
      const target = lvSelected;
      openLocationPicker({
        label: target.name, lat: null, lng: null,
        onSave: async ({ lat, lng }) => {
          await updateCustomerLocation(target.id, { lat, lng });
          target.lat = lat; target.lng = lng;      // same object the customer cache holds
          if (lvSelected && lvSelected.id === target.id) lvApplyPinGate();
          renderTodaysVisits();
          showToast('Location pinned. You can place the order now.', 'success');
        },
      });
    }

    lvPinNowBtn.addEventListener('click', lvPromptForPin);

    function lvResetOutcome() {
      lvOutcomeCard.style.display = 'none';
      lvNoOrderFields.style.display = 'none';
      lvOrderFormWrap.style.display = 'none';
      lvPinRequired.style.display = 'none';
      lvOutcomeYes.classList.remove('active');
      lvOutcomeNo.classList.remove('active');
      lvOrderItemsBody.innerHTML = '';
      lvOrderNotes.value = '';
      lvReasonNotes.value = '';
      lvReason.selectedIndex = 0;            // "Select a reason…" — never pre-chosen
      lvNoOrderError.style.display = 'none';
      lvRepeatNote.style.display = 'none';
      lvConflict = false; lvConflictBox.style.display = 'none';
      lvUpdateExplanationLabel();
    }

    // The request id was already saved with DIFFERENT details. Nothing new was saved. Show what
    // is on record and make the rep choose; never swap the request id automatically.
    function lvShowConflict(err) {
      lvConflict = true;
      lvConflictText.textContent = 'On record: ' + (err.message.match(/differently: (.*?)\. The new details/)?.[1] || 'a visit saved earlier') + '.';
      lvConflictBox.style.display = 'block';
      lvConflictBox.scrollIntoView?.({ block: 'center' });
    }
    document.getElementById('lvConflictKeepBtn').addEventListener('click', () => {
      if (lvSaving) return;
      lvConflict = false; lvConflictBox.style.display = 'none';
      lvAfterSaved();                       // close the form and reload what is actually saved
    });
    document.getElementById('lvConflictNewBtn').addEventListener('click', () => {
      if (lvSaving) return;
      lvRequestId = newRequestId();         // deliberate choice by the rep: a separate, extra visit
      lvConflict = false; lvConflictBox.style.display = 'none';
      showToast('Ready to record this as a new visit. Check the details and save again.', 'info');
    });

    function lvResetAll() {
      lvSelected = null;
      lvRequestId = null;
      lvSelectedCustomer.style.display = 'none';
      lvCustSearch.style.display = 'block';
      lvCustSearch.value = '';
      lvResetOutcome();
    }

    function lvUpdateExplanationLabel() {
      lvReasonNotesLabel.textContent = lvReason.value === 'Other' ? 'Explanation (required for "Other")' : 'Details (optional)';
      lvReasonNotes.required = lvReason.value === 'Other';
    }
    lvReason.addEventListener('change', () => { lvUpdateExplanationLabel(); lvNoOrderError.style.display = 'none'; });

    // Reps can only use Quick Add from the catalog — free-text custom
    // items are how inconsistent/misspelled product descriptions creep
    // into orders, so that's manager-only (see the New Invoice form and
    // Edit Order modal, which both keep their "+ Add custom item"
    // button since those are already manager-only screens).
    document.getElementById('lvOrderAddItemBtn').style.display = 'none';

    function selectCustomerForVisit(c) {
      lvSelected = c;
      lvRequestId = newRequestId();
      lvCustName.textContent = c.name;
      lvCustPhone.textContent = c.phone || '';
      lvCustLocation.textContent = c.location || '';
      lvRefreshPinStatus();
      lvSelectedCustomer.style.display = 'block';
      lvCustSearch.style.display = 'none';
      lvCustSuggestions.style.display = 'none';
      lvOutcomeCard.style.display = 'block';
      const earlier = todayVisits.filter(v => v.customerId === c.id);
      if (earlier.length) {
        const last = earlier[earlier.length - 1];
        lvRepeatNote.textContent = `Already visited today (${last.outcome === 'Order Placed' ? 'order ' + (last.orderNo || '') : 'no order: ' + (last.reasonNoOrder || '')}). Saving again records an extra visit; it still counts as one shop visited.`;
        lvRepeatNote.style.display = 'block';
      } else {
        lvRepeatNote.style.display = 'none';
      }
    }

    // ---- Today's list and progress ----
    // Saved visits are the single source of truth: the list and the counters are rebuilt from
    // them, so leaving the screen or refreshing the page shows the same progress.
    const todaysRouteCard = document.getElementById('todaysRouteCard');
    const todaysRouteDayLabel = document.getElementById('todaysRouteDayLabel');
    const todaysRouteDate = document.getElementById('todaysRouteDate');
    const todaysRouteList = document.getElementById('todaysRouteList');
    const todaysRouteEmpty = document.getElementById('todaysRouteEmpty');
    const todaysOtherWrap = document.getElementById('todaysOtherWrap');
    const todaysOtherList = document.getElementById('todaysOtherList');
    const todaysLoadError = document.getElementById('todaysLoadError');
    const dayFullNames = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };

    let todayVisits = [];        // this rep's visits for todayDate
    let todayDate = malawiDate();
    let visitsLoaded = false;

    // Straight-line route ordering for today's customers. Start = the phone's GPS position.
    // Unpinned customers go last.
    let todaysRouteInfo = null; // Map(customerId -> { stopNo, legKm })
    const todaysRouteOptimizeBtn = document.getElementById('todaysRouteOptimizeBtn');
    const todaysRouteSummary = document.getElementById('todaysRouteSummary');

    todaysRouteOptimizeBtn.addEventListener('click', async () => {
      const todays = scheduledForDate(customersCache, todayDate);
      const pinned = todays.filter(hasPin);
      if (pinned.length === 0) { showToast('None of today\'s customers have a pin yet.', 'error'); return; }
      setButtonLoading(todaysRouteOptimizeBtn, 'Finding your location…');
      try {
        const start = await getStartPoint();
        if (!start) {
          showToast('Allow location access on your phone to find the shortest route.', 'error');
          return;
        }
        const { ordered, totalKm } = orderStops(start, pinned.map(c => ({ id: c.id, lat: c.lat, lng: c.lng })));
        todaysRouteInfo = new Map(ordered.map(o => [o.id, { stopNo: o.stopNo, legKm: o.legKm }]));
        todaysRouteSummary.style.display = 'block';
        todaysRouteSummary.textContent =
          `Shortest route from ${startLabel(start)}: about ${esc(formatKm(totalKm))} for ${ordered.length} stop${ordered.length === 1 ? '' : 's'} (straight-line).` +
          (todays.length > pinned.length ? ` ${todays.length - pinned.length} without a pin are listed last.` : '');
        renderTodaysVisits();
      } finally {
        clearButtonLoading(todaysRouteOptimizeBtn);
      }
    });

    function visitStatusHtml(visits) {
      if (!visits || !visits.length) return '<span class="visit-status todo">To visit</span>';
      const last = visits[visits.length - 1];
      const more = visits.length > 1 ? ` · ${visits.length} visits` : '';
      return last.outcome === 'Order Placed'
        ? `<span class="visit-status order">✓ Order ${esc(last.orderNo || '')}${esc(more)}</span>`
        : `<span class="visit-status noorder">✓ No order: ${esc(last.reasonNoOrder || '')}${esc(more)}</span>`;
    }

    function renderTodaysVisits() {
      todayDate = malawiDate();
      const weekday = weekdayOfDate(todayDate);
      todaysRouteCard.style.display = 'block';
      todaysRouteDayLabel.textContent = dayFullNames[weekday];
      todaysRouteDate.textContent = `(${formatDate(todayDate)}, Malawi time)`;

      const progress = repDayProgress({ customers: customersCache, visits: todayVisits, date: todayDate });
      document.getElementById('vpScheduled').textContent = progress.scheduledCount;
      document.getElementById('vpVisited').textContent = progress.visitedCount;
      document.getElementById('vpDue').textContent = progress.stillDue.length;
      document.getElementById('vpOrders').textContent = progress.ordersTaken;
      document.getElementById('vpNoOrder').textContent = progress.noOrderVisits;

      let list = progress.scheduled;
      todaysRouteEmpty.style.display = list.length === 0 ? 'block' : 'none';
      todaysRouteOptimizeBtn.style.display = list.length > 1 ? 'block' : 'none';
      if (todaysRouteInfo) {
        list = list.slice().sort((a, b) => (todaysRouteInfo.get(a.id)?.stopNo ?? 9999) - (todaysRouteInfo.get(b.id)?.stopNo ?? 9999));
      } else {
        // still-to-visit first, then the ones with an outcome
        list = list.slice().sort((a, b) => (progress.visitsByCustomer.has(a.id) ? 1 : 0) - (progress.visitsByCustomer.has(b.id) ? 1 : 0));
      }
      todaysRouteList.innerHTML = list.map(c => {
        const visits = progress.visitsByCustomer.get(c.id);
        return `
        <button type="button" class="todays-route-item ${esc(visits ? 'visited' : '')}" data-id="${esc(c.id)}">
          ${todaysRouteInfo && todaysRouteInfo.get(c.id) ? `<span class="route-stop-badge">${esc(todaysRouteInfo.get(c.id).stopNo)}</span>` : ''}
          <span class="todays-route-name">${esc(c.name)}</span>${visitStatusHtml(visits)}
          ${todaysRouteInfo && todaysRouteInfo.get(c.id) ? `<span class="todays-route-location">${esc(formatKm(todaysRouteInfo.get(c.id).legKm))} from previous</span>` : ''}
          ${c.location ? `<span class="todays-route-location">${esc(c.location)}</span>` : ''}
          ${hasPin(c) ? '' : '<span class="no-pin-tag">📍 needs pin</span>'}
        </button>`;
      }).join('');

      // visits to shops that are not on today's list
      const scheduledIds = new Set(progress.scheduled.map(c => c.id));
      const otherIds = [...progress.visitsByCustomer.keys()].filter(id => !scheduledIds.has(id));
      todaysOtherWrap.style.display = otherIds.length ? 'block' : 'none';
      todaysOtherList.innerHTML = otherIds.map(id => {
        const visits = progress.visitsByCustomer.get(id);
        return `<div style="padding:6px 0; border-bottom:1px solid var(--line);">${esc(visits[0].customerName)} ${visitStatusHtml(visits)}</div>`;
      }).join('');
    }

    const todaysVisitsGuard = createPagedLoadGuard();
    async function loadTodaysVisits() {
      todaysVisitsGuard.reset();
      const date = malawiDate();
      await todaysVisitsGuard.run({
        fetch: async () => {
          try { await loadCustomersCache(); } catch (err) { /* keep the cache we already have */ }
          return fetchMyVisitsForDate(user.uid, date);
        },
        apply: (visits) => {
          todayVisits = visits; todayDate = date; visitsLoaded = true;
          todaysLoadError.style.display = 'none';
          renderTodaysVisits();
        },
        onError: (err) => {
          // Never show an empty "0 visited" screen as if it were true when the load failed.
          todaysLoadError.textContent = 'Could not load today\'s saved visits (' + err.message + '). Progress shown may be incomplete. Pull to refresh or reopen this screen.';
          todaysLoadError.style.display = 'block';
          renderTodaysVisits();
        },
      });
    }
    window.__loadTodaysVisits = loadTodaysVisits;

    // If the app stays open past midnight (Malawi), reload when the rep comes back to it.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && visitsLoaded && malawiDate() !== todayDate) loadTodaysVisits();
    });

    todaysRouteList.addEventListener('click', (e) => {
      const item = e.target.closest('.todays-route-item');
      if (!item || lvSaving) return;
      const c = customersCache.find(cc => cc.id === item.dataset.id);
      if (!c) return;
      lvResetOutcome();
      selectCustomerForVisit(c);
      lvOutcomeCard.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });

    lvCustSearch.addEventListener('input', () => {
      const q = lvCustSearch.value.trim().toLowerCase();
      if (!q) { lvCustSuggestions.style.display = 'none'; return; }
      const matches = customersCache.filter(c => c.active !== false && (c.name || '').toLowerCase().includes(q));
      if (!matches.length) { lvCustSuggestions.style.display = 'none'; return; }
      lvCustSuggestions.innerHTML = matches.slice(0, 8).map(c => `
        <div class="suggestion-item" data-id="${esc(c.id)}">
          <span class="sug-name">${esc(c.name)}</span>
          <span class="sug-meta">${esc(c.phone || '')}${esc(c.phone && c.location ? ' · ' : '')}${esc(c.location || '')}${esc(c.assignedDay === weekdayOfDate(malawiDate()) ? '' : ' · not scheduled today')}${esc(hasPin(c) ? '' : ' · ⚠ no pin')}</span>
        </div>
      `).join('');
      lvCustSuggestions.style.display = 'block';
    });

    lvCustSuggestions.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      const c = customersCache.find(c => c.id === item.dataset.id);
      if (!c) return;
      lvResetOutcome();
      selectCustomerForVisit(c);
    });

    lvClearCustomer.addEventListener('click', (e) => {
      e.preventDefault();
      if (lvSaving) return;
      lvResetAll();
    });

    lvOutcomeYes.addEventListener('click', () => {
      lvOutcomeYes.classList.add('active');
      lvOutcomeNo.classList.remove('active');
      lvNoOrderFields.style.display = 'none';
      lvApplyPinGate();
      if (lvSelected && !hasPin(lvSelected)) lvPromptForPin();   // prompt straight away
    });

    lvOutcomeNo.addEventListener('click', () => {
      lvOutcomeNo.classList.add('active');
      lvOutcomeYes.classList.remove('active');
      lvOrderFormWrap.style.display = 'none';
      lvPinRequired.style.display = 'none';
      lvNoOrderFields.style.display = 'block';
    });

    function lvAfterSaved() {
      lvResetAll();
      return loadTodaysVisits();   // reload from the database so what is shown is what is saved
    }

    lvSubmitNoOrderBtn.addEventListener('click', async () => {
      if (lvSaving) return;
      if (lvConflict) { showToast('This visit was already saved differently. Choose "Keep what was saved" or "Record my new details as a NEW visit" first.', 'error', 6000); return; }
      if (!lvSelected) { showToast('Select a customer first.', 'error'); return; }
      const problem = validateNoOrderInput({ reason: lvReason.value, notes: lvReasonNotes.value });
      if (problem) {
        lvNoOrderError.textContent = problem;
        lvNoOrderError.style.display = 'block';
        (lvReason.value ? lvReasonNotes : lvReason).focus();
        return;
      }
      lvNoOrderError.style.display = 'none';
      lvSaving = true;
      setButtonLoading(lvSubmitNoOrderBtn, 'Saving…');
      try {
        const res = await recordNoOrderVisit({
          customerId: lvSelected.id, reason: lvReason.value, notes: lvReasonNotes.value,
          requestId: lvRequestId, uid: user.uid, email: user.email,
        });
        showToast(res.alreadySaved ? 'This visit had already been saved. No duplicate was created.' : 'Visit logged.', res.alreadySaved ? 'info' : 'success');
        await lvAfterSaved();
      } catch (err) {
        if (err.code === 'visit-conflict') { lvShowConflict(err); return; }
        // lvRequestId is kept: if the save actually went through, Retry finds it instead of duplicating.
        lvNoOrderError.textContent = 'Could not save the visit: ' + err.message + ' You can tap Log Visit again; it will not create a duplicate.';
        lvNoOrderError.style.display = 'block';
      } finally {
        lvSaving = false;
        clearButtonLoading(lvSubmitNoOrderBtn);
      }
    });

    lvSubmitOrderBtn.addEventListener('click', async () => {
      if (lvSaving) return;
      if (lvConflict) { showToast('This visit was already saved differently. Choose "Keep what was saved" or "Record my new details as a NEW visit" first.', 'error', 6000); return; }
      if (!lvSelected) { showToast('Select a customer first.', 'error'); return; }
      if (!hasPin(lvSelected)) {
        showToast('Pin this customer\'s location before placing an order.', 'error');
        lvApplyPinGate();
        return;
      }
      const items = getItems(lvOrderItemsBody);
      const problem = validateOrderItems(items);
      if (problem) { showToast(problem, 'error'); return; }

      lvSaving = true;
      setButtonLoading(lvSubmitOrderBtn, 'Submitting…');
      try {
        // Order + visit + order number are saved together or not at all.
        const res = await submitOrderWithVisit({
          customerId: lvSelected.id, items, notes: lvOrderNotes.value,
          requestId: lvRequestId, uid: user.uid, email: user.email,
        });
        showToast(res.alreadySaved
          ? `Order ${res.orderNo} had already been saved. No duplicate was created.`
          : `Order ${res.orderNo} submitted and visit logged.`, res.alreadySaved ? 'info' : 'success');
        await lvAfterSaved();
      } catch (err) {
        if (err.code === 'visit-conflict') { lvShowConflict(err); return; }
        showToast('Could not submit the order: ' + err.message + ' Nothing was half-saved; you can tap Submit again, it will not create a duplicate.', 'error', 7000);
      } finally {
        lvSaving = false;
        clearButtonLoading(lvSubmitOrderBtn);
      }
    });

    renderTodaysVisits();
  }

  // ============= MY VISITS (submitter) =============
  if (!isManager) {
    var myVisitsBody = document.getElementById('myVisitsBody');
    var myVisitsEmpty = document.getElementById('myVisitsEmpty');
    var loadMoreMyVisitsBtn = document.getElementById('loadMoreMyVisitsBtn');
    var loadedMyVisits = [], myVisitsCursor = null, myVisitsHasMore = true;
    var myVisitsGuard = createPagedLoadGuard();

    function renderMyVisitsRows(list) {
      myVisitsBody.innerHTML = '';
      myVisitsEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(v => {
        const tr = document.createElement('tr');
        const reason = v.outcome === 'No Order' ? (v.reasonNoOrder || '—') : '—';
        tr.innerHTML = `
          <td>${esc(formatDate(v.date))}</td>
          <td>${esc(v.customerName)}</td>
          <td>${esc(v.outcome === 'Order Placed' ? '✓ Order Placed' : '✕ No Order')}</td>
          <td>${esc(reason)}</td>
        `;
        myVisitsBody.appendChild(tr);
      });
    }

    window.resetAndLoadMyVisits = async function resetAndLoadMyVisits() {
      myVisitsGuard.reset();
      loadedMyVisits = []; myVisitsCursor = null; myVisitsHasMore = true;
      await loadNextMyVisitsPage();
    };

    async function loadNextMyVisitsPage() {
      if (!myVisitsHasMore) return;
      const cursor = myVisitsCursor;
      await myVisitsGuard.run({
        setLoading: (on) => (on ? setButtonLoading(loadMoreMyVisitsBtn, 'Loading…') : clearButtonLoading(loadMoreMyVisitsBtn)),
        fetch: () => fetchMyVisitsPage(user.uid, cursor),
        apply: (result) => {
          loadedMyVisits = mergeById(loadedMyVisits, result.items);
          myVisitsCursor = result.lastDoc; myVisitsHasMore = result.hasMore;
          renderMyVisitsRows(loadedMyVisits);
          loadMoreMyVisitsBtn.style.display = myVisitsHasMore ? 'block' : 'none';
        },
        onError: (err) => showToast('Could not load visits: ' + err.message, 'error'),
      });
    }

    loadMoreMyVisitsBtn.addEventListener('click', loadNextMyVisitsPage);
  }
  async function resetAndLoadMyVisits() { if (window.resetAndLoadMyVisits) await window.resetAndLoadMyVisits(); }

  // ============= DELIVERIES ANALYTICS (manager) =============
  if (isManager) {
    const delPeriod = document.getElementById('delPeriod');
    const delOverdueHours = document.getElementById('delOverdueHours');
    delOverdueHours.innerHTML = OVERDUE_HOUR_OPTIONS
      .map(h => `<option value="${esc(h)}" ${esc(h === DEFAULT_OVERDUE_HOURS ? 'selected' : '')}>${esc(h)} hours</option>`).join('');

    let delData = null; // { delivered, failures, pending }

    const fmtWhen = (v) => {
      const d = toDate(v);
      return d ? d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    };
    const orderHasPin = (o) => {
      const c = customersCache.find(cc => cc.id === o.customerId);
      return hasPin(c) || isValidPin(o.customerLat, o.customerLng);
    };

    function renderDeliveries() {
      if (!delData) return;
      const stats = buildDeliveryStats({
        ...delData, now: new Date(),
        period: delPeriod.value, overdueHours: parseInt(delOverdueHours.value, 10),
      });

      document.getElementById('delTiles').innerHTML = `
        <div class="exp-tile exp-tile-transport"><span class="exp-tile-label">Delivered</span><span class="exp-tile-amount">${esc(stats.totals.delivered)}</span></div>
        <div class="exp-tile exp-tile-other"><span class="exp-tile-label">Failed attempts</span><span class="exp-tile-amount">${esc(stats.totals.failed)}</span></div>
        <div class="exp-tile exp-tile-meals"><span class="exp-tile-label">Pending</span><span class="exp-tile-amount">${esc(stats.totals.pending)}</span></div>
        <div class="exp-tile del-tile-overdue"><span class="exp-tile-label">Overdue</span><span class="exp-tile-amount">${esc(stats.totals.overdue)}</span></div>`;

      document.getElementById('delPersonEmpty').style.display = stats.perDeliverer.length === 0 ? 'block' : 'none';
      document.getElementById('delPersonBody').innerHTML = stats.perDeliverer.map(p => `
        <tr>
          <td>${esc(displayNameForEmail(p.email))}</td>
          <td>${esc(p.today)}</td><td>${esc(p.week)}</td><td><strong>${esc(p.month)}</strong></td>
          <td>${esc(p.failedPeriod)}</td>
          <td>${esc(p.avgHours === null ? '—' : formatAge(p.avgHours))}</td>
        </tr>`).join('');

      document.getElementById('delPendingEmpty').style.display = stats.pendingRows.length === 0 ? 'block' : 'none';
      document.getElementById('delPendingBody').innerHTML = stats.pendingRows.map(o => {
        const f = o.lastDeliveryFailure;
        const failText = f ? `${esc(f.reason || '')}${f.note ? ` — ${esc(f.note)}` : ''}${o.deliveryAttemptCount > 1 ? ` (${esc(o.deliveryAttemptCount)} tries)` : ''}` : '—';
        return `
        <tr class="${esc(o.overdue ? 'del-overdue' : '')}">
          <td>${esc(o.orderNo)}</td>
          <td>${esc(o.customerName)}</td>
          <td>${esc((o.customerLocation && o.customerLocation !== '-') ? o.customerLocation : '—')}</td>
          <td>${orderHasPin(o) ? '📍 ✓' : '<span class="no-pin-tag">⚠ No pin</span>'}</td>
          <td>${esc(formatAge(o.ageHours))}${esc(o.overdue ? ' ⚠' : '')}</td>
          <td>${failText}</td>
        </tr>`;
      }).join('');

      document.getElementById('delAreaEmpty').style.display = stats.perArea.length === 0 ? 'block' : 'none';
      document.getElementById('delAreaBody').innerHTML = stats.perArea.map(a => `
        <tr><td>${esc(a.area)}</td><td>${esc(a.delivered)}</td><td>${esc(a.failed)}</td><td>${esc(a.pending)}</td></tr>`).join('');

      document.getElementById('delFailEmpty').style.display = stats.failuresInPeriod.length === 0 ? 'block' : 'none';
      document.getElementById('delFailBody').innerHTML = stats.failuresInPeriod.map(f => `
        <tr>
          <td>${esc(fmtWhen(f.at))}</td>
          <td>${esc(f.orderNo)}</td>
          <td>${esc(f.customerName)}</td>
          <td>${esc(f.area)}</td>
          <td>${esc(displayNameForEmail(f.byEmail))}</td>
          <td>${esc(f.reason)}${f.note ? ` — ${esc(f.note)}` : ''}</td>
        </tr>`).join('');
    }

    window.loadDeliveriesView = async function loadDeliveriesView() {
      const refreshBtn = document.getElementById('delRefreshBtn');
      setButtonLoading(refreshBtn, 'Loading…');
      try {
        const since = earliestNeededStart(new Date());
        const [delivered, failures, pending] = await Promise.all([
          fetchDeliveredSince(since), fetchFailedAttemptsSince(since), fetchPendingDeliveries(),
        ]);
        delData = { delivered, failures, pending };
        renderDeliveries();
      } catch (err) {
        showToast('Could not load delivery analytics: ' + err.message, 'error');
      } finally {
        clearButtonLoading(refreshBtn);
      }
    };

    delPeriod.addEventListener('change', renderDeliveries);
    delOverdueHours.addEventListener('change', renderDeliveries);
    document.getElementById('delRefreshBtn').addEventListener('click', () => window.loadDeliveriesView());
  }
  async function loadDeliveriesView() { if (window.loadDeliveriesView) await window.loadDeliveriesView(); }

  // ============= REP PERFORMANCE (manager) =============
  // Daily-visit report: filter by date range and rep; reps with no visits are included.
  // Definitions (also shown on screen): see src/visitSchedule.js and docs/DAILY-VISITS.md.
  if (isManager) {
    const repSummaryBody = document.getElementById('repSummaryBody');
    const repSummaryEmpty = document.getElementById('repSummaryEmpty');
    const allVisitsBody = document.getElementById('allVisitsBody');
    const allVisitsEmpty = document.getElementById('allVisitsEmpty');
    const perfRepFilter = document.getElementById('perfRepFilter');
    const perfFrom = document.getElementById('perfFrom');
    const perfTo = document.getElementById('perfTo');
    const perfRunBtn = document.getElementById('perfRunBtn');
    const perfScheduleWarning = document.getElementById('perfScheduleWarning');
    const dueBody = document.getElementById('dueBody'), dueEmpty = document.getElementById('dueEmpty');
    const noOrderBody = document.getElementById('noOrderBody'), noOrderEmpty = document.getElementById('noOrderEmpty');
    const ordersTakenBody = document.getElementById('ordersTakenBody'), ordersTakenEmpty = document.getElementById('ordersTakenEmpty');
    const ordersValueNote = document.getElementById('ordersValueNote');
    const perfGuard = createPagedLoadGuard();
    let perfReps = [];

    const pctText = (p) => (p === null ? '—' : p + '%');
    const nameOf = (email) => esc(displayNameForEmail(email));

    function renderPerformance(report, visits) {
      const rows = report.rows;
      repSummaryEmpty.style.display = rows.length === 0 ? 'block' : 'none';
      repSummaryBody.innerHTML = rows.map(r => `
        <tr data-rep="${esc(r.rep)}">
          <td>${esc(nameOf(r.rep))}${r.totalVisits === 0 ? ' <span class="numbering-hint">(no visits recorded)</span>' : ''}</td>
          ${r.reliableDays === 0
            ? '<td colspan="3" class="numbering-hint">not calculated (no reliable schedule for these dates)</td>'
            : `<td>${esc(r.scheduledCount)}</td><td>${esc(r.visitedCount)}</td><td>${esc(r.stillDueCount)}</td>`}
          <td>${esc(r.ordersTaken)}</td><td>${esc(r.noOrderVisits)}</td>
          <td>${esc(pctText(r.coveragePct))}</td><td>${esc(pctText(r.conversionPct))}</td>
          <td>${r.attributedOrders ? `${esc(r.attributedOrders)} order(s), ${esc(r.attributedValue === null ? '—' : mwk(r.attributedValue))}` : '—'}${r.attributedCancelled ? ` <span class="numbering-hint">(${esc(r.attributedCancelled)} cancelled)</span>` : ''}</td>
          <td>${esc(r.closedVisits)}</td><td>${esc(pctText(r.conversionExclClosedPct))}</td>
        </tr>`).join('');
      // The limitation is stated plainly - no figure is shown for a date without a reliable schedule record.
      if (report.limitation) { perfScheduleWarning.textContent = report.limitation; perfScheduleWarning.style.display = 'block'; }
      else perfScheduleWarning.style.display = 'none';

      const due = rows.flatMap(r => r.due.map(d => ({ rep: r.rep, ...d })));
      dueEmpty.style.display = due.length ? 'none' : 'block';
      dueBody.innerHTML = due.sort((a, b) => a.date.localeCompare(b.date) || a.rep.localeCompare(b.rep)).map(d => `
        <tr><td>${esc(formatDate(d.date))}</td><td>${esc(nameOf(d.rep))}</td><td>${esc(d.customer.name)}</td><td>${esc(d.customer.location || '')}</td></tr>`).join('');

      const noOrder = rows.flatMap(r => r.noOrder).sort((a, b) => b.date.localeCompare(a.date));
      noOrderEmpty.style.display = noOrder.length ? 'none' : 'block';
      noOrderBody.innerHTML = noOrder.map(v => `
        <tr><td>${esc(formatDate(v.date))}</td><td>${esc(nameOf(v.repEmail))}</td><td>${esc(v.customerName)}</td>
        <td>${esc(v.reasonNoOrder || '—')}</td><td>${esc(v.reasonNotes || '')}</td></tr>`).join('');

      const orders = rows.flatMap(r => r.orders).sort((a, b) => b.date.localeCompare(a.date));
      ordersTakenEmpty.style.display = orders.length ? 'none' : 'block';
      ordersTakenBody.innerHTML = orders.map(v => `
        <tr><td>${esc(formatDate(v.date))}</td><td>${esc(nameOf(v.repEmail))}</td><td>${esc(v.customerName)}</td>
        <td>${v.orderId ? `<button type="button" class="list-action-btn" data-view-order="${esc(v.orderId)}">${esc(v.orderNo || 'View order')}</button>` : '—'}</td>
        <td>${esc(typeof v.orderValue === 'number' ? mwk(v.orderValue) : '—')}</td></tr>`).join('');
      const valued = rows.reduce((s, r) => s + r.valuedOrders, 0), unvalued = rows.reduce((s, r) => s + r.unvaluedOrders, 0);
      const total = rows.reduce((s, r) => s + (r.valueTotal || 0), 0);
      ordersValueNote.textContent = orders.length
        ? (valued ? `Value of ${valued} order(s) where a value was recorded when the visit was saved: ${esc(mwk(total))}.` : 'No order values were recorded for these visits.') +
          (unvalued ? ` ${unvalued} older visit(s) have no recorded value and are left out of that total (shown as "—", not as zero).` : '') +
          ' Values are as taken on the visit; later edits to an order are not reflected.'
        : '';

      const repKeys = new Set(rows.map(r => r.rep));
      const shown = visits.filter(v => repKeys.has(String(v.repEmail || '').trim().toLowerCase()))
        .sort((a, b) => b.date.localeCompare(a.date));
      allVisitsEmpty.style.display = shown.length ? 'none' : 'block';
      allVisitsBody.innerHTML = shown.map(v => `
        <tr><td>${esc(formatDate(v.date))}</td><td>${esc(nameOf(v.repEmail))}</td><td>${esc(v.customerName)}</td>
        <td>${esc(v.outcome === 'Order Placed' ? '✓ Order Placed' : '✕ No Order')}</td>
        <td>${v.outcome === 'No Order' ? esc(v.reasonNoOrder || '—') + (v.reasonNotes ? ': ' + esc(v.reasonNotes) : '') : '—'}</td>
        <td>${esc(v.wasScheduled === true ? 'Yes' : v.wasScheduled === false ? 'No' : '—')}</td></tr>`).join('');

    }

    const perfShownRange = document.getElementById('perfShownRange');
    const perfRangeError = document.getElementById('perfRangeError');
    const rangeText = (r) => (r.from === r.to ? formatDate(r.from) : `${formatDate(r.from)} to ${formatDate(r.to)}`);
    // The line above the table says which dates the report on screen really covers, and warns
    // when the date boxes have been changed since (so the boxes never look like the report).
    function updateShownRange() {
      if (!perfReport) { perfShownRange.textContent = ''; return; }
      const shown = { from: perfReport.from, to: perfReport.to };
      const differs = perfFrom.value !== shown.from || perfTo.value !== shown.to;
      perfShownRange.textContent = `Showing: ${rangeText(shown)}` + (differs ? ' - the dates above have changed. Tap Show report to update.' : '');
    }
    // Latest request wins: requestReport() invalidates any older request, so a slow earlier
    // answer can never replace the report for the dates now selected.
    function runPerformance() {
      return requestReport(perfGuard, {
        from: perfFrom.value, to: perfTo.value,
        setLoading: (on) => (on ? setButtonLoading(perfRunBtn, 'Loading…') : clearButtonLoading(perfRunBtn)),
        onInvalid: (msg) => { perfRangeError.textContent = msg; perfRangeError.style.display = 'block'; },
        fetch: async ({ from, to }) => {
          perfRangeError.style.display = 'none';
          const [visits, reps, history, orders] = await Promise.all([
            fetchVisitsInRange(from, to), fetchRepEmails(), fetchScheduleHistory(), fetchOrdersInRange(from, to),
          ]);
          try { await loadProfilesCache(); await loadCustomersCache(); } catch (err) { /* names fall back to emails */ }
          return { visits, reps, history, attributedOrders: orders.filter(o => o.source === 'manager-entered') };
        },
        apply: ({ visits, reps, history, attributedOrders }, { from, to }) => {
          perfReps = reps;
          const prev = perfRepFilter.value;
          const all = [...new Set([...reps, ...visits.map(v => v.repEmail)].filter(Boolean).map(e => e.trim().toLowerCase()))].sort();
          perfRepFilter.innerHTML = `<option value="all">All reps</option>` + all.map(r => `<option value="${esc(r)}">${esc(nameOf(r))}</option>`).join('');
          perfRepFilter.value = all.includes(prev) ? prev : 'all';
          perfReport = { visits, from, to, history, attributedOrders };      // the range that was FETCHED, not whatever the boxes say now
          drawPerformance();
        },
        onError: (err) => showToast('Could not load the report: ' + err.message, 'error'),
      });
    }
    let perfReport = null;
    function drawPerformance() {
      if (!perfReport) return;
      const { visits, from, to, history, attributedOrders } = perfReport;
      const index = buildScheduleIndex(history);
      document.getElementById('scheduleHistoryStartBox').style.display = index.startDate ? 'none' : 'block';
      const report = buildPerformanceReport({ index, visits, reps: perfReps, from, to, repFilter: perfRepFilter.value, attributedOrders });
      const mismatches = findScheduleMismatches(index, customersCache);
      if (mismatches.length) {
        report.limitation = (report.limitation ? report.limitation + ' ' : '') +
          `Warning: ${mismatches.length} customer(s) have a current schedule that does not match their schedule history (${mismatches.slice(0, 3).map(m => m.name).join(', ')}${mismatches.length > 3 ? ', …' : ''}), so recent targets may be wrong. Ask the developer to check.`;
      }
      renderPerformance(report, visits);
      updateShownRange();
    }

    window.loadPerformanceView = async function loadPerformanceView() {
      if (!perfFrom.value || !perfTo.value) { perfFrom.value = perfTo.value = malawiDate(); }
      await runPerformance();
    };

    document.getElementById('startScheduleHistoryBtn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (!confirm('Start the dated schedule history now?\n\nEach customer\'s CURRENT visit day and active state is recorded as the starting point from today. Dates before today will show "no reliable schedule" in reports. Do this once, not close to midnight.')) return;
      setButtonLoading(btn, 'Starting…');
      try {
        await loadCustomersCache();
        const res = await startScheduleHistory({ customers: customersCache, uid: user.uid, email: user.email });
        showToast(res.status === 'already-started' ? `Schedule history already started on ${res.startDate}.` : `Schedule history started for ${res.added} customer(s).`, 'success');
        await runPerformance();
      } catch (err) {
        showToast('Could not start the schedule history: ' + err.message, 'error', 8000);
      } finally { clearButtonLoading(btn); }
    });
    perfRunBtn.addEventListener('click', runPerformance);
    document.getElementById('perfTodayBtn').addEventListener('click', () => { perfFrom.value = perfTo.value = malawiDate(); runPerformance(); });
    document.getElementById('perfWeekBtn').addEventListener('click', () => {
      const today = malawiDate();
      const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekdayOfDate(today)];
      perfFrom.value = addDays(today, -offset); perfTo.value = today; runPerformance();
    });
    perfRepFilter.addEventListener('change', drawPerformance);
    perfFrom.addEventListener('input', updateShownRange);
    perfTo.addEventListener('input', updateShownRange);
    ordersTakenBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-view-order]');
      if (!btn) return;
      try {
        const order = await fetchOrderById(btn.dataset.viewOrder);
        if (!order) { showToast('That order could not be found.', 'error'); return; }
        openOrderPreviewModal(order);
      } catch (err) { showToast('Could not open the order: ' + err.message, 'error'); }
    });
  }
  async function loadPerformanceView() { if (window.loadPerformanceView) await window.loadPerformanceView(); }

  // ============= SUMMARY (manager) =============
  if (isManager) {
    const sumFromInput = document.getElementById('sumFrom');
    const sumToInput = document.getElementById('sumTo');
    const sumResultsCard = document.getElementById('sumResultsCard');
    const sumRangeLabel = document.getElementById('sumRangeLabel');
    const sumResultsBody = document.getElementById('sumResultsBody');
    const sumGenerateBtn = document.getElementById('sumGenerateBtn');

    function isoDate(d) { return malawiDate(d); }   // Malawi calendar date, so 'today' matches visit dates

    function setRangeToday() {
      const t = isoDate(new Date());
      sumFromInput.value = t; sumToInput.value = t;
    }
    function setRangeThisWeek() {
      const today = malawiDate();
      const offset = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 }[weekdayOfDate(today)];
      sumFromInput.value = addDays(today, -offset);
      sumToInput.value = today;
    }
    function setRangeThisMonth() {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      sumFromInput.value = isoDate(first);
      sumToInput.value = isoDate(now);
    }

    function renderSummary(summary, from, to) {
      sumRangeLabel.textContent = from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`;

      const statusOrder = ['Submitted', 'Approved', 'Invoiced', 'Rejected', 'Cancelled'];
      const statusBreakdown = statusOrder
        .filter(s => summary.orders.byStatus[s])
        .map(s => `<div class="summary-breakdown-row"><span>${esc(s)}</span><span>${esc(summary.orders.byStatus[s])}</span></div>`)
        .join('') || `<div class="summary-breakdown-row"><span style="color:var(--muted);">No orders in this range</span></div>`;

      const expenseBreakdown = Object.entries(summary.expenses.byCategory)
        .filter(([, amt]) => amt > 0)
        .map(([cat, amt]) => `<div class="summary-breakdown-row"><span>${esc(cat)}</span><span>${esc(mwk(amt))}</span></div>`)
        .join('') || `<div class="summary-breakdown-row"><span style="color:var(--muted);">No expenses in this range</span></div>`;

      const topProductsHtml = summary.topProducts.length
        ? summary.topProducts.map(p => `<div class="summary-breakdown-row"><span>${esc(p.desc)}</span><span>${esc(p.qty)} units</span></div>`).join('')
        : `<div class="summary-breakdown-row"><span style="color:var(--muted);">No items ordered in this range</span></div>`;

      sumResultsBody.innerHTML = `
        <div class="summary-grid">
          <div class="summary-tile"><span class="summary-tile-label">Orders</span><span class="summary-tile-value">${esc(summary.orders.total)}</span></div>
          <div class="summary-tile"><span class="summary-tile-label">Invoices</span><span class="summary-tile-value">${esc(summary.invoices.count)}</span></div>
          <div class="summary-tile summary-tile-positive"><span class="summary-tile-label">Revenue</span><span class="summary-tile-value">${esc(mwk(summary.invoices.revenue))}</span></div>
          <div class="summary-tile summary-tile-negative"><span class="summary-tile-label">Expenses</span><span class="summary-tile-value">${esc(mwk(summary.expenses.total))}</span></div>
          <div class="summary-tile ${esc(summary.netCashflow >= 0 ? 'summary-tile-positive' : 'summary-tile-negative')}"><span class="summary-tile-label">Net</span><span class="summary-tile-value">${esc(mwk(summary.netCashflow))}</span></div>
          <div class="summary-tile"><span class="summary-tile-label">Visits</span><span class="summary-tile-value">${esc(summary.visits.total)}</span><span class="summary-tile-sub">${esc(summary.visits.successRate)}% placed an order</span></div>
        </div>
        <div class="summary-section-title">Orders by Status</div>
        ${statusBreakdown}
        <div class="summary-section-title">Expenses by Category</div>
        ${expenseBreakdown}${invalidAmountNote(summary.expenses.invalid || [])}
        <div class="summary-section-title">Top Products Ordered</div>
        ${topProductsHtml}
      `;
      sumResultsCard.style.display = 'block';
    }

    async function generateSummary() {
      const from = sumFromInput.value, to = sumToInput.value;
      if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }
      if (from > to) { showToast('The From date must be before the To date.', 'error'); return; }
      setButtonLoading(sumGenerateBtn, 'Crunching numbers…');
      try {
        const [orders, invoices, expenses, visits] = await Promise.all([
          fetchOrdersInRange(from, to),
          fetchInvoicesByDateRange(from, to),
          fetchExpensesInRange(from, to),
          fetchVisitsInRange(from, to),
        ]);
        const summary = buildIntervalSummary({ orders, invoices, expenses, visits });
        renderSummary(summary, from, to);
      } catch (err) {
        showToast('Could not generate summary: ' + err.message, 'error');
      } finally {
        clearButtonLoading(sumGenerateBtn);
      }
    }

    document.getElementById('sumTodayBtn').addEventListener('click', () => { setRangeToday(); generateSummary(); });
    document.getElementById('sumWeekBtn').addEventListener('click', () => { setRangeThisWeek(); generateSummary(); });
    document.getElementById('sumMonthBtn').addEventListener('click', () => { setRangeThisMonth(); generateSummary(); });
    sumGenerateBtn.addEventListener('click', () => generateSummary());

    // Opening the Summary tab with no range picked yet defaults to
    // "Today" and generates immediately — the closest thing to an
    // automatic end-of-day summary without a server-side scheduler
    // (see the note where this is wired into main.js for why).
    window.loadSummaryView = async function loadSummaryView() {
      if (!sumFromInput.value || !sumToInput.value) setRangeToday();
      await generateSummary();
    };
  }
  async function loadSummaryView() { if (window.loadSummaryView) await window.loadSummaryView(); }

  // Default landing view per role — called last, after every section
  // above has run its setup code (their `let`/`const` state variables
  // need to exist before showView() can safely trigger their loaders).
  await showView(isManager ? 'orders' : 'logvisit');

  hideAppOverlay();
}

// ============================================================
// DELIVERY MODE — a completely separate, minimal interface.
// Deliberately NOT reusing initApp's nav/views/modals: the delivery
// person's entire job is one thing (deliver invoiced orders), and
// keeping this isolated means it can stay as simple as possible
// (big text, few words, icons) without inheriting any complexity
// from the manager/rep app. Built for one delivery person today but
// designed for several: every delivery person sees the same shared
// pool of Invoiced orders (see fetchOrdersReadyToDeliverPage in
// orders.js for the note on fair-assignment being a future step).
// ============================================================
let deliveryAppInitialized = false;

async function initDeliveryApp(user) {
  if (deliveryAppInitialized) { hideAppOverlay(); return; }
  deliveryAppInitialized = true;

  document.getElementById('deliveryTopbarLogo').src = LOGO_DATA_URI;

  const deliveryReadyCount = document.getElementById('deliveryReadyCount');
  const deliveryDoneBanner = document.getElementById('deliveryDoneBanner');
  const deliveryListEmpty = document.getElementById('deliveryListEmpty');
  const deliveryList = document.getElementById('deliveryList');
  const deliveryLoadMoreBtn = document.getElementById('deliveryLoadMoreBtn');

  let loadedDeliveries = [], deliveriesCursor = null, deliveriesHasMore = true;
  const deliveriesGuard = createPagedLoadGuard();
  const deliverySortBtn = document.getElementById('deliverySortBtn');
  const deliveryRouteSummary = document.getElementById('deliveryRouteSummary');
  const deliveryPinCache = new Map();     // orderId -> { lat, lng } | null
  let deliveryStopInfo = null;            // Map(orderId -> { stopNo, legKm }) once sorted
  let deliveredThisSession = 0;

  // ---- Simple expense logging (fuel, transport, meals, other) ----
  // Kept to the bare minimum a delivery person needs: pick a category
  // by icon, type an amount, save. No notes field, no date picker
  // (always today) — anything that adds reading or typing is left out
  // on purpose.
  const deliveryExpenseToggleBtn = document.getElementById('deliveryExpenseToggleBtn');
  const deliveryExpenseForm = document.getElementById('deliveryExpenseForm');
  const deliveryExpenseAmount = document.getElementById('deliveryExpenseAmount');
  const deliveryExpenseSaveBtn = document.getElementById('deliveryExpenseSaveBtn');
  const deliveryExpenseCancelBtn = document.getElementById('deliveryExpenseCancelBtn');
  let selectedExpenseCategory = null;

  function resetDeliveryExpenseForm() {
    selectedExpenseCategory = null;
    deliveryExpenseAmount.value = '';
    deliveryExpenseSaveBtn.disabled = true;
    deliveryExpenseForm.querySelectorAll('.delivery-expense-cat-btn').forEach(b => b.classList.remove('active'));
  }

  deliveryExpenseToggleBtn.addEventListener('click', () => {
    const opening = deliveryExpenseForm.style.display === 'none';
    deliveryExpenseForm.style.display = opening ? 'block' : 'none';
    if (opening) resetDeliveryExpenseForm();
  });
  deliveryExpenseCancelBtn.addEventListener('click', () => {
    deliveryExpenseForm.style.display = 'none';
    resetDeliveryExpenseForm();
  });

  deliveryExpenseForm.querySelectorAll('.delivery-expense-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedExpenseCategory = btn.dataset.category;
      deliveryExpenseForm.querySelectorAll('.delivery-expense-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      deliveryExpenseSaveBtn.disabled = !(selectedExpenseCategory && parseFloat(deliveryExpenseAmount.value) > 0);
    });
  });
  deliveryExpenseAmount.addEventListener('input', () => {
    deliveryExpenseSaveBtn.disabled = !(selectedExpenseCategory && parseFloat(deliveryExpenseAmount.value) > 0);
  });

  deliveryExpenseSaveBtn.addEventListener('click', async () => {
    if (!selectedExpenseCategory) return;
    const amount = parseFloat(deliveryExpenseAmount.value);
    if (!amount || amount <= 0) return;
    deliveryExpenseSaveBtn.disabled = true;
    deliveryExpenseSaveBtn.textContent = 'Saving…';
    try {
      await addExpense({
        date: new Date().toISOString().slice(0, 10),
        category: selectedExpenseCategory, amount, notes: '',
        uid: user.uid, email: user.email,
      });
      showToast('Expense saved.', 'success');
      deliveryExpenseForm.style.display = 'none';
      resetDeliveryExpenseForm();
    } catch (err) {
      showToast('Could not save: ' + err.message, 'error');
    } finally {
      deliveryExpenseSaveBtn.textContent = '✓ SAVE';
    }
  });

  // The delivery point is the customer's PINNED location (coordinates),
  // never the location name. Prefer the customer's current pin (so a
  // corrected pin is picked up); fall back to the pin saved on the order
  // when the order was placed. No pin at all = no map button, a clear
  // warning, and the "couldn't find the location" reason is available.
  async function resolveDeliveryPin(order) {
    if (deliveryPinCache.has(order.id)) return deliveryPinCache.get(order.id);
    const pin = await lookupDeliveryPin(order);
    deliveryPinCache.set(order.id, pin);
    return pin;
  }

  async function lookupDeliveryPin(order) {
    if (order.customerId) {
      try {
        const customer = await fetchCustomerById(order.customerId);
        if (hasPin(customer)) return { lat: customer.lat, lng: customer.lng };
      } catch (err) { /* fall back to the pin saved on the order */ }
    }
    if (isValidPin(order.customerLat, order.customerLng)) return { lat: order.customerLat, lng: order.customerLng };
    return null;
  }

  function directionsUrl(pin) {
    return `https://www.google.com/maps/dir/?api=1&destination=${Number(pin.lat)},${Number(pin.lng)}&travelmode=driving`;
  }

  function renderDeliveryEmpty() {
    deliveryListEmpty.style.display = loadedDeliveries.length === 0 ? 'block' : 'none';
  }

  async function renderDeliveryCard(order) {
    const itemsHtml = (order.items || [])
      .map(it => `<div class="delivery-item-row">${esc(it.qty)}× ${esc(it.desc || '—')}</div>`)
      .join('') || `<div class="delivery-item-row">—</div>`;
    const areaLabel = (order.customerLocation && order.customerLocation !== '-') ? order.customerLocation : '';
    const pin = await resolveDeliveryPin(order);
    const failure = order.lastDeliveryFailure;

    const card = document.createElement('div');
    card.className = 'delivery-card';
    card.dataset.id = order.id;
    const stop = deliveryStopInfo && deliveryStopInfo.get(order.id);
    card.innerHTML = `
      ${stop ? `<div class="delivery-stop-badge">Stop ${esc(stop.stopNo)} · ${esc(formatKm(stop.legKm))} from previous</div>` : ''}
      <div class="delivery-card-name">${esc(order.customerName || '—')}</div>
      ${pin
        ? `<div class="delivery-card-location">📍 Pinned location${areaLabel ? ` · ${esc(areaLabel)}` : ''}</div>
           <a href="${esc(directionsUrl(pin))}" target="_blank" rel="noopener" class="delivery-map-btn">🗺️ Navigate to Pin</a>`
        : `<div class="delivery-card-nopin">⚠ No pinned location saved for this customer.<br>Tell the manager.</div>`}
      ${failure ? `<div class="delivery-card-failed">Last try failed: ${esc(failure.reason || '')}${failure.note ? ` — ${esc(failure.note)}` : ''}${order.deliveryAttemptCount > 1 ? ` (${esc(order.deliveryAttemptCount)} tries)` : ''}</div>` : ''}
      <div class="delivery-items">${itemsHtml}</div>
      <div class="delivery-total">${esc(mwk(order.grandTotal || 0))}</div>
      ${order.invoiceNo ? `<div class="delivery-invoice">Invoice ${esc(order.invoiceNo)}</div>` : ''}
      <button type="button" class="delivery-deliver-btn" data-action="deliver" data-id="${esc(order.id)}">✓ DELIVERED</button>
      <button type="button" class="delivery-fail-btn" data-action="fail-open" data-id="${esc(order.id)}">✕ NOT DELIVERED</button>
      <div class="delivery-fail-panel" style="display:none;">
        <div class="delivery-fail-title">Why was it not delivered?</div>
        ${FAIL_REASONS.map(r => `<button type="button" class="delivery-reason-btn" data-action="fail-reason" data-code="${esc(r.code)}" data-id="${esc(order.id)}"><span>${esc(r.icon)}</span> ${esc(r.label)}</button>`).join('')}
        <div class="delivery-fail-other" style="display:none;">
          <textarea class="delivery-fail-note" placeholder="Write the reason..."></textarea>
          <button type="button" class="delivery-deliver-btn delivery-fail-save" data-action="fail-save-other" data-id="${esc(order.id)}">SAVE REASON</button>
        </div>
        <button type="button" class="list-action-btn delivery-fail-cancel" data-action="fail-cancel" style="width:100%; margin-top:10px; padding:14px;">Cancel</button>
      </div>
    `;
    return card;
  }

  async function loadNextDeliveryPage() {
    if (!deliveriesHasMore) return false;
    const cursor = deliveriesCursor;
    return await deliveriesGuard.run({
      setLoading: (on) => (on ? setButtonLoading(deliveryLoadMoreBtn, 'Loading…') : clearButtonLoading(deliveryLoadMoreBtn)),
      // Cards are built BEFORE apply, so a superseded response is discarded without touching the DOM.
      fetch: async () => {
        const result = await fetchOrdersReadyToDeliverPage(cursor);
        const cards = [];
        for (const order of result.items) cards.push(await renderDeliveryCard(order));
        return { result, cards };
      },
      apply: ({ result, cards }) => {
        loadedDeliveries = mergeById(loadedDeliveries, result.items);
        deliveriesCursor = result.lastDoc;
        deliveriesHasMore = result.hasMore;
        deliveryReadyCount.textContent = loadedDeliveries.length;
        renderDeliveryEmpty();
        for (const card of cards) deliveryList.appendChild(card);
        deliveryLoadMoreBtn.style.display = deliveriesHasMore ? 'block' : 'none';
      },
      onError: (err) => showToast('Could not load deliveries: ' + err.message, 'error'),
    });
  }

  async function loadAllDeliveryPages() {
    let guard = 0;
    while (deliveriesHasMore && guard++ < 10) { if (!(await loadNextDeliveryPage())) break; }
  }

  async function rerenderDeliveryList() {
    deliveryList.innerHTML = '';
    for (const order of loadedDeliveries) deliveryList.appendChild(await renderDeliveryCard(order));
    renderDeliveryEmpty();
  }

  // Orders the whole waiting list into a short route starting from the phone's GPS position.
  // Orders without a pin can't be placed on the route, so they're listed last.
  deliverySortBtn.addEventListener('click', async () => {
    setButtonLoading(deliverySortBtn, 'Finding your location…');
    try {
      await loadAllDeliveryPages();
      const start = await getStartPoint();
      if (!start) {
        showToast('Turn on location on your phone to find the shortest route.', 'error');
        return;
      }
      const pinned = [];
      for (const o of loadedDeliveries) {
        const pin = await resolveDeliveryPin(o);
        if (pin) pinned.push({ id: o.id, lat: pin.lat, lng: pin.lng });
      }
      if (pinned.length === 0) { showToast('None of these orders have a pinned location.', 'error'); return; }
      const { ordered, totalKm } = orderStops(start, pinned);
      deliveryStopInfo = new Map(ordered.map(o => [o.id, { stopNo: o.stopNo, legKm: o.legKm }]));
      const rank = (o) => deliveryStopInfo.get(o.id)?.stopNo ?? 9999;
      loadedDeliveries = loadedDeliveries.slice().sort((a, b) => rank(a) - rank(b));

      // Google Maps multi-stop link (first 10 stops; Maps limits waypoints).
      const first = ordered.slice(0, 10);
      const dest = first[first.length - 1];
      const waypoints = first.slice(0, -1).map(p => `${Number(p.lat)},${Number(p.lng)}`).join('|');
      const mapsUrl = `https://www.google.com/maps/dir/?api=1` +
        `&destination=${Number(dest.lat)},${Number(dest.lng)}` + (waypoints ? `&waypoints=${encodeURIComponent(waypoints)}` : '') + `&travelmode=driving`;
      deliveryRouteSummary.style.display = 'block';
      deliveryRouteSummary.innerHTML =
        `Shortest route from ${esc(startLabel(start))}: about <strong>${esc(formatKm(totalKm))}</strong> (straight-line), ${esc(ordered.length)} stop${esc(ordered.length === 1 ? '' : 's')}.` +
        `${loadedDeliveries.length > ordered.length ? ` ${loadedDeliveries.length - ordered.length} without a pin are listed last.` : ''}` +
        `<br><a href="${esc(mapsUrl)}" target="_blank" rel="noopener" class="delivery-map-btn" style="margin-top:10px;">🗺️ Open route in Google Maps${esc(ordered.length > 10 ? ' (first 10 stops)' : '')}</a>`;
      await rerenderDeliveryList();
    } catch (err) {
      showToast('Could not sort the route: ' + err.message, 'error');
    } finally {
      clearButtonLoading(deliverySortBtn);
    }
  });

  async function resetAndLoadDeliveries() {
    deliveriesGuard.reset();
    loadedDeliveries = []; deliveriesCursor = null; deliveriesHasMore = true;
    deliveryList.innerHTML = '';
    await loadNextDeliveryPage();
  }

  deliveryLoadMoreBtn.addEventListener('click', loadNextDeliveryPage);

  async function saveDeliveryFailure(order, card, reasonCode, note) {
    await markOrderDeliveryFailed(order.id, { uid: user.uid, email: user.email, reasonCode, note });
    const reasonLabel = FAIL_REASONS.find(r => r.code === reasonCode).label;
    const updated = {
      ...order,
      lastDeliveryFailure: { reason: reasonLabel, note: (note || '').trim() },
      deliveryAttemptCount: (order.deliveryAttemptCount || 0) + 1,
    };
    const idx = loadedDeliveries.findIndex(o => o.id === order.id);
    if (idx !== -1) loadedDeliveries[idx] = updated;
    card.replaceWith(await renderDeliveryCard(updated));
    showToast('Saved. The order stays on your list for another try.', 'success');
  }

  deliveryList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const card = btn.closest('.delivery-card');
    const action = btn.dataset.action;
    const panel = card.querySelector('.delivery-fail-panel');
    const order = loadedDeliveries.find(o => o.id === btn.dataset.id) || loadedDeliveries.find(o => o.id === card.dataset.id);
    if (!order) return;

    if (action === 'fail-open') { panel.style.display = 'block'; btn.style.display = 'none'; return; }
    if (action === 'fail-cancel') {
      panel.style.display = 'none';
      card.querySelector('[data-action="fail-open"]').style.display = '';
      return;
    }
    if (action === 'fail-reason') {
      const code = btn.dataset.code;
      if (code === 'other') { card.querySelector('.delivery-fail-other').style.display = 'block'; return; }
      const label = FAIL_REASONS.find(r => r.code === code).label;
      if (!confirm(`Not delivered: "${label}". Save this?`)) return;
      btn.disabled = true;
      try { await saveDeliveryFailure(order, card, code, ''); }
      catch (err) { showToast('Could not save: ' + err.message, 'error'); btn.disabled = false; }
      return;
    }
    if (action === 'fail-save-other') {
      const note = card.querySelector('.delivery-fail-note').value;
      if (!note.trim()) { showToast('Please write the reason.', 'error'); return; }
      btn.disabled = true;
      try { await saveDeliveryFailure(order, card, 'other', note); }
      catch (err) { showToast('Could not save: ' + err.message, 'error'); btn.disabled = false; }
      return;
    }

    if (action !== 'deliver') return;
    const confirmed = confirm(`Mark ${order.customerName || 'this order'} as DELIVERED?`);
    if (!confirmed) return;

    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await markOrderDelivered(order.id, { uid: user.uid, email: user.email });
      deliveredThisSession++;
      deliveryDoneBanner.textContent = `✓ ${deliveredThisSession} delivered today`;
      deliveryDoneBanner.style.display = 'block';
      card.remove();
      loadedDeliveries = loadedDeliveries.filter(o => o.id !== order.id);
      deliveryReadyCount.textContent = loadedDeliveries.length;
      renderDeliveryEmpty();
      showToast('Marked as delivered.', 'success');
    } catch (err) {
      showToast('Could not mark as delivered: ' + err.message, 'error');
      btn.disabled = false;
      btn.textContent = '✓ DELIVERED';
    }
  });

  await resetAndLoadDeliveries();
  hideAppOverlay();
}
