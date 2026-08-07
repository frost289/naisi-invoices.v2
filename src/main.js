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
  fetchMyInvoices, fetchAllInvoices, fetchInvoicesByDateRange,
  fetchInvoiceById, updateInvoice
} from './invoices.js';
import { buildAndDownloadInvoiceReport } from './export.js';
import {
  fetchAllCustomers, addCustomer, updateCustomer, findExactNameMatch
} from './customers.js';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

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
  document.getElementById('appTitle').textContent =
    role === 'manager' ? 'Invoice Manager' : 'Invoice Generator';

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
  let currentInvoices = [];
  let customersCache = [];

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
  navInvoicesBtn.addEventListener('click', async () => { showView('invoices'); await renderInvoiceList(); });
  navCustomersBtn.addEventListener('click', async () => { showView('customers'); await renderCustomerList(); });
  showView('form');

  // ============= CUSTOMERS: load + autocomplete =============
  async function loadCustomers() {
    customersCache = await fetchAllCustomers();
  }
  await loadCustomers();

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
    const query = els.custName.value.trim().toLowerCase();
    customerSaveNote.textContent = '';
    if (!query) { custSuggestions.style.display = 'none'; return; }
    const matches = customersCache.filter(c => (c.name || '').toLowerCase().includes(query));
    renderSuggestions(matches);
  });

  els.custName.addEventListener('blur', () => {
    // Small delay so a click on a suggestion registers before the dropdown hides.
    setTimeout(() => { custSuggestions.style.display = 'none'; }, 150);
  });

  // mousedown fires before blur, so selecting a suggestion works reliably.
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
    if (!name) { alert('Enter a customer name first.'); return; }

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

    try {
      await addCustomer({
        name,
        phone: els.custPhone.value.trim(),
        location: els.custLocation.value.trim(),
        uid: user.uid,
      });
      customerSaveNote.textContent = 'Saved to customer list.';
      await loadCustomers();
    } catch (err) {
      console.error(err);
      alert('Could not save the customer: ' + err.message);
    }
  });

  // ============= CUSTOMERS: manage/edit list =============
  const customerListBody = document.getElementById('customerListBody');
  const customerListEmpty = document.getElementById('customerListEmpty');

  async function renderCustomerList() {
    await loadCustomers();
    customerListBody.innerHTML = '';
    customerListEmpty.style.display = customersCache.length === 0 ? 'block' : 'none';

    customersCache.forEach(c => {
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

  customerListBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const id = tr.dataset.id;

    if (btn.dataset.action === 'edit') {
      const customer = customersCache.find(c => c.id === id);
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
      await renderCustomerList();
    } else if (btn.dataset.action === 'save') {
      const name = tr.querySelector('[data-field="name"]').value.trim();
      const phone = tr.querySelector('[data-field="phone"]').value.trim();
      const location = tr.querySelector('[data-field="location"]').value.trim();
      if (!name) { alert('Name cannot be empty.'); return; }
      try {
        await updateCustomer(id, { name, phone, location });
        await renderCustomerList();
      } catch (err) {
        console.error(err);
        alert('Could not update the customer: ' + err.message);
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
      } else {
        await addDoc(collection(db, 'invoices'), {
          ...meta, grandTotal, createdBy: user.uid, createdAt: serverTimestamp(),
        });
        const { next } = await incrementCounterAtomically();
        document.getElementById('invCounter').value = next.counter;
        refreshInvoiceNoField();
        refreshPreview();
      }
    } catch (err) {
      console.error(err);
      alert('Could not save the invoice: ' + err.message);
    }
  });

  // ============= Invoice list =============
  const listTitle = document.getElementById('listTitle');
  const listHead = document.getElementById('invoiceListHead');
  const listBody = document.getElementById('invoiceListBody');
  const listEmpty = document.getElementById('invoiceListEmpty');

  function renderRows(invoices) {
    listBody.innerHTML = '';
    listEmpty.style.display = invoices.length === 0 ? 'block' : 'none';
    invoices.forEach(inv => {
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

  async function renderInvoiceList() {
    if (role === 'manager') {
      listTitle.textContent = 'All Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th><th></th></tr>`;
      currentInvoices = await fetchAllInvoices();
    } else {
      listTitle.textContent = 'My Submitted Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th></tr>`;
      currentInvoices = await fetchMyInvoices(user.uid);
    }
    renderRows(currentInvoices);
  }

  document.getElementById('applyFilterBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    if (!from || !to) { alert('Pick both a From and To date.'); return; }
    listTitle.textContent = `Invoices: ${from} to ${to}`;
    currentInvoices = await fetchInvoicesByDateRange(from, to);
    renderRows(currentInvoices);
  });

  document.getElementById('clearFilterBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    document.getElementById('filterFrom').value = '';
    document.getElementById('filterTo').value = '';
    await renderInvoiceList();
  });

  document.getElementById('exportBtn').addEventListener('click', async () => {
    if (role !== 'manager') return;
    if (currentInvoices.length === 0) { alert('No invoices to export in the current view.'); return; }
    const from = document.getElementById('filterFrom').value || 'all';
    const to = document.getElementById('filterTo').value || 'dates';
    try {
      await buildAndDownloadInvoiceReport(currentInvoices, from, to);
    } catch (err) {
      console.error(err);
      alert('Could not build the report: ' + err.message);
    }
  });

  listBody.addEventListener('click', async (e) => {
    if (role !== 'manager') return;
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
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
    }
  });
}