import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, getDoc, updateDoc, writeBatch, runTransaction,
  serverTimestamp, query, where, orderBy, limit, startAfter
} from 'firebase/firestore';
import { makeError } from './orderRevision.js';

const PAGE_SIZE = 25;

export async function fetchAllCustomers() {
  const q = query(collection(db, 'customers'), orderBy('name'));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function fetchCustomersPage(cursor = null) {
  const constraints = [orderBy('name'), limit(PAGE_SIZE)];
  if (cursor) constraints.push(startAfter(cursor));
  const snap = await getDocs(query(collection(db, 'customers'), ...constraints));
  return {
    items: snap.docs.map(d => ({ id: d.id, ...d.data() })),
    lastDoc: snap.docs.at(-1) || null,
    hasMore: snap.docs.length === PAGE_SIZE,
  };
}

// ---- Text normalization (names, locations) ----
// Trims, collapses internal whitespace, and title-cases every word so
// "john   BANDA" / "john banda" / "John Banda" all end up identical —
// this is what makes duplicate detection and search actually work.
export function normalizeText(str) {
  if (!str) return '';
  return str.trim().replace(/\s+/g, ' ')
    .split(' ')
    .map(w => w.length ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');
}

// ---- Phone validation/normalization (Malawi numbers) ----
// Accepts common input shapes (0991234567, +265991234567, 265991234567,
// with or without spaces) and normalizes them all to a single stored
// form: +265XXXXXXXXX (9 digits after the country code, no spaces).
// Returns { valid: false, error } for anything that isn't a plausible
// Malawi mobile number. An EMPTY input is valid — phone stays optional.
export function normalizePhone(raw) {
  if (!raw || !raw.trim()) return { valid: true, value: '' };
  const digits = raw.replace(/\D/g, '');
  let local9 = null;
  if (digits.length === 10 && digits.startsWith('0')) local9 = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('265')) local9 = digits.slice(3);
  else if (digits.length === 9) local9 = digits;

  if (!local9 || local9.length !== 9 || !/^\d{9}$/.test(local9)) {
    return { valid: false, error: 'Enter a valid Malawi phone number, e.g. 0991 234 567.' };
  }
  return { valid: true, value: `+265${local9}` };
}

// Stored form (+265991234567) -> display form (+265 99 123 4567).
export function formatPhoneForDisplay(stored) {
  if (!stored || !stored.startsWith('+265') || stored.length !== 13) return stored || '';
  const local9 = stored.slice(4);
  return `+265 ${local9.slice(0, 2)} ${local9.slice(2, 5)} ${local9.slice(5)}`;
}

// ---- WhatsApp number conversion ----
// wa.me links need the number as country-code + subscriber number,
// digits only, no +, no spaces, no leading 0 (e.g. 265991234567).
// This is deliberately more lenient than normalizePhone() above: it
// accepts whatever format a phone number ended up stored in —
// customers created through this app (+265XXXXXXXXX), invoices with
// raw hand-typed numbers, numbers with spaces/dashes/brackets, a
// stray double country-code typo — and returns null instead of an
// error when it can't confidently identify a 9-digit Malawi
// subscriber number, so callers can just hide the WhatsApp button
// rather than show a broken link.
export function toWhatsAppNumber(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  let local9 = null;
  if (digits.length === 9) local9 = digits;
  else if (digits.length === 10 && digits.startsWith('0')) local9 = digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('265')) local9 = digits.slice(3);
  else if (digits.length === 13 && digits.startsWith('0265')) local9 = digits.slice(4); // e.g. "0" + "+265..." typed together
  if (!local9 || local9.length !== 9 || !/^\d{9}$/.test(local9)) return null;
  return `265${local9}`;
}

// ---- Duplicate detection ----
// Checks a candidate {name, phone, location} against everyone already
// in customersCache, on three independent signals: exact normalized
// name match, exact phone match (phone is already normalized so this
// is a clean equality check), and exact normalized location match.
// excludeId lets an edit-in-place skip matching against itself.
export function findPossibleDuplicates(customersCache, { name, phone, location }, excludeId = null) {
  const normName = normalizeText(name).toLowerCase();
  const normLocation = normalizeText(location).toLowerCase();
  const matches = [];
  customersCache.forEach(c => {
    if (excludeId && c.id === excludeId) return;
    const nameMatches = !!(normName && (c.name || '').toLowerCase() === normName);
    const phoneMatches = !!(phone && c.phone && c.phone === phone);
    // Location alone is NOT a sign of duplication — with standardized
    // locations, lots of genuinely different customers legitimately
    // share the same one (e.g. everyone in "Area 25"). Flagging on
    // location alone was blocking reps from adding real new customers
    // any time they picked a busy, commonly-used location. Only a name
    // or phone match actually suggests the same person; location just
    // rides along as extra context once one of those has already hit.
    if (!nameMatches && !phoneMatches) return;
    const reasons = [];
    if (nameMatches) reasons.push('name');
    if (phoneMatches) reasons.push('phone number');
    if (normLocation && (c.location || '').toLowerCase() === normLocation) reasons.push('location');
    matches.push({ customer: c, reasons });
  });
  return matches;
}

