import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, getDoc, updateDoc, deleteDoc, writeBatch,
  serverTimestamp, query, where, orderBy, limit, startAfter
} from 'firebase/firestore';

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
    const reasons = [];
    if (normName && (c.name || '').toLowerCase() === normName) reasons.push('name');
    if (phone && c.phone && c.phone === phone) reasons.push('phone number');
    if (normLocation && (c.location || '').toLowerCase() === normLocation) reasons.push('location');
    if (reasons.length > 0) matches.push({ customer: c, reasons });
  });
  return matches;
}

export async function addCustomer({ name, phone, location, lat, lng, uid }) {
  const docRef = await addDoc(collection(db, 'customers'), {
    name: normalizeText(name), phone: phone || '', location: normalizeText(location),
    lat: (typeof lat === 'number' && !isNaN(lat)) ? lat : null,
    lng: (typeof lng === 'number' && !isNaN(lng)) ? lng : null,
    createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return docRef.id;
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
// Read-only preview of what a merge would move, shown before the
// manager confirms — so they know what they're doing before it's done.
export async function countCustomerActivity(customerId) {
  const [ordersSnap, visitsSnap, invoicesSnap] = await Promise.all([
    getDocs(query(collection(db, 'orders'), where('customerId', '==', customerId))),
    getDocs(query(collection(db, 'visits'), where('customerId', '==', customerId))),
    getDocs(query(collection(db, 'invoices'), where('customerId', '==', customerId))),
  ]);
  return { orders: ordersSnap.size, visits: visitsSnap.size, invoices: invoicesSnap.size };
}

// Moves every order/visit/invoice pointing at mergeId over to keepId,
// then deletes the mergeId customer record. keepId's own name/phone/
// location are copied onto the moved records so their denormalized
// display fields stay consistent with the surviving customer.
//
// IMPORTANT LIMITATION: invoices only started carrying a customerId
// field once this merge feature shipped. Invoices created before that
// have no customerId to match on, so they won't be found/moved by this
// function — they'll keep showing whatever customer name was on them
// at the time, same as they always have. This is a data-migration gap
// that predates this feature, not a bug in the merge itself.
export async function mergeCustomers(keepId, mergeId) {
  if (keepId === mergeId) throw new Error('Cannot merge a customer into itself.');

  const keepSnap = await getDoc(doc(db, 'customers', keepId));
  if (!keepSnap.exists()) throw new Error('The customer to keep no longer exists.');
  const keep = keepSnap.data();

  const [ordersSnap, visitsSnap, invoicesSnap] = await Promise.all([
    getDocs(query(collection(db, 'orders'), where('customerId', '==', mergeId))),
    getDocs(query(collection(db, 'visits'), where('customerId', '==', mergeId))),
    getDocs(query(collection(db, 'invoices'), where('customerId', '==', mergeId))),
  ]);

  const allDocs = [
    ...ordersSnap.docs.map(d => ({ ref: d.ref, coll: 'orders' })),
    ...visitsSnap.docs.map(d => ({ ref: d.ref, coll: 'visits' })),
    ...invoicesSnap.docs.map(d => ({ ref: d.ref, coll: 'invoices' })),
  ];

  // Firestore batches cap at 500 writes; chunk defensively even though
  // a small business is very unlikely to ever hit this in practice.
  for (let i = 0; i < allDocs.length; i += 400) {
    const chunk = allDocs.slice(i, i + 400);
    const batch = writeBatch(db);
    chunk.forEach(({ ref, coll }) => {
      if (coll === 'orders') {
        batch.update(ref, {
          customerId: keepId, customerName: keep.name,
          customerPhone: keep.phone || '-', customerLocation: keep.location || '-',
        });
      } else if (coll === 'visits') {
        batch.update(ref, { customerId: keepId, customerName: keep.name });
      } else if (coll === 'invoices') {
        batch.update(ref, {
          customerId: keepId, customer: keep.name,
          phone: keep.phone || '-', location: keep.location || '-',
        });
      }
    });
    await batch.commit();
  }

  await deleteDoc(doc(db, 'customers', mergeId));

  return { orders: ordersSnap.size, visits: visitsSnap.size, invoices: invoicesSnap.size };
}
