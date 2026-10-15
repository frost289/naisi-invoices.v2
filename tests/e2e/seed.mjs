// Fake data only.
const pinned = { lat: -13.98, lng: 33.78 };
export const THU = '2026-10-15T08:00:00Z';   // Thursday 10:00 in Malawi
export function seedData() {
  const c = (name, over = {}) => ({ name, phone: '0999000000', location: 'Area 25', active: true, assignedDay: 'Thu', ...pinned, ...over });
  const p = (name, price) => ({ productName: name, packLabel: 'Strip', quantity: 1, price, stockOnHand: 500 });
  return {
    'config/roles': { managers: ['mgr@naisi.test'], submitters: ['rep1@naisi.test', 'rep2@naisi.test', 'rep3@naisi.test'], deliverers: [] },
    'users/u_rep1': { name: 'Rep One', email: 'rep1@naisi.test' },
    'users/u_rep2': { name: 'Rep Two', email: 'rep2@naisi.test' },
    'users/u_rep3': { name: 'Rep Three', email: 'rep3@naisi.test' },
    'customers/c1': c('Alpha Shop'),
    'customers/c2': c('Bravo Shop'),
    'customers/c3': c('Charlie Shop'),
    'customers/c4': c('Delta Inactive', { active: false, assignedDay: null }),
    'customers/c5': c('Echo Friday', { assignedDay: 'Fri' }),
    'customers/c6': c('Foxtrot No Pin', { lat: null, lng: null }),
    'products/p1': p('Amanda 100g', 1000),
    'products/p2': p('Amanda 250g', 2200),
    'orderCounters/naisiOrder': { counter: 41 },
    'counters/naisiInvoice': { prefix: 'NF-INV', counter: 370 },
  };
}