export async function fetchCustomerById(id) {
  const snap = await getDoc(doc(db, 'customers', id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// A "pinned location" means real coordinates — the delivery point. The
// location NAME (e.g. "Area 25") is only an area label; it is never
// enough on its own to deliver to a customer.
export function isValidPin(lat, lng) {
  return typeof lat === 'number' && typeof lng === 'number'
    && isFinite(lat) && isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
export function hasPin(customer) {
  return !!customer && isValidPin(customer.lat, customer.lng);
}

// New customers are created UNSCHEDULED: no weekday is assigned automatically. Reps and managers may create a
// customer; only a manager gives it a visit day (setCustomerVisitDay below), and until then it is listed as
// "awaiting scheduling" for managers and is not a target for any rep. The security rules refuse a new customer
// that carries a day, is inactive, or carries any schedule/merge field.
export async function addCustomer({ name, phone, location, lat, lng, uid }) {
  if (!isValidPin(lat, lng)) throw new Error('A pinned location is required to add a customer.');
  const docRef = await addDoc(collection(db, 'customers'), {
    name: normalizeText(name), phone: phone || '', location: normalizeText(location),
    lat: (typeof lat === 'number' && !isNaN(lat)) ? lat : null,
    lng: (typeof lng === 'number' && !isNaN(lng)) ? lng : null,
    active: true, assignedDay: null,
    createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export const VISIT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- Schedule changes (manager only) ----
// Visit day, deactivation and reactivation are the ONLY changes to a customer's schedule. Each one is a
// transaction that updates the customer AND appends a dated history entry (scheduleChanges) in the same commit;
// the rules refuse a schedule change that has no matching history entry, and refuse any edit/delete of an
// entry. Nothing here touches a customer's past orders, visits or invoices.
async function applyScheduleChange(id, { kind, wantActive, wantDay, uid, email }) {
  const customerRef = doc(db, 'customers', id);
  const changeRef = doc(collection(db, 'scheduleChanges'));      // id chosen once, outside the (re-runnable) callback
  return await runTransaction(db, async (tx) => {
    const snap = await tx.get(customerRef);
    if (!snap.exists()) throw new Error('That customer no longer exists.');
    const c = snap.data();
    if (c.mergeLock) throw makeError('This customer is being merged right now and cannot be changed. Finish or cancel the merge first.', { code: 'customer-merging' });
    const active = wantActive === undefined ? c.active !== false : wantActive;
    const day = wantDay === undefined ? (c.assignedDay ?? null) : wantDay;
    if (kind === 'reactivate' && c.active !== false) return { unchanged: true };     // already active: never clears its day
    if (!active && day) throw new Error('Reactivate the customer before choosing a visit day.');
    if ((c.active !== false) === active && (c.assignedDay ?? null) === day) return { unchanged: true };
    tx.update(customerRef, { active, assignedDay: day, lastScheduleChangeId: changeRef.id, updatedAt: serverTimestamp() });
    tx.set(changeRef, {
      customerId: id, customerName: c.name || '', kind, active, assignedDay: day,
      changedBy: uid, changedByEmail: email, createdAt: serverTimestamp(),
    });
    return { unchanged: false, changeId: changeRef.id };
  });
}

// ---- Archiving (shop closed for good) ----
// Soft delete only: the customer record, and every order/invoice/visit that references it, stays intact. An inactive
// customer disappears from active pickers and from the schedule (it is no longer a target from that day on; earlier
// days keep their targets - see scheduleHistory.js). Deactivating also clears the visit day.
export async function deactivateCustomer(id, { uid, email }) {
  return applyScheduleChange(id, { kind: 'deactivate', wantActive: false, wantDay: null, uid, email });
}

// Reactivating (the shop reopens) makes it active but UNSCHEDULED: a manager must choose a visit day again.
export async function reactivateCustomer(id, { uid, email }) {
  return applyScheduleChange(id, { kind: 'reactivate', wantActive: true, wantDay: null, uid, email });
}

// day is one of 'Mon'..'Sat', or null to take the customer off the schedule (awaiting scheduling).
export async function setCustomerVisitDay(id, day, { uid, email }) {
  if (day && !VISIT_DAYS.includes(day)) throw new Error('Visit day must be Monday to Saturday.');
  return applyScheduleChange(id, { kind: 'schedule', wantActive: undefined, wantDay: day || null, uid, email });
}

export async function updateCustomer(id, { name, phone, location, lat, lng }) {
  const patch = {
    name: normalizeText(name), phone: phone || '', location: normalizeText(location),
    updatedAt: serverTimestamp(),
  };
  // Only touch lat/lng if this call actually passed them — otherwise the
  // many existing callers that just edit name/phone/location would wipe
  // out a previously-saved pin every time they save.
  if (lat !== undefined) patch.lat = (typeof lat === 'number' && !isNaN(lat)) ? lat : null;
  if (lng !== undefined) patch.lng = (typeof lng === 'number' && !isNaN(lng)) ? lng : null;
  await updateDoc(doc(db, 'customers', id), patch);
}

// Location-only patch, used by the "Set Location" pin button on an
// existing customer row — doesn't require re-sending name/phone/location.
export async function updateCustomerLocation(id, { lat, lng }) {
  await updateDoc(doc(db, 'customers', id), {
    lat: (typeof lat === 'number' && !isNaN(lat)) ? lat : null,
    lng: (typeof lng === 'number' && !isNaN(lng)) ? lng : null,
    updatedAt: serverTimestamp(),
  });
}

export function findExactNameMatch(customers, name) {
  const target = normalizeText(name).toLowerCase();
  return customers.find(c => (c.name || '').trim().toLowerCase() === target) || null;
}

// ---- Merge (manager-only) ----
// Read-only preview of what a merge would move, shown before the manager confirms. It also reports orders that
// are being invoiced right now: such a merge is refused until invoicing finishes.
export async function countCustomerActivity(customerId) {
  const [ordersSnap, visitsSnap, invoicesSnap] = await Promise.all([
    getDocs(query(collection(db, 'orders'), where('customerId', '==', customerId))),
    getDocs(query(collection(db, 'visits'), where('customerId', '==', customerId))),
    getDocs(query(collection(db, 'invoices'), where('customerId', '==', customerId))),
  ]);
  const invoicing = ordersSnap.docs.filter(d => d.data().status === 'Invoicing').map(d => d.data().orderNo || d.id);
  return { orders: ordersSnap.size, visits: visitsSnap.size, invoices: invoicesSnap.size, invoicing };
}

// Why 8: the security rules look up the customer and the roles document for every moved record, and Firestore allows
// 20 rule-lookups per batched write. 8 records x 2 lookups = 16, inside the limit even if lookups are not shared between
// the writes of one batch. (Shared lookups would allow more; tests/rules group M checks a full-size merge on the emulator.)
export const MERGE_CHUNK = 8;

function mergeBlocked(orderNos) {
  return makeError(
    `This merge cannot run right now: ${orderNos.length === 1 ? 'order' : 'orders'} ${orderNos.join(', ')} ` +
    `${orderNos.length === 1 ? 'is' : 'are'} being invoiced. Nothing was moved and no customer was deleted. ` +
    'Wait for invoicing to finish (or for a stuck invoice to be reviewed), then try the merge again.',
    { code: 'merge-blocked-invoicing', orders: orderNos });
}

async function releaseMergeLock(mergeId, keepId) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'customers', mergeId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const lock = snap.data().mergeLock;
    if (lock && lock.into === keepId) tx.update(ref, { mergeLock: null, updatedAt: serverTimestamp() });
  });
}
export async function cancelMergeLock(mergeId) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'customers', mergeId);
    const snap = await tx.get(ref);
    if (snap.exists() && snap.data().mergeLock) tx.update(ref, { mergeLock: null, updatedAt: serverTimestamp() });
  });
}

