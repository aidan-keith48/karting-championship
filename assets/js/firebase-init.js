/* ============================================================
   APEX KARTING LEAGUE — Firebase bootstrap
   ES module (type="module" in index.html), loaded before app.js
   and editor.js. Those two are plain classic scripts (no bundler,
   no build step, by this codebase's long-standing convention), so
   this module's whole job is to initialize Firebase once and hang
   everything they need off `window` — same "shared global scope"
   pattern app.js/editor.js already use with each other.

   Module scripts execute after the document is parsed but before
   DOMContentLoaded fires, and app.js/editor.js only touch Firebase
   from inside their own DOMContentLoaded handlers — so by the time
   they run, window.db/window.auth/window.fb are guaranteed to
   exist. No async race to worry about.

   Local testing against the Firebase Emulator Suite instead of the
   real project: open the page with ?emulator=1 in the URL. Without
   that flag, even localhost talks to the real apexkarting-f9b86
   project (fine — reads are public, writes need an allowlisted
   Google sign-in either way).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  connectAuthEmulator,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  collection,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, EDITOR_ALLOWLIST } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const useEmulator = new URLSearchParams(location.search).get("emulator") === "1";
if (useEmulator) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

window.auth = auth;
window.db = db;
window.EDITOR_ALLOWLIST = EDITOR_ALLOWLIST;
// Firestore helper functions, namespaced since editor.js/app.js are plain
// scripts and can't `import` these themselves.
window.fb = { doc, getDoc, setDoc, deleteDoc, onSnapshot, collection, writeBatch };

// Lowercased comparison, matching firestore.rules — Gmail addresses are
// case-insensitive and Google's reported casing isn't guaranteed stable.
const editorAllowlistLower = new Set(EDITOR_ALLOWLIST.map((e) => e.toLowerCase()));
window.isAllowlisted = (email) => !!email && editorAllowlistLower.has(email.toLowerCase());

window.fbSignInWithGoogle = () => signInWithPopup(auth, provider);
window.fbSignOut = () => signOut(auth);

// currentUser mirrors auth.currentUser but is available synchronously without
// reaching into the SDK; 'fb-auth-changed' lets editor.js react without
// importing onAuthStateChanged itself.
window.currentUser = null;
onAuthStateChanged(auth, (user) => {
  window.currentUser = user;
  window.dispatchEvent(new CustomEvent("fb-auth-changed", { detail: user }));
});
