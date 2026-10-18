// Browser build of the in-memory Firestore stand-in. The store is kept in localStorage so a page
// refresh keeps the data, and window.__fake exposes seeding / inspection / failure injection.
import * as F from '../helpers/fakeFirestore.js';
export * from '../helpers/fakeFirestore.js';

const KEY = 'naisi-fake-store';
F.setClock(null);
try { const saved = localStorage.getItem(KEY); if (saved) F.restore(saved); } catch (e) { /* ignore */ }
F.events.onChange = () => { try { localStorage.setItem(KEY, F.serialize()); } catch (e) { /* ignore */ } };

let failCommits = 0, failAfter = 0, holdVisitRange = [];
F.hooks.failCommit = () => (failCommits > 0 ? (failCommits--, new Error('Simulated network failure')) : null);
F.hooks.failAfterCommit = () => (failAfter > 0 ? (failAfter--, new Error('Simulated lost acknowledgement')) : null);

// slow answers for the manager's date-range visit query: holdVisitRange is a queue of delays (ms), used in order
F.hooks.holdQuery = (q) => (q && q.path === 'visits' && (q.cs || []).some(c => c.f === 'date' && c.op === '>=') && holdVisitRange.length ? holdVisitRange.shift() : 0);
const decode = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v && typeof v === 'object' && '__ts' in v ? F.ts(v.__ts) : v]));
window.__fake = {
  seed(entries) { F.store.clear(); for (const [p, d] of Object.entries(entries)) F.store.set(p, decode(d)); F.events.onChange(); },
  put(p, d) { F.store.set(p, decode(d)); F.events.onChange(); },        // test hook: simulates ANOTHER manager changing a record
  get: (p) => { const d = F.store.get(p); return d ? JSON.parse(JSON.stringify(d)) : null; },
  list: (prefix) => [...F.store].filter(([p]) => p.startsWith(prefix + '/')).map(([p, d]) => ({ id: p.slice(prefix.length + 1), ...JSON.parse(JSON.stringify(d)) })),
  failNextCommits(n = 1) { failCommits = n; },
  failNextAcks(n = 1) { failAfter = n; },
  delayVisitRangeQueries(list) { holdVisitRange = [...list]; },
};
