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
// MERGES (finding 4): a merge is dated like any other change. From the merge day the merged-away shop is no longer a target and the
//   survivor is. Before the merge day both shops are SEPARATE targets, exactly as they were, so a merge made today cannot change an
//   earlier date. The merge re-points visits to the survivor, so each re-pointed visit keeps the shop it was recorded against in
//   `originalCustomerId` (set once, never overwritten), and the customerMerges record says `visitsKeepOriginal: true`. A visit's shop on a date = its original shop followed forward through the
//   merges that had happened by that date. Merges done BEFORE originalCustomerId existed cannot be told apart afterwards: such a
//   visit (made before a merge that moved visits, and re-pointed to the survivor) is AMBIGUOUS, is never credited to any shop, and is
//   reported (see visitIdentityAt and docs/SCHEDULE-HISTORY.md).
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
  for (const m of merges) mergeInto.set(m.id, { keepId: m.keepId, date: malawiDateOfTimestamp(m.mergedAt), movedVisits: (m.moved && typeof m.moved.visits === 'number') ? m.moved.visits : null, keepsOriginal: m.visitsKeepOriginal === true });
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

// Date-aware: follow only the merges that had already happened on `date` (merge day included). A merge with no usable date is ignored, never guessed.
export function resolveCustomerIdAt(index, id, date) {
  let cur = id;
  for (let i = 0; i < 50; i++) {
    const m = index.mergeInto.get(cur);
    if (!m || !m.date || m.date > date) return cur;
    cur = m.keepId;
  }
  return cur;
}

// Which shop a recorded visit belongs to, as of the visit's own date.
//   { id, ambiguous:false }                       the shop (original shop followed through the merges done by the visit date)
//   { id:null, ambiguous:true, candidates:[ids] } a visit that a LEGACY merge (made before origins were kept) re-pointed after the visit was recorded
//
// PROVENANCE (RC5): originalCustomerId proves only "the shop this visit pointed at when a merge that KEEPS origins moved it". It cannot recover what an
// EARLIER legacy merge already lost. So the legacy-ambiguity test always runs, on the best starting point we have: the stamp if there is one,
// else the visit's current shop. Example: legacy b->a (14th, origins not kept), then a new a->c (18th) stamps originalCustomerId=a on a visit of the 8th.
// The stamp says "a", but that visit may really have been b's: it stays AMBIGUOUS between a and b. A visit recorded on or after the legacy merge date,
// or a legacy merge that moved no visits, creates no uncertainty.
export function visitIdentityAt(index, visit) {
  const X = visit.originalCustomerId || visit.customerId;
  // shops that were merged (directly or through a chain) into X, but only AFTER this visit's date, by a merge that did not keep origins and moved visits (or unknown count)
  const candidates = [];
  for (const [y, m] of index.mergeInto) {
    if (!m.date || m.date <= visit.date || m.movedVisits === 0 || m.keepsOriginal) continue;   // a merge made by the current app stamped every visit it moved
    let cur = y, ok = false;
    for (let i = 0; i < 50 && cur; i++) { const next = index.mergeInto.get(cur); if (!next) break; if (next.keepId === X) { ok = true; break; } cur = next.keepId; }
    if (ok) candidates.push(y);
  }
  if (!candidates.length) return { id: resolveCustomerIdAt(index, X, visit.date), ambiguous: false, candidates: [] };
  return { id: null, ambiguous: true, candidates: [X, ...candidates] };
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
    // Each shop is its own target on this date. A shop merged away stops being a target from its merge day (customerStateAt),
    // so a LATER merge never changes an earlier date.
    if (!seen.has(customerId)) seen.set(customerId, { customerId, customerName: st.customerName });
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
