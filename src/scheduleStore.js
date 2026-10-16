// Firestore side of the schedule history (see scheduleHistory.js for the rules of the model).
import { db } from './firebase.js';
import { collection, doc, getDoc, getDocs, writeBatch, serverTimestamp } from 'firebase/firestore';
import { malawiDate } from './malawiTime.js';
import { makeError } from './orderRevision.js';

export const SCHEDULE_CONFIG_DOC = () => doc(db, 'config', 'scheduleHistory');
// Baselines must be finished within this window after the history is started (also enforced by the rules).
export const BASELINE_WINDOW_MS = 60 * 60 * 1000;

export async function fetchScheduleHistory() {
  const [cfgSnap, changesSnap, mergesSnap] = await Promise.all([
    getDoc(SCHEDULE_CONFIG_DOC()),
    getDocs(collection(db, 'scheduleChanges')),
    getDocs(collection(db, 'customerMerges')),
  ]);
  return {
    config: cfgSnap.exists() ? cfgSnap.data() : null,
    changes: changesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    merges: mergesSnap.docs.map(d => ({ id: d.id, ...d.data() })),
  };
}

export const baselineIdFor = (customerId) => `base_${customerId}`;

// Starts the history: ONE baseline entry per existing customer (their schedule as it is right now) plus the
// config document, all within one hour. Safe to run again within that hour (it only adds missing baselines).
// A manager does this once, after RC3 is released. It does not invent anything: the baseline is today's real state,
// effective from today; earlier dates stay "no reliable history".
export async function startScheduleHistory({ customers, uid, email, now = () => Date.now(), chunk = 300 }) {
  const cfgRef = SCHEDULE_CONFIG_DOC();
  const cfgSnap = await getDoc(cfgRef);
  const startedMs = cfgSnap.exists() && cfgSnap.data().startedAt && typeof cfgSnap.data().startedAt.toMillis === 'function' ? cfgSnap.data().startedAt.toMillis() : null;
  if (cfgSnap.exists() && now() - startedMs > BASELINE_WINDOW_MS) {
    return { status: 'already-started', startDate: malawiDate(new Date(startedMs)), added: 0 };
  }
  const existing = cfgSnap.exists()
    ? new Set((await getDocs(collection(db, 'scheduleChanges'))).docs.filter(d => d.data().kind === 'baseline').map(d => d.data().customerId))
    : new Set();
  const todo = customers.filter(c => !existing.has(c.id));
  let first = !cfgSnap.exists();
  let added = 0;
  for (let i = 0; i < todo.length || first; i += chunk) {
    const batch = writeBatch(db);
    if (first) {
      batch.set(cfgRef, { startedAt: serverTimestamp(), startedBy: uid, startedByEmail: email, baselineCount: todo.length });
      first = false;
    }
    for (const c of todo.slice(i, i + chunk)) {
      batch.set(doc(db, 'scheduleChanges', baselineIdFor(c.id)), {
        customerId: c.id, customerName: c.name || '', kind: 'baseline',
        active: c.active !== false, assignedDay: c.assignedDay || null,
        changedBy: uid, changedByEmail: email, createdAt: serverTimestamp(),
      });
      added++;
    }
    await batch.commit();
    if (todo.length === 0) break;
  }
  return { status: 'started', added };
}

export function scheduleHistoryNotReady() {
  return makeError('Schedule history has not been started yet. A manager must start it from the Rep Performance screen.', { code: 'history-not-started' });
}
