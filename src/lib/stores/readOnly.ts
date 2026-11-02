import { writable } from 'svelte/store';

/**
 * True while a public share link is open. Nothing about the open project is then
 * persisted (IndexedDB, version history, thumbnails, cloud) and edits are refused,
 * until the viewer explicitly saves a copy.
 */
export const readOnly = writable(false);
