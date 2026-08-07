import './style.css';
import { LOGO_DATA_URI } from './logo.js';
import { auth, db } from './firebase.js';
import { watchAuth, login } from './auth.js';
import { getUserRole } from './roles.js';
import { addItemRow, buildQuickAddGrid, getItems, mwk } from './items.js';
import { updatePreview, formatDate } from './preview.js';
import { loadCounterState, buildInvoiceNo, incrementCounterAtomically, savePrefixYear } from './numbering.js';
import { generatePdf } from './pdf.js';
import {
  fetchMyInvoicesPage, fetchAllInvoicesPage, fetchInvoicesByDateRangePage,
  fetchInvoicesByDateRange, fetchInvoiceById, updateInvoice
} from './invoices.js';
import { buildAndDownloadInvoiceReport } from './export.js';
import {
  fetchAllCustomers, fetchCustomersPage, addCustomer, updateCustomer, findExactNameMatch
} from './customers.js';
import { showToast, setButtonLoading, clearButtonLoading, initOfflineBanner } from './ui.js';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

initOfflineBanner();

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
      initApp(user, role);
    } else {
      appRoot.style.display = 'none';
      noAccessScreen.style.display = 'block';
    }
  },
  () => {
    loginScreen.style.display = 'block';
    appRoot.style.display = 'none';
    noAccessScreen.style.display = 'none';
  }
);

document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    await login(email, password);
  } catch (e) {
    document.getElementById('loginError').textContent = e.message;
  }
});

let appInitialized = false;

