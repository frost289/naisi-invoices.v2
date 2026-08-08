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
  showToast, setButtonLoading, clearButtonLoading,
  initOfflineBanner, showAppOverlay, hideAppOverlay, fadeInView
} from './ui.js';
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
  const expensesView = document.getElementById('expensesView');
  const navFormBtn = document.getElementById('navFormBtn');
  const navInvoicesBtn = document.getElementById('navInvoicesBtn');
  const navCustomersBtn = document.getElementById('navCustomersBtn');
  const navExpensesBtn = document.getElementById('navExpensesBtn');
  const filterCard = document.getElementById('filterCard');

  navInvoicesBtn.textContent = role === 'manager' ? 'All Invoices' : 'My Invoices';
  filterCard.style.display = role === 'manager' ? 'block' : 'none';

  function showView(view) {
    formView.style.display = view === 'form' ? 'block' : 'none';
    invoicesView.style.display = view === 'invoices' ? 'block' : 'none';
    customersView.style.display = view === 'customers' ? 'block' : 'none';
    expensesView.style.display = view === 'expenses' ? 'block' : 'none';
    navFormBtn.classList.toggle('active', view === 'form');
    navInvoicesBtn.classList.toggle('active', view === 'invoices');
    navCustomersBtn.classList.toggle('active', view === 'customers');
    navExpensesBtn.classList.toggle('active', view === 'expenses');
    const activeEl = { form: formView, invoices: invoicesView, customers: customersView, expenses: expensesView }[view];
    if (activeEl) fadeInView(activeEl);
  }

  navFormBtn.addEventListener('click', () => showView('form'));
  navInvoicesBtn.addEventListener('click', async () => { showView('invoices'); await resetAndLoadInvoices(); });
  navCustomersBtn.addEventListener('click', async () => { showView('customers'); await resetAndLoadCustomers(); });
  navExpensesBtn.addEventListener('click', async () => { showView('expenses'); await resetAndLoadExpenses(); });
  showView('form');

  // ============= NUMBERING =============
  const invPrefixInput = document.getElementById('invPrefix');
  const invCounterInput = document.getElementById('invCounter');
  const invYearDisplay = document.getElementById('invYearDisplay');
  invYearDisplay.value = currentYear();

  try {
    await loadCounterState(role === 'manager');
    watchCounterState((data) => {
      invPrefixInput.value = data.prefix;
      invCounterInput.value = data.counter;
      invYearDisplay.value = currentYear();
      if (!editingInvoiceId) {
        els.invoiceNo.value = buildInvoiceNo(data.prefix, data.counter);
      }
    });
  } catch (err) {
    showToast(err.message, 'error');
  }

  if (role !== 'manager') {
    invPrefixInput.disabled = true;
    invCounterInput.disabled = true;
  } else {
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

  // ============= CUSTOMERS AUTOCOMPLETE =============
  let customersCache = [];
  async function loadCustomersCache() { customersCache = await fetchAllCustomers(); }
  await loadCustomersCache();

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

  // ============= CUSTOMERS MANAGE LIST =============
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

  // ============= FORM / INVOICE SUBMIT =============
  if (role === 'submitter') {
    generateBtn.textContent = 'Submit Invoice';
    generateNote.textContent = 'Saves this invoice. A manager will handle printing/downloading it.';
  } else {
    generateBtn.textContent = 'Download PDF Invoice';
    generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
  }

  function refreshPreview() { updatePreview(els); }

  buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview);
  document.getElementById('addItemBtn').addEventListener('click', () => { addItemRow(itemsBody, refreshPreview, 1, '', ''); refreshPreview(); });

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
    (inv.items || []).forEach(it => addItemRow(itemsBody, refreshPreview, it.qty, it.desc, it.price));
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
    generateBtn.textContent = role === 'submitter' ? 'Submit Invoice' : 'Download PDF Invoice';
    generateNote.textContent = role === 'submitter'
      ? 'Saves this invoice. A manager will handle printing/downloading it.'
      : 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
    invPrefixInput.disabled = role !== 'manager';
    invCounterInput.disabled = role !== 'manager';
    itemsBody.innerHTML = '';
    els.custName.value = ''; els.custPhone.value = ''; els.custLocation.value = '';
    els.notes.value = ''; els.providerPhone.value = '';
    els.invoiceDate.value = new Date().toISOString().slice(0, 10);
    refreshPreview();
  }

  cancelEditBtn.addEventListener('click', (e) => { e.preventDefault(); exitEditMode(); });

  generateBtn.addEventListener('click', async () => {
    const wasEditing = !!editingInvoiceId;
    setButtonLoading(generateBtn, wasEditing ? 'Saving…' : role === 'manager' ? 'Generating…' : 'Submitting…');
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

      let grandTotal;
      if (role === 'manager') {
        ({ grandTotal } = generatePdf(meta));
      } else {
        grandTotal = items.reduce((sum, it) => sum + it.total, 0);
      }

      if (wasEditing) {
        await updateInvoice(editingInvoiceId, { ...meta, grandTotal });
        exitEditMode();
        showToast('Invoice updated.', 'success');
      } else {
        await addDoc(collection(db, 'invoices'), {
          ...meta, grandTotal, createdBy: user.uid, createdAt: serverTimestamp(),
        });
        els.invoiceNo.value = buildInvoiceNo(reservation.next.prefix, reservation.next.counter);
        showToast(role === 'manager' ? 'Invoice saved and downloaded.' : 'Invoice submitted.', 'success');
      }
    } catch (err) {
      console.error(err);
      showToast('Could not save the invoice: ' + err.message, 'error');
    } finally {
      clearButtonLoading(generateBtn);
    }
  });

  // ============= INVOICES LIST =============
  const listTitle = document.getElementById('listTitle');
  const listHead = document.getElementById('invoiceListHead');
  const listBody = document.getElementById('invoiceListBody');
  const listEmpty = document.getElementById('invoiceListEmpty');
  const loadMoreInvoicesBtn = document.getElementById('loadMoreInvoicesBtn');
  const invoiceSearchInput = document.getElementById('invoiceSearchInput');
  const invoiceSearchHint = document.getElementById('invoiceSearchHint');
  let invoiceListMode = 'default', invoiceRangeFrom = null, invoiceRangeTo = null;
  let loadedInvoices = [], invoicesCursor = null, invoicesHasMore = true;

  function renderInvoiceRows(list) {
    listBody.innerHTML = '';
    listEmpty.style.display = list.length === 0 ? 'block' : 'none';
    list.forEach(inv => {
      const tr = document.createElement('tr');
      const base = `<td>${inv.invoiceNo}</td><td>${formatDate(inv.date)}</td><td>${inv.customer}</td><td>${mwk(inv.grandTotal || 0)}</td>`;
      tr.innerHTML = role === 'manager'
        ? base + `<td><button type="button" class="list-action-btn" data-action="edit" data-id="${inv.id}">Edit</button><button type="button" class="list-action-btn" data-action="download" data-id="${inv.id}">Download</button></td>`
        : base;
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

  async function resetAndLoadInvoices() {
    invoiceListMode = 'default'; loadedInvoices = []; invoicesCursor = null; invoicesHasMore = true;
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
      if (invoiceListMode === 'range') result = await fetchInvoicesByDateRangePage(invoiceRangeFrom, invoiceRangeTo, invoicesCursor);
      else if (role === 'manager') result = await fetchAllInvoicesPage(invoicesCursor);
      else result = await fetchMyInvoicesPage(user.uid, invoicesCursor);
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
    if (role !== 'manager') return;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    if (!from || !to) { showToast('Pick both a From and To date.', 'error'); return; }
    invoiceListMode = 'range'; invoiceRangeFrom = from; invoiceRangeTo = to;
    loadedInvoices = []; invoicesCursor = null; invoicesHasMore = true; invoiceSearchInput.value = '';
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
        generatePdf({ invoiceNo: inv.invoiceNo, date: inv.date, customer: inv.customer, phone: inv.phone, location: inv.location, terms: inv.terms, providerPhone: inv.providerPhone, notes: inv.notes, items: inv.items || [] });
        showToast('PDF downloaded.', 'success');
      }
    } catch (err) {
      showToast('Something went wrong: ' + err.message, 'error');
    } finally {
      clearButtonLoading(btn);
    }
  });

  // ============= EXPENSES =============
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
  expListTitle.textContent = role === 'manager' ? 'All Expenses' : 'My Expenses';
  expenseListHead.innerHTML = role === 'manager'
    ? `<tr><th>Date</th><th>Category</th><th>Amount</th><th>Notes</th><th>By</th><th></th></tr>`
    : `<tr><th>Date</th><th>Category</th><th>Amount</th><th>Notes</th><th></th></tr>`;

  let loadedExpenses = [], expensesCursor = null, expensesHasMore = true;

  function badgeHtml(cat) {
    return `<span class="exp-badge exp-badge-${cat}">${cat}</span>`;
  }

  function renderExpenseSummary() {
    const el = document.getElementById('expenseSummary');
    if (!el) return;
    const totals = { Transport: 0, Meals: 0, Other: 0 };
    loadedExpenses.forEach(e => { totals[e.category] = (totals[e.category] || 0) + (e.amount || 0); });
    const grand = Object.values(totals).reduce((a, b) => a + b, 0);
    el.innerHTML = `
      <div class="exp-summary-tiles">
        <div class="exp-tile exp-tile-transport">
          <span class="exp-tile-label">Transport</span>
          <span class="exp-tile-amount">${mwk(totals.Transport)}</span>
        </div>
        <div class="exp-tile exp-tile-meals">
          <span class="exp-tile-label">Meals</span>
          <span class="exp-tile-amount">${mwk(totals.Meals)}</span>
        </div>
        <div class="exp-tile exp-tile-other">
          <span class="exp-tile-label">Other</span>
          <span class="exp-tile-amount">${mwk(totals.Other)}</span>
        </div>
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
      const byCell = role === 'manager' ? `<td style="font-size:0.72rem; color:var(--muted);">${exp.createdByEmail || '—'}</td>` : '';
      const canEdit = role === 'manager' || exp.createdBy === user.uid;
      const actions = `
        ${canEdit ? `<button type="button" class="list-action-btn" data-action="edit">Edit</button>` : ''}
        ${role === 'manager' ? `<button type="button" class="list-action-btn exp-delete-btn" data-action="delete">Delete</button>` : ''}
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
      const result = role === 'manager'
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
      expAmount.value = '';
      expNotes.value = '';
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
      if (role !== 'manager' && exp.createdBy !== user.uid) return;
      const byEditCell = role === 'manager' ? `<td></td>` : '';
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
      if (role !== 'manager') return;
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

  hideAppOverlay();
}