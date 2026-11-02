import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

let env: RulesTestEnvironment;

const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-openplan3d',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
});
afterAll(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'config/access'), { allowedEmails: ['alice@x.com', 'bob@x.com'] });
  });
});

const ctxOf = (uid: string, email: string, verified = true) =>
  env.authenticatedContext(uid, { email, email_verified: verified });
const alice = () => ctxOf('alice', 'alice@x.com').firestore();
const bob = () => ctxOf('bob', 'bob@x.com').firestore();
const carol = () => ctxOf('carol', 'carol@x.com').firestore();

const project = (over: Record<string, unknown> = {}) => ({
  ownerUid: 'alice',
  editorEmails: ['alice@x.com', 'bob@x.com'],
  rev: 0,
  ...over,
});
const seed = async (path: string, data: Record<string, unknown>) => {
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), path), data); });
};

describe('config/access', () => {
  it('denies client reads and writes', async () => {
    await assertFails(getDoc(doc(alice(), 'config/access')));
    await assertFails(setDoc(doc(alice(), 'config/access'), { allowedEmails: ['alice@x.com'] }));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'config/access')));
  });
});

describe('project create', () => {
  it('allows an allowlisted verified owner at rev 0', async () => {
    await assertSucceeds(setDoc(doc(alice(), 'projects/p1'), project({ editorEmails: ['alice@x.com'] })));
  });
  it('denies when not allowlisted', async () => {
    await assertFails(setDoc(doc(carol(), 'projects/p1'),
      project({ ownerUid: 'carol', editorEmails: ['carol@x.com'] })));
  });
  it('denies rev 1', async () => {
    await assertFails(setDoc(doc(alice(), 'projects/p1'), project({ rev: 1 })));
  });
  it('denies ownerUid of someone else', async () => {
    await assertFails(setDoc(doc(alice(), 'projects/p1'), project({ ownerUid: 'bob' })));
  });
  it('denies when own email is missing from editorEmails', async () => {
    await assertFails(setDoc(doc(alice(), 'projects/p1'), project({ editorEmails: ['bob@x.com'] })));
  });
  it('denies unverified email', async () => {
    await assertFails(setDoc(doc(ctxOf('alice', 'alice@x.com', false).firestore(), 'projects/p1'), project()));
  });
  it('denies unauthenticated', async () => {
    await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'projects/p1'), project()));
  });
  it('matches emails case-insensitively', async () => {
    const db = ctxOf('alice', 'Alice@X.com').firestore();
    await assertSucceeds(setDoc(doc(db, 'projects/p1'), project({ editorEmails: ['alice@x.com'] })));
  });
});

describe('project create by allowed domain', () => {
  const dan = (email = 'dan@family.org', verified = true) => ctxOf('dan', email, verified).firestore();
  const asDan = (email = 'dan@family.org') => project({ ownerUid: 'dan', editorEmails: [email.toLowerCase()] });
  beforeEach(async () => {
    await seed('config/access', { allowedEmails: ['alice@x.com'], allowedDomains: ['family.org'] });
  });
  it('allows any verified address at an allowed domain', async () => {
    await assertSucceeds(setDoc(doc(dan(), 'projects/p1'), asDan()));
  });
  it('matches the domain case-insensitively', async () => {
    await assertSucceeds(setDoc(doc(dan('Dan@Family.ORG'), 'projects/p1'), asDan('Dan@Family.ORG')));
  });
  it('still allows listed addresses', async () => {
    await assertSucceeds(setDoc(doc(alice(), 'projects/p1'), project({ editorEmails: ['alice@x.com'] })));
  });
  it('denies other domains', async () => {
    await assertFails(setDoc(doc(dan('dan@other.org'), 'projects/p1'), asDan('dan@other.org')));
  });
  it('denies subdomains and lookalike domains', async () => {
    await assertFails(setDoc(doc(dan('dan@mail.family.org'), 'projects/p1'), asDan('dan@mail.family.org')));
    await assertFails(setDoc(doc(dan('dan@notfamily.org'), 'projects/p1'), asDan('dan@notfamily.org')));
  });
  it('denies an unverified address at an allowed domain', async () => {
    await assertFails(setDoc(doc(dan('dan@family.org', false), 'projects/p1'), asDan()));
  });
  it('works when only allowedDomains is set', async () => {
    await seed('config/access', { allowedDomains: ['family.org'] });
    await assertSucceeds(setDoc(doc(dan(), 'projects/p1'), asDan()));
    await assertFails(setDoc(doc(alice(), 'projects/p2'), project({ editorEmails: ['alice@x.com'] })));
  });
});

