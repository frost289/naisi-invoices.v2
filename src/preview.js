import { mwk, getItems } from './items.js';

export function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

export function updatePreview(els) {
  const invoiceNo = els.invoiceNo.value || '—';
  const date = els.invoiceDate.value;
  const customer = els.custName.value || '—';
  const phone = els.custPhone.value || '—';
  const location = els.custLocation.value || '—';
  const terms = els.terms.value;
  const providerPhone = els.providerPhone.value.trim();

  els.pvProviderPhone.textContent = providerPhone ? ('Tel: ' + providerPhone) : '';
  els.pvInvoiceNo.textContent = invoiceNo;
  els.pvDate.textContent = formatDate(date);
  els.pvCustomer.textContent = customer;
  els.pvPhone.textContent = phone;
  els.pvLocation.textContent = location;
  els.pvTerms.textContent = terms;

  const items = getItems(els.itemsBody);
  els.pvItemsBody.innerHTML = '';
  let grandTotal = 0;
  items.forEach(it => {
    grandTotal += it.total;
    const tr = document.createElement('tr');
    const cell = (text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; return td; };
    tr.append(cell(String(it.qty)), cell(it.desc || '—'), cell(mwk(it.price), 'num'), cell(mwk(it.total), 'num'));
    els.pvItemsBody.appendChild(tr);
  });
  if (items.length === 0) {
    els.pvItemsBody.innerHTML = `<tr><td colspan="4" style="color:var(--muted); font-style:italic;">No items added yet</td></tr>`;
  }
  els.pvGrandTotal.textContent = mwk(grandTotal);
  return { items, grandTotal };
}