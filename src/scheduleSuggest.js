// Distance-based schedule SUGGESTIONS (manager tool). PURE: no Firestore, no clock, deterministic.
//
// What it does: proposes which weekday each shop should be visited on so that shops visited on the same day are close together
// and the days are roughly equal in size. It NEVER changes anything: the manager reviews the proposal and applies it through the
// normal dated schedule-change path (customers.js), so history, rules and "effective from the start of the Malawi day" are unchanged.
//
// Honest limits (shown to the manager): distances are STRAIGHT-LINE (real roads are longer, and the ratio varies); shops without a map
// pin cannot be placed and are listed, never guessed; the result is a good starting plan, not a proven optimum.
import { haversineKm, orderStops } from './routing.js';

export const DEFAULT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hasPin = (c) => c && typeof c.lat === 'number' && typeof c.lng === 'number' && isFinite(c.lat) && isFinite(c.lng)
  && c.lat >= -90 && c.lat <= 90 && c.lng >= -180 && c.lng <= 180;
const eligible = (c) => c && c.active !== false && !c.mergeLock;          // closed shops and shops being merged are never planned

const centroid = (pts) => pts.length ? { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length } : null;
// Average distance to the m nearest members: robust when a day's group is spread over two areas (a plain centroid would sit in between).
function nearnessKm(p, members, m = 3) {
  if (!members.length) return Infinity;
  const d = members.map(q => haversineKm(p, q)).sort((a, b) => a - b).slice(0, m);
  return d.reduce((s, x) => s + x, 0) / d.length;
}
const byIdThenName = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Approximate working distance of one day: an open route through that day's shops (same ordering code the reps' route screen uses).
export function dayRouteKm(points) {
  if (points.length < 2) return 0;
  if (points.length > 150) return null;                      // too many stops to estimate quickly: say so rather than guess
  const c = centroid(points);
  const startIdx = points.reduce((best, p, i) => (haversineKm(c, p) < haversineKm(c, points[best]) ? i : best), 0);
  const rest = points.filter((_, i) => i !== startIdx);
  return orderStops(points[startIdx], rest).totalKm;
}

function routeStats(days, groups) {
  const perDay = days.map(d => ({ day: d, count: groups[d].length, km: dayRouteKm(groups[d]) }));
  const known = perDay.every(x => x.km !== null);
  return { perDay, totalKm: known ? perDay.reduce((s, x) => s + x.km, 0) : null };
}

// Capacity-limited assignment: shops with the most to lose (largest gap between best and second-best day) choose first.
function assignWithCapacity(points, days, costOf, capacityOf) {
  const load = Object.fromEntries(days.map(d => [d, 0]));
  const out = new Map();
  const costs = points.map(p => ({ p, c: days.map(d => costOf(p, d)) }));
  const regret = (row) => { const s = row.c.filter(isFinite).sort((a, b) => a - b); return s.length > 1 ? s[1] - s[0] : (s.length ? Infinity : 0); };
  costs.sort((a, b) => regret(b) - regret(a) || byIdThenName(a.p, b.p));
  for (const row of costs) {
    const order = days.map((d, i) => ({ d, c: row.c[i] })).sort((a, b) => a.c - b.c || days.indexOf(a.d) - days.indexOf(b.d));
    const pick = order.find(o => load[o.d] < capacityOf(o.d)) || order.reduce((best, o) => (load[o.d] < load[best.d] ? o : best), order[0]);
    out.set(row.p.id, pick.d); load[pick.d]++;
  }
  return out;
}

// scope 'unscheduled' (default, low risk): only shops with NO day are placed, next to the shops already on each day. Nothing existing moves.
// scope 'all': re-plans every eligible shop (shows exactly which shops would move; the manager can untick any).
export function suggestSchedule(customers, { days = DEFAULT_DAYS, scope = 'unscheduled', tolerance = 0.15 } = {}) {
  const useDays = DEFAULT_DAYS.filter(d => days.includes(d));
  if (!useDays.length) throw new Error('Choose at least one visit day.');
  const all = customers.filter(eligible);
  const skipped = all.filter(c => !hasPin(c) && (scope === 'all' || !c.assignedDay)).map(c => ({ id: c.id, name: c.name || '', reason: 'no-pin' }))
    .sort(byIdThenName);
  const pinned = all.filter(hasPin).map(c => ({ id: c.id, name: c.name || '', lat: c.lat, lng: c.lng, from: c.assignedDay || null }));
  const currentGroups = Object.fromEntries(DEFAULT_DAYS.map(d => [d, pinned.filter(p => p.from === d)]));
  const before = routeStats(DEFAULT_DAYS.filter(d => currentGroups[d].length), currentGroups);

  let target = new Map();                                       // id -> suggested day
  if (scope === 'all') {
    const pts = pinned.slice().sort(byIdThenName);
    const k = useDays.length;
    if (pts.length) {
      const cap = Math.max(1, Math.ceil(pts.length / k * (1 + tolerance)));
      // deterministic farthest-point seeding, then balanced reassignment until stable
      let seeds = [pts[0]];
      while (seeds.length < Math.min(k, pts.length)) {
        let far = null, farD = -1;
        for (const p of pts) { const d = Math.min(...seeds.map(s => haversineKm(p, s))); if (d > farD + 1e-12) { farD = d; far = p; } }
        seeds.push(far);
      }
      let centers = seeds.map(s => ({ lat: s.lat, lng: s.lng }));
      const idx = Array.from({ length: centers.length }, (_, i) => i);
      let assign = new Map();
      for (let it = 0; it < 40; it++) {
        const asg = assignWithCapacity(pts, idx, (p, i) => haversineKm(p, centers[i]), () => cap);
        const next = idx.map(i => centroid(pts.filter(p => asg.get(p.id) === i)) || centers[i]);
        const same = [...asg].every(([id, g]) => assign.get(id) === g);
        assign = asg; centers = next;
        if (same) break;
      }
      // name the clusters with weekdays so that as few shops as possible change day (tries every mapping; k <= 6)
      const groupsIdx = idx.map(i => pts.filter(p => assign.get(p.id) === i));
      let bestPerm = null, bestKeep = -1;
      const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms(arr.slice(0, i).concat(arr.slice(i + 1))).map(r => [x, ...r]));
      for (const perm of perms(useDays.slice(0, idx.length))) {
        const keep = groupsIdx.reduce((s, g, i) => s + g.filter(p => p.from === perm[i]).length, 0);
        if (keep > bestKeep) { bestKeep = keep; bestPerm = perm; }
      }
      groupsIdx.forEach((g, i) => g.forEach(p => target.set(p.id, bestPerm[i])));
    }
  } else {
    const fresh = pinned.filter(p => !p.from).sort(byIdThenName);
    const base = Object.fromEntries(useDays.map(d => [d, currentGroups[d].map(p => ({ lat: p.lat, lng: p.lng }))]));
    const total = fresh.length + useDays.reduce((s, d) => s + base[d].length, 0);
    // A day may grow up to 15% above the average OR up to the size of the busiest day that already exists, whichever is larger:
    // a shop is never sent across town just because the plan was already uneven before it arrived.
    let cap = Math.max(1, Math.ceil(total / useDays.length * (1 + tolerance)), ...useDays.map(d => base[d].length));
    const room = () => useDays.reduce((s, d) => s + Math.max(0, cap - base[d].length), 0);
    while (room() < fresh.length) cap++;                           // never refuse to place a shop just because the days are full
    // place in rounds so each shop sees the shops already placed before it (clusters of new shops stay together)
    const placed = new Map(); const growing = Object.fromEntries(useDays.map(d => [d, base[d].slice()]));
    let pending = fresh.slice();
    while (pending.length) {
      const asg = assignWithCapacity(pending.slice(0, 1), useDays, (p, d) => nearnessKm(p, growing[d]), (d) => cap - growing[d].length);
      const [p] = pending; const d = asg.get(p.id);
      placed.set(p.id, d); growing[d].push({ lat: p.lat, lng: p.lng }); pending = pending.slice(1);
    }
    target = placed;
  }

  const changes = pinned.filter(p => target.has(p.id)).map(p => ({ id: p.id, name: p.name, from: p.from, to: target.get(p.id), changed: p.from !== target.get(p.id) }))
    .sort((a, b) => (a.to === b.to ? (a.name < b.name ? -1 : 1) : useDays.indexOf(a.to) - useDays.indexOf(b.to)));
  const afterGroups = Object.fromEntries(DEFAULT_DAYS.map(d => [d, pinned.filter(p => (target.has(p.id) ? target.get(p.id) : p.from) === d)]));
  const after = routeStats(DEFAULT_DAYS.filter(d => afterGroups[d].length), afterGroups);
  return { scope, days: useDays, changes, moves: changes.filter(c => c.changed), skipped, before, after };
}

// Applies the ticked suggestions one shop at a time through the normal dated schedule change. A shop whose day was changed by someone
// else since the suggestion was made is SKIPPED (never overwritten). A failure on one shop does not stop the others.
export async function applySuggestions(moves, { setDay, onProgress = () => {} }) {
  const result = { applied: [], stale: [], failed: [] };
  for (const [i, m] of moves.entries()) {
    try {
      const r = await setDay(m.id, m.to, m.from);
      if (r && r.stale) result.stale.push(m); else result.applied.push(m);
    } catch (e) { result.failed.push({ ...m, error: e.message || String(e) }); }
    onProgress(i + 1, moves.length);
  }
  return result;
}
