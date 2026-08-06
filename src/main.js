import './style.css';
import { LOGO_DATA_URI } from './logo.js';
import { auth, db } from './firebase.js';
import { watchAuth, login } from './auth.js';
import { getUserRole } from './roles.js';
import { addItemRow, buildQuickAddGrid, getItems, mwk } from './items.js';
import { updatePreview, formatDate } from './preview.js';
import { loadCounterState, buildInvoiceNo, incrementCounterAtomically, savePrefixYear } from './numbering.js';
import { generatePdf } from './pdf.js';
import { fetchMyInvoices, fetchAllInvoices, fetchInvoiceById, updateInvoice } from './invoices.js';
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

  // --- Button text depends on role, set once up front ---
  if (role === 'submitter') {
    generateBtn.textContent = 'Submit Invoice';
    generateNote.textContent = 'Saves this invoice. A manager will handle printing/downloading it.';
  } else {
    generateBtn.textContent = 'Download PDF Invoice';
    generateNote.textContent = 'Generates a print-ready PDF, logs the invoice to Firestore, and increments the counter.';
  }

  function refreshPreview() { updatePreview(els); }

  // --- Items ---
  buildQuickAddGrid(quickAddGrid, itemsBody, refreshPreview);
  document.getElementById('addItemBtn').addEventListener('click', () => {
    addItemRow(itemsBody, refreshPreview, 1, '', '');
    refreshPreview();
  });

  // --- Numbering (Firestore) ---
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

  // --- Init date + first preview ---
  const today = new Date();
  els.invoiceDate.value = today.toISOString().slice(0, 10);
  refreshPreview();

  ['invoiceDate', 'custName', 'custPhone', 'custLocation', 'terms', 'providerPhone', 'notes'].forEach(id => {
    document.getElementById(id).addEventListener('input', refreshPreview);
    document.getElementById(id).addEventListener('change', refreshPreview);
  });

  // --- Enter edit mode with an existing invoice's data (manager only, but harmless if called) ---
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
    (inv.items || []).forEach(it => {
      addItemRow(itemsBody, refreshPreview, it.qty, it.desc, it.price);
    });

    editingInvoiceId = inv.id;
    editingInvoiceNoLabel.textContent = inv.invoiceNo;
    editingBanner.style.display = 'block';
    generateBtn.textContent = 'Save Changes';
    generateNote.textContent = 'Updates this invoice in place. Does not change the invoice number or counter.';

    refreshPreview();
    document.querySelector('.panel').scrollIntoView({ behavior: 'smooth' });
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

  cancelEditBtn.addEventListener('click', (e) => {
    e.preventDefault();
    exitEditMode();
  });

  // --- Generate / Save ---
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

      // Only managers ever trigger a PDF/file download from this button.
      // Submitters just save the record — no generatePdf() call at all.
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
          ...meta,
          grandTotal,
          createdBy: user.uid,
          createdAt: serverTimestamp(),
        });
        const { next } = await incrementCounterAtomically();
        document.getElementById('invCounter').value = next.counter;
        refreshInvoiceNoField();
        refreshPreview();
      }

      await renderInvoiceList();
    } catch (err) {
      console.error(err);
      alert('Could not save the invoice: ' + err.message);
    }
  });

  // --- Invoice list (role-dependent) ---
  const listSection = document.getElementById('invoiceListSection');
  const listTitle = document.getElementById('listTitle');
  const listHead = document.getElementById('invoiceListHead');
  const listBody = document.getElementById('invoiceListBody');
  const listEmpty = document.getElementById('invoiceListEmpty');

  async function renderInvoiceList() {
    listSection.style.display = 'block';
    let invoices;

    if (role === 'manager') {
      listTitle.textContent = 'All Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th><th></th></tr>`;
      invoices = await fetchAllInvoices();
    } else {
      listTitle.textContent = 'My Submitted Invoices';
      listHead.innerHTML = `<tr><th>Invoice No.</th><th>Date</th><th>Customer</th><th>Total</th></tr>`;
      invoices = await fetchMyInvoices(user.uid);
    }

    listBody.innerHTML = '';
    listEmpty.style.display = invoices.length === 0 ? 'block' : 'none';

    invoices.forEach(inv => {
      const tr = document.createElement('tr');
      const baseCells = `
        <td>${inv.invoiceNo}</td>
        <td>${formatDate(inv.date)}</td>
        <td>${inv.customer}</td>
        <td>${mwk(inv.grandTotal || 0)}</td>
      `;
      // Edit/Download buttons ONLY render for managers. Submitters get
      // a read-only row, no action column at all.
      if (role === 'manager') {
        tr.innerHTML = baseCells + `
          <td>
            <button type="button" class="list-action-btn" data-action="edit" data-id="${inv.id}">Edit</button>
            <button type="button" class="list-action-btn" data-action="download" data-id="${inv.id}">Download</button>
          </td>
        `;
      } else {
        tr.innerHTML = baseCells;
      }
      listBody.appendChild(tr);
    });
  }

  listBody.addEventListener('click', async (e) => {
    // Extra guard: even if something rendered a button unexpectedly,
    // non-managers can't act on it.
    if (role !== 'manager') return;

    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const inv = await fetchInvoiceById(id);
    if (!inv) return;

    if (btn.dataset.action === 'edit') {
      populateFormFromInvoice(inv);
    } else if (btn.dataset.action === 'download') {
      generatePdf({
        invoiceNo: inv.invoiceNo,
        date: inv.date,
        customer: inv.customer,
        phone: inv.phone,
        location: inv.location,
        terms: inv.terms,
        providerPhone: inv.providerPhone,
        notes: inv.notes,
        items: inv.items || [],
      });
    }
  });

  await renderInvoiceList();
}