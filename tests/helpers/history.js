// Test helpers for the dated schedule history (src/scheduleHistory.js).
const Ts = (ms) => ({ toMillis: () => ms });
export const tsOn = (date, hhmmUtc = '08:00') => Ts(Date.parse(`${date}T${hhmmUtc}:00Z`));

// History that began on `startDate`, with one baseline entry per customer = its schedule as given.
export function baselineHistory(customers, startDate = '2020-01-01') {
  return {
    config: { startedAt: tsOn(startDate, '06:00') },
    changes: customers.map(c => ({
      id: 'base_' + c.id, customerId: c.id, customerName: c.name, kind: 'baseline',
      active: c.active !== false, assignedDay: c.assignedDay || null, createdAt: tsOn(startDate, '06:05'),
    })),
    merges: [],
  };
}
// One later change (schedule/deactivate/reactivate), saved by the server on `date`.
export function change(id, customerId, kind, { active = true, assignedDay = null, date, time = '09:00', name = customerId } = {}) {
  return { id, customerId, customerName: name, kind, active, assignedDay, createdAt: tsOn(date, time) };
}
