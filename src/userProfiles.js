import { db } from './firebase.js';
import { collection, doc, getDoc, setDoc, getDocs, serverTimestamp } from 'firebase/firestore';

export async function fetchMyProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export async function saveMyProfile(uid, { name, email }) {
  await setDoc(doc(db, 'users', uid), {
    name: (name || '').trim(), email, updatedAt: serverTimestamp(),
  }, { merge: true });
}

// Fetches every user profile so emails can be resolved to display
// names in reports (Rep Performance, Stock Movement History, Order
// Preview, etc.) in one shot rather than one lookup per row.
// Returns { uid: { name, email } }.
export async function fetchAllProfiles() {
  const snap = await getDocs(collection(db, 'users'));
  const map = {};
  snap.docs.forEach(d => { map[d.id] = d.data(); });
  return map;
}

// Resolves an email to a display name using the map from
// fetchAllProfiles() — falls back to the email itself if that person
// hasn't set a display name yet, so nothing breaks for them.
export function resolveNameByEmail(profilesByUid, email) {
  if (!email) return '—';
  const match = Object.values(profilesByUid).find(p => p.email === email);
  return (match && match.name) ? match.name : email;
}
