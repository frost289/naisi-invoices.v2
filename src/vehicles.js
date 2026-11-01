// Phase 1, Stage 1 — Vehicle management (manager-only)
//
// Vehicles are used by deliverers to log Fuel and VehicleMaintenance expenses.
// Soft-delete only (active = false): financial records referencing a vehicle must remain readable.
//
// Firestore collection: vehicles/{vehicleId}  (auto-id)
// Fields:
//   registration   string   e.g. "MW 1234 A"  (uppercase, trimmed)
//   description    string   e.g. "Delivery Truck – White Nissan UD"
//   assignedToUid  string?  uid of the primary deliverer (null = pool vehicle)
//   active         bool     false = soft-deleted
//   createdBy      string   uid of manager who added it
//   createdAt      Timestamp
//   updatedAt      Timestamp

import { db } from './firebase.js';
import {
  collection, doc, addDoc, updateDoc,
  getDocs, query, where, orderBy, serverTimestamp,
} from 'firebase/firestore';

const COL = 'vehicles';

// Fetch all active vehicles (manager and deliverer screens).
export async function fetchActiveVehicles() {
  // Filter only; sorted here (a filter + orderBy on another field would need a composite index).
  const snap = await getDocs(query(collection(db, COL), where('active', '==', true)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.registration).localeCompare(String(b.registration)));
}

// Fetch all vehicles including inactive (manager admin view).
export async function fetchAllVehicles() {
  const snap = await getDocs(
    query(collection(db, COL), orderBy('registration', 'asc'))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Add a new vehicle. Returns the new document reference.
export async function addVehicle({ registration, description, assignedToUid, uid }) {
  const data = {
    registration: registration.trim().toUpperCase(),
    description:  description.trim(),
    assignedToUid: assignedToUid || null,
    active: true,
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  return addDoc(collection(db, COL), data);
}

// Update editable fields on a vehicle.
export async function updateVehicle(id, { registration, description, assignedToUid }) {
  const data = {
    registration: registration.trim().toUpperCase(),
    description:  description.trim(),
    assignedToUid: assignedToUid || null,
    updatedAt: serverTimestamp(),
  };
  await updateDoc(doc(db, COL, id), data);
}

// Soft-delete: sets active = false. Financial records referencing this vehicle are unaffected.
export async function deactivateVehicle(id) {
  await updateDoc(doc(db, COL, id), { active: false, updatedAt: serverTimestamp() });
}

// Re-activate a previously deactivated vehicle.
export async function activateVehicle(id) {
  await updateDoc(doc(db, COL, id), { active: true, updatedAt: serverTimestamp() });
}
