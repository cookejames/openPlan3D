import { env } from '$env/dynamic/public';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, browserPopupRedirectResolver, connectAuthEmulator, GoogleAuthProvider, initializeAuth, signInWithCredential, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, type Firestore } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, type FirebaseStorage } from 'firebase/storage';
import { getAnalytics, isSupported, type Analytics } from 'firebase/analytics';

const firebaseConfig = {
  apiKey: env.PUBLIC_FIREBASE_API_KEY ?? '',
  authDomain: env.PUBLIC_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: env.PUBLIC_FIREBASE_PROJECT_ID ?? '',
  storageBucket: env.PUBLIC_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: env.PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: env.PUBLIC_FIREBASE_APP_ID ?? '',
  measurementId: env.PUBLIC_FIREBASE_MEASUREMENT_ID || undefined,
};

// Cloud sync is off unless the core config is provided; the app then stays local-only.
export const firebaseEnabled = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

// Firebase is client-only: SSR and prerender get nulls.
const isBrowser = typeof window !== 'undefined';

export const app: FirebaseApp | null =
  firebaseEnabled && isBrowser ? initializeApp(firebaseConfig) : null;

// Dev/test only: point the SDKs at the local Firebase emulators (see `npm run test:e2e:cloud`).
export const useEmulators = env.PUBLIC_FIREBASE_USE_EMULATORS === 'true';

export const auth: Auth | null = app
  // initializeAuth, unlike getAuth, omits the popup resolver; signInWithPopup fails without it.
  ? initializeAuth(app, { persistence: browserLocalPersistence, popupRedirectResolver: browserPopupRedirectResolver })
  : null;

export const db: Firestore | null = app
  ? initializeFirestore(app, { localCache: useEmulators ? memoryLocalCache() : persistentLocalCache() })
  : null;

export const storage: FirebaseStorage | null = app ? getStorage(app) : null;

if (useEmulators && auth && db && storage) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectStorageEmulator(storage, '127.0.0.1', 9199);

  // Test-only sign-in without the Google popup: window.__o3dTestSignIn(email) signs in a verified
  // account on the Auth emulator. It exists only when PUBLIC_FIREBASE_USE_EMULATORS=true, which is
  // never set for a real deployment (and the emulator rejects nothing a real project would accept).
  (window as unknown as { __o3dTestSignIn?: (email: string) => Promise<void> }).__o3dTestSignIn = async (email) => {
    const idToken = JSON.stringify({ sub: email, email, email_verified: true });
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  };
}

// Analytics needs a measurement id and a browser that supports it.
export const analytics: Promise<Analytics | null> =
  app && firebaseConfig.measurementId
    ? isSupported().then((yes) => (yes ? getAnalytics(app) : null))
    : Promise.resolve(null);
