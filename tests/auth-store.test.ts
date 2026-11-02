import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { User } from 'firebase/auth';

const fake = vi.hoisted(() => ({
  auth: null as null | { currentUser: unknown },
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  sendSignInLinkToEmail: vi.fn(),
  isSignInWithEmailLink: vi.fn(),
  signInWithEmailLink: vi.fn(),
  setCustomParameters: vi.fn(),
  GoogleAuthProvider: class {
    setCustomParameters(params: unknown) { fake.setCustomParameters(params); }
  },
}));

vi.mock('$lib/firebase', () => ({
  get auth() { return fake.auth; },
}));

vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: fake.GoogleAuthProvider,
  onAuthStateChanged: fake.onAuthStateChanged,
  signInWithPopup: fake.signInWithPopup,
  signOut: fake.signOut,
  sendSignInLinkToEmail: fake.sendSignInLinkToEmail,
  isSignInWithEmailLink: fake.isSignInWithEmailLink,
  signInWithEmailLink: fake.signInWithEmailLink,
}));

function user(overrides: Partial<User> = {}): User {
  return {
    uid: 'uid-1',
    email: 'Jane.Doe@Example.com',
    emailVerified: true,
    displayName: 'Jane',
    photoURL: 'https://img.example/jane.png',
    ...overrides,
  } as User;
}

async function loadStore(auth: typeof fake.auth = { currentUser: null }) {
  vi.resetModules();
  fake.auth = auth;
  return import('../src/lib/stores/auth');
}

beforeEach(() => {
  fake.onAuthStateChanged.mockReset();
  fake.signInWithPopup.mockReset().mockResolvedValue(undefined);
  fake.signOut.mockReset().mockResolvedValue(undefined);
  fake.setCustomParameters.mockReset();
  fake.sendSignInLinkToEmail.mockReset().mockResolvedValue(undefined);
  fake.isSignInWithEmailLink.mockReset().mockReturnValue(true);
  fake.signInWithEmailLink.mockReset().mockResolvedValue(undefined);
  stubBrowser();
});

// The suite runs in a node environment, so provide minimal location/history/localStorage fakes.
function stubBrowser() {
  const items = new Map<string, string>();
  const loc = { origin: 'https://app.test', pathname: '/', search: '', hash: '', get href() { return this.origin + this.pathname + this.search + this.hash; } };
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', {
    state: null,
    replaceState(_s: unknown, _t: string, url: string) {
      const u = new URL(url, 'https://app.test');
      loc.pathname = u.pathname; loc.search = u.search; loc.hash = u.hash;
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => { items.set(k, v); },
    removeItem: (k: string) => { items.delete(k); },
  });
}

describe('auth store', () => {
  it('is disabled without Firebase auth and never subscribes', async () => {
    const store = await loadStore(null);
    expect(get(store.authState)).toEqual({ status: 'disabled' });
    expect(fake.onAuthStateChanged).not.toHaveBeenCalled();
    await expect(store.signIn()).resolves.toBeUndefined();
    await expect(store.signOut()).resolves.toBeUndefined();
    expect(fake.signInWithPopup).not.toHaveBeenCalled();
    expect(fake.signOut).not.toHaveBeenCalled();
    expect(store.currentUser()).toBeNull();
  });

  it('starts loading, then follows the auth callback to a signed-in user with a lower-cased email', async () => {
    const store = await loadStore();
    let captured: ((u: User | null) => void) | undefined;
    const unsubscribe = vi.fn();
    fake.onAuthStateChanged.mockImplementation((_auth, cb) => { captured = cb; return unsubscribe; });

    const seen: unknown[] = [];
    const stop = store.authState.subscribe((s) => seen.push(s));
    expect(seen[0]).toEqual({ status: 'loading' });
    expect(fake.onAuthStateChanged).toHaveBeenCalledTimes(1);

    captured!(user());
    expect(seen[seen.length - 1]).toEqual({
      status: 'signedIn',
      user: { uid: 'uid-1', email: 'jane.doe@example.com', displayName: 'Jane', photoURL: 'https://img.example/jane.png' },
    });

    captured!(null);
    expect(seen[seen.length - 1]).toEqual({ status: 'signedOut' });

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('treats a user with an unverified or missing email as signed out', async () => {
    const store = await loadStore();
    let captured: ((u: User | null) => void) | undefined;
    fake.onAuthStateChanged.mockImplementation((_auth, cb) => { captured = cb; return () => {}; });
    const stop = store.authState.subscribe(() => {});

    captured!(user({ emailVerified: false }));
    expect(get(store.authState)).toEqual({ status: 'signedOut' });

    captured!(user({ email: null }));
    expect(get(store.authState)).toEqual({ status: 'signedOut' });
    stop();
  });

  it('signs in with a Google popup that prompts for account selection', async () => {
    const store = await loadStore();
    await store.signIn();
    expect(fake.setCustomParameters).toHaveBeenCalledWith({ prompt: 'select_account' });
    expect(fake.signInWithPopup).toHaveBeenCalledWith(fake.auth, expect.any(Object));
  });

  it('swallows popup-closed and cancelled-request errors', async () => {
    const store = await loadStore();
    for (const code of ['auth/popup-closed-by-user', 'auth/cancelled-popup-request']) {
      fake.signInWithPopup.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(store.signIn()).resolves.toBeUndefined();
    }
  });

  it('rethrows other sign-in errors', async () => {
    const store = await loadStore();
    const failure = Object.assign(new Error('blocked'), { code: 'auth/popup-blocked' });
    fake.signInWithPopup.mockRejectedValueOnce(failure);
    await expect(store.signIn()).rejects.toBe(failure);
  });

  it('signs out through Firebase when enabled', async () => {
    const store = await loadStore();
    await store.signOut();
    expect(fake.signOut).toHaveBeenCalledWith(fake.auth);
  });

  it('returns a synchronous snapshot of the current verified user', async () => {
    const store = await loadStore();
    expect(store.currentUser()).toBeNull();

    fake.auth!.currentUser = user();
    expect(store.currentUser()).toEqual({
      uid: 'uid-1',
      email: 'jane.doe@example.com',
      displayName: 'Jane',
      photoURL: 'https://img.example/jane.png',
    });

    fake.auth!.currentUser = user({ emailVerified: false });
    expect(store.currentUser()).toBeNull();
  });
});

describe('email-link sign-in', () => {
  it('normalises the email, sends the link with a stripped return URL and stores the email', async () => {
    const store = await loadStore();
    history.replaceState(null, '', '/editor?id=abc&apiKey=k&oobCode=c&mode=signIn&lang=en&continueUrl=x');
    await store.sendEmailLink('  Jane.Doe@Example.com ');
    expect(fake.sendSignInLinkToEmail).toHaveBeenCalledWith(
      fake.auth,
      'jane.doe@example.com',
      { url: `${location.origin}/editor?id=abc`, handleCodeInApp: true },
    );
    expect(localStorage.getItem('o3d_emailForSignIn')).toBe('jane.doe@example.com');
  });

  it('rejects invalid emails without calling Firebase', async () => {
    const store = await loadStore();
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com']) {
      await expect(store.sendEmailLink(bad)).rejects.toMatchObject({ code: 'invalid-email' });
    }
    expect(fake.sendSignInLinkToEmail).not.toHaveBeenCalled();
  });

  it('does not store the email when sending fails', async () => {
    const store = await loadStore();
    fake.sendSignInLinkToEmail.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/too-many-requests' }));
    await expect(store.sendEmailLink('a@b.co')).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    expect(localStorage.getItem('o3d_emailForSignIn')).toBeNull();
  });

  it('is a no-op when auth is disabled', async () => {
    const store = await loadStore(null);
    await expect(store.sendEmailLink('a@b.co')).resolves.toBeUndefined();
    await expect(store.completeEmailLinkSignIn()).resolves.toBe('none');
    expect(fake.sendSignInLinkToEmail).not.toHaveBeenCalled();
    expect(localStorage.getItem('o3d_emailForSignIn')).toBeNull();
  });

  it('returns none when the URL is not a sign-in link', async () => {
    const store = await loadStore();
    fake.isSignInWithEmailLink.mockReturnValue(false);
    await expect(store.completeEmailLinkSignIn()).resolves.toBe('none');
    expect(fake.signInWithEmailLink).not.toHaveBeenCalled();
  });

  it('returns needsEmail when no email is stored', async () => {
    const store = await loadStore();
    await expect(store.completeEmailLinkSignIn()).resolves.toBe('needsEmail');
    expect(get(store.emailLinkState)).toBe('needsEmail');
    expect(fake.signInWithEmailLink).not.toHaveBeenCalled();
  });

  it('signs in with the stored email, clears it and cleans the URL but keeps other params', async () => {
    const store = await loadStore();
    localStorage.setItem('o3d_emailForSignIn', 'jane@example.com');
    history.replaceState(null, '', '/editor?id=abc&apiKey=k&oobCode=c&mode=signIn&lang=en');
    const href = location.href;
    await expect(store.completeEmailLinkSignIn()).resolves.toBe('signedIn');
    expect(fake.signInWithEmailLink).toHaveBeenCalledWith(fake.auth, 'jane@example.com', href);
    expect(localStorage.getItem('o3d_emailForSignIn')).toBeNull();
    expect(location.pathname + location.search).toBe('/editor?id=abc');
    expect(get(store.emailLinkState)).toBe('idle');
  });

  it('uses the override email', async () => {
    const store = await loadStore();
    localStorage.setItem('o3d_emailForSignIn', 'stored@example.com');
    history.replaceState(null, '', '/?oobCode=c&mode=signIn');
    await store.completeEmailLinkSignIn(' Other@Example.com ');
    expect(fake.signInWithEmailLink).toHaveBeenCalledWith(fake.auth, 'other@example.com', expect.any(String));
    expect(location.search).toBe('');
  });

  it('propagates Firebase errors and records them for the UI', async () => {
    const store = await loadStore();
    localStorage.setItem('o3d_emailForSignIn', 'jane@example.com');
    const failure = Object.assign(new Error('used'), { code: 'auth/invalid-action-code' });
    fake.signInWithEmailLink.mockRejectedValueOnce(failure);
    await expect(store.completeEmailLinkSignIn()).rejects.toBe(failure);
    expect(get(store.emailLinkState)).toBe('error');
    expect(get(store.emailLinkError)).toBe('auth/invalid-action-code');
    expect(localStorage.getItem('o3d_emailForSignIn')).toBe('jane@example.com');
  });

  it('asks again when the email does not match the link', async () => {
    const store = await loadStore();
    fake.signInWithEmailLink.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'auth/invalid-email' }));
    await expect(store.completeEmailLinkSignIn('wrong@example.com')).rejects.toBeDefined();
    expect(get(store.emailLinkState)).toBe('needsEmail');
  });

  it('completes on load only once', async () => {
    const store = await loadStore();
    localStorage.setItem('o3d_emailForSignIn', 'jane@example.com');
    await store.completeEmailLinkOnLoad();
    await store.completeEmailLinkOnLoad();
    expect(fake.signInWithEmailLink).toHaveBeenCalledTimes(1);
  });
});
