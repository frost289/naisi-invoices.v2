// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
const { fillItemRows, getItems } = await import('../../src/items.js');
describe('edit-order rows keep productId', () => {
  it('fillItemRows -> getItems round trip preserves productId, pack info', () => {
    document.body.innerHTML = '<table><tbody id="b"></tbody></table>';
    const body = document.getElementById('b');
    const src = [{ qty: 2, desc: 'Amanda 100g', price: 100, total: 200, productId: 'p1', productName: 'Amanda', packLabel: 'Strip', packQuantity: 10 }];
    fillItemRows(body, src);
    const out = getItems(body);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe('p1');
    expect(out[0].qty).toBe(2);
  });
  it('untracked (typed) lines stay untracked', () => {
    document.body.innerHTML = '<table><tbody id="b"></tbody></table>';
    const body = document.getElementById('b');
    fillItemRows(body, [{ qty: 1, desc: 'Delivery', price: 500, total: 500 }]);
    expect(getItems(body)[0].productId || null).toBeNull();
  });
});
