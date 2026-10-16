// Fake data only.
const pinned = { lat: -13.98, lng: 33.78 };
export const THU = '2026-10-15T08:00:00Z';   // Thursday 10:00 in Malawi
const HISTORY_START = Date.parse('2026-01-01T06:00:00Z');   // the dated schedule history began long before the test dates
export function seedData({ history = true } = {}) {
  const c = (name, over = {}) => ({ name, phone: '0999000000', location: 'Area 25', active: true, assignedDay: 'Thu', ...pinned, ...over });
  const p = (name, price) => ({ productName: name, packLabel: 'Strip', quantity: 1, price, stockOnHand: 500 });
  const seed = {
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
  if (history) {
    const data = seed;
    data['config/scheduleHistory'] = { startedAt: { __ts: HISTORY_START }, startedBy: 'u_mgr', startedByEmail: 'mgr@naisi.test', baselineCount: 6 };
    for (const [k, c] of Object.entries(data)) {
      if (!k.startsWith('customers/')) continue;
      const id = k.slice('customers/'.length);
      data['scheduleChanges/base_' + id] = { customerId: id, customerName: c.name, kind: 'baseline', active: c.active !== false, assignedDay: c.assignedDay || null, changedBy: 'u_mgr', changedByEmail: 'mgr@naisi.test', createdAt: { __ts: HISTORY_START + 300000 } };
    }
  }
  return seed;
}
