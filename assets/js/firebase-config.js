/* ============================================================
   APEX KARTING LEAGUE — Firebase project config
   Not a secret: Firebase web config identifies the project to
   Google's servers, it doesn't grant access by itself. Actual
   write access is enforced server-side by firestore.rules.
   EDITOR_ALLOWLIST here is a client-side convenience copy (used
   only to show/hide the Editor's forms) — keep it in sync with
   the allowlist in firestore.rules by hand; it is NOT the
   security boundary.
   ============================================================ */

export const firebaseConfig = {
  apiKey: "AIzaSyAUJKqWfpqij40FT-pLo--prQjG-6dPgIs",
  authDomain: "apexkarting-f9b86.firebaseapp.com",
  projectId: "apexkarting-f9b86",
  storageBucket: "apexkarting-f9b86.firebasestorage.app",
  messagingSenderId: "520356954998",
  appId: "1:520356954998:web:83421ed930901ea878b057",
  measurementId: "G-EEN3QWSR2K",
};

export const EDITOR_ALLOWLIST = ["aidannaidoo2801@gmail.com", "ktml.dev@gmail.com", "mzshaik1@gmail.com", "daiyaanmanique1@gmail.com"];
