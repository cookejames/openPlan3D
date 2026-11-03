import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  readOnly, readOnlyReason, setEditLockReadOnly, setMobileReadOnly, enableMobileEditing,
  isMobileBrowser, initMobileReadOnly, resetMobileReadOnly,
} from '$lib/stores/readOnly';

const win = (coarse: boolean, innerWidth: number, innerHeight: number) =>
  ({ matchMedia: (q: string) => ({ matches: coarse && q === '(pointer: coarse)' }), innerWidth, innerHeight }) as never;

const reset = () => { readOnly.set(false); setEditLockReadOnly(false); resetMobileReadOnly(); };
beforeEach(reset);
afterEach(reset);

describe('mobile read-only', () => {
  it('detects any touch-primary device whatever its size or orientation', () => {
    expect(isMobileBrowser(win(true, 390, 844))).toBe(true);   // phone, portrait
    expect(isMobileBrowser(win(true, 844, 390))).toBe(true);   // phone, landscape
    expect(isMobileBrowser(win(true, 800, 830))).toBe(true);   // unfolded foldable
    expect(isMobileBrowser(win(true, 1366, 1024))).toBe(true); // large tablet
    expect(isMobileBrowser(win(false, 1366, 1024))).toBe(false); // mouse/trackpad, incl. touchscreen laptops
    expect(isMobileBrowser(undefined)).toBe(false);
  });

  it('is off on the server / without a window', () => {
    initMobileReadOnly();
    expect(get(readOnly)).toBe(false);
  });

  it('makes the editor read-only with reason mobile, and enableMobileEditing clears it', () => {
    setMobileReadOnly(true);
    expect(get(readOnly)).toBe(true);
    expect(get(readOnlyReason)).toBe('mobile');
    enableMobileEditing();
    expect(get(readOnly)).toBe(false);
    expect(get(readOnlyReason)).toBeNull();
  });

  it('ranks share > lock > mobile and keeps the sources independent', () => {
    setMobileReadOnly(true);
    setEditLockReadOnly(true);
    expect(get(readOnlyReason)).toBe('lock');
    readOnly.set(true);
    expect(get(readOnlyReason)).toBe('share');
    // leaving the share view or the lock does not clear the mobile default
    readOnly.set(false);
    setEditLockReadOnly(false);
    expect(get(readOnlyReason)).toBe('mobile');
    // enabling editing does not clear share or lock
    setEditLockReadOnly(true);
    readOnly.set(true);
    enableMobileEditing();
    expect(get(readOnlyReason)).toBe('share');
    readOnly.set(false);
    expect(get(readOnlyReason)).toBe('lock');
  });
});