describe('project read', () => {
  beforeEach(async () => { await seed('projects/p1', project({ editorEmails: ['alice@x.com'] })); });
  it('allows an editor', async () => { await assertSucceeds(getDoc(doc(alice(), 'projects/p1'))); });
  it('denies a non-editor', async () => { await assertFails(getDoc(doc(bob(), 'projects/p1'))); });
  it('denies unauthenticated', async () => {
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'projects/p1')));
  });
});

describe('project update', () => {
  beforeEach(async () => { await seed('projects/p1', project({ rev: 5 })); });
  it('allows rev + 1', async () => { await assertSucceeds(updateDoc(doc(bob(), 'projects/p1'), { rev: 6 })); });
  it('allows the same rev', async () => { await assertSucceeds(updateDoc(doc(bob(), 'projects/p1'), { rev: 5 })); });
  it('denies rev + 2', async () => { await assertFails(updateDoc(doc(bob(), 'projects/p1'), { rev: 7 })); });
  it('denies rev - 1', async () => { await assertFails(updateDoc(doc(bob(), 'projects/p1'), { rev: 4 })); });
  it('denies changing ownerUid', async () => {
    await assertFails(updateDoc(doc(alice(), 'projects/p1'), { ownerUid: 'bob' }));
  });
  it('denies a non-editor', async () => { await assertFails(updateDoc(doc(carol(), 'projects/p1'), { rev: 6 })); });
  it('denies a non-owner editor changing editorEmails', async () => {
    await assertFails(updateDoc(doc(bob(), 'projects/p1'),
      { editorEmails: ['alice@x.com', 'bob@x.com', 'carol@x.com'] }));
  });
  it('allows the owner changing editorEmails', async () => {
    await assertSucceeds(updateDoc(doc(alice(), 'projects/p1'),
      { editorEmails: ['alice@x.com', 'bob@x.com', 'carol@x.com'] }));
  });
});

describe('project delete', () => {
  beforeEach(async () => { await seed('projects/p1', project()); });
  it('allows the owner', async () => { await assertSucceeds(deleteDoc(doc(alice(), 'projects/p1'))); });
  it('denies a non-owner editor', async () => { await assertFails(deleteDoc(doc(bob(), 'projects/p1'))); });
});

describe('shares', () => {
  const token = 'a'.repeat(32);
  beforeEach(async () => { await seed('projects/p1', project({ editorEmails: ['alice@x.com'] })); });

  it('lets an editor create', async () => {
    await assertSucceeds(setDoc(doc(alice(), `shares/${token}`), { projectId: 'p1' }));
  });
  it('denies a non-editor create', async () => {
    await assertFails(setDoc(doc(bob(), `shares/${token}`), { projectId: 'p1' }));
  });
  it('lets any signed-in user get', async () => {
    await seed(`shares/${token}`, { projectId: 'p1' });
    await assertSucceeds(getDoc(doc(carol(), `shares/${token}`)));
  });
  it('denies list', async () => {
    await seed(`shares/${token}`, { projectId: 'p1' });
    await assertFails(getDocs(collection(alice(), 'shares')));
  });
  it('denies update', async () => {
    await seed(`shares/${token}`, { projectId: 'p1' });
    await assertFails(updateDoc(doc(alice(), `shares/${token}`), { projectId: 'p1', x: 1 }));
  });
  it('lets an editor delete', async () => {
    await seed(`shares/${token}`, { projectId: 'p1' });
    await assertSucceeds(deleteDoc(doc(alice(), `shares/${token}`)));
  });
  it('denies a non-editor delete', async () => {
    await seed(`shares/${token}`, { projectId: 'p1' });
    await assertFails(deleteDoc(doc(bob(), `shares/${token}`)));
  });
});