// Moves every order/visit/invoice pointing at mergeId onto keepId, then deletes mergeId.
//
// HOW IT STAYS SAFE (not a pre-check that can go stale):
//  1. LOCK. In one transaction the customer being merged away gets `mergeLock: { into: keepId }`. From the moment
//     that commit succeeds, the security rules refuse (a) an order of that customer entering "Invoicing", (b) any
//     new visit, order or invoice for it, (c) any schedule change to it.
//  2. CHECK. Only AFTER the lock is in place does it look for orders of that customer in "Invoicing". None can appear
//     afterwards, so this check cannot go stale. If one is found the lock is released and the merge is refused with a
//     clear message BEFORE anything has been moved (no partial move, no deletion).
//  3. MOVE in chunks of MERGE_CHUNK documents. The rules allow a move ONLY while the lock points at the same keepId,
//     and only the customer fields change (amounts, numbers, statuses, invoice links and dates are untouched).
//  4. VERIFY nothing is left, then delete the customer and write the customerMerges record in ONE commit (the
//     rules refuse a delete without that record). The merged customer's schedule history is kept.
// If the app is closed part-way, the lock stays (nothing else can touch that customer) and running the same merge
// again resumes it; "Cancel merge" releases the lock.
export async function mergeCustomers(keepId, mergeId, { uid, email, chunk = MERGE_CHUNK, afterChunk = null } = {}) {
  if (keepId === mergeId) throw new Error('Cannot merge a customer into itself.');
  if (!uid) throw new Error('Not signed in.');
  const keepRef = doc(db, 'customers', keepId);
  const mergeRef = doc(db, 'customers', mergeId);

  // 1. lock (or resume)
  const lockState = await runTransaction(db, async (tx) => {
    const keepSnap = await tx.get(keepRef);
    const mergeSnap = await tx.get(mergeRef);
    if (!keepSnap.exists()) throw new Error('The customer to keep no longer exists.');
    if (!mergeSnap.exists()) throw new Error('The customer to merge away no longer exists.');
    const keep = keepSnap.data(), away = mergeSnap.data();
    if (keep.mergeLock) throw makeError('The customer to keep is itself being merged into another customer. Finish that merge first.', { code: 'customer-merging' });
    if (away.mergeLock) {
      if (away.mergeLock.into !== keepId) throw makeError('This customer is already being merged into a different customer. Cancel that merge first.', { code: 'customer-merging' });
      return { resumed: true, keep };
    }
    tx.update(mergeRef, { mergeLock: { into: keepId, by: uid, at: serverTimestamp() }, updatedAt: serverTimestamp() });
    return { resumed: false, keep };
  });
  const keep = lockState.keep;

  // 2. check for orders being invoiced (AFTER the lock, so the answer cannot change under us)
  const invoicingNow = async () => {
    const snap = await getDocs(query(collection(db, 'orders'), where('customerId', '==', mergeId), where('status', '==', 'Invoicing')));
    return snap.docs.map(d => d.data().orderNo || d.id);
  };
  const blocked = await invoicingNow();
  if (blocked.length) {
    if (!lockState.resumed) await releaseMergeLock(mergeId, keepId);
    throw mergeBlocked(blocked);
  }

  // 3. move, chunk by chunk
  const totals = { orders: 0, visits: 0, invoices: 0 };
  for (let pass = 0; pass < 5; pass++) {
    const [ordersSnap, visitsSnap, invoicesSnap] = await Promise.all([
      getDocs(query(collection(db, 'orders'), where('customerId', '==', mergeId))),
      getDocs(query(collection(db, 'visits'), where('customerId', '==', mergeId))),
      getDocs(query(collection(db, 'invoices'), where('customerId', '==', mergeId))),
    ]);
    const stuck = ordersSnap.docs.filter(d => d.data().status === 'Invoicing').map(d => d.data().orderNo || d.id);
    if (stuck.length) throw mergeBlocked(stuck);          // lock kept: resumable, nothing deleted
    const all = [
      ...ordersSnap.docs.map(d => ({ ref: d.ref, coll: 'orders' })),
      ...visitsSnap.docs.map(d => ({ ref: d.ref, coll: 'visits' })),
      ...invoicesSnap.docs.map(d => ({ ref: d.ref, coll: 'invoices' })),
    ];
    if (all.length === 0) break;
    for (let i = 0; i < all.length; i += chunk) {
      const batch = writeBatch(db);
      for (const { ref, coll } of all.slice(i, i + chunk)) {
        if (coll === 'orders') {
          batch.update(ref, { customerId: keepId, customerName: keep.name, customerPhone: keep.phone || '-', customerLocation: keep.location || '-' });
        } else if (coll === 'visits') {
          batch.update(ref, { customerId: keepId, customerName: keep.name });
        } else {
          batch.update(ref, { customerId: keepId, customer: keep.name, phone: keep.phone || '-', location: keep.location || '-' });
        }
      }
      await batch.commit();
      if (afterChunk) await afterChunk();
    }
    totals.orders += ordersSnap.size; totals.visits += visitsSnap.size; totals.invoices += invoicesSnap.size;
  }

  // 4. verify nothing is left, then delete + record in ONE commit
  const left = await countCustomerActivity(mergeId);
  if (left.orders + left.visits + left.invoices > 0) {
    throw makeError('The merge could not move every record, so the customer was NOT deleted. The merge is paused; run it again to resume.', { code: 'merge-incomplete' });
  }
  const finish = writeBatch(db);
  finish.set(doc(db, 'customerMerges', mergeId), {
    keepId, keepName: keep.name || '', mergedName: (await getDoc(mergeRef)).data().name || '',
    moved: totals, mergedBy: uid, mergedByEmail: email, mergedAt: serverTimestamp(),
  });
  finish.delete(mergeRef);
  await finish.commit();
  return totals;
}
