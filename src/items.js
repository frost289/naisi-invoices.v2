export function mwk(n) {
  return 'MWK ' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let itemCounter = 0;

export function addItemRow(itemsBody, onChange, qty, desc, price, productName = null, packLabel = null, packQuantity = null, productId = null) {
  itemCounter++;
  const tr = document.createElement('tr');
  tr.dataset.id = itemCounter;
  tr.innerHTML = `
    <td class="qty-col"><input type="number" min="0" step="1" class="qty-input" value="${qty ?? 1}"></td>
    <td>
      <input type="text" class="desc-input" placeholder="e.g. Angel Yeast 10g" value="${desc ?? ''}">
      <input type="hidden" class="product-name-input" value="${productName ?? ''}">
      <input type="hidden" class="pack-label-input" value="${packLabel ?? ''}">
      <input type="hidden" class="pack-quantity-input" value="${packQuantity ?? ''}">
      <input type="hidden" class="product-id-input" value="${productId ?? ''}">
    </td>
    <td class="price-col"><input type="number" min="0" step="0.01" class="price-input" value="${price ?? ''}" placeholder="0.00"></td>
    <td class="del-col"><button type="button" class="del-btn" title="Remove item">&times;</button></td>
  `;
  itemsBody.appendChild(tr);
  tr.querySelectorAll('.qty-input, .desc-input, .price-input').forEach(inp => inp.addEventListener('input', onChange));
  tr.querySelector('.del-btn').addEventListener('click', () => {
    tr.remove();
    onChange();
  });
}

export function buildQuickAddGrid(quickAddGrid, itemsBody, onChange, products) {
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
        <span class="qa-name">${p.productName}</span>
        <span class="qa-pack">${p.packLabel} · Qty: ${p.quantity ?? '—'}</span>
        <span class="qa-stock ${stock <= 0 ? 'qa-stock-low' : ''}">Stock: ${stock}</span>
        <span class="qa-price">${mwk(p.price)}</span>
      `;
      btn.addEventListener('click', () => {
        addItemRow(itemsBody, onChange, 1, `${p.productName} — ${p.packLabel}`, p.price, p.productName, p.packLabel, p.quantity, p.id);
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
        qty, desc, price, total: qty * price,
        productName: productName || null,
        packLabel: packLabel || null,
        packQuantity: packQuantityRaw !== '' ? parseFloat(packQuantityRaw) : null,
        productId: productId || null,
      });
    }
  });
  return items;
}
