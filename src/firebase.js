import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyACgsYqYfrZVZ2qL_UvtQXu6bPpY48qeZw",
  authDomain: "naisi-invoices.firebaseapp.com",
  projectId: "naisi-invoices",
  storageBucket: "naisi-invoices.firebasestorage.app",
  messagingSenderId: "555183502792",
  appId: "1:555183502792:web:a9e1d1329e45eedc43bcfd",
  measurementId: "G-0P2DVL3YXP"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Local testing only: build/run with VITE_USE_EMULATORS=true to talk to the Firebase Emulator Suite
// (Firestore on 8080, Auth on 9099) instead of the live project. Without that flag nothing changes.
if (import.meta.env && import.meta.env.VITE_USE_EMULATORS === 'true') {
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}