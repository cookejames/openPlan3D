import { readable, type Readable } from 'svelte/store';
import { auth } from '$lib/firebase';
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';

export interface AuthUser { uid: string; email: string; displayName: string | null; photoURL: string | null }
export type AuthState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; user: AuthUser };

const SILENT_POPUP_ERRORS = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];

// The security rules require a verified email, so unverified accounts count as signed out.
function toAuthUser(user: User | null): AuthUser | null {
  if (!user || !user.email || user.emailVerified === false) return null;
  return {
    uid: user.uid,
    email: user.email.toLowerCase(),
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

export const authState: Readable<AuthState> = readable<AuthState>(
  auth ? { status: 'loading' } : { status: 'disabled' },
  (set) => {
    if (!auth) return;
    return onAuthStateChanged(auth, (user) => {
      const signedIn = toAuthUser(user);
      set(signedIn ? { status: 'signedIn', user: signedIn } : { status: 'signedOut' });
    });
  }
);

export async function signIn(): Promise<void> {
  if (!auth) return;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && SILENT_POPUP_ERRORS.includes(code)) return;
    throw error;
  }
}

export async function signOut(): Promise<void> {
  if (!auth) return;
  await firebaseSignOut(auth);
}

/** Synchronous snapshot of the signed-in user, or null when signed out or disabled. */
export function currentUser(): AuthUser | null {
  return toAuthUser(auth?.currentUser ?? null);
}
