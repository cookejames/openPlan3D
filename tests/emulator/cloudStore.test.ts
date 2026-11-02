import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, GoogleAuthProvider, signInWithCredential, signOut } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getFirestore, updateDoc } from 'firebase/firestore';
import { connectStorageEmulator, getStorage, ref, getBytes } from 'firebase/storage';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { createCloudStore } from '$lib/services/cloudStore';
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

async function revObjects(id: string): Promise<string[]> {
  const { listAll, ref: r } = await import('firebase/storage');
  return (await listAll(r(alice.storage, `projects/${id}/revs`))).items.map((i) => i.name).sort();
}
const objectExists = (c: Client, path: string) => getBytes(ref(c.storage, path)).then(() => true, () => false);

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
