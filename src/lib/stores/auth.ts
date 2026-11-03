import { readable, writable, type Readable, type Writable } from 'svelte/store';
import { auth } from '$lib/firebase';
import {
  GoogleAuthProvider,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendSignInLinkToEmail,
  signInWithEmailLink,
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

// ---- Passwordless email-link sign-in ----

const EMAIL_KEY = 'o3d_emailForSignIn';
const LINK_PARAMS = ['apiKey', 'oobCode', 'mode', 'lang', 'continueUrl'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailLinkState = 'idle' | 'completing' | 'needsEmail' | 'error';
export type EmailLinkResult = 'none' | 'signedIn' | 'needsEmail';

export const emailLinkState: Writable<EmailLinkState> = writable('idle');
/** Firebase error code of the last failed completion, for the UI. */
export const emailLinkError: Writable<string | null> = writable(null);

function invalidEmailError(): Error & { code: string } {
  return Object.assign(new Error('Invalid email address'), { code: 'invalid-email' });
}

function strippedParams(params: URLSearchParams): string {
  const copy = new URLSearchParams(params);
  for (const key of LINK_PARAMS) copy.delete(key);
  const query = copy.toString();
  return query ? `?${query}` : '';
}

export async function sendEmailLink(rawEmail: string): Promise<void> {
  if (!auth) return;
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw invalidEmailError();
  const url = location.origin + location.pathname + strippedParams(new URLSearchParams(location.search));
  await sendSignInLinkToEmail(auth, email, { url, handleCodeInApp: true });
  try { localStorage.setItem(EMAIL_KEY, email); } catch { /* storage unavailable */ }
}

export async function completeEmailLinkSignIn(emailOverride?: string): Promise<EmailLinkResult> {
  if (!auth || !isSignInWithEmailLink(auth, location.href)) return 'none';
  let email = emailOverride?.trim().toLowerCase();
  if (!email) {
    try { email = localStorage.getItem(EMAIL_KEY) ?? undefined; } catch { /* storage unavailable */ }
  }
  if (!email) {
    emailLinkState.set('needsEmail');
    return 'needsEmail';
  }
  emailLinkState.set('completing');
  emailLinkError.set(null);
  try {
    await signInWithEmailLink(auth, email, location.href);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    emailLinkError.set(typeof code === 'string' ? code : 'unknown');
    // A mismatched email can be retried on the same link; anything else is terminal.
    emailLinkState.set(code === 'auth/invalid-email' ? 'needsEmail' : 'error');
    throw error;
  }
  try { localStorage.removeItem(EMAIL_KEY); } catch { /* storage unavailable */ }
  try {
    history.replaceState(history.state, '', location.pathname + strippedParams(new URLSearchParams(location.search)) + location.hash);
  } catch { /* ignore */ }
  emailLinkState.set('idle');
  return 'signedIn';
}

let startupAttempted = false;
/** Completes a sign-in if the page was opened from an email link. Runs at most once per page load. */
export async function completeEmailLinkOnLoad(): Promise<void> {
  if (startupAttempted) return;
  startupAttempted = true;
  try {
    await completeEmailLinkSignIn();
  } catch (error) {
    console.error('Email-link sign-in failed', error);
  }
}
