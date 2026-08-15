import './style.css';
import { LOGO_DATA_URI } from './logo.js';
import { auth, db } from './firebase.js';
import { watchAuth, login } from './auth.js';
import { getUserRole } from './roles.js';
import { addItemRow, buildQuickAddGrid, getItems, mwk } from './items.js';
import { updatePreview, formatDate } from './preview.js';
import {
  loadCounterState, incrementCounterAtomically, watchCounterState,
  buildInvoiceNo, currentYear, setCounterStart
} from './numbering.js';
import { generatePdf } from './pdf.js';
import {
  fetchMyInvoicesPage, fetchAllInvoicesPage, fetchInvoicesByDateRangePage,
  fetchInvoicesByDateRange, fetchInvoiceById, updateInvoice
} from './invoices.js';
import { buildAndDownloadInvoiceReport } from './export.js';
import {
  fetchAllCustomers, fetchCustomersPage, addCustomer, updateCustomer, findExactNameMatch
} from './customers.js';
import {
  fetchAllExpensesPage, fetchMyExpensesPage, addExpense, updateExpense, deleteExpense
} from './expenses.js';
import {
  fetchAllProducts, fetchProductsPage, addProduct, updateProduct, deleteProduct,
  seedDefaultProductsIfEmpty
} from './products.js';
import {
  submitOrder, fetchMyOrdersPage, fetchOrdersByStatusPage, fetchAllOrdersPage,
  fetchOrderById, setOrderStatus, markOrderInvoiced, deleteOrder
} from './orders.js';
import {
  submitVisit, fetchMyVisitsPage, fetchAllVisitsForAggregation, aggregateVisitsByRep,
  NO_ORDER_REASONS
} from './visits.js';
import {
  showToast, setButtonLoading, clearButtonLoading,
  initOfflineBanner, showAppOverlay, hideAppOverlay, fadeInView
} from './ui.js';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

initOfflineBanner();

function formatItemsSummary(items) {
  if (!items || items.length === 0) return '—';
  return items.map(it => `${it.qty}× ${it.desc || '—'}`).join(', ');
}

const loginScreen = document.getElementById('loginScreen');
const noAccessScreen = document.getElementById('noAccessScreen');
const appRoot = document.getElementById('appRoot');

