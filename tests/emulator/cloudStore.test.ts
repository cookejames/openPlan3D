import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, signOut } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, updateDoc } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, ref, getBytes } from 'firebase/storage';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { createCloudStore, readSharedSnapshot, ShareNotFoundError } from '$lib/services/cloudStore';
import { ProjectConflictError } from '$lib/services/datastore';
import type { Project } from '$lib/models/types';

// The module under test imports the app singletons; the tests inject emulator instances instead.
vi.mock('$lib/firebase', () => ({ db: null, storage: null, firebaseEnabled: false }));
vi.mock('$lib/stores/auth', () => ({ currentUser: () => null }));

const PROJECT_ID = 'demo-openplan3d';
const BUCKET = 'demo-openplan3d.appspot.com';

type Client = { app: FirebaseApp; store: ReturnType<typeof createCloudStore>; db: ReturnType<typeof getFirestore>; storage: ReturnType<typeof getStorage>; uid: string; email: string };

const apps: FirebaseApp[] = [];
let env: RulesTestEnvironment;
let counter = 0;

async function client(sub: string, email: string): Promise<Client> {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake', storageBucket: BUCKET }, `cs-${sub}-${counter++}`);
  apps.push(app);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  const storage = getStorage(app);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  const cred = await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({ sub, email, email_verified: true })));
  const uid = cred.user.uid;
  const store = createCloudStore({ db, storage, user: () => ({ uid, email }) });
  return { app, store, db, storage, uid, email };
}

function makeProject(id: string, padding = 0): Project {
  return {
    id, name: `Plan ${id}`, floors: [], activeFloorId: 'f1', createdAt: new Date(0), updatedAt: new Date(0),
    ...(padding ? { description: 'x'.repeat(padding) + ' é\u{1F600}' } : {}),
  } as unknown as Project;
}

let alice: Client, bob: Client, eve: Client;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { host: '127.0.0.1', port: 8080 },
    storage: { host: '127.0.0.1', port: 9199 },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { setDoc, doc: d } = await import('firebase/firestore');
    await setDoc(d(ctx.firestore(), 'config', 'access'), {
      allowedEmails: ['alice@example.com', 'bob@example.com'],
    });
  });
  alice = await client('alice', 'alice@example.com');
  bob = await client('bob', 'bob@example.com');
  eve = await client('eve', 'eve@example.com');
});

afterAll(async () => {
  await env?.cleanup();
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})));
});

