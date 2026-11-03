import { localStore } from './datastore';
import { cloudStore } from './cloudStore';
import { createSyncStore, type SyncStore } from './syncStore';
import { currentUser } from '$lib/stores/auth';
import { readSyncMeta, writeSyncMeta, deleteSyncMeta } from './localDatabase';

/** The app's project store: local-first, syncing to the cloud when Firebase is configured and the user is signed in. */
export const projectStore: SyncStore = createSyncStore({
  local: localStore,
  cloud: cloudStore,
  user: currentUser,
  meta: { read: readSyncMeta, write: writeSyncMeta, remove: deleteSyncMeta },
});
