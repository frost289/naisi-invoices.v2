import { db } from './firebase.js';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { isValidPin } from './customers.js';

// The warehouse / depot pin — the fallback starting point for routes when
// a phone's GPS isn't available. Set once by a manager.
export async function fetchDepot() {
  const snap = await getDoc(doc(db, 'config', 'depot'));
  if (!snap.exists()) return null;
  const d = snap.data();
  return isValidPin(d.lat, d.lng) ? { lat: d.lat, lng: d.lng } : null;
}

export async function saveDepot({ lat, lng, uid }) {
  if (!isValidPin(lat, lng)) throw new Error('Invalid location.');
  await setDoc(doc(db, 'config', 'depot'), { lat, lng, updatedBy: uid, updatedAt: serverTimestamp() });
}
