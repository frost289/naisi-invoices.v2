import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

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