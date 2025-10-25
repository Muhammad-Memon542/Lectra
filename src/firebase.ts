// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";


// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyD9Z5A7UgJEJjv7yo2qzPSgWU7y4ib07_E",
  authDomain: "lectra-a03f1.firebaseapp.com",
  projectId: "lectra-a03f1",
  storageBucket: "lectra-a03f1.firebasestorage.app",
  messagingSenderId: "128548320011",
  appId: "1:128548320011:web:ef714cd3a1a5d26d77680e"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);


