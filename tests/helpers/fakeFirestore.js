// Minimal in-memory stand-in for the parts of firebase/firestore that the
// order / stock / invoice logic uses. It models:
//   - transactions that buffer writes and apply them all-or-nothing at commit;
//   - optimistic concurrency: if a document the transaction READ was changed by
//     another commit in the meantime, the callback is re-run (max 5 attempts,
//     like the real SDK);
//   - last-write-wins when one transaction updates the same document twice.
// It also runs simple queries (where / orderBy / limit / startAfter) over the in-memory store.
// It does NOT model: security rules, composite-index requirements, offline persistence, latency compensation,
// real network failures, or the SDK's exact retry/backoff timing.
export const store = new Map();   // path -> data
const versions = new Map();       // path -> version number
let idSeq = 0;
let clockMs = Date.now();

export const stats = { txAttempts: 0, commits: 0 };
// Test hooks (all reset by reset()):
//  hooks.beforeCommit({ attempt, writes })  async; runs after the callback, before conflict check
//  hooks.failCommit(writes) -> Error|null   thrown INSTEAD of committing (nothing written)
//  hooks.failAfterCommit(writes) -> Error|null  commit is applied, then the error is thrown (lost acknowledgement)
export const hooks = {};

export function reset() {
  clockMs = Date.now();
  store.clear(); versions.clear(); idSeq = 0;
  stats.txAttempts = 0; stats.commits = 0;
  for (const k of Object.keys(hooks)) delete hooks[k];
}
export function setClock(ms) { clockMs = ms; }      // null = follow the real clock (browser harness)
export function now() { return nowMs(); }
function nowMs() { return clockMs === null ? Date.now() : clockMs; }
export const ts = (ms) => new Ts(ms);

class Ts {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
}
const SERVER_TS = { __serverTs: true };
export const serverTimestamp = () => SERVER_TS;
function resolve(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? new Ts(nowMs()) : v;
  return out;
}

export function collection(_db, name) { return { kind: 'col', path: name }; }
export function doc(a, b, c) {
  const make = (path) => ({ kind: 'doc', path, get id() { return path.split('/')[1]; } });
  if (a && a.kind === 'col') return make(`${a.path}/${b ?? 'auto' + (++idSeq)}`);
  return make(`${b}/${c}`);
}
function snap(ref) {
  const data = store.get(ref.path);
  return { id: ref.id, exists: () => data !== undefined, data: () => (data ? structuredCloneSafe(data) : undefined) };
}
function structuredCloneSafe(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) out[k] = (v instanceof Ts) ? v : (Array.isArray(v) ? v.map(x => (x && typeof x === 'object' ? { ...x } : x)) : v);
  return out;
}
function write(ref, data) { store.set(ref.path, data); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); changed(); }
export const events = { onChange: null };   // browser harness persists the store from here
const listeners = new Set();
function changed() { if (events.onChange) events.onChange(); for (const l of [...listeners]) queueMicrotask(l); }
export function serialize() {
  return JSON.stringify([...store].map(([p, d]) => [p, JSON.parse(JSON.stringify(d, (k, v) => v)), Object.fromEntries(Object.entries(d).filter(([, v]) => v instanceof Ts).map(([k, v]) => [k, v.ms]))]));
}
export function restore(json) {
  store.clear();
  for (const [p, d, tsFields] of JSON.parse(json)) {
    const o = { ...d };
    for (const [k, ms] of Object.entries(tsFields || {})) o[k] = new Ts(ms);
    store.set(p, o);
  }
}

export async function getDoc(ref) { return snap(ref); }
export async function setDoc(ref, data, options) {
  if (options && options.merge && store.has(ref.path)) write(ref, { ...store.get(ref.path), ...resolve(data) });
  else write(ref, resolve(data));
}
export async function updateDoc(ref, data) {
  if (!store.has(ref.path)) throw new Error('No document to update: ' + ref.path);
  write(ref, { ...store.get(ref.path), ...resolve(data) });
}
export async function addDoc(col, data) { const ref = doc(col); write(ref, resolve(data)); return ref; }
export async function deleteDoc(ref) { store.delete(ref.path); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); changed(); }

export async function runTransaction(_db, fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    stats.txAttempts++;
    const reads = new Map();
    const writes = [];
    let wrote = false;
    const tx = {
      async get(ref) {
        if (wrote) throw new Error('Firestore transactions require all reads before any writes.');
        reads.set(ref.path, versions.get(ref.path) || 0);
        await new Promise(r => setTimeout(r, 1));
        return snap(ref);
      },
      set(ref, data) { wrote = true; writes.push(['set', ref, data]); return tx; },
      update(ref, data) { wrote = true; writes.push(['update', ref, data]); return tx; },
      delete(ref) { wrote = true; writes.push(['delete', ref]); return tx; },
    };
    const result = await fn(tx);
    if (hooks.beforeCommit) await hooks.beforeCommit({ attempt, writes });
    // --- atomic section: no awaits between the conflict check and the apply ---
    const conflict = [...reads].some(([p, v]) => (versions.get(p) || 0) !== v);
    if (conflict) continue;
    const failure = hooks.failCommit && hooks.failCommit(writes);
    if (failure) throw failure;
    for (const [op, ref, data] of writes) {
      if (op === 'set') write(ref, resolve(data));
      else if (op === 'update') {
        if (!store.has(ref.path)) throw new Error('No document to update: ' + ref.path);
        write(ref, { ...store.get(ref.path), ...resolve(data) });
      } else { store.delete(ref.path); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); changed(); }
    }
    stats.commits++;
    const lost = hooks.failAfterCommit && hooks.failAfterCommit(writes);
    if (lost) throw lost;
    return result;
  }
  throw new Error('Transaction failed after retries');
}

// ---- queries ----
export const where = (f, op, v) => ({ t: 'where', f, op, v });
export const orderBy = (f, dir = 'asc') => ({ t: 'orderBy', f, dir });
export const limit = (n) => ({ t: 'limit', n });
export const startAfter = (snapOrValue) => ({ t: 'startAfter', snap: snapOrValue });
export const query = (col, ...cs) => ({ kind: 'query', path: col.path, cs });
const cmpVal = (v) => (v instanceof Ts ? v.ms : v);
function compare(a, b) { a = cmpVal(a); b = cmpVal(b); return a < b ? -1 : a > b ? 1 : 0; }
function getField(d, f) { return f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d); }
function runQuery(q) {
  const prefix = q.path + '/';
  let docs = [...store].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map(([p, d]) => ({ path: p, id: p.slice(prefix.length), data: d }));
  const orders = q.cs.filter(c => c.t === 'orderBy');
  for (const c of q.cs.filter(c => c.t === 'where')) {
    docs = docs.filter(({ data }) => {
      const x = getField(data, c.f);
      if (x === undefined) return false;
      const a = cmpVal(x), b = cmpVal(c.v);
      switch (c.op) {
        case '==': return a === b;
        case '!=': return a !== b;
        case '>': return a > b; case '>=': return a >= b;
        case '<': return a < b; case '<=': return a <= b;
        case 'in': return c.v.map(cmpVal).includes(a);
        default: throw new Error('fake firestore: unsupported operator ' + c.op);
      }
    });
  }
  // like Firestore, a document without the ordered field is not returned
  for (const o of orders) docs = docs.filter(({ data }) => getField(data, o.f) !== undefined);
  if (orders.length) {
    docs.sort((x, y) => {
      for (const o of orders) { const r = compare(getField(x.data, o.f), getField(y.data, o.f)); if (r) return o.dir === 'desc' ? -r : r; }
      return x.id < y.id ? -1 : 1;
    });
  }
  const sa = q.cs.find(c => c.t === 'startAfter');
  if (sa && orders.length) {
    const ref = sa.snap && sa.snap.data ? sa.snap.data() : sa.snap;
    const idx = docs.findIndex(({ data, id }) => orders.every((o) => compare(getField(data, o.f), getField(ref, o.f)) === 0) && (!sa.snap.id || id === sa.snap.id));
    if (idx >= 0) docs = docs.slice(idx + 1);
  }
  const lim = q.cs.find(c => c.t === 'limit');
  if (lim) docs = docs.slice(0, lim.n);
  return docs.map(({ path, id }) => { const ref = { kind: 'doc', path, id }; return Object.assign(snap(ref), { ref }); });
}
export async function getDocs(q) {
  await new Promise(r => setTimeout(r, 1));
  const docs = runQuery(q.kind === 'query' ? q : { path: q.path, cs: [] });
  return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
}
export function onSnapshot(target, cb) {
  const fire = () => {
    if (target.kind === 'doc') cb(snap(target));
    else { const docs = runQuery(target.kind === 'query' ? target : { path: target.path, cs: [] }); cb({ docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) }); }
  };
  listeners.add(fire);
  queueMicrotask(fire);
  return () => listeners.delete(fire);
}
export function writeBatch() {
  const ops = [];
  const b = {
    set(ref, data, options) { ops.push(() => setDoc(ref, data, options)); return b; },
    update(ref, data) { ops.push(() => updateDoc(ref, data)); return b; },
    delete(ref) { ops.push(() => deleteDoc(ref)); return b; },
    async commit() { for (const op of ops) await op(); },
  };
  return b;
}
export const Timestamp = { now: () => new Ts(nowMs()), fromMillis: (ms) => new Ts(ms), fromDate: (d) => new Ts(d.getTime()) };
export function getFirestore() { return {}; }
export const db = {};
export const auth = {};
export const googleProvider = {};
export function connectFirestoreEmulator() {}
