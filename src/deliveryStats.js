// Pure delivery-analytics helpers: no Firebase, so they can be tested in plain Node.

export const OVERDUE_HOUR_OPTIONS = [12, 24, 48, 72];
export const DEFAULT_OVERDUE_HOURS = 24;

// ---- Pure helpers (no Firestore — easy to test) ----
export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v === 'number') return new Date(v);
  return null;
}

export function startOfToday(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
export function startOfWeek(now = new Date()) {         // Monday
  const d = startOfToday(now);
  const dow = (d.getDay() + 6) % 7;                      // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return d;
}
export function startOfMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
export function earliestNeededStart(now = new Date()) {
  const w = startOfWeek(now), m = startOfMonth(now);
  return w < m ? w : m;
}
export function periodStart(period, now = new Date()) {
  if (period === 'today') return startOfToday(now);
  if (period === 'week') return startOfWeek(now);
  return startOfMonth(now);
}

const areaOf = (o) => (o.customerLocation && o.customerLocation !== '-') ? o.customerLocation : 'Unknown area';

export function buildDeliveryStats({ delivered, failures, pending, now = new Date(), period = 'month', overdueHours = DEFAULT_OVERDUE_HOURS }) {
  const t0 = startOfToday(now), w0 = startOfWeek(now), m0 = startOfMonth(now);
  const p0 = periodStart(period, now);

  // --- per deliverer ---
  const byPerson = new Map();
  const person = (email) => {
    const key = (email || 'unknown').toLowerCase();
    if (!byPerson.has(key)) byPerson.set(key, { email: email || 'unknown', today: 0, week: 0, month: 0, failedPeriod: 0, hoursSum: 0, hoursCount: 0 });
    return byPerson.get(key);
  };
  delivered.forEach(o => {
    const at = toDate(o.deliveredAt);
    if (!at) return;
    const p = person(o.deliveredByEmail);
    if (at >= t0) p.today++;
    if (at >= w0) p.week++;
    if (at >= m0) p.month++;
    const inv = toDate(o.invoicedAt);
    if (inv && at >= m0 && at >= inv) { p.hoursSum += (at - inv) / 3_600_000; p.hoursCount++; }
  });
  const failuresInPeriod = failures.filter(f => { const at = toDate(f.at); return at && at >= p0; });
  failuresInPeriod.forEach(f => { person(f.byEmail).failedPeriod++; });
  const perDeliverer = [...byPerson.values()]
    .map(p => ({ ...p, avgHours: p.hoursCount ? p.hoursSum / p.hoursCount : null }))
    .sort((a, b) => b.month - a.month || a.email.localeCompare(b.email));

  // --- pending / overdue ---
  const pendingRows = pending.map(o => {
    const inv = toDate(o.invoicedAt) || toDate(o.createdAt);
    const ageHours = inv ? Math.max(0, (now - inv) / 3_600_000) : null;
    return { ...o, ageHours, overdue: ageHours !== null && ageHours >= overdueHours };
  }).sort((a, b) => (b.ageHours ?? -1) - (a.ageHours ?? -1));

  // --- by area (selected period) ---
  const byArea = new Map();
  const area = (name) => {
    if (!byArea.has(name)) byArea.set(name, { area: name, delivered: 0, failed: 0, pending: 0 });
    return byArea.get(name);
  };
  delivered.forEach(o => { const at = toDate(o.deliveredAt); if (at && at >= p0) area(areaOf(o)).delivered++; });
  failuresInPeriod.forEach(f => { area(f.area || 'Unknown area').failed++; });
  pendingRows.forEach(o => { area(areaOf(o)).pending++; });
  const perArea = [...byArea.values()].sort((a, b) => (b.delivered + b.pending + b.failed) - (a.delivered + a.pending + a.failed) || a.area.localeCompare(b.area));

  const deliveredInPeriod = delivered.filter(o => { const at = toDate(o.deliveredAt); return at && at >= p0; }).length;

  return {
    perDeliverer, perArea, pendingRows, failuresInPeriod,
    totals: {
      delivered: deliveredInPeriod,
      failed: failuresInPeriod.length,
      pending: pendingRows.length,
      overdue: pendingRows.filter(o => o.overdue).length,
    },
  };
}

export function formatAge(hours) {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return '<1 h';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
