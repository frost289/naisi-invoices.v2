import { esc } from "./ui.js";
import { mwk, round2 } from './money.js';
export { mwk };

let itemCounter = 0;

export function addItemRow(itemsBody, onChange, qty, desc, price, productName = null, packLabel = null, packQuantity = null, productId = null, locked = false) {
  itemCounter++;
  const tr = document.createElement('tr');
  tr.dataset.id = itemCounter;
  // Static markup only; every saved value is assigned as a DOM property below, so it can never be parsed as HTML.
  tr.innerHTML = `
    <td class="qty-col"><input type="number" min="0" step="1" class="qty-input"></td>
    <td>
      <input type="text" class="desc-input" placeholder="e.g. Angel Yeast 10g">
      <input type="hidden" class="product-name-input">
      <input type="hidden" class="pack-label-input">
      <input type="hidden" class="pack-quantity-input">
      <input type="hidden" class="product-id-input">
    </td>
    <td class="price-col"><input type="number" min="0" step="0.01" class="price-input" placeholder="0.00"></td>
    <td class="del-col">${locked ? '' : '<button type="button" class="del-btn" title="Remove item">&times;</button>'}</td>
  `;
  const setVal = (sel, v) => { tr.querySelector(sel).value = v ?? ''; };
  setVal('.qty-input', qty ?? 1); setVal('.desc-input', desc); setVal('.product-name-input', productName);
  setVal('.pack-label-input', packLabel); setVal('.pack-quantity-input', packQuantity); setVal('.product-id-input', productId); setVal('.price-input', price);
  if (locked) { tr.querySelector('.desc-input').readOnly = true; tr.querySelector('.price-input').readOnly = true; }
  itemsBody.appendChild(tr);
  tr.querySelectorAll('.qty-input, .desc-input, .price-input').forEach(inp => inp.addEventListener('input', onChange));
  if (!locked) {
    tr.querySelector('.del-btn').addEventListener('click', () => {
      tr.remove();
      onChange();
    });
  }
}

// Rebuilds rows from STORED items, keeping every field — including productId,
// which stock tracking depends on. (The edit screen used to drop it, turning
// tracked items into untracked ones on save.)
export function fillItemRows(itemsBody, items, onChange = () => {}, locked = false) {
  (items || []).forEach(it => addItemRow(
    itemsBody, onChange, it.qty, it.desc, it.price,
    it.productName ?? null, it.packLabel ?? null, it.packQuantity ?? null, it.productId ?? null, locked
  ));
}

export function buildQuickAddGrid(quickAddGrid, itemsBody, onChange, products, locked = false) {
  quickAddGrid.innerHTML = '';

  if (!products || products.length === 0) {
    quickAddGrid.innerHTML = `<p style="grid-column:1/-1; color:var(--muted); font-size:0.78rem;">No products in the catalog yet. A manager can add some in the Products tab.</p>`;
    return;
  }

  const groups = {};
  products.forEach(p => {
    if (!groups[p.productName]) groups[p.productName] = [];
    groups[p.productName].push(p);
  });

  Object.entries(groups).forEach(([productName, variants]) => {
    const groupLabel = document.createElement('div');
    groupLabel.className = 'quick-add-group-label';
    groupLabel.textContent = productName;
    quickAddGrid.appendChild(groupLabel);

    const groupWrap = document.createElement('div');
    groupWrap.className = 'quick-add-group';

    variants.forEach(p => {
      const stock = p.stockOnHand ?? 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'quick-add-btn';
      btn.innerHTML = `
        <span class="qa-name">${esc(p.productName)}</span>
        <span class="qa-pack">${esc(p.packLabel)} · Qty: ${esc(p.quantity ?? '—')}</span>
        <span class="qa-stock ${esc(stock <= 0 ? 'qa-stock-low' : '')}">Stock: ${esc(stock)}</span>
        <span class="qa-price">${esc(mwk(p.price))}</span>
      `;
      btn.addEventListener('click', () => {
        addItemRow(itemsBody, onChange, 1, `${p.productName} — ${p.packLabel}`, p.price, p.productName, p.packLabel, p.quantity, p.id, locked);
        onChange();
      });
      groupWrap.appendChild(btn);
    });

    quickAddGrid.appendChild(groupWrap);
  });
}

export function getItems(itemsBody) {
  const rows = itemsBody.querySelectorAll('tr');
  const items = [];
  rows.forEach(row => {
    const qty = parseFloat(row.querySelector('.qty-input').value) || 0;
    const desc = row.querySelector('.desc-input').value.trim();
    const price = parseFloat(row.querySelector('.price-input').value) || 0;
    const productName = row.querySelector('.product-name-input')?.value || '';
    const packLabel = row.querySelector('.pack-label-input')?.value || '';
    const packQuantityRaw = row.querySelector('.pack-quantity-input')?.value || '';
    const productId = row.querySelector('.product-id-input')?.value || '';
    if (desc || qty || price) {
      items.push({
        qty, desc, price, total: round2(qty * price),
        productName: productName || null,
        packLabel: packLabel || null,
        packQuantity: packQuantityRaw !== '' ? parseFloat(packQuantityRaw) : null,
        productId: productId || null,
        // A row without a catalogue product is, by being typed in, an EXPLICIT custom line (freight, discount...). Rep screens refuse these.
        ...(productId ? {} : { custom: true }),
      });
    }
  });
  return items;
}
