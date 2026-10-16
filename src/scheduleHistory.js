// Dated schedule history: what each customer's weekly visit day / active state WAS on any past date.
//
// WHY: reports must show the targets that applied at the time. Later scheduling, deactivation, reactivation or
// merges must never rewrite last month's targets or percentages.
//
// WHAT IS STORED (all append-only, written ONLY together with the customer change they describe; see the rules):
//   scheduleChanges/{id}  customerId, customerName, kind (baseline|schedule|deactivate|reactivate), active,
//                         assignedDay (Mon..Sat|null), changedBy, changedByEmail, createdAt (SERVER time)
//   customerMerges/{mergedCustomerId}  keepId, mergedAt (SERVER time) ...
//   config/scheduleHistory  startedAt (SERVER time) - the day the history began
//
// WHEN A CHANGE TAKES EFFECT (documented rule, see docs/SCHEDULE-HISTORY.md):
//   A change applies from the START of the Malawi calendar day on which the server saved it, for that whole day and every
//   later day, until the next change. Earlier days keep what applied before. So a change made at 14:00 on Wednesday also
//   changes Wednesday's target; Tuesday and earlier are untouched. The date comes from the SERVER time of the change
//   (createdAt), never from a phone's clock. Several changes on the same day: the last one decides that day.
//
// OLDER DATA: dates before the history began have NO reliable schedule. Reports show that limitation and
// do not calculate targets or percentages for those dates (nothing is estimated from today's schedule).
import { malawiDate, weekdayOfDate, datesInRange } from './malawiTime.js';

export const CHANGE_KINDS = ['baseline', 'schedule', 'deactivate', 'reactivate'];

const tsMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis() : (typeof t === 'number' ? t : null));
export const malawiDateOfTimestamp = (t) => { const ms = tsMs(t); return ms === null ? null : malawiDate(new Date(ms)); };

// The Malawi date the history began (null when it has not been started).
export function historyStartDate(config) {
  return config ? malawiDateOfTimestamp(config.startedAt) : null;
}

// Malawi date a change takes effect. A baseline is effective from the history start date.
export function effectiveDateOf(change, startDate) {
  if (change.kind === 'baseline') return startDate;
  return malawiDateOfTimestamp(change.createdAt);
}

// config: { startedAt } | null ; changes: scheduleChanges docs ; merges: customerMerges docs ({ id = merged customer id, keepId, mergedAt })
export function buildScheduleIndex({ config = null, changes = [], merges = [] } = {}) {
  const startDate = historyStartDate(config);
  const byCustomer = new Map();
  for (const ch of changes) {
    const eff = effectiveDateOf(ch, startDate);
    if (!eff) continue;                       // a change without a usable date is ignored, never guessed
    const list = byCustomer.get(ch.customerId) || [];
    list.push({ ...ch, eff, ms: tsMs(ch.createdAt) ?? 0 });
    byCustomer.set(ch.customerId, list);
  }
  for (const list of byCustomer.values()) {
    list.sort((a, b) => (a.eff < b.eff ? -1 : a.eff > b.eff ? 1 : (a.ms - b.ms) || (a.id < b.id ? -1 : 1)));
  }
  const mergeInto = new Map();
  for (const m of merges) mergeInto.set(m.id, { keepId: m.keepId, date: malawiDateOfTimestamp(m.mergedAt) });
  return { startDate, byCustomer, mergeInto };
}

// Follow merges: a customer merged into another (possibly several times) resolves to the surviving customer.
export function resolveCustomerId(index, id) {
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const m = index.mergeInto.get(cur);
    if (!m) return cur;
    cur = m.keepId;
  }
  return cur;
}

// The state of one customer at the END of the given Malawi date, or null when no change had happened by then.
export function customerStateAt(index, customerId, date) {
  const list = index.byCustomer.get(customerId);
  if (!list) return null;
  let state = null;
  for (const ch of list) { if (ch.eff <= date) state = ch; else break; }
  if (!state) return null;
  // A customer that was merged away stops being a target from the day of the merge (the surviving customer takes over).
  const m = index.mergeInto.get(customerId);
  if (m && m.date && m.date <= date) return { active: false, assignedDay: null, customerName: state.customerName, mergedAway: true };
  return { active: state.active !== false, assignedDay: state.assignedDay ?? null, customerName: state.customerName, mergedAway: false };
}

// Targets for one date. reliable=false when the history did not exist yet on that date (no targets are produced then).
export function targetsForDate(index, date) {
  if (!index.startDate || date < index.startDate) {
    return { reliable: false, reason: index.startDate ? `Schedule history began on ${index.startDate}` : 'Schedule history has not been started', targets: [] };
  }
  const weekday = weekdayOfDate(date);
  const seen = new Map();
  for (const customerId of index.byCustomer.keys()) {
    const st = customerStateAt(index, customerId, date);
    if (!st || !st.active || st.assignedDay !== weekday) continue;
    const key = resolveCustomerId(index, customerId);   // two shops merged later count once
    if (!seen.has(key)) seen.set(key, { customerId: key, customerName: st.customerName, originalCustomerId: customerId });
  }
  return { reliable: true, reason: null, targets: [...seen.values()] };
}

// Customers whose CURRENT schedule does not match the last history entry: a sign that the schedule was changed
// without a history entry (a write that bypassed the app). Reports should warn about these.
export function findScheduleMismatches(index, customers) {
  if (!index.startDate) return [];
  const out = [];
  for (const c of customers || []) {
    if (c.mergeLock) continue;
    const list = index.byCustomer.get(c.id);
    const last = list && list[list.length - 1];
    const curActive = c.active !== false, curDay = c.assignedDay ?? null;
    if (!last) { if (curDay !== null || !curActive) out.push({ id: c.id, name: c.name, why: 'has a schedule or is inactive but has no history entry' }); continue; }
    if ((last.active !== false) !== curActive || (last.assignedDay ?? null) !== curDay) out.push({ id: c.id, name: c.name, why: 'current schedule differs from its last history entry' });
  }
  return out;
}

// The customer list for managers: active customers that have no visit day yet.
export function awaitingScheduling(customers) {
  return (customers || []).filter(c => c.active !== false && !c.assignedDay && !c.mergeLock);
}

export { datesInRange };