watchAuth(
  async (user) => {
    loginScreen.style.display = 'none';
    const role = await getUserRole(user.email);
    if (role === 'manager' || role === 'submitter') {
      noAccessScreen.style.display = 'none';
      appRoot.style.display = 'block';
      await initApp(user, role);
    } else {
      appRoot.style.display = 'none';
      noAccessScreen.style.display = 'block';
      hideAppOverlay();
    }
  },
  () => {
    loginScreen.style.display = 'block';
    appRoot.style.display = 'none';
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

let appInitialized = false;

async function initApp(user, role) {
  if (appInitialized) { hideAppOverlay(); return; }
  appInitialized = true;

  const isManager = role === 'manager';

  document.getElementById('topbarLogo').src = LOGO_DATA_URI;
  document.getElementById('previewLogo').src = LOGO_DATA_URI;
  document.getElementById('appTitle').textContent = 'Naisi Foods';
  document.getElementById('appSubtitle').textContent = isManager ? 'Management' : 'Sales Rep';

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
    logvisit: document.getElementById('navLogVisitBtn'),
    myvisits: document.getElementById('navMyVisitsBtn'),
  };

  const managerOnlyNav = ['form', 'invoices', 'products', 'performance'];
  const submitterOnlyNav = ['logvisit', 'myvisits'];

  managerOnlyNav.forEach(k => { navBtns[k].style.display = isManager ? 'inline-flex' : 'none'; });
  submitterOnlyNav.forEach(k => { navBtns[k].style.display = isManager ? 'none' : 'inline-flex'; });

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
    myvisits: resetAndLoadMyVisits,
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


  // ============= NUMBERING (manager-only screen, but always init so PDF/no. logic works) =============
  const invPrefixInput = document.getElementById('invPrefix');
  const invCounterInput = document.getElementById('invCounter');
  const invYearDisplay = document.getElementById('invYearDisplay');
  invYearDisplay.value = currentYear();

  if (isManager) {
    try {
      await loadCounterState(true);
      watchCounterState((data) => {
        invPrefixInput.value = data.prefix;
        invCounterInput.value = data.counter;
        invYearDisplay.value = currentYear();
        if (!editingInvoiceId) els.invoiceNo.value = buildInvoiceNo(data.prefix, data.counter);
      });
    } catch (err) {
      showToast(err.message, 'error');
    }
    [invPrefixInput, invCounterInput].forEach(input => {
      input.addEventListener('change', async () => {
        const prefix = invPrefixInput.value.trim() || 'NF-INV';
        const counter = parseInt(invCounterInput.value, 10) || 1;
        try {
          await setCounterStart(prefix, counter);
          showToast('Numbering settings updated.', 'success');
        } catch (err) {
          showToast('Could not update numbering: ' + err.message, 'error');
        }
      });
    });
  }

  function refreshPreview() { updatePreview(els); }

  // ============= PRODUCTS: catalog cache (used by quick-add grids) =============
  let productsCache = [];
  async function loadProductsCache() {
    productsCache = await fetchAllProducts();
    if (isManager) buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview, productsCache);
    buildQuickAddGrid(lvQuickAddGrid, lvOrderItemsBody, () => {}, productsCache);
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

  // === references used by both roles ===
  const lvQuickAddGrid = document.getElementById('lvQuickAddGrid');
  const lvOrderItemsBody = document.getElementById('lvOrderItemsBody');

  await loadProductsCache();

  if (isManager) {
    document.getElementById('addItemBtn').addEventListener('click', () => {
      addItemRow(itemsBody, refreshPreview, 1, '', '');
      refreshPreview();
    });

    const custSuggestions = document.getElementById('custSuggestions');
    const saveCustomerBtn = document.getElementById('saveCustomerBtn');
    const customerSaveNote = document.getElementById('customerSaveNote');

    function renderSuggestions(matches) {
      if (!matches.length) { custSuggestions.style.display = 'none'; custSuggestions.innerHTML = ''; return; }
      custSuggestions.innerHTML = matches.slice(0, 8).map(c => `
        <div class="suggestion-item" data-id="${c.id}">
          <span class="sug-name">${c.name}</span>
          <span class="sug-meta">${c.phone || ''}${c.phone && c.location ? ' · ' : ''}${c.location || ''}</span>
        </div>
      `).join('');
      custSuggestions.style.display = 'block';
    }

    els.custName.addEventListener('input', () => {
      const q = els.custName.value.trim().toLowerCase();
      customerSaveNote.textContent = '';
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
      els.custPhone.value = customer.phone || '';
      els.custLocation.value = customer.location || '';
      custSuggestions.style.display = 'none';
      updatePreview(els);
    });

    saveCustomerBtn.addEventListener('click', async () => {
      const name = els.custName.value.trim();
      if (!name) { showToast('Enter a customer name first.', 'error'); return; }
      const existing = findExactNameMatch(customersCache, name);
      if (existing) {
        const proceed = confirm(`A customer named "${name}" already exists.\n\nOK = save as a new entry anyway\nCancel = keep using the existing one`);
        if (!proceed) {
          els.custPhone.value = existing.phone || '';
          els.custLocation.value = existing.location || '';
          updatePreview(els);
          return;
        }
      }
      setButtonLoading(saveCustomerBtn, 'Saving…');
      try {
        await addCustomer({ name, phone: els.custPhone.value.trim(), location: els.custLocation.value.trim(), uid: user.uid });
        customerSaveNote.textContent = 'Saved to customer list.';
        showToast('Customer saved.', 'success');
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
  const newCustLocation = document.getElementById('newCustLocation');
  const addCustomerBtn = document.getElementById('addCustomerBtn');
  const addCustomerNote = document.getElementById('addCustomerNote');

  addCustomerBtn.addEventListener('click', async () => {
    const name = newCustName.value.trim();
    if (!name) { showToast('Enter a customer name.', 'error'); return; }
    const existing = findExactNameMatch(customersCache, name);
    if (existing) {
      const proceed = confirm(`A customer named "${name}" already exists.\n\nOK = save as a new entry anyway\nCancel = don't save`);
      if (!proceed) return;
    }
    setButtonLoading(addCustomerBtn, 'Saving…');
    try {
      await addCustomer({ name, phone: newCustPhone.value.trim(), location: newCustLocation.value.trim(), uid: user.uid });
      newCustName.value = ''; newCustPhone.value = ''; newCustLocation.value = '';
      addCustomerNote.textContent = 'Customer added.';
      showToast('Customer added.', 'success');
      await loadCustomersCache();
      await resetAndLoadCustomers();
    } catch (err) {
      showToast('Could not add customer: ' + err.message, 'error');
    } finally {
      clearButtonLoading(addCustomerBtn);
    }
  });

  // ============= CUSTOMERS: manage list (shared — both roles can add/edit, read below) =============
  const customerListBody = document.getElementById('customerListBody');
  const customerListEmpty = document.getElementById('customerListEmpty');
  const loadMoreCustomersBtn = document.getElementById('loadMoreCustomersBtn');
  const customerSearchInput = document.getElementById('customerSearchInput');
  const customerSearchHint = document.getElementById('customerSearchHint');
  let loadedCustomers = [], customersCursor = null, customersHasMore = true;

  function renderCustomerRows(list) {
    customerListBody.innerHTML = '';
    customerListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(c => {
      const tr = document.createElement('tr');
      tr.dataset.id = c.id;
      tr.innerHTML = `
        <td>${c.name}</td><td>${c.phone || ''}</td><td>${c.location || ''}</td>
        <td><button type="button" class="list-action-btn" data-action="edit">Edit</button></td>
      `;
      customerListBody.appendChild(tr);
    });
  }

  function applyCustomerSearchAndRender() {
    const term = customerSearchInput.value.trim().toLowerCase();
    const filtered = term ? loadedCustomers.filter(c => (c.name || '').toLowerCase().includes(term)) : loadedCustomers;
    renderCustomerRows(filtered);
    customerSearchHint.textContent = term ? `Searching ${loadedCustomers.length} loaded customer${loadedCustomers.length === 1 ? '' : 's'}.` : '';
  }

  async function resetAndLoadCustomers() {
    loadedCustomers = []; customersCursor = null; customersHasMore = true;
    customerSearchInput.value = '';
    await loadNextCustomerPage();
  }

  async function loadNextCustomerPage() {
    if (!customersHasMore) return;
    setButtonLoading(loadMoreCustomersBtn, 'Loading…');
    try {
      const result = await fetchCustomersPage(customersCursor);
      loadedCustomers = loadedCustomers.concat(result.items);
      customersCursor = result.lastDoc;
      customersHasMore = result.hasMore;
      applyCustomerSearchAndRender();
      loadMoreCustomersBtn.style.display = customersHasMore ? 'block' : 'none';
    } catch (err) {
      showToast('Could not load customers: ' + err.message, 'error');
    } finally {
      clearButtonLoading(loadMoreCustomersBtn);
    }
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
        <td><input class="customer-edit-input" data-field="name" value="${c.name || ''}"></td>
        <td><input class="customer-edit-input" data-field="phone" value="${c.phone || ''}"></td>
        <td><input class="customer-edit-input" data-field="location" value="${c.location || ''}"></td>
        <td>
          <button type="button" class="list-action-btn" data-action="save">Save</button>
          <button type="button" class="list-action-btn" data-action="cancel">Cancel</button>
        </td>`;
    } else if (btn.dataset.action === 'cancel') {
      applyCustomerSearchAndRender();
    } else if (btn.dataset.action === 'save') {
      const name = tr.querySelector('[data-field="name"]').value.trim();
      const phone = tr.querySelector('[data-field="phone"]').value.trim();
      const location = tr.querySelector('[data-field="location"]').value.trim();
      if (!name) { showToast('Name cannot be empty.', 'error'); return; }
      setButtonLoading(btn, 'Saving…');
      try {
        await updateCustomer(id, { name, phone, location });
        const idx = loadedCustomers.findIndex(c => c.id === id);
        if (idx !== -1) loadedCustomers[idx] = { ...loadedCustomers[idx], name, phone, location };
        await loadCustomersCache();
        applyCustomerSearchAndRender();
        showToast('Customer updated.', 'success');
      } catch (err) {
        showToast('Could not update: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    }
  });

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
    let loadedProducts = [], productsCursor = null, productsHasMore = true;

    function renderProductRows(list) {
      productListBody.innerHTML = '';
      productListEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(p => {
        const tr = document.createElement('tr');
        tr.dataset.id = p.id;
        tr.innerHTML = `
          <td>${p.productName}</td>
          <td>${p.packLabel}</td>
          <td style="font-family:'JetBrains Mono',monospace;">${p.quantity ?? '—'}</td>
          <td style="font-family:'JetBrains Mono',monospace; white-space:nowrap;">${mwk(p.price)}</td>
          <td>
            <button type="button" class="list-action-btn" data-action="edit">Edit</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="delete">Delete</button>
          </td>`;
        productListBody.appendChild(tr);
      });
    }

    async function resetAndLoadProducts() {
      loadedProducts = []; productsCursor = null; productsHasMore = true;
      await loadNextProductPage();
    }

    async function loadNextProductPage() {
      if (!productsHasMore) return;
      setButtonLoading(loadMoreProductsBtn, 'Loading…');
      try {
        const result = await fetchProductsPage(productsCursor);
        loadedProducts = loadedProducts.concat(result.items);
        productsCursor = result.lastDoc; productsHasMore = result.hasMore;
        renderProductRows(loadedProducts);
        loadMoreProductsBtn.style.display = productsHasMore ? 'block' : 'none';
      } catch (err) {
        showToast('Could not load products: ' + err.message, 'error');
      } finally {
        clearButtonLoading(loadMoreProductsBtn);
      }
    }

    loadMoreProductsBtn.addEventListener('click', loadNextProductPage);

    addProductBtn.addEventListener('click', async () => {
      const name = prodName.value.trim();
      const pack = prodPack.value.trim();
      const quantity = parseFloat(prodQuantity.value);
      const price = parseFloat(prodPrice.value);
      if (!name || !pack) { showToast('Enter both a product name and a pack.', 'error'); return; }
      if (!quantity || quantity <= 0) { showToast('Enter a quantity greater than 0.', 'error'); return; }
      if (!price || price <= 0) { showToast('Enter a price greater than 0.', 'error'); return; }
      setButtonLoading(addProductBtn, 'Saving…');
      try {
        await addProduct({ productName: name, packLabel: pack, quantity, price, uid: user.uid });
        prodName.value = ''; prodPack.value = ''; prodQuantity.value = ''; prodPrice.value = '';
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
          <td><input class="customer-edit-input" data-field="productName" value="${p.productName}"></td>
          <td><input class="customer-edit-input" data-field="packLabel" value="${p.packLabel}"></td>
          <td><input class="customer-edit-input" data-field="quantity" type="number" min="0" step="1" value="${p.quantity ?? 0}"></td>
          <td><input class="customer-edit-input" data-field="price" type="number" min="0" step="1" value="${p.price}"></td>
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
        if (!productName || !packLabel) { showToast('Name and pack cannot be empty.', 'error'); return; }
        setButtonLoading(btn, 'Saving…');
        try {
          await updateProduct(id, { productName, packLabel, quantity, price });
          const idx = loadedProducts.findIndex(p => p.id === id);
          if (idx !== -1) loadedProducts[idx] = { ...loadedProducts[idx], productName, packLabel, quantity, price };
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
      }
    });

    var resetAndLoadProductsRef = resetAndLoadProducts; // exposed to viewLoaders closure below
  }
  async function resetAndLoadProducts() { if (typeof resetAndLoadProductsRef === 'function') await resetAndLoadProductsRef(); }

  // ============= NEW INVOICE FORM (manager only) =============
  if (isManager) {
    generateBtn.textContent = 'Download PDF Invoice';
    generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';

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
      els.terms.value = inv.terms || 'CASH ON DELIVERY (COD)';
      els.providerPhone.value = inv.providerPhone || '';
      els.notes.value = inv.notes || '';
      itemsBody.innerHTML = '';
      (inv.items || []).forEach(it => addItemRow(itemsBody, refreshPreview, it.qty, it.desc, it.price, it.productName, it.packLabel, it.packQuantity));
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
      els.notes.value = ''; els.providerPhone.value = '';
      els.invoiceDate.value = new Date().toISOString().slice(0, 10);
      refreshPreview();
    }

    cancelEditBtn.addEventListener('click', (e) => { e.preventDefault(); exitEditMode(); });

    // ---- Generate invoice from an approved order ----
    function loadOrderIntoInvoiceForm(order) {
      exitEditMode();
      generatingFromOrder = { id: order.id, orderNo: order.orderNo };
      fromOrderNoLabel.textContent = order.orderNo;
      fromOrderBanner.style.display = 'block';

      els.custName.value = order.customerName || '';
      els.custPhone.value = order.customerPhone === '-' ? '' : (order.customerPhone || '');
      els.custLocation.value = order.customerLocation === '-' ? '' : (order.customerLocation || '');
      els.notes.value = order.notes || '';

      itemsBody.innerHTML = '';
      (order.items || []).forEach(it => addItemRow(itemsBody, refreshPreview, it.qty, it.desc, it.price, it.productName, it.packLabel, it.packQuantity));

      showView('form');
      refreshPreview();
      showToast(`Loaded order ${order.orderNo} — review and download.`, 'info');
    }

    function exitFromOrderMode() {
      generatingFromOrder = null;
      fromOrderBanner.style.display = 'none';
    }

    cancelFromOrderBtn.addEventListener('click', (e) => {
      e.preventDefault();
      exitFromOrderMode();
      exitEditMode();
    });

    generateBtn.addEventListener('click', async () => {
      const wasEditing = !!editingInvoiceId;
      setButtonLoading(generateBtn, wasEditing ? 'Saving…' : 'Generating…');
      try {
        const items = getItems(itemsBody);
        let invoiceNo = els.invoiceNo.value;
        let reservation = null;

        if (!wasEditing) {
          reservation = await incrementCounterAtomically();
          invoiceNo = reservation.usedNo;
        }

        const meta = {
          invoiceNo,
          date: els.invoiceDate.value,
          customer: els.custName.value || '-',
          phone: els.custPhone.value || '-',
          location: els.custLocation.value || '-',
          terms: els.terms.value,
          providerPhone: els.providerPhone.value.trim(),
          notes: els.notes.value.trim(),
          items,
        };

        const { grandTotal } = generatePdf(meta);

        if (wasEditing) {
          await updateInvoice(editingInvoiceId, { ...meta, grandTotal });
          exitEditMode();
          showToast('Invoice updated.', 'success');
        } else {
          const docRef = await addDoc(collection(db, 'invoices'), {
            ...meta, grandTotal, createdBy: user.uid, createdAt: serverTimestamp(),
          });
          els.invoiceNo.value = buildInvoiceNo(reservation.next.prefix, reservation.next.counter);

          if (generatingFromOrder) {
            try {
              await markOrderInvoiced(generatingFromOrder.id, { invoiceId: docRef.id, invoiceNo });
              showToast(`Invoice saved. Order ${generatingFromOrder.orderNo} marked as Invoiced.`, 'success');
            } catch (err) {
              showToast('Invoice saved, but could not update the order status: ' + err.message, 'error');
            }
            exitFromOrderMode();
            if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
          } else {
            showToast('Invoice saved and downloaded.', 'success');
          }
        }
      } catch (err) {
        console.error(err);
        showToast('Could not save the invoice: ' + err.message, 'error');
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

    function renderInvoiceRows(list) {
      listBody.innerHTML = '';
      listEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(inv => {
        const tr = document.createElement('tr');
        const productsSummary = formatItemsSummary(inv.items);
        tr.innerHTML = `
          <td>${inv.invoiceNo}</td>
          <td>${formatDate(inv.date)}</td>
          <td>${inv.customer}</td>
          <td class="inv-products-cell" title="${productsSummary}">${productsSummary}</td>
          <td>${mwk(inv.grandTotal || 0)}</td>
          <td><button type="button" class="list-action-btn" data-action="edit" data-id="${inv.id}">Edit</button><button type="button" class="list-action-btn" data-action="download" data-id="${inv.id}">Download</button></td>
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
      invoiceListMode = 'default'; loadedInvoices = []; invoicesCursor = null; invoicesHasMore = true;
      invoiceSearchInput.value = '';
      listTitle.textContent = 'All Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Products</th><th>Total</th><th></th></tr>`;
      await loadNextInvoicePage();
      if (window.loadPendingInvoiceOrders) await window.loadPendingInvoiceOrders();
    };

    async function loadNextInvoicePage() {
      if (!invoicesHasMore) return;
      setButtonLoading(loadMoreInvoicesBtn, 'Loading…');
      try {
        let result;
        if (invoiceListMode === 'range') result = await fetchInvoicesByDateRangePage(invoiceRangeFrom, invoiceRangeTo, invoicesCursor);
        else result = await fetchAllInvoicesPage(invoicesCursor);
        loadedInvoices = loadedInvoices.concat(result.items);
        invoicesCursor = result.lastDoc; invoicesHasMore = result.hasMore;
        applyInvoiceSearchAndRender();
        loadMoreInvoicesBtn.style.display = invoicesHasMore ? 'block' : 'none';
      } catch (err) {
        showToast('Could not load invoices: ' + err.message, 'error');
      } finally {
        clearButtonLoading(loadMoreInvoicesBtn);
      }
    }

    loadMoreInvoicesBtn.addEventListener('click', loadNextInvoicePage);
    invoiceSearchInput.addEventListener('input', applyInvoiceSearchAndRender);

    document.getElementById('applyFilterBtn').addEventListener('click', async () => {
      const from = document.getElementById('filterFrom').value;
      const to = document.getElementById('filterTo').value;
      if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }
      invoiceListMode = 'range'; invoiceRangeFrom = from; invoiceRangeTo = to;
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
        }
      } catch (err) {
        showToast('Something went wrong: ' + err.message, 'error');
      } finally {
        clearButtonLoading(btn);
      }
    });

    window.__loadOrderIntoInvoiceForm = loadOrderIntoInvoiceForm;

    // ---- Orders Ready to Invoice (Approved orders, shown in the Invoices tab) ----
    const pendingInvoiceOrdersBody = document.getElementById('pendingInvoiceOrdersBody');
    const pendingInvoiceOrdersEmpty = document.getElementById('pendingInvoiceOrdersEmpty');

    window.loadPendingInvoiceOrders = async function loadPendingInvoiceOrders() {
      try {
        const result = await fetchOrdersByStatusPage('Approved', null);
        const list = result.items;
        pendingInvoiceOrdersEmpty.style.display = list.length === 0 ? 'block' : 'none';
        pendingInvoiceOrdersBody.innerHTML = list.map(o => {
          const itemsSummary = (o.items || []).map(it => `${it.qty}× ${it.desc}`).join(', ') || '—';
          return `
            <tr>
              <td>${o.orderNo}</td>
              <td>${o.customerName}</td>
              <td class="inv-products-cell" title="${itemsSummary}">${itemsSummary}</td>
              <td>${mwk(o.grandTotal || 0)}</td>
              <td><button type="button" class="list-action-btn" data-action="generate-invoice" data-id="${o.id}">Generate Invoice</button></td>
            </tr>
          `;
        }).join('');
      } catch (err) {
        showToast('Could not load approved orders: ' + err.message, 'error');
      }
    };

    pendingInvoiceOrdersBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-action="generate-invoice"]');
      if (!btn) return;
      setButtonLoading(btn, '…');
      try {
        const order = await fetchOrderById(btn.dataset.id);
        if (order) loadOrderIntoInvoiceForm(order);
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

  let loadedExpenses = [], expensesCursor = null, expensesHasMore = true;

  function badgeHtml(cat) { return `<span class="exp-badge exp-badge-${cat}">${cat}</span>`; }

  function renderExpenseSummary() {
    const el = document.getElementById('expenseSummary');
    if (!el) return;
    const totals = { Transport: 0, Meals: 0, Other: 0 };
    loadedExpenses.forEach(e => { totals[e.category] = (totals[e.category] || 0) + (e.amount || 0); });
    const grand = Object.values(totals).reduce((a, b) => a + b, 0);
    el.innerHTML = `
      <div class="exp-summary-tiles">
        <div class="exp-tile exp-tile-transport"><span class="exp-tile-label">Transport</span><span class="exp-tile-amount">${mwk(totals.Transport)}</span></div>
        <div class="exp-tile exp-tile-meals"><span class="exp-tile-label">Meals</span><span class="exp-tile-amount">${mwk(totals.Meals)}</span></div>
        <div class="exp-tile exp-tile-other"><span class="exp-tile-label">Other</span><span class="exp-tile-amount">${mwk(totals.Other)}</span></div>
      </div>
      <div class="exp-grand-total">
        <span>Grand Total (${loadedExpenses.length} record${loadedExpenses.length !== 1 ? 's' : ''} loaded)</span>
        <span class="exp-grand-amount">${mwk(grand)}</span>
      </div>
    `;
  }

  function renderExpenseRows(list) {
    expenseListBody.innerHTML = '';
    expenseListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(exp => {
      const tr = document.createElement('tr');
      tr.dataset.id = exp.id;
      const notesShort = exp.notes ? (exp.notes.length > 40 ? exp.notes.substring(0, 40) + '…' : exp.notes) : '—';
      const byCell = isManager ? `<td style="font-size:0.72rem; color:var(--muted);">${exp.createdByEmail || '—'}</td>` : '';
      const canEdit = isManager || exp.createdBy === user.uid;
      const actions = `
        ${canEdit ? `<button type="button" class="list-action-btn" data-action="edit">Edit</button>` : ''}
        ${isManager ? `<button type="button" class="list-action-btn exp-delete-btn" data-action="delete">Delete</button>` : ''}
      `;
      tr.innerHTML = `
        <td>${formatDate(exp.date)}</td>
        <td>${badgeHtml(exp.category)}</td>
        <td style="font-family:'JetBrains Mono',monospace; white-space:nowrap;">${mwk(exp.amount || 0)}</td>
        <td style="color:var(--muted); font-size:0.78rem;">${notesShort}</td>
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
    loadedExpenses = []; expensesCursor = null; expensesHasMore = true;
    expenseSearchInput.value = '';
    await loadNextExpensePage();
  }

  async function loadNextExpensePage() {
    if (!expensesHasMore) return;
    setButtonLoading(loadMoreExpensesBtn, 'Loading…');
    try {
      const result = isManager
        ? await fetchAllExpensesPage(expensesCursor)
        : await fetchMyExpensesPage(user.uid, expensesCursor);
      loadedExpenses = loadedExpenses.concat(result.items);
      expensesCursor = result.lastDoc; expensesHasMore = result.hasMore;
      applyExpenseSearchAndRender();
      loadMoreExpensesBtn.style.display = expensesHasMore ? 'block' : 'none';
    } catch (err) {
      showToast('Could not load expenses: ' + err.message, 'error');
    } finally {
      clearButtonLoading(loadMoreExpensesBtn);
    }
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
        <td><input class="customer-edit-input" data-field="date" type="date" value="${exp.date || ''}"></td>
        <td>
          <select class="customer-edit-input" data-field="category">
            <option ${exp.category === 'Transport' ? 'selected' : ''}>Transport</option>
            <option ${exp.category === 'Meals' ? 'selected' : ''}>Meals</option>
            <option ${exp.category === 'Other' ? 'selected' : ''}>Other</option>
          </select>
        </td>
        <td><input class="customer-edit-input" data-field="amount" type="number" min="0" step="1" value="${exp.amount || 0}"></td>
        <td><input class="customer-edit-input" data-field="notes" value="${exp.notes || ''}"></td>
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
      const confirmed = confirm(`Delete this ${exp?.category || ''} expense of ${mwk(exp?.amount || 0)}?\n\nThis cannot be undone.`);
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
  let currentOrderStatusFilter = 'Submitted';

  function orderStatusBadge(status) {
    return `<span class="order-status-badge order-status-${status}">${status}</span>`;
  }

  function renderOrderRows(list) {
    orderListBody.innerHTML = '';
    orderListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(o => {
      const tr = document.createElement('tr');
      tr.dataset.id = o.id;
      const itemsSummary = (o.items || []).map(it => `${it.qty}× ${it.desc}`).join(', ') || '—';
      const baseCells = `
        <td>${o.orderNo}</td>
        <td>${o.customerName}</td>
        <td class="inv-products-cell" title="${itemsSummary}">${itemsSummary}</td>
        <td>${mwk(o.grandTotal || 0)}</td>
        <td>${orderStatusBadge(o.status)}</td>
      `;
      let actions = '';
      if (isManager) {
        if (o.status === 'Submitted') {
          actions = `
            <button type="button" class="list-action-btn" data-action="approve">Approve</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="reject">Reject</button>
          `;
        } else if (o.status === 'Approved') {
          actions = `
            <button type="button" class="list-action-btn" data-action="generate-invoice">Generate Invoice</button>
            <button type="button" class="list-action-btn exp-delete-btn" data-action="cancel">Cancel</button>
          `;
        }
      }
      // Reps: no actions — only managers change order status now.
      tr.innerHTML = baseCells + `<td>${actions}</td>`;
      orderListBody.appendChild(tr);
    });
  }

  async function resetAndLoadOrders() {
    loadedOrders = []; ordersCursor = null; ordersHasMore = true;
    orderListTitle.textContent = isManager
      ? (currentOrderStatusFilter === 'all' ? 'All Orders' : `Orders: ${currentOrderStatusFilter}`)
      : 'My Orders';
    orderListHead.innerHTML = `<tr><th>Order No.</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr>`;
    await loadNextOrderPage();
  }

  async function loadNextOrderPage() {
    if (!ordersHasMore) return;
    setButtonLoading(loadMoreOrdersBtn, 'Loading…');
    try {
      let result;
      if (isManager) {
        result = currentOrderStatusFilter === 'all'
          ? await fetchAllOrdersPage(ordersCursor)
          : await fetchOrdersByStatusPage(currentOrderStatusFilter, ordersCursor);
      } else {
        result = await fetchMyOrdersPage(user.uid, ordersCursor);
      }
      loadedOrders = loadedOrders.concat(result.items);
      ordersCursor = result.lastDoc; ordersHasMore = result.hasMore;
      renderOrderRows(loadedOrders);
      loadMoreOrdersBtn.style.display = ordersHasMore ? 'block' : 'none';
    } catch (err) {
      showToast('Could not load orders: ' + err.message, 'error');
    } finally {
      clearButtonLoading(loadMoreOrdersBtn);
    }
  }

  loadMoreOrdersBtn.addEventListener('click', loadNextOrderPage);

  if (isManager) {
    orderStatusFilter.addEventListener('change', async () => {
      currentOrderStatusFilter = orderStatusFilter.value;
      await resetAndLoadOrders();
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
      setButtonLoading(btn, '…');
      try {
        await setOrderStatus(id, 'Approved');
        showToast(`Order ${order.orderNo} approved — find it in the Invoices tab to generate the invoice.`, 'success');
        await resetAndLoadOrders();
      } catch (err) {
        showToast('Could not approve: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'reject') {
      const confirmed = confirm(`Reject and permanently delete order ${order.orderNo}?\n\nThis cannot be undone.`);
      if (!confirmed) return;
      setButtonLoading(btn, '…');
      try {
        await deleteOrder(id);
        loadedOrders = loadedOrders.filter(o => o.id !== id);
        renderOrderRows(loadedOrders);
        showToast('Order rejected and removed.', 'success');
      } catch (err) {
        showToast('Could not reject: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'cancel') {
      const confirmed = confirm(`Cancel and permanently delete order ${order.orderNo}?\n\nThis cannot be undone.`);
      if (!confirmed) return;
      setButtonLoading(btn, '…');
      try {
        await deleteOrder(id);
        loadedOrders = loadedOrders.filter(o => o.id !== id);
        renderOrderRows(loadedOrders);
        showToast('Order cancelled and removed.', 'success');
      } catch (err) {
        showToast('Could not cancel: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    } else if (btn.dataset.action === 'generate-invoice') {
      if (window.__loadOrderIntoInvoiceForm) window.__loadOrderIntoInvoiceForm(order);
    }
  });

  // ============= LOG VISIT (submitter) =============
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
    const lvSubmitNoOrderBtn = document.getElementById('lvSubmitNoOrderBtn');
    const lvOrderFormWrap = document.getElementById('lvOrderFormWrap');
    const lvOrderNotes = document.getElementById('lvOrderNotes');
    const lvSubmitOrderBtn = document.getElementById('lvSubmitOrderBtn');

    let lvSelected = null;

    function lvResetOutcome() {
      lvOutcomeCard.style.display = 'none';
      lvNoOrderFields.style.display = 'none';
      lvOrderFormWrap.style.display = 'none';
      lvOutcomeYes.classList.remove('active');
      lvOutcomeNo.classList.remove('active');
      lvOrderItemsBody.innerHTML = '';
      lvOrderNotes.value = '';
      lvReasonNotes.value = '';
      lvReason.value = 'Not interested';
    }

    function lvResetAll() {
      lvSelected = null;
      lvSelectedCustomer.style.display = 'none';
      lvCustSearch.style.display = 'block';
      lvCustSearch.value = '';
      lvResetOutcome();
    }

    document.getElementById('orderAddItemBtnPlaceholder'); // no-op guard

    document.getElementById('lvOrderAddItemBtn').addEventListener('click', () => {
      addItemRow(lvOrderItemsBody, () => {}, 1, '', '');
    });

    lvCustSearch.addEventListener('input', () => {
      const q = lvCustSearch.value.trim().toLowerCase();
      if (!q) { lvCustSuggestions.style.display = 'none'; return; }
      const matches = customersCache.filter(c => (c.name || '').toLowerCase().includes(q));
      if (!matches.length) { lvCustSuggestions.style.display = 'none'; return; }
      lvCustSuggestions.innerHTML = matches.slice(0, 8).map(c => `
        <div class="suggestion-item" data-id="${c.id}">
          <span class="sug-name">${c.name}</span>
          <span class="sug-meta">${c.phone || ''}${c.phone && c.location ? ' · ' : ''}${c.location || ''}</span>
        </div>
      `).join('');
      lvCustSuggestions.style.display = 'block';
    });

    lvCustSuggestions.addEventListener('mousedown', (e) => {
      const item = e.target.closest('.suggestion-item');
      if (!item) return;
      const c = customersCache.find(c => c.id === item.dataset.id);
      if (!c) return;
      lvSelected = c;
      lvCustName.textContent = c.name;
      lvCustPhone.textContent = c.phone || '';
      lvCustLocation.textContent = c.location || '';
      lvSelectedCustomer.style.display = 'block';
      lvCustSearch.style.display = 'none';
      lvCustSuggestions.style.display = 'none';
      lvOutcomeCard.style.display = 'block';
    });

    lvClearCustomer.addEventListener('click', (e) => {
      e.preventDefault();
      lvResetAll();
    });

    lvOutcomeYes.addEventListener('click', () => {
      lvOutcomeYes.classList.add('active');
      lvOutcomeNo.classList.remove('active');
      lvNoOrderFields.style.display = 'none';
      lvOrderFormWrap.style.display = 'block';
    });

    lvOutcomeNo.addEventListener('click', () => {
      lvOutcomeNo.classList.add('active');
      lvOutcomeYes.classList.remove('active');
      lvOrderFormWrap.style.display = 'none';
      lvNoOrderFields.style.display = 'block';
    });

    lvSubmitNoOrderBtn.addEventListener('click', async () => {
      if (!lvSelected) { showToast('Select a customer first.', 'error'); return; }
      setButtonLoading(lvSubmitNoOrderBtn, 'Saving…');
      try {
        await submitVisit({
          customerId: lvSelected.id, customerName: lvSelected.name,
          outcome: 'No Order',
          reasonNoOrder: lvReason.value,
          reasonNotes: lvReasonNotes.value.trim(),
          orderId: null, orderNo: null,
          uid: user.uid, email: user.email,
        });
        showToast('Visit logged.', 'success');
        lvResetAll();
      } catch (err) {
        showToast('Could not log visit: ' + err.message, 'error');
      } finally {
        clearButtonLoading(lvSubmitNoOrderBtn);
      }
    });

    lvSubmitOrderBtn.addEventListener('click', async () => {
      if (!lvSelected) { showToast('Select a customer first.', 'error'); return; }
      const items = getItems(lvOrderItemsBody);
      if (items.length === 0) { showToast('Add at least one item.', 'error'); return; }

      setButtonLoading(lvSubmitOrderBtn, 'Submitting…');
      try {
        const { id: orderId, orderNo } = await submitOrder({
          customerId: lvSelected.id,
          customerName: lvSelected.name,
          customerPhone: lvSelected.phone || '-',
          customerLocation: lvSelected.location || '-',
          items,
          notes: lvOrderNotes.value.trim(),
          uid: user.uid,
          email: user.email,
        });
        await submitVisit({
          customerId: lvSelected.id, customerName: lvSelected.name,
          outcome: 'Order Placed',
          reasonNoOrder: null, reasonNotes: '',
          orderId, orderNo,
          uid: user.uid, email: user.email,
        });
        showToast(`Order ${orderNo} submitted and visit logged.`, 'success');
        lvResetAll();
      } catch (err) {
        showToast('Could not submit order: ' + err.message, 'error');
      } finally {
        clearButtonLoading(lvSubmitOrderBtn);
      }
    });
  }

  // ============= MY VISITS (submitter) =============
  if (!isManager) {
    var myVisitsBody = document.getElementById('myVisitsBody');
    var myVisitsEmpty = document.getElementById('myVisitsEmpty');
    var loadMoreMyVisitsBtn = document.getElementById('loadMoreMyVisitsBtn');
    var loadedMyVisits = [], myVisitsCursor = null, myVisitsHasMore = true;

    function renderMyVisitsRows(list) {
      myVisitsBody.innerHTML = '';
      myVisitsEmpty.style.display = list.length === 0 ? 'block' : 'none';
      list.forEach(v => {
        const tr = document.createElement('tr');
        const reason = v.outcome === 'No Order' ? (v.reasonNoOrder || '—') : '—';
        tr.innerHTML = `
          <td>${formatDate(v.date)}</td>
          <td>${v.customerName}</td>
          <td>${v.outcome === 'Order Placed' ? '✓ Order Placed' : '✕ No Order'}</td>
          <td>${reason}</td>
        `;
        myVisitsBody.appendChild(tr);
      });
    }

    window.resetAndLoadMyVisits = async function resetAndLoadMyVisits() {
      loadedMyVisits = []; myVisitsCursor = null; myVisitsHasMore = true;
      await loadNextMyVisitsPage();
    };

    async function loadNextMyVisitsPage() {
      if (!myVisitsHasMore) return;
      setButtonLoading(loadMoreMyVisitsBtn, 'Loading…');
      try {
        const result = await fetchMyVisitsPage(user.uid, myVisitsCursor);
        loadedMyVisits = loadedMyVisits.concat(result.items);
        myVisitsCursor = result.lastDoc; myVisitsHasMore = result.hasMore;
        renderMyVisitsRows(loadedMyVisits);
        loadMoreMyVisitsBtn.style.display = myVisitsHasMore ? 'block' : 'none';
      } catch (err) {
        showToast('Could not load visits: ' + err.message, 'error');
      } finally {
        clearButtonLoading(loadMoreMyVisitsBtn);
      }
    }

    loadMoreMyVisitsBtn.addEventListener('click', loadNextMyVisitsPage);
  }
  async function resetAndLoadMyVisits() { if (window.resetAndLoadMyVisits) await window.resetAndLoadMyVisits(); }

  // ============= REP PERFORMANCE (manager) =============
  if (isManager) {
    const repSummaryBody = document.getElementById('repSummaryBody');
    const repSummaryEmpty = document.getElementById('repSummaryEmpty');
    const allVisitsBody = document.getElementById('allVisitsBody');
    const allVisitsEmpty = document.getElementById('allVisitsEmpty');
    const perfRepFilter = document.getElementById('perfRepFilter');
    let allVisitsCache = [];

    window.loadPerformanceView = async function loadPerformanceView() {
      try {
        allVisitsCache = await fetchAllVisitsForAggregation();
      } catch (err) {
        showToast('Could not load visit reports: ' + err.message, 'error');
        return;
      }

      const summary = aggregateVisitsByRep(allVisitsCache);
      repSummaryEmpty.style.display = summary.length === 0 ? 'block' : 'none';
      repSummaryBody.innerHTML = summary.map(r => `
        <tr>
          <td>${r.repEmail}</td>
          <td>${r.total}</td>
          <td>${r.ordersPlaced}</td>
          <td><strong>${r.successRate}%</strong></td>
        </tr>
      `).join('');

      const reps = [...new Set(allVisitsCache.map(v => v.repEmail))].sort();
      perfRepFilter.innerHTML = `<option value="all">All reps</option>` + reps.map(r => `<option value="${r}">${r}</option>`).join('');

      renderAllVisits();
    };

    function renderAllVisits() {
      const filterVal = perfRepFilter.value;
      const filtered = filterVal === 'all' ? allVisitsCache : allVisitsCache.filter(v => v.repEmail === filterVal);
      allVisitsEmpty.style.display = filtered.length === 0 ? 'block' : 'none';
      allVisitsBody.innerHTML = filtered.map(v => {
        const reason = v.outcome === 'No Order' ? (v.reasonNoOrder || '—') : '—';
        return `
          <tr>
            <td>${formatDate(v.date)}</td>
            <td>${v.repEmail}</td>
            <td>${v.customerName}</td>
            <td>${v.outcome === 'Order Placed' ? '✓ Order Placed' : '✕ No Order'}</td>
            <td>${reason}</td>
          </tr>
        `;
      }).join('');
    }

    perfRepFilter.addEventListener('change', renderAllVisits);
  }
  async function loadPerformanceView() { if (window.loadPerformanceView) await window.loadPerformanceView(); }

  // Default landing view per role — called last, after every section
  // above has run its setup code (their `let`/`const` state variables
  // need to exist before showView() can safely trigger their loaders).
  await showView(isManager ? 'orders' : 'logvisit');

  hideAppOverlay();
}