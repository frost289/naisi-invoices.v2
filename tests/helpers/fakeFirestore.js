// Minimal in-memory stand-in for the parts of firebase/firestore that the
// order / stock / invoice logic uses. It models:
//   - transactions that buffer writes and apply them all-or-nothing at commit;
//   - optimistic concurrency: if a document the transaction READ was changed by
//     another commit in the meantime, the callback is re-run (max 5 attempts,
//     like the real SDK);
//   - last-write-wins when one transaction updates the same document twice.
// It does NOT model: security rules, offline persistence, latency compensation,
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
export function setClock(ms) { clockMs = ms; }
export function now() { return clockMs; }
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
  for (const [k, v] of Object.entries(data)) out[k] = v === SERVER_TS ? new Ts(clockMs) : v;
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
function write(ref, data) { store.set(ref.path, data); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); }

export async function getDoc(ref) { return snap(ref); }
export async function setDoc(ref, data) { write(ref, resolve(data)); }
export async function updateDoc(ref, data) {
  if (!store.has(ref.path)) throw new Error('No document to update: ' + ref.path);
  write(ref, { ...store.get(ref.path), ...resolve(data) });
}
export async function addDoc(col, data) { const ref = doc(col); write(ref, resolve(data)); return ref; }
export async function deleteDoc(ref) { store.delete(ref.path); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); }

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
      } else { store.delete(ref.path); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); }
    }
    stats.commits++;
    const lost = hooks.failAfterCommit && hooks.failAfterCommit(writes);
    if (lost) throw lost;
    return result;
  }
  throw new Error('Transaction failed after retries');
}

// Queries are not exercised by these tests.
export const query = () => ({}), where = () => ({}), orderBy = () => ({}), limit = () => ({}), startAfter = () => ({});
export async function getDocs() { return { docs: [] }; }
export function onSnapshot() { return () => {}; }
export function getFirestore() { return {}; }
