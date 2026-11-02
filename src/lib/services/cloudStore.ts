import {
  collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, query, runTransaction, serverTimestamp,
  setDoc, Timestamp, updateDoc, where, type DocumentData, type Firestore,
} from 'firebase/firestore';
import {
  deleteObject, getBytes, listAll, ref, uploadBytes, type FirebaseStorage,
} from 'firebase/storage';
import { db, storage } from '$lib/firebase';
import { currentUser } from '$lib/stores/auth';
import { ProjectConflictError } from '$lib/services/datastore';
import type { Project } from '$lib/models/types';

export type CloudProjectMeta = {
  id: string;
  name: string;
  ownerUid: string;
  editorEmails: string[];
  rev: number;
  planPath: string;
  thumbPath: string | null;
  sizeBytes: number;
  updatedAt: Date | null;
  updatedBy: string;
  shareToken: string | null;
};

export interface CloudStoreDeps {
  db: Firestore;
  storage: FirebaseStorage;
  user: () => { uid: string; email: string } | null;
}

const MAX_FALLBACK = 10;
// Every upload attempt gets its own object, so a losing writer can never touch the winner's bytes.
function revPath(id: string, rev: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `projects/${id}/revs/${rev}-${nonce}.json`;
}
/** Leading integer of a revision object name (`7-ab12.json` -> 7), or null. */
function revOfName(name: string): number | null {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : null;
}

function isPermissionDenied(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'permission-denied';
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'storage/object-not-found';
}

function toMeta(id: string, data: DocumentData): CloudProjectMeta {
  const at = data.updatedAt;
  return {
    id,
    name: data.name,
    ownerUid: data.ownerUid,
    editorEmails: data.editorEmails ?? [],
    rev: data.rev,
    planPath: data.planPath,
    thumbPath: data.thumbPath ?? null,
    sizeBytes: data.sizeBytes ?? 0,
    updatedAt: at instanceof Timestamp ? at.toDate() : null,
    updatedBy: data.updatedBy ?? '',
    shareToken: data.shareToken ?? null,
  };
}

export function createCloudStore(deps: CloudStoreDeps) {
  const { db, storage } = deps;
  const projectDoc = (id: string) => doc(db, 'projects', id);
  const me = () => {
    const user = deps.user();
    if (!user) throw new Error('Sign in to sync projects');
    return user;
  };
  const bytesOf = (text: string) => new TextEncoder().encode(text);
  const upload = (path: string, json: string) =>
    uploadBytes(ref(storage, path), bytesOf(json), { contentType: 'application/json' });
  const removeQuietly = async (path: string) => {
    try { await deleteObject(ref(storage, path)); } catch (error) { if (!isNotFound(error)) throw error; }
  };

  async function downloadRev(path: string): Promise<string> {
    return new TextDecoder().decode(await getBytes(ref(storage, path)));
  }

  return {
    async listProjects(): Promise<CloudProjectMeta[]> {
      const user = me();
      const snap = await getDocs(query(collection(db, 'projects'), where('editorEmails', 'array-contains', user.email)));
      return snap.docs.map((d) => toMeta(d.id, d.data()));
    },

    /**
     * null = gone or no longer shared with you; both mean stop syncing. The security rules deny gets of
     * missing documents (resource is null), so a missing project surfaces as permission-denied and is
     * mapped to null here, indistinguishable from a project the caller cannot read.
     */
    async readMeta(id: string): Promise<CloudProjectMeta | null> {
      me();
      let snap;
      try {
        snap = await getDoc(projectDoc(id));
      } catch (error) {
        if (isPermissionDenied(error)) return null;
        throw error;
      }
      return snap.exists() ? toMeta(snap.id, snap.data()) : null;
    },

    async createProject(project: Project): Promise<CloudProjectMeta> {
      const user = me();
      const id = project.id;
      const json = JSON.stringify(project);
      const email = user.email.toLowerCase();
      const path = revPath(id, 0);
      // The Storage rules read this document, so it must exist before the upload.
      await setDoc(projectDoc(id), {
        name: project.name,
        ownerUid: user.uid,
        editorEmails: [email],
        rev: 0,
        planPath: path,
        thumbPath: null,
        sizeBytes: bytesOf(json).byteLength,
        updatedAt: serverTimestamp(),
        updatedBy: email,
        shareToken: null,
      });
      try {
        await upload(path, json);
      } catch (error) {
        await deleteDoc(projectDoc(id)).catch(() => {});
        throw error;
      }
      const meta = await getDoc(projectDoc(id));
      return toMeta(id, meta.data()!);
    },

    async pushRevision(id: string, baseRev: number, json: string, name: string): Promise<number> {
      const user = me();
      const email = user.email.toLowerCase();
      const next = baseRev + 1;
      const path = revPath(id, next);
      // Cheap pre-check: revision objects are never overwritten, so do not touch a slot already taken.
      // permission-denied means the doc is gone or access was revoked: a conflict, and nothing is uploaded.
      const current = await getDoc(projectDoc(id)).catch((error) => {
        if (isPermissionDenied(error)) throw new ProjectConflictError();
        throw error;
      });
      if (!current.exists() || current.data().rev !== baseRev) throw new ProjectConflictError();
      await upload(path, json);
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(projectDoc(id)).catch((error) => {
            if (isPermissionDenied(error)) throw new ProjectConflictError();
            throw error;
          });
          if (!snap.exists() || snap.data().rev !== baseRev) throw new ProjectConflictError();
          tx.update(projectDoc(id), {
            rev: next,
            planPath: path,
            sizeBytes: bytesOf(json).byteLength,
            name,
            updatedAt: serverTimestamp(),
            updatedBy: email,
          });
        });
      } catch (error) {
        // The object is this attempt's own, so removing it is always safe.
        await removeQuietly(path).catch(() => {});
        throw error;
      }
      return next;
    },

    downloadRev,

    async downloadLatest(meta: Pick<CloudProjectMeta, 'id' | 'rev' | 'planPath'>): Promise<string> {
      try {
        return await downloadRev(meta.planPath);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const { items } = await listAll(ref(storage, `projects/${meta.id}/revs`));
      const older = items
        .map((item) => ({ item, rev: revOfName(item.name) }))
        .filter((x): x is { item: typeof x.item; rev: number } => x.rev !== null && x.rev < meta.rev)
        .sort((x, y) => y.rev - x.rev)
        .slice(0, MAX_FALLBACK);
      for (const { item } of older) {
        try {
          return await downloadRev(item.fullPath);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
      throw new Error('No downloadable revision found for this project');
    },

    async pruneRevs(id: string, currentRev: number, keep = 10): Promise<void> {
      me();
      const { items } = await listAll(ref(storage, `projects/${id}/revs`));
      for (const item of items) {
        // Orphans (a crash between upload and commit) age out through this same window.
        const n = revOfName(item.name);
        if (n !== null && n <= currentRev - keep) await removeQuietly(item.fullPath);
      }
    },

    async deleteProject(id: string): Promise<void> {
      me();
      const walk = async (folder: ReturnType<typeof ref>): Promise<void> => {
        const { items, prefixes } = await listAll(folder);
        for (const item of items) await removeQuietly(item.fullPath);
        for (const prefix of prefixes) await walk(prefix);
      };
      await walk(ref(storage, `projects/${id}`));
      await deleteDoc(projectDoc(id));
    },

    async uploadThumbnail(id: string, jpeg: Blob): Promise<void> {
      me();
      const path = `projects/${id}/thumb.jpg`;
      await uploadBytes(ref(storage, path), jpeg, { contentType: 'image/jpeg' });
      await updateDoc(projectDoc(id), { thumbPath: path });
    },

    watchProject(id: string, cb: (meta: CloudProjectMeta | null) => void): () => void {
      me();
      return onSnapshot(projectDoc(id), (snap) => cb(snap.exists() ? toMeta(snap.id, snap.data()) : null));
    },
  };
}

export type CloudStore = ReturnType<typeof createCloudStore>;

export const cloudStore: CloudStore | null =
  db && storage ? createCloudStore({ db, storage, user: currentUser }) : null;
