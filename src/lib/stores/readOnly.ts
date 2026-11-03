import { derived, get, writable, type Readable } from 'svelte/store';

const shareActive = writable(false);
const lockActive = writable(false);

/**
 * True whenever edits are refused: a public share link is open (nothing is persisted until the viewer
 * saves a copy), or another session holds the soft edit lock of a cloud project. Every write gate and
 * save guard reads this one store. `set` is owned by the share view; the edit lock uses `setEditLockReadOnly`,
 * so neither can clear the other's state.
 */
export const readOnly: Readable<boolean> & { set(value: boolean): void } = {
  ...derived([shareActive, lockActive], ([s, l]) => s || l),
  set(value: boolean) { shareActive.set(value); },
};

/** Why the editor is read-only; the share view wins when both apply. */
export const readOnlyReason: Readable<'share' | 'lock' | null> =
  derived([shareActive, lockActive], ([s, l]) => (s ? 'share' : l ? 'lock' : null));

export function setEditLockReadOnly(value: boolean) { lockActive.set(value); }
export const isEditLockReadOnly = () => get(lockActive);
