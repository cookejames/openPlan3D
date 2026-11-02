import { derived, get, writable } from 'svelte/store';
import { currentProject, loadProject } from './project';
import { saveState, markClean, autoSave } from './saveStatus';
import { authState } from './auth';
import { readOnly, readOnlyReason } from './readOnly';
import { projectStore } from '$lib/services/projectStore';
import { storageErrorMessage } from '$lib/services/datastore';

/** A newer cloud revision written by someone else, offered as a non-blocking "Reload" notice. */
export const remoteChange = writable<{ id: string; updatedBy: string } | null>(null);
export const syncBusy = writable(false);
export const syncError = writable<string | null>(null);
/** Name of the copy made by "Keep mine as a copy", shown as a confirmation. */
export const keptCopyName = writable<string | null>(null);

/** Pure decision for a delivered remote change: notice when nothing is pending, otherwise conflict. */
export function handleRemoteChange(id: string, change: { updatedBy: string }) {
  if (get(currentProject)?.id !== id) return;
  const status = get(projectStore.syncStatus)[id];
  if (status === 'conflict') return;
  // Locked view (another session is editing): follow the holder silently, no notice.
  if (get(readOnlyReason) === 'lock') { void reloadLatest(); return; }
  const pending = get(saveState) !== 'saved' || status === 'syncing' || status === 'offline' || status === 'error';
  if (pending) {
    projectStore.markConflict(id);
    remoteChange.set(null);
  } else {
    remoteChange.set({ id, updatedBy: change.updatedBy });
  }
}

async function adoptLatest(id: string, project: Awaited<ReturnType<typeof projectStore.loadLatest>>) {
  if (get(currentProject)?.id !== id) return false;
  loadProject(project);
  markClean();
  remoteChange.set(null);
  return true;
}

async function run(work: () => Promise<void>): Promise<boolean> {
  if (get(syncBusy)) return false;
  syncBusy.set(true);
  syncError.set(null);
  try { await work(); return true; }
  catch (error) { syncError.set(storageErrorMessage(error)); return false; }
  finally { syncBusy.set(false); }
}

/** Discards local unsynced edits and shows the cloud's latest revision. */
export function reloadLatest(): Promise<boolean> {
  const id = get(currentProject)?.id;
  if (!id) return Promise.resolve(false);
  keptCopyName.set(null);
  return run(async () => { await adoptLatest(id, await projectStore.loadLatest(id)); });
}

/** Saves the local version as a copy, then opens the latest original. */
export function keepMineAsCopy(): Promise<boolean> {
  const id = get(currentProject)?.id;
  if (!id) return Promise.resolve(false);
  return run(async () => {
    // Unsaved in-memory edits must reach disk first, since the copy is taken from the stored version.
    if (get(saveState) !== 'saved' && !(await autoSave())) throw new Error('Could not save your edits locally.');
    const copy = await projectStore.keepMineAsCopy(id);
    const latest = await projectStore.load(id);
    if (!latest) throw new Error('Project not found');
    if (await adoptLatest(id, latest)) keptCopyName.set(copy.name);
  });
}

/** Watch the open project for remote changes; resubscribes when the project id or auth changes. */
export function startCloudWatch(): () => void {
  if (get(readOnly)) return () => {};
  let unwatch: (() => void) | null = null;
  const target = derived([currentProject, authState], ([p, a]) => `${a.status === 'signedIn' ? a.user.uid : ''}|${p?.id ?? ''}`);
  let lastId = '';
  const stopTarget = target.subscribe(key => {
    unwatch?.();
    unwatch = null;
    const id = key.split('|')[1];
    if (id !== lastId) { lastId = id; remoteChange.set(null); keptCopyName.set(null); syncError.set(null); }
    if (!key.startsWith('|') && id) unwatch = projectStore.watch(id, change => handleRemoteChange(id, change));
  });
  return () => { stopTarget(); unwatch?.(); unwatch = null; };
}
