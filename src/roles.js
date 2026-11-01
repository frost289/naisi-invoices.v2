import { db } from './firebase.js';
import { doc, getDoc } from 'firebase/firestore';

export async function getUserRole(email) {
  const snap = await getDoc(doc(db, 'config', 'roles'));
  if (!snap.exists()) return null;
  const data = snap.data();
  if ((data.managers || []).includes(email)) return 'manager';
  if ((data.submitters || []).includes(email)) return 'submitter';
  if ((data.deliverers || []).includes(email)) return 'delivery';
  return null;
}

// Phase 1: everyone who can hold a cash float (sales reps and drivers).
export async function fetchFloatHolderEmails() {
  const snap = await getDoc(doc(db, 'config', 'roles'));
  const d = snap.exists() ? snap.data() : {};
  return { submitters: [...(d.submitters || [])], deliverers: [...(d.deliverers || [])] };
}

// Emails of every sales rep (role "submitter"), so reports can list reps who
// have not recorded any visit.
export async function fetchRepEmails() {
  const snap = await getDoc(doc(db, 'config', 'roles'));
  return snap.exists() ? [...(snap.data().submitters || [])] : [];
}
