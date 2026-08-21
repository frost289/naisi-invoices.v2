import { db } from './firebase.js';
import {
  collection, addDoc, getDocs, doc, updateDoc,
  serverTimestamp, query, orderBy, limit, startAfter
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

export async function addCustomer({ name, phone, location, lat, lng, uid }) {
  const docRef = await addDoc(collection(db, 'customers'), {
    name, phone: phone || '', location: location || '',
    lat: (typeof lat === 'number' && !isNaN(lat)) ? lat : null,
    lng: (typeof lng === 'number' && !isNaN(lng)) ? lng : null,
    createdBy: uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return docRef.id;
}

export async function updateCustomer(id, { name, phone, location, lat, lng }) {
  const patch = { name, phone: phone || '', location: location || '', updatedAt: serverTimestamp() };
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
  const target = name.trim().toLowerCase();
  return customers.find(c => (c.name || '').trim().toLowerCase() === target) || null;
}