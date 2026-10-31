// Phase 1, Stage 1 — Float account settings (manager-only writes)
//
// One document per staff member who holds a cash float.
// Document ID = uid (deterministic, no duplicates).
//
// Firestore collection: floatSettings/{uid}
// Fields:
//   staffUid         string   uid of the float holder
//   staffEmail       string   email of the float holder (for display)
//   floatTarget      number   target float balance in MWK (e.g. 20000)
//   allowedCategories string[] categories this person may claim (subset of ALL_OPERATING_EXPENSE_CATEGORIES)
//   updatedBy        string   uid of manager who last changed the settings
//   updatedAt        Timestamp
//
// Phase 1 note: floatPeriods, moneyIssued are Stage 2 collections.
// This file is intentionally limited to the settings document only.

import { db } from './firebase.js';
import {
  doc, getDoc, setDoc, getDocs,
  collection, serverTimestamp,
} from 'firebase/firestore';

const COL = 'floatSettings';

// Fetch settings for a single staff member. Returns null if not yet configured.
export async function fetchFloatSettings(staffUid) {
  const snap = await getDoc(doc(db, COL, staffUid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Fetch all float settings (manager overview).
export async function fetchAllFloatSettings() {
  const snap = await getDocs(collection(db, COL));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Create or fully replace float settings for a staff member.
// Uses setDoc with merge:false so the manager's intent is explicit.
export async function setFloatSettings({ staffUid, staffEmail, floatTarget, allowedCategories, managerUid }) {
  const data = {
    staffUid,
    staffEmail,
    floatTarget: Number(floatTarget),
    allowedCategories: allowedCategories || [],
    updatedBy: managerUid,
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(db, COL, staffUid), data);
}
