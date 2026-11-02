import { env } from '$env/dynamic/public';
import { initializeApp, type FirebaseApp } from 'firebase/app';
import { browserLocalPersistence, initializeAuth, type Auth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';
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

export const auth: Auth | null = app
  ? initializeAuth(app, { persistence: browserLocalPersistence })
  : null;

export const db: Firestore | null = app
  ? initializeFirestore(app, { localCache: persistentLocalCache() })
  : null;

export const storage: FirebaseStorage | null = app ? getStorage(app) : null;

// Analytics needs a measurement id and a browser that supports it.
export const analytics: Promise<Analytics | null> =
  app && firebaseConfig.measurementId
    ? isSupported().then((yes) => (yes ? getAnalytics(app) : null))
    : Promise.resolve(null);
