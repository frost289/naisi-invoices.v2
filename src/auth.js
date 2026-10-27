import { auth } from './firebase.js';
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, inMemoryPersistence
} from 'firebase/auth';

// Session lives only in memory for this page load. Refreshing, closing
// the tab, or reopening the browser all require signing in again.
const persistenceReady = setPersistence(auth, inMemoryPersistence);

export function watchAuth(onSignedIn, onSignedOut) {
  persistenceReady.finally(() => {
    onAuthStateChanged(auth, (user) => {
      if (user) onSignedIn(user);
      else onSignedOut();
    });
  });
}

export async function login(email, password) {
  await setPersistence(auth, inMemoryPersistence);
  await signInWithEmailAndPassword(auth, email, password);
}

export async function logout() {
  await signOut(auth);
}