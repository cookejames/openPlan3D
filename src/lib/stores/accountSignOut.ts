import { get } from 'svelte/store';
import { currentUser, signOut } from './auth';
import { currentProject } from './project';
import { saveState, autoSave } from './saveStatus';
import { readOnly } from './readOnly';
import { releaseEditLock } from './editLock';
import { projectStore } from '$lib/services/projectStore';

/**
 * First step of signing out: saves the open plan and pushes waiting edits. Resolves to the cloud plans whose
 * changes are still only in this browser; signing out removes them, so the caller asks before going on.
 */
export async function prepareSignOut(): Promise<{ id: string; name: string }[]> {
  if (get(currentProject) && !get(readOnly) && get(saveState) !== 'saved') await autoSave();
  return projectStore.unsyncedProjects();
}

/** Releases the edit lock while still signed in, signs out, then removes this browser's copies of the account's cloud plans. */
export async function signOutAndClear(): Promise<void> {
  const uid = currentUser()?.uid;
  await releaseEditLock();
  await signOut();
  if (uid) await projectStore.discardCloudCopies(uid);
}