async function initApp(user, role) {
  if (appInitialized) return;
  appInitialized = true;

  document.getElementById('topbarLogo').src = LOGO_DATA_URI;
  document.getElementById('previewLogo').src = LOGO_DATA_URI;
  document.getElementById('appTitle').textContent = role === 'manager' ? 'Invoice Manager' : 'Invoice Generator';

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

  let editingInvoiceId = null;

  // ============= VIEW SWITCHING =============
  const formView = document.getElementById('formView');
  const invoicesView = document.getElementById('invoicesView');
  const customersView = document.getElementById('customersView');
  const navFormBtn = document.getElementById('navFormBtn');
  const navInvoicesBtn = document.getElementById('navInvoicesBtn');
  const navCustomersBtn = document.getElementById('navCustomersBtn');
  const filterCard = document.getElementById('filterCard');

  navInvoicesBtn.textContent = role === 'manager' ? 'All Invoices' : 'My Invoices';
  filterCard.style.display = role === 'manager' ? 'block' : 'none';

  function showView(view) {
    formView.style.display = view === 'form' ? 'block' : 'none';
    invoicesView.style.display = view === 'invoices' ? 'block' : 'none';
    customersView.style.display = view === 'customers' ? 'block' : 'none';
    navFormBtn.classList.toggle('active', view === 'form');
    navInvoicesBtn.classList.toggle('active', view === 'invoices');
    navCustomersBtn.classList.toggle('active', view === 'customers');
  }
  navFormBtn.addEventListener('click', () => showView('form'));
  navInvoicesBtn.addEventListener('click', async () => { showView('invoices'); await resetAndLoadInvoices(); });
  navCustomersBtn.addEventListener('click', async () => { showView('customers'); await resetAndLoadCustomers(); });
  showView('form');

  // ============= CUSTOMERS: autocomplete cache (full fetch, unrelated to pagination) =============
  let customersCache = [];
  async function loadCustomersCache() { customersCache = await fetchAllCustomers(); }
  await loadCustomersCache();

  const custSuggestions = document.getElementById('custSuggestions');
  const saveCustomerBtn = document.getElementById('saveCustomerBtn');
  const customerSaveNote = document.getElementById('customerSaveNote');

  function renderSuggestions(matches) {
    if (matches.length === 0) { custSuggestions.style.display = 'none'; custSuggestions.innerHTML = ''; return; }
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

  els.custName.addEventListener('blur', () => {
    setTimeout(() => { custSuggestions.style.display = 'none'; }, 150);
  });

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
      const proceed = confirm(`A customer named "${name}" already exists — use existing or save anyway?\n\nOK = save as a new entry anyway\nCancel = keep using the existing one`);
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
      console.error(err);
      showToast('Could not save the customer: ' + err.message, 'error');
    } finally {
      clearButtonLoading(saveCustomerBtn);
    }
  });

  // ============= CUSTOMERS: paginated manage list =============
  const customerListBody = document.getElementById('customerListBody');
  const customerListEmpty = document.getElementById('customerListEmpty');
  const loadMoreCustomersBtn = document.getElementById('loadMoreCustomersBtn');
  const customerSearchInput = document.getElementById('customerSearchInput');
  const customerSearchHint = document.getElementById('customerSearchHint');

  let loadedCustomers = [];
  let customersCursor = null;
  let customersHasMore = true;

  function renderCustomerRows(list) {
    customerListBody.innerHTML = '';
    customerListEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(c => {
      const tr = document.createElement('tr');
      tr.dataset.id = c.id;
      tr.innerHTML = `
        <td class="cust-name">${c.name}</td>
        <td class="cust-phone">${c.phone || ''}</td>
        <td class="cust-location">${c.location || ''}</td>
        <td><button type="button" class="list-action-btn" data-action="edit">Edit</button></td>
      `;
      customerListBody.appendChild(tr);
    });
  }

  function applyCustomerSearchAndRender() {
    const term = customerSearchInput.value.trim().toLowerCase();
    const filtered = term ? loadedCustomers.filter(c => (c.name || '').toLowerCase().includes(term)) : loadedCustomers;
    renderCustomerRows(filtered);
    customerSearchHint.textContent = term
      ? `Searching ${loadedCustomers.length} loaded customer${loadedCustomers.length === 1 ? '' : 's'}. Load more to search further.`
      : '';
  }

  async function resetAndLoadCustomers() {
    loadedCustomers = [];
    customersCursor = null;
    customersHasMore = true;
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
      console.error(err);
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
      const customer = loadedCustomers.find(c => c.id === id);
      if (!customer) return;
      tr.innerHTML = `
        <td><input class="customer-edit-input" data-field="name" value="${customer.name || ''}"></td>
        <td><input class="customer-edit-input" data-field="phone" value="${customer.phone || ''}"></td>
        <td><input class="customer-edit-input" data-field="location" value="${customer.location || ''}"></td>
        <td>
          <button type="button" class="list-action-btn" data-action="save">Save</button>
          <button type="button" class="list-action-btn" data-action="cancel">Cancel</button>
        </td>
      `;
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
        await loadCustomersCache(); // keep autocomplete in sync too
        applyCustomerSearchAndRender();
        showToast('Customer updated.', 'success');
      } catch (err) {
        console.error(err);
        showToast('Could not update the customer: ' + err.message, 'error');
        clearButtonLoading(btn);
      }
    }
  });

  // ============= Button text depends on role =============
  if (role === 'submitter') {
    generateBtn.textContent = 'Submit Invoice';
    generateNote.textContent = 'Saves this invoice. A manager will handle printing/downloading it.';
  } else {
    generateBtn.textContent = 'Download PDF Invoice';
    generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
  }

  function refreshPreview() { updatePreview(els); }

  buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview);
  document.getElementById('addItemBtn').addEventListener('click', () => {
    addItemRow(itemsBody, refreshPreview, 1, '', '');
    refreshPreview();
  });

  let counterState = await loadCounterState();

  function refreshInvoiceNoField() {
    const prefix = document.getElementById('invPrefix').value.trim() || 'NF-INV';
    const year = document.getElementById('invYear').value.trim() || String(new Date().getFullYear());
    const counter = parseInt(document.getElementById('invCounter').value, 10) || 1;
    els.invoiceNo.value = buildInvoiceNo(prefix, year, counter);
  }

  document.getElementById('invPrefix').value = counterState.prefix;
  document.getElementById('invYear').value = counterState.year;
  document.getElementById('invCounter').value = counterState.counter;
  refreshInvoiceNoField();

  ['invPrefix', 'invYear', 'invCounter'].forEach(id => {
    document.getElementById(id).addEventListener('input', async () => {
      refreshInvoiceNoField();
      if (editingInvoiceId) return;
      const prefix = document.getElementById('invPrefix').value.trim() || 'NF-INV';
      const year = document.getElementById('invYear').value.trim() || String(new Date().getFullYear());
      const counter = parseInt(document.getElementById('invCounter').value, 10) || 1;
      await savePrefixYear(prefix, year, counter);
      refreshPreview();
    });
  });

  const today = new Date();
  els.invoiceDate.value = today.toISOString().slice(0, 10);
  refreshPreview();

  ['invoiceDate', 'custName', 'custPhone', 'custLocation', 'terms', 'providerPhone', 'notes'].forEach(id => {
    document.getElementById(id).addEventListener('input', refreshPreview);
    document.getElementById(id).addEventListener('change', refreshPreview);
  });

  function populateFormFromInvoice(inv) {
    document.getElementById('invPrefix').disabled = true;
    document.getElementById('invYear').disabled = true;
    document.getElementById('invCounter').disabled = true;
    els.invoiceNo.value = inv.invoiceNo;

    els.invoiceDate.value = inv.date || '';
    els.custName.value = inv.customer === '-' ? '' : inv.customer;
    els.custPhone.value = inv.phone === '-' ? '' : inv.phone;
    els.custLocation.value = inv.location === '-' ? '' : inv.location;
    els.terms.value = inv.terms || 'CASH ON DELIVERY (COD)';
    els.providerPhone.value = inv.providerPhone || '';
    els.notes.value = inv.notes || '';

    itemsBody.innerHTML = '';
    (inv.items || []).forEach(it => addItemRow(itemsBody, refreshPreview, it.qty, it.desc, it.price));

    editingInvoiceId = inv.id;
    editingInvoiceNoLabel.textContent = inv.invoiceNo;
    editingBanner.style.display = 'block';
    generateBtn.textContent = 'Save Changes';
    generateNote.textContent = 'Updates this invoice in place. Does not change the invoice number or counter.';

    showView('form');
    refreshPreview();
  }

  function exitEditMode() {
    editingInvoiceId = null;
    editingBanner.style.display = 'none';
    generateBtn.textContent = role === 'submitter' ? 'Submit Invoice' : 'Download PDF Invoice';
    generateNote.textContent = role === 'submitter'
      ? 'Saves this invoice. A manager will handle printing/downloading it.'
      : 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
    document.getElementById('invPrefix').disabled = false;
    document.getElementById('invYear').disabled = false;
    document.getElementById('invCounter').disabled = false;

    itemsBody.innerHTML = '';
    els.custName.value = '';
    els.custPhone.value = '';
    els.custLocation.value = '';
    els.notes.value = '';
    els.providerPhone.value = '';
    els.invoiceDate.value = new Date().toISOString().slice(0, 10);
    refreshInvoiceNoField();
    refreshPreview();
  }

  cancelEditBtn.addEventListener('click', (e) => { e.preventDefault(); exitEditMode(); });

  generateBtn.addEventListener('click', async () => {
    const wasEditing = !!editingInvoiceId;
    setButtonLoading(generateBtn, wasEditing ? 'Saving…' : (role === 'manager' ? 'Generating…' : 'Submitting…'));
    try {
      const items = getItems(itemsBody);
      const meta = {
        invoiceNo: els.invoiceNo.value,
        date: els.invoiceDate.value,
        customer: els.custName.value || '-',
        phone: els.custPhone.value || '-',
        location: els.custLocation.value || '-',
        terms: els.terms.value,
        providerPhone: els.providerPhone.value.trim(),
        notes: els.notes.value.trim(),
        items,
      };

      let grandTotal;
      if (role === 'manager') {
        ({ grandTotal } = generatePdf(meta));
      } else {
        grandTotal = items.reduce((sum, it) => sum + it.total, 0);
      }

      if (editingInvoiceId) {
        await updateInvoice(editingInvoiceId, { ...meta, grandTotal });
        exitEditMode();
        showToast('Invoice updated.', 'success');
      } else {
        await addDoc(collection(db, 'invoices'), {
          ...meta, grandTotal, createdBy: user.uid, createdAt: serverTimestamp(),
        });
        const { next } = await incrementCounterAtomically();
        document.getElementById('invCounter').value = next.counter;
        refreshInvoiceNoField();
        refreshPreview();
        showToast(role === 'manager' ? 'Invoice saved and downloaded.' : 'Invoice submitted.', 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Could not save the invoice: ' + err.message, 'error');
    } finally {
      clearButtonLoading(generateBtn);
    }
  });

  // ============= INVOICES: paginated list =============
  const listTitle = document.getElementById('listTitle');
  const listHead = document.getElementById('invoiceListHead');
  const listBody = document.getElementById('invoiceListBody');
  const listEmpty = document.getElementById('invoiceListEmpty');
  const loadMoreInvoicesBtn = document.getElementById('loadMoreInvoicesBtn');
  const invoiceSearchInput = document.getElementById('invoiceSearchInput');
  const invoiceSearchHint = document.getElementById('invoiceSearchHint');

  let invoiceListMode = 'default'; // 'default' | 'range'
  let invoiceRangeFrom = null, invoiceRangeTo = null;
  let loadedInvoices = [];
  let invoicesCursor = null;
  let invoicesHasMore = true;

  function renderInvoiceRows(list) {
    listBody.innerHTML = '';
    listEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(inv => {
      const tr = document.createElement('tr');
      const baseCells = `
        <td>${inv.invoiceNo}</td><td>${formatDate(inv.date)}</td>
        <td>${inv.customer}</td><td>${mwk(inv.grandTotal || 0)}</td>
      `;
      if (role === 'manager') {
        tr.innerHTML = baseCells + `
          <td>
            <button type="button" class="list-action-btn" data-action="edit" data-id="${inv.id}">Edit</button>
            <button type="button" class="list-action-btn" data-action="download" data-id="${inv.id}">Download</button>
          </td>`;
      } else {
        tr.innerHTML = baseCells;
      }
      listBody.appendChild(tr);
    });
  }

  function applyInvoiceSearchAndRender() {
    const term = invoiceSearchInput.value.trim().toLowerCase();
    const filtered = term
      ? loadedInvoices.filter(inv =>
          (inv.invoiceNo || '').toLowerCase().includes(term) ||
          (inv.customer || '').toLowerCase().includes(term))
      : loadedInvoices;
    renderInvoiceRows(filtered);
    invoiceSearchHint.textContent = term
      ? `Searching ${loadedInvoices.length} loaded invoice${loadedInvoices.length === 1 ? '' : 's'}. Load more to search further back.`
      : '';
  }

  async function resetAndLoadInvoices() {
    invoiceListMode = 'default';
    loadedInvoices = [];
    invoicesCursor = null;
    invoicesHasMore = true;
    invoiceSearchInput.value = '';
    listTitle.textContent = role === 'manager' ? 'All Invoices' : 'My Submitted Invoices';
    listHead.innerHTML = role === 'manager'
      ? `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th><th></th></tr>`
      : `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th></tr>`;
    await loadNextInvoicePage();
  }

  async function loadNextInvoicePage() {
    if (!invoicesHasMore) return;
    setButtonLoading(loadMoreInvoicesBtn, 'Loading…');
    try {
      let result;
      if (invoiceListMode === 'range') {
        result = await fetchInvoicesByDateRangePage(invoiceRangeFrom, invoiceRangeTo, invoicesCursor);
      } else if (role === 'manager') {
        result = await fetchAllInvoicesPage(invoicesCursor);
      } else {
        result = await fetchMyInvoicesPage(user.uid, invoicesCursor);
      }
      loadedInvoices = loadedInvoices.concat(result.items);
      invoicesCursor = result.lastDoc;
      invoicesHasMore = result.hasMore;
      applyInvoiceSearchAndRender();
      loadMoreInvoicesBtn.style.display = invoicesHasMore ? 'block' : 'none';
    } catch (err) {
      console.error(err);
      showToast('Could not load invoices: ' + err.message, 'error');
    } finally {
      clearButtonLoading(loadMoreInvoicesBtn);
    }
  }

  loadMoreInvoicesBtn.addEventListener('click', loadNextInvoicePage);
  invoiceSearchInput.addEventListener('input', applyInvoiceSearchAndRender);

  document.getElementById('applyFilterBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }

    invoiceListMode = 'range';
    invoiceRangeFrom = from;
    invoiceRangeTo = to;
    loadedInvoices = [];
    invoicesCursor = null;
    invoicesHasMore = true;
    invoiceSearchInput.value = '';
    listTitle.textContent = `Invoices: ${from} to ${to}`;
    listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th><th></th></tr>`;
    await loadNextInvoicePage();
  });

  document.getElementById('clearFilterBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    await resetAndLoadInvoices();
  });

  document.getElementById('exportBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    if (!from || !to) { showToast('Pick both a From and To date to export.', 'error'); return; }

    const exportBtn = document.getElementById('exportBtn');
    setButtonLoading(exportBtn, 'Building report…');
    try {
      // Deliberately fetches the FULL range fresh, independent of what's
      // currently paginated on screen, so the export is always complete.
      const fullRangeInvoices = await fetchInvoicesByDateRange(from, to);
      if (fullRangeInvoices.length === 0) {
        showToast('No invoices found in that range.', 'info');
        return;
      }
      await buildAndDownloadInvoiceReport(fullRangeInvoices, from, to);
      showToast('Report downloaded.', 'success');
    } catch (err) {
      console.error(err);
      showToast('Could not build the report: ' + err.message, 'error');
    } finally {
      clearButtonLoading(exportBtn);
    }
  });

  listBody.addEventListener('click', async (e) => {
    if (role !== 'manager') return;
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    setButtonLoading(btn, '…');
    try {
      const inv = await fetchInvoiceById(btn.dataset.id);
      if (!inv) return;

      if (btn.dataset.action === 'edit') {
        populateFormFromInvoice(inv);
      } else if (btn.dataset.action === 'download') {
        generatePdf({
          invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer,
          phone: inv.phone, location: inv.location, terms: inv.terms,
          providerPhone: inv.providerPhone, notes: inv.notes, items: inv.items || [],
        });
        showToast('PDF downloaded.', 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Something went wrong: ' + err.message, 'error');
    } finally {
      clearButtonLoading(btn);
    }
  });
}