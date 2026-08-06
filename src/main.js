import './style.css';
import { LOGO_DATA_URI } from './logo.js';
import { auth, db } from './firebase.js';
import { watchAuth, login } from './auth.js';
import { addItemRow, buildQuickAddGrid, getItems, mwk } from './items.js';
import { updatePreview, formatDate } from './preview.js';
import { loadCounterState, buildInvoiceNo, incrementCounterAtomically, savePrefixYear } from './numbering.js';
import { generatePdf } from './pdf.js';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';

const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('appRoot');

watchAuth(
  (user) => { loginScreen.style.display = 'none'; appRoot.style.display = 'block'; initApp(user); },
  () => { loginScreen.style.display = 'block'; appRoot.style.display = 'none'; }
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

async function initApp(user) {
  if (appInitialized) return;
  appInitialized = true;

  document.getElementById('topbarLogo').src = LOGO_DATA_URI;
  document.getElementById('previewLogo').src = LOGO_DATA_URI;

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

  // --- Generate PDF, log invoice, increment counter ---
  document.getElementById('generateBtn').addEventListener('click', async () => {
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

      const { grandTotal } = generatePdf(meta);

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
    } catch (err) {
      console.error(err);
      alert('Could not generate the PDF: ' + err.message);
    }
  });
}