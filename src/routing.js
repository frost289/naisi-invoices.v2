// Straight-line route ordering. No network, no API key, works offline.
// Straight-line distance slightly under-estimates real road distance, but
// it orders stops sensibly and costs nothing.

export function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathKm(start, pts) {
  let total = 0, prev = start;
  for (const p of pts) { total += haversineKm(prev, p); prev = p; }
  return total;
}

// Orders `stops` ([{ lat, lng, ... }]) into a short open route that begins
// at `start` ({ lat, lng }) and ends wherever is cheapest (no return trip).
// Nearest-neighbour first, then 2-opt improvement.
export function orderStops(start, stops) {
  const remaining = stops.slice();
  let path = [];
  let cur = start;
  while (remaining.length) {
    let best = 0, bestD = Infinity;
    remaining.forEach((p, i) => { const d = haversineKm(cur, p); if (d < bestD) { bestD = d; best = i; } });
    cur = remaining.splice(best, 1)[0];
    path.push(cur);
  }

  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    let bestLen = pathKm(start, path);
    for (let i = 0; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const cand = path.slice(0, i).concat(path.slice(i, j + 1).reverse(), path.slice(j + 1));
        const len = pathKm(start, cand);
        if (len < bestLen - 1e-9) { path = cand; bestLen = len; improved = true; }
      }
    }
    // Or-opt: try moving a single stop to every other position.
    for (let i = 0; i < path.length; i++) {
      for (let j = 0; j < path.length; j++) {
        if (i === j) continue;
        const without = path.slice(0, i).concat(path.slice(i + 1));
        const cand = without.slice(0, j).concat([path[i]], without.slice(j));
        const len = pathKm(start, cand);
        if (len < bestLen - 1e-9) { path = cand; bestLen = len; improved = true; }
      }
    }
  }

  let prev = start, cum = 0;
  const ordered = path.map((p, i) => {
    const legKm = haversineKm(prev, p);
    cum += legKm; prev = p;
    return { ...p, stopNo: i + 1, legKm, cumKm: cum };
  });
  return { ordered, totalKm: cum };
}

export function formatKm(km) {
  if (km === null || km === undefined || isNaN(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// GPS first; if the phone refuses / times out, fall back to the warehouse
// pin; if neither exists, returns null.
export async function getStartPoint(depot) {
  const gps = await new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'gps' }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  });
  if (gps) return gps;
  if (depot && typeof depot.lat === 'number' && typeof depot.lng === 'number') {
    return { lat: depot.lat, lng: depot.lng, source: 'depot' };
  }
  return null;
}

export function startLabel(start) {
  return start.source === 'gps' ? 'your current location' : 'the warehouse';
}
