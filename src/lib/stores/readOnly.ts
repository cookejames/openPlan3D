import { derived, get, writable, type Readable } from 'svelte/store';

const shareActive = writable(false);
const lockActive = writable(false);
const mobileActive = writable(false);

/**
 * True whenever edits are refused: a public share link is open (nothing is persisted until the viewer
 * saves a copy), another session holds the soft edit lock of a cloud project, or a mobile browser has not
 * yet opted in to editing. Every write gate and save guard reads this one store. `set` is owned by the share
 * view; the edit lock uses `setEditLockReadOnly` and the mobile default `setMobileReadOnly`, so none can clear
 * another's state.
 */
export const readOnly: Readable<boolean> & { set(value: boolean): void } = {
  ...derived([shareActive, lockActive, mobileActive], ([s, l, m]) => s || l || m),
  set(value: boolean) { shareActive.set(value); },
};

export type ReadOnlyReason = 'share' | 'lock' | 'mobile';

/** Why the editor is read-only; precedence share > lock > mobile. */
export const readOnlyReason: Readable<ReadOnlyReason | null> =
  derived([shareActive, lockActive, mobileActive], ([s, l, m]) => (s ? 'share' : l ? 'lock' : m ? 'mobile' : null));

export function setEditLockReadOnly(value: boolean) { lockActive.set(value); }
export const isEditLockReadOnly = () => get(lockActive);

/** True while the mobile view-only default is on, whatever else makes the editor read-only. */
export const mobileReadOnly: Readable<boolean> = { subscribe: mobileActive.subscribe };
export function setMobileReadOnly(value: boolean) { mobileActive.set(value); }
/** The "Enable editing" action: clears only the mobile source for this session. */
export const enableMobileEditing = () => mobileActive.set(false);

/**
 * Touch is the primary input: phones in either orientation, foldables folded or unfolded, and tablets of
 * any size. Touchscreen laptops report their trackpad as primary, so they stay editable. SSR-safe.
 */
export function isMobileBrowser(win: Pick<Window, 'matchMedia'> | undefined =
  typeof window === 'undefined' ? undefined : window): boolean {
  return !!win?.matchMedia && win.matchMedia('(pointer: coarse)').matches;
}

let mobileChecked = false;
/** Once per page session, so retrying the editor load never undoes "Enable editing". */
export function initMobileReadOnly() {
  if (mobileChecked) return;
  mobileChecked = true;
  if (isMobileBrowser()) mobileActive.set(true);
}
/** Test hook. */
export function resetMobileReadOnly() { mobileChecked = false; mobileActive.set(false); }
