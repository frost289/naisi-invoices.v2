import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, deleteDoc, updateDoc, query, orderBy, serverTimestamp
} from 'firebase/firestore';
import { normalizeText } from './customers.js';

// Small, business-scale list (dozens, not thousands) — fetched in full
// every time rather than paginated, same reasoning as the products
// catalog cache.
export async function fetchAllLocations() {
  const snap = await getDocs(query(collection(db, 'locations'), orderBy('name')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function addLocation(name, uid, { pendingReview = false } = {}) {
  const clean = normalizeText(name);
  if (!clean) throw new Error('Enter a location name.');
  const docRef = await addDoc(collection(db, 'locations'), {
    name: clean, pendingReview, createdBy: uid, createdAt: serverTimestamp(),
  });
  return { id: docRef.id, name: clean, pendingReview };
}

export async function deleteLocation(id) {
  await deleteDoc(doc(db, 'locations', id));
}

export async function markLocationReviewed(id) {
  await updateDoc(doc(db, 'locations', id), { pendingReview: false });
}

export function findLocationByName(locationsCache, name) {
  const target = normalizeText(name).toLowerCase();
  return locationsCache.find(l => (l.name || '').toLowerCase() === target) || null;
}

// The in-app pin-drop map only exists for customers with a saved lat/
// lng. For everyone else, this builds a Google Maps text-search link
// from the location NAME instead — same idea as forwarding a text
// location in WhatsApp instead of a GPS pin: it still opens Google Maps
// and centers on the right place, just without an exact coordinate.
export function googleMapsSearchUrlForLocation(locationName) {
  if (!locationName) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(locationName + ', Malawi')}`;
}
