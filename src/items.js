export const PRODUCTS = [
  { name: 'Angel Instant Dry Yeast', pack: 'Box (25 × 10g Sachets)', price: 10500 },
  { name: 'Angel Instant Dry Yeast', pack: 'Case (12 Boxes)', price: 114000 },
  { name: 'Bakerdream Instant Dry Yeast', pack: '1 × 450g Pack', price: 8000 },
  { name: 'Bakerdream Instant Dry Yeast', pack: 'Case (20 Packs)', price: 153000 },
];

export function mwk(n) {
  return 'MWK ' + (n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let itemCounter = 0;

export function addItemRow(itemsBody, onChange, qty, desc, price) {
  itemCounter++;
  const tr = document.createElement('tr');
  tr.dataset.id = itemCounter;
  tr.innerHTML = `
    <td class="qty-col"><input type="number" min="0" step="1" class="qty-input" value="${qty ?? 1}"></td>
    <td><input type="text" class="desc-input" placeholder="e.g. Angel Yeast 10g" value="${desc ?? ''}"></td>
    <td class="price-col"><input type="number" min="0" step="0.01" class="price-input" value="${price ?? ''}" placeholder="0.00"></td>
    <td class="del-col"><button type="button" class="del-btn" title="Remove item">&times;</button></td>
  `;
  itemsBody.appendChild(tr);
  tr.querySelectorAll('input').forEach(inp => inp.addEventListener('input', onChange));
  tr.querySelector('.del-btn').addEventListener('click', () => {
    tr.remove();
    onChange();
  });
}

export function buildQuickAddGrid(quickAddGrid, itemsBody, onChange) {
  PRODUCTS.forEach(p => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'quick-add-btn';
    btn.innerHTML = `
      <span class="qa-name">${p.name}</span>
      <span class="qa-pack">${p.pack}</span>
      <span class="qa-price">${mwk(p.price)}</span>
    `;
    btn.addEventListener('click', () => {
      addItemRow(itemsBody, onChange, 1, `${p.name} — ${p.pack}`, p.price);
      onChange();
    });
    quickAddGrid.appendChild(btn);
  });
}

export function getItems(itemsBody) {
  const rows = itemsBody.querySelectorAll('tr');
  const items = [];
  rows.forEach(row => {
    const qty = parseFloat(row.querySelector('.qty-input').value) || 0;
    const desc = row.querySelector('.desc-input').value.trim();
    const price = parseFloat(row.querySelector('.price-input').value) || 0;
    if (desc || qty || price) items.push({ qty, desc, price, total: qty * price });
  });
  return items;
}