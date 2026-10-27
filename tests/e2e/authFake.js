// Browser stand-in for firebase/auth: any email with the password "pw" signs in.
// The session is in memory only (like the real app), so a page refresh signs out.
const listeners = new Set();
const auth = { currentUser: null };
const emit = () => listeners.forEach(cb => cb(auth.currentUser));
export const getAuth = () => auth;
export class GoogleAuthProvider {}
export const inMemoryPersistence = {};
export const setPersistence = async () => {};
export function onAuthStateChanged(_a, cb) { listeners.add(cb); queueMicrotask(() => cb(auth.currentUser)); return () => listeners.delete(cb); }
export async function signInWithEmailAndPassword(_a, email, password) {
  if (password !== 'pw') { const e = new Error('Firebase: Error (auth/invalid-credential).'); e.code = 'auth/invalid-credential'; throw e; }
  auth.currentUser = { uid: 'u_' + email.split('@')[0], email };
  emit();
  return { user: auth.currentUser };
}
export async function signOut() { auth.currentUser = null; emit(); }
export function connectAuthEmulator() {}
