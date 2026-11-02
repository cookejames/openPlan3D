import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { getBytes, listAll, ref, uploadBytes } from 'firebase/storage';

let env: RulesTestEnvironment;

const hostPort = (v: string | undefined, d: string): [string, number] => {
  const [h, p] = (v ?? d).split(':');
  return [h, Number(p)];
};
const [fsHost, fsPort] = hostPort(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8080');
const [stHost, stPort] = hostPort(process.env.FIREBASE_STORAGE_EMULATOR_HOST, '127.0.0.1:9199');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-openplan3d',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: fsHost, port: fsPort },
    storage: { rules: readFileSync('storage.rules', 'utf8'), host: stHost, port: stPort },
  });
});
afterAll(async () => { await env?.cleanup(); });

const token = 'abcdef0123456789abcdef0123456789';
const bytes = (s = '{}') => new TextEncoder().encode(s);

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'projects/p1'),
      { ownerUid: 'alice', editorEmails: ['alice@x.com'], rev: 0 });
    await setDoc(doc(ctx.firestore(), `shares/${token}`), { projectId: 'p1' });
    await uploadBytes(ref(ctx.storage(), 'projects/p1/revs/1.json'), bytes('{"a":1}'));
    await uploadBytes(ref(ctx.storage(), `shared/${token}.json`), bytes('{"s":1}'));
  });
});

const alice = () => env.authenticatedContext('alice', { email: 'Alice@x.com', email_verified: true }).storage();
const bob = () => env.authenticatedContext('bob', { email: 'bob@x.com', email_verified: true }).storage();
const unverified = () =>
  env.authenticatedContext('alice', { email: 'alice@x.com', email_verified: false }).storage();
const anon = () => env.unauthenticatedContext().storage();

describe('projects/{pid}/**', () => {
  const path = 'projects/p1/revs/1.json';
  it('lets an editor read', async () => { await assertSucceeds(getBytes(ref(alice(), path))); });
  it('lets an editor write (small upload)', async () => {
    await assertSucceeds(uploadBytes(ref(alice(), 'projects/p1/revs/2.json'), bytes()));
  });
  it('denies a non-editor read', async () => { await assertFails(getBytes(ref(bob(), path))); });
  it('denies a non-editor write', async () => { await assertFails(uploadBytes(ref(bob(), path), bytes())); });
  it('denies unauthenticated read and write', async () => {
    await assertFails(getBytes(ref(anon(), path)));
    await assertFails(uploadBytes(ref(anon(), path), bytes()));
  });
  it('denies an editor with an unverified email', async () => {
    await assertFails(getBytes(ref(unverified(), path)));
  });
  // The 96 MiB cap (sizeOk) is not exercised: uploading >96 MiB through the emulator is
  // impractical in a unit test. The small-upload case above covers the passing side.
});

describe('shared/{token}.json', () => {
  it('allows public get', async () => {
    await assertSucceeds(getBytes(ref(anon(), `shared/${token}.json`)));
  });
  it('denies list of shared/', async () => {
    await assertFails(listAll(ref(anon(), 'shared')));
  });
  it('allows write by an editor of the share project', async () => {
    await assertSucceeds(uploadBytes(ref(alice(), `shared/${token}.json`), bytes('{"s":2}')));
  });
  it('denies write by a non-editor', async () => {
    await assertFails(uploadBytes(ref(bob(), `shared/${token}.json`), bytes()));
  });
  it('denies unauthenticated write', async () => {
    await assertFails(uploadBytes(ref(anon(), `shared/${token}.json`), bytes()));
  });
  it('denies a non-matching filename', async () => {
    await assertFails(uploadBytes(ref(alice(), 'shared/abc.json'), bytes()));
  });
  it('denies a write for a token with no share document', async () => {
    await assertFails(uploadBytes(ref(alice(), `shared/${'f'.repeat(32)}.json`), bytes()));
  });
});