describe('cloudStore (emulator)', () => {
  it('requires sign-in', async () => {
    const store = createCloudStore({ db: alice.db, storage: alice.storage, user: () => null });
    await expect(store.listProjects()).rejects.toThrow('Sign in to sync projects');
  });

  it('create round-trips meta, list and a >1 MiB JSON byte-for-byte', async () => {
    const project = makeProject('p1', 1.5 * 1024 * 1024);
    const json = JSON.stringify(project);
    const meta = await alice.store.createProject(project);
    expect(meta).toMatchObject({ id: 'p1', rev: 0, ownerUid: alice.uid, editorEmails: ['alice@example.com'], planPath: expect.stringMatching(/^projects\/p1\/revs\/0-[0-9a-f]{12}\.json$/), thumbPath: null, shareToken: null });
    expect(meta.sizeBytes).toBe(new TextEncoder().encode(json).byteLength);
    expect(meta.updatedAt).toBeInstanceOf(Date);
    expect(await alice.store.readMeta('p1')).toEqual(meta);
    expect((await alice.store.listProjects()).map((m) => m.id)).toEqual(['p1']);
    expect(await alice.store.downloadLatest(meta)).toBe(json);
  });

  it('create rolls back the doc when the upload fails', async () => {
    // A Storage instance pointed at a dead port makes the upload fail.
    const storage = getStorage(alice.app, 'gs://unreachable-bucket');
    connectStorageEmulator(storage, '127.0.0.1', 9);
    storage.maxUploadRetryTime = 300;
    storage.maxOperationRetryTime = 300;
    const store = createCloudStore({ db: alice.db, storage, user: () => ({ uid: alice.uid, email: alice.email }) });
    await expect(store.createProject(makeProject('p-fail'))).rejects.toThrow();
    await expectDocAbsent('p-fail');
  });

  it('pushRevision increments the revision and updates meta', async () => {
    await alice.store.createProject(makeProject('p2'));
    const json = JSON.stringify({ ...makeProject('p2'), name: 'Renamed' });
    expect(await alice.store.pushRevision('p2', 0, json, 'Renamed')).toBe(1);
    const meta = (await alice.store.readMeta('p2'))!;
    expect(meta).toMatchObject({ rev: 1, name: 'Renamed', planPath: expect.stringMatching(/^projects\/p2\/revs\/1-[0-9a-f]{12}\.json$/), updatedBy: 'alice@example.com', sizeBytes: new TextEncoder().encode(json).byteLength });
    expect(await alice.store.downloadLatest(meta)).toBe(json);
    expect(await alice.store.pushRevision('p2', 1, json, 'Renamed')).toBe(2);
  });

  it('a stale baseRev conflicts and leaves the winner intact', async () => {
    await alice.store.createProject(makeProject('p3'));
    await alice.store.pushRevision('p3', 0, '{"a":1}', 'one');
    await expect(alice.store.pushRevision('p3', 0, '{"a":2}', 'two')).rejects.toBeInstanceOf(ProjectConflictError);
    const meta = (await alice.store.readMeta('p3'))!;
    expect(meta.rev).toBe(1);
    expect(await alice.store.downloadLatest(meta)).toBe('{"a":1}');
  });

  it('two concurrent pushes from the same baseRev: one wins, one conflicts', async () => {
    await alice.store.createProject(makeProject('p4'));
    const results = await Promise.allSettled([
      alice.store.pushRevision('p4', 0, '{"who":"a"}', 'A'),
      alice.store.pushRevision('p4', 0, '{"who":"b"}', 'B'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ProjectConflictError);
    const meta = (await alice.store.readMeta('p4'))!;
    expect(meta.rev).toBe(1);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<number>;
    expect(winner.value).toBe(1);
    const payloads = ['{"who":"a"}', '{"who":"b"}'];
    const bytes = await alice.store.downloadLatest(meta);
    expect(payloads).toContain(bytes);
    // The loser's object is gone: only the committed revision-0 and revision-1 objects remain.
    expect(await revObjects('p4')).toHaveLength(2);
    expect(await objectExists(alice, meta.planPath)).toBe(true);
  });

  it('a stale push leaves no orphan and the winner object intact', async () => {
    await alice.store.createProject(makeProject('p5'));
    await alice.store.pushRevision('p5', 0, '{"keep":1}', 'n');
    await expect(alice.store.pushRevision('p5', 0, '{"lose":1}', 'n')).rejects.toBeInstanceOf(ProjectConflictError);
    const meta = (await alice.store.readMeta('p5'))!;
    expect(await alice.store.downloadLatest(meta)).toBe('{"keep":1}');
    expect(await revObjects('p5')).toHaveLength(2); // revision 0 and the winner, no orphan
  });

  it('downloadLatest falls back to earlier revisions when the current object is missing', async () => {
    await alice.store.createProject(makeProject('p6'));
    await alice.store.pushRevision('p6', 0, '{"r":1}', 'n');
    await alice.store.pushRevision('p6', 1, '{"r":2}', 'n');
    const meta = (await alice.store.readMeta('p6'))!;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { deleteObject, ref: r } = await import('firebase/storage');
      await deleteObject(r(ctx.storage(BUCKET), meta.planPath));
    });
    expect(await alice.store.downloadLatest(meta)).toBe('{"r":1}');
  });

  it('pruneRevs keeps the last N revisions', async () => {
    await alice.store.createProject(makeProject('p7'));
    for (let i = 0; i < 5; i++) await alice.store.pushRevision('p7', i, `{"r":${i + 1}}`, 'n');
    await alice.store.pruneRevs('p7', 5, 2);
    const revs = (await revObjects('p7')).map((n) => Number(n.split('-')[0])).sort();
    expect(revs).toEqual([4, 5]);
    await alice.store.pruneRevs('p7', 5, 2); // idempotent
  });

  it('uploadThumbnail sets thumbPath', async () => {
    await alice.store.createProject(makeProject('p8'));
    await alice.store.uploadThumbnail('p8', new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }));
    expect((await alice.store.readMeta('p8'))!.thumbPath).toBe('projects/p8/thumb.jpg');
  });

  it('downloadThumbnail round-trips uploadThumbnail and is null when absent', async () => {
    await alice.store.createProject(makeProject('p8b'));
    const absent = (await alice.store.readMeta('p8b'))!;
    expect(await alice.store.downloadThumbnail(absent)).toBeNull();
    await alice.store.uploadThumbnail('p8b', new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }));
    const meta = (await alice.store.readMeta('p8b'))!;
    expect(await alice.store.downloadThumbnail(meta)).toBe('data:image/jpeg;base64,/9j/4A==');
    expect(await alice.store.downloadThumbnail({ ...meta, thumbPath: 'projects/p8b/missing.jpg' })).toBeNull();
  });

  it('watchProject reports changes and deletion', async () => {
    await alice.store.createProject(makeProject('p9'));
    const seen: Array<number | null> = [];
    const stop = alice.store.watchProject('p9', (m) => seen.push(m ? m.rev : null));
    await vi_waitFor(() => seen.includes(0));
    await alice.store.pushRevision('p9', 0, '{}', 'n');
    await vi_waitFor(() => seen.includes(1));
    stop();
  });

  it('deleteProject removes the doc and every object', async () => {
    await alice.store.createProject(makeProject('p10'));
    await alice.store.pushRevision('p10', 0, '{}', 'n');
    await alice.store.uploadThumbnail('p10', new Blob(['x'], { type: 'image/jpeg' }));
    await alice.store.deleteProject('p10');
    await expectDocAbsent('p10');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { listAll, ref: r } = await import('firebase/storage');
      const root = await listAll(r(ctx.storage(BUCKET), 'projects/p10'));
      const revs = await listAll(r(ctx.storage(BUCKET), 'projects/p10/revs'));
      expect(root.items.length + revs.items.length).toBe(0);
    });
  });

  it('readMeta returns null after deleteProject', async () => {
    await alice.store.createProject(makeProject('p13'));
    await alice.store.deleteProject('p13');
    expect(await alice.store.readMeta('p13')).toBeNull();
  });

  it('pushRevision after deleteProject conflicts and leaves no object behind', async () => {
    await alice.store.createProject(makeProject('p14'));
    await alice.store.deleteProject('p14');
    await expect(alice.store.pushRevision('p14', 0, '{}', 'n')).rejects.toBeInstanceOf(ProjectConflictError);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { listAll, ref: r } = await import('firebase/storage');
      expect((await listAll(r(ctx.storage(BUCKET), 'projects/p14/revs'))).items).toHaveLength(0);
    });
  });

  it('a second editor can list and push; non-owners cannot delete', async () => {
    await alice.store.createProject(makeProject('p11'));
    await updateDoc(doc(alice.db, 'projects', 'p11'), { editorEmails: ['alice@example.com', 'bob@example.com'] });
    expect((await bob.store.listProjects()).map((m) => m.id)).toEqual(['p11']);
    expect(await bob.store.pushRevision('p11', 0, '{"by":"bob"}', 'n')).toBe(1);
    const meta = (await alice.store.readMeta('p11'))!;
    expect(meta.updatedBy).toBe('bob@example.com');
    expect(await alice.store.downloadLatest(meta)).toBe('{"by":"bob"}');
    await expect(bob.store.deleteProject('p11')).rejects.toThrow();
  });

  it('a non-editor gets null from readMeta and sees nothing in the list', async () => {
    await alice.store.createProject(makeProject('p12'));
    expect(await eve.store.readMeta('p12')).toBeNull();
    expect(await eve.store.listProjects()).toEqual([]);
  });
});

describe('sharing (emulator)', () => {
  const TOKEN_RE = /^[a-f0-9]{32}$/;
  const withEditor = async (id: string) => {
    await alice.store.createProject(makeProject(id));
    await alice.store.setEditors(id, ['bob@example.com']);
  };
  const shareDocExists = async (token: string) => {
    let exists = false;
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { getDoc, doc: d } = await import('firebase/firestore');
      exists = (await getDoc(d(ctx.firestore(), 'shares', token))).exists();
    });
    return exists;
  };

  it('setEditors normalises, dedupes and keeps the owner', async () => {
    await alice.store.createProject(makeProject('s1'));
    const list = await alice.store.setEditors('s1', [' Bob@Example.com ', 'bob@example.com', '', 'carol@example.com']);
    expect(list).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com']);
    expect((await alice.store.readMeta('s1'))!.editorEmails).toEqual(list);
    expect(await alice.store.setEditors('s1', [])).toEqual(['alice@example.com']);
    await expect(alice.store.setEditors('s1', ['not-an-email'])).rejects.toThrow('Invalid email');
  });

  it('non-owner setEditors throws', async () => {
    await withEditor('s2');
    await expect(bob.store.setEditors('s2', ['eve@example.com'])).rejects.toThrow('Only the project owner');
    expect((await alice.store.readMeta('s2'))!.editorEmails).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('enableSharing creates doc, snapshot and token; anonymous reads it; second call reuses token', async () => {
    await alice.store.createProject(makeProject('s3'));
    const token = await alice.store.enableSharing('s3', '{"v":1}');
    expect(token).toMatch(TOKEN_RE);
    expect((await alice.store.readMeta('s3'))!.shareToken).toBe(token);
    expect(await shareDocExists(token)).toBe(true);
    // eve's storage instance has no relation to the project: the read works without being an editor.
    expect(await readSharedSnapshot(eve.storage, token)).toBe('{"v":1}');
    expect(await alice.store.enableSharing('s3', '{"v":2}')).toBe(token);
    expect(await readSharedSnapshot(eve.storage, token)).toBe('{"v":2}');
  });

  it('readSharedSnapshot works with no signed-in user', async () => {
    await alice.store.createProject(makeProject('s3b'));
    const token = await alice.store.enableSharing('s3b', '{"anon":true}');
    const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake', storageBucket: BUCKET }, `anon-${counter++}`);
    apps.push(app);
    const storage = getStorage(app);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
    expect(await readSharedSnapshot(storage, token)).toBe('{"anon":true}');
  });

  it('updateShareSnapshot overwrites the bytes', async () => {
    await alice.store.createProject(makeProject('s4'));
    const token = await alice.store.enableSharing('s4', '{"a":1}');
    await alice.store.updateShareSnapshot(token, '{"a":2}');
    expect(await readSharedSnapshot(eve.storage, token)).toBe('{"a":2}');
  });

  it('disableSharing removes snapshot, share doc and token', async () => {
    await alice.store.createProject(makeProject('s5'));
    const token = await alice.store.enableSharing('s5', '{}');
    await alice.store.disableSharing('s5');
    expect((await alice.store.readMeta('s5'))!.shareToken).toBeNull();
    expect(await shareDocExists(token)).toBe(false);
    await expect(readSharedSnapshot(eve.storage, token)).rejects.toBeInstanceOf(ShareNotFoundError);
    await alice.store.disableSharing('s5'); // idempotent
  });

  it('an editor who is not the owner can enable and disable sharing', async () => {
    await withEditor('s6');
    const token = await bob.store.enableSharing('s6', '{"by":"bob"}');
    expect(await readSharedSnapshot(eve.storage, token)).toBe('{"by":"bob"}');
    expect((await alice.store.readMeta('s6'))!.shareToken).toBe(token);
    await bob.store.disableSharing('s6');
    await expect(readSharedSnapshot(eve.storage, token)).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it('a non-editor cannot enable sharing', async () => {
    await alice.store.createProject(makeProject('s7'));
    await expect(eve.store.enableSharing('s7', '{}')).rejects.toThrow();
  });

  it('deleteProject with sharing on cleans up the snapshot and share doc', async () => {
    await alice.store.createProject(makeProject('s8'));
    const token = await alice.store.enableSharing('s8', '{}');
    await alice.store.deleteProject('s8');
    await expectDocAbsent('s8');
    expect(await shareDocExists(token)).toBe(false);
    await expect(readSharedSnapshot(eve.storage, token)).rejects.toBeInstanceOf(ShareNotFoundError);
  });

  it('readSharedSnapshot rejects a malformed token without a network call', async () => {
    const storage = { _bad: true } as never; // any network use would throw a different error
    await expect(readSharedSnapshot(storage, '../projects/x')).rejects.toBeInstanceOf(ShareNotFoundError);
    await expect(readSharedSnapshot(storage, 'ABCDEF')).rejects.toBeInstanceOf(ShareNotFoundError);
  });
});

async function revObjects(id: string): Promise<string[]> {
  const { listAll, ref: r } = await import('firebase/storage');
  return (await listAll(r(alice.storage, `projects/${id}/revs`))).items.map((i) => i.name).sort();
}
const objectExists = (c: Client, path: string) => getBytes(ref(c.storage, path)).then(() => true, () => false);

describe('presence (emulator)', () => {
  const latest = (c: Client, pid: string) => {
    const box: { entries: import('$lib/services/cloudStore').PresenceEntry[] } = { entries: [] };
    const stop = c.store.watchPresence(pid, (e) => { box.entries = e; });
    return { box, stop };
  };
  const find = (box: { entries: { sessionId: string }[] }, sid: string) => box.entries.find((e) => e.sessionId === sid) as import('$lib/services/cloudStore').PresenceEntry | undefined;

  async function shared(pid: string) {
    await alice.store.createProject(makeProject(pid));
    await alice.store.setEditors(pid, ['alice@example.com', 'bob@example.com']);
  }

  it('round-trips presence between two users', async () => {
    await shared('pr1');
    const w = latest(bob, 'pr1');
    await alice.store.writePresence('pr1', 'sa', { mode: 'editing', claim: true });
    await bob.store.writePresence('pr1', 'sb', { mode: 'viewing', claim: false });
    await vi_waitFor(() => !!find(w.box, 'sa')?.claimedAt && !!find(w.box, 'sb'));
    const a = find(w.box, 'sa')!;
    expect(a).toMatchObject({ uid: alice.uid, email: 'alice@example.com', mode: 'editing' });
    expect(a.lastSeen).toBeInstanceOf(Date);
    expect(find(w.box, 'sb')).toMatchObject({ mode: 'viewing', claimedAt: null });
    const claimed = a.claimedAt!.getTime();
    // heartbeat keeps claimedAt
    await alice.store.writePresence('pr1', 'sa', { mode: 'editing', claim: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(find(w.box, 'sa')!.claimedAt!.getTime()).toBe(claimed);
    // viewing clears it
    await alice.store.writePresence('pr1', 'sa', { mode: 'viewing', claim: false });
    await vi_waitFor(() => find(w.box, 'sa')?.mode === 'viewing');
    expect(find(w.box, 'sa')!.claimedAt).toBeNull();
    w.stop();
  });

  it('removePresence deletes and swallows errors', async () => {
    await shared('pr2');
    const w = latest(alice, 'pr2');
    await alice.store.writePresence('pr2', 'sa', { mode: 'editing', claim: true });
    await vi_waitFor(() => !!find(w.box, 'sa'));
    await alice.store.removePresence('pr2', 'sa');
    await vi_waitFor(() => !find(w.box, 'sa'));
    await expect(eve.store.removePresence('pr2', 'sa')).resolves.toBeUndefined();
    w.stop();
  });

  it('watchPresence reports [] and does not throw when denied', async () => {
    await shared('pr3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let got: unknown = null;
    const stop = eve.store.watchPresence('pr3', (e) => { got = e; });
    await vi_waitFor(() => Array.isArray(got));
    expect(got).toEqual([]);
    stop();
    warn.mockRestore();
  });

  it('deleteProject removes presence docs', async () => {
    await shared('pr4');
    await alice.store.writePresence('pr4', 'sa', { mode: 'editing', claim: true });
    await bob.store.writePresence('pr4', 'sb', { mode: 'viewing', claim: false });
    await alice.store.deleteProject('pr4');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { getDocs, collection } = await import('firebase/firestore');
      expect((await getDocs(collection(ctx.firestore(), 'projects', 'pr4', 'presence'))).size).toBe(0);
    });
    await expectDocAbsent('pr4');
  });
});

// Rules deny reads of missing documents (resource is null), so absence is checked with rules disabled.
async function expectDocAbsent(id: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const { getDoc, doc: d } = await import('firebase/firestore');
    expect((await getDoc(d(ctx.firestore(), 'projects', id))).exists()).toBe(false);
  });
}

async function vi_waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
void signOut;
