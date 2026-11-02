import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import type { User } from 'firebase/auth';

const fake = vi.hoisted(() => ({
  auth: null as null | { currentUser: unknown },
  onAuthStateChanged: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
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
});

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
