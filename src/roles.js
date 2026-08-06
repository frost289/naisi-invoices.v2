import { db } from './firebase.js';
import { doc, getDoc } from 'firebase/firestore';

export async function getUserRole(email) {
  const snap = await getDoc(doc(db, 'config', 'roles'));
  if (!snap.exists()) return null;
  const data = snap.data();
  if ((data.managers || []).includes(email)) return 'manager';
  if ((data.submitters || []).includes(email)) return 'submitter';
  return null;
}