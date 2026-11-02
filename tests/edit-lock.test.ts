import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';
import {
  createEditLock, lockHolder, HEARTBEAT_MS, STALE_MS,
  type EditLockDeps, type EditLockState, type LockSource, type PresenceEntry,
} from '$lib/stores/editLock';
import { readOnly, readOnlyReason, setEditLockReadOnly } from '$lib/stores/readOnly';

const ME = 'me-session';
const src = (over: Partial<LockSource> = {}): LockSource => ({ user: { uid: 'u1' }, projectId: 'p1', cloudTracked: true, shareView: false, ...over });
const entry = (over: Partial<PresenceEntry> = {}): PresenceEntry => ({
  sessionId: 'other', uid: 'u2', email: 'ann@x.c', mode: 'editing',
  claimedAt: new Date(Date.now() - 5000), lastSeen: new Date(), ...over,
});

function setup() {
  let cb: (e: PresenceEntry[]) => void = () => {};
  const calls: string[] = [];
  const presence = {
    writePresence: vi.fn(async (_p: string, _s: string, o: { mode: string; claim: boolean }) => { calls.push(`write:${o.mode}:${o.claim}`); }),
    removePresence: vi.fn(async () => { calls.push('remove'); }),
    watchPresence: vi.fn((_p: string, c: (e: PresenceEntry[]) => void) => { cb = c; return () => { calls.push('unwatch'); }; }),
  };
  const order: string[] = [];
  const deps: EditLockDeps = {
    presence, now: () => Date.now(), sessionId: ME,
    save: vi.fn(async () => { order.push('save'); return true; }),
    flush: vi.fn(async () => { order.push('flush'); }),
    loadLatest: vi.fn(async () => { order.push('loadLatest'); return { id: 'p1' } as never; }),
    loadProject: vi.fn(() => { order.push('loadProject'); }),
    markClean: vi.fn(() => { order.push('markClean'); }),
    setReadOnly: vi.fn((v: boolean) => { order.push(`ro:${v}`); setEditLockReadOnly(v); }),
  };
  const state = writable<EditLockState>({ phase: 'off', notice: null, holderEmail: null, holderIsSelf: false, busy: false, error: null });
  const lock = createEditLock(deps, state);
  return { lock, deps, presence, calls, order, state, emit: (e: PresenceEntry[]) => cb(e) };
}
async function open(h: ReturnType<typeof setup>, entries: PresenceEntry[], source = src()) {
  h.lock.update(source);
  h.emit(entries);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => { vi.useFakeTimers(); setEditLockReadOnly(false); readOnly.set(false); });
afterEach(() => { vi.useRealTimers(); setEditLockReadOnly(false); readOnly.set(false); });

describe('lockHolder', () => {
  it('picks the latest claim, ties to the larger session id, ignores stale and viewers', () => {
    const t = new Date(1000);
    const now = Date.now();
    expect(lockHolder([entry({ sessionId: 'a', claimedAt: t }), entry({ sessionId: 'b', claimedAt: t })], now)?.sessionId).toBe('b');
    expect(lockHolder([entry({ sessionId: 'a', claimedAt: new Date(2000) }), entry({ sessionId: 'b', claimedAt: t })], now)?.sessionId).toBe('a');
    expect(lockHolder([entry({ mode: 'viewing' })], now)).toBeNull();
    expect(lockHolder([entry({ lastSeen: new Date(now - STALE_MS - 1) })], now)).toBeNull();
    expect(lockHolder([entry({ lastSeen: null })], now)).not.toBeNull();
    expect(lockHolder([entry({ sessionId: 'z', claimedAt: null }), entry({ sessionId: 'a', claimedAt: t })], now)?.sessionId).toBe('a');
  });
});

describe('edit lock', () => {
  it('claims when nobody else is editing', async () => {
    const h = setup();
    await open(h, []);
    expect(h.calls).toContain('write:editing:true');
    expect(get(h.state).phase).toBe('editing');
    expect(get(readOnly)).toBe(false);
  });

  it('proceeds as empty when the first snapshot never arrives', async () => {
    const h = setup();
    h.lock.update(src());
    await vi.advanceTimersByTimeAsync(3100);
    expect(get(h.state).phase).toBe('editing');
    expect(h.calls).toContain('write:editing:true');
  });

  it('enters locked view when another live editor exists', async () => {
    const h = setup();
    await open(h, [entry()]);
    expect(get(h.state)).toMatchObject({ phase: 'locked', notice: 'held', holderEmail: 'ann@x.c', holderIsSelf: false });
    expect(h.calls).toContain('write:viewing:false');
    expect(h.calls).not.toContain('write:editing:true');
    expect(get(readOnly)).toBe(true);
    expect(get(readOnlyReason)).toBe('lock');
  });

  it('reports the same user in another window', async () => {
    const h = setup();
    await open(h, [entry({ uid: 'u1', email: 'me@x.c' })]);
    expect(get(h.state).holderIsSelf).toBe(true);
  });

  it('ignores a stale editor', async () => {
    const h = setup();
    await open(h, [entry({ lastSeen: new Date(Date.now() - STALE_MS - 1000) })]);
    expect(get(h.state).phase).toBe('editing');
    expect(get(readOnly)).toBe(false);
  });

  it('heartbeats every 30s keeping the mode', async () => {
    const h = setup();
    await open(h, []);
    h.presence.writePresence.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(h.presence.writePresence.mock.calls.map(c => c[2])).toEqual([{ mode: 'editing', claim: false }, { mode: 'editing', claim: false }]);
    const v = setup();
    await open(v, [entry()]);
    v.presence.writePresence.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(v.presence.writePresence.mock.calls[0][2]).toEqual({ mode: 'viewing', claim: false });
  });

  it('saves and flushes before turning read-only when another session takes over', async () => {
    const h = setup();
    await open(h, []);
    h.emit([entry({ claimedAt: new Date(Date.now() + 1000) })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.order).toEqual(['ro:false', 'save', 'flush', 'ro:true']);
    expect(get(h.state)).toMatchObject({ phase: 'locked', notice: 'tookOver', holderEmail: 'ann@x.c' });
    expect(h.calls).toContain('write:viewing:false');
  });

  it('shows finished when the holder goes away, without auto-switching', async () => {
    const h = setup();
    await open(h, [entry()]);
    h.emit([]);
    expect(get(h.state)).toMatchObject({ phase: 'locked', notice: 'finished' });
    expect(get(readOnly)).toBe(true);
    // holder goes stale without a snapshot
    const h2 = setup();
    await open(h2, [entry()]);
    await vi.advanceTimersByTimeAsync(STALE_MS + HEARTBEAT_MS);
    expect(get(h2.state).notice).toBe('finished');
  });

  it('edit anyway loads latest, then claims and clears read-only', async () => {
    const h = setup();
    await open(h, [entry()]);
    expect(await h.lock.editAnyway()).toBe(true);
    expect(h.order).toEqual(['ro:true', 'loadLatest', 'loadProject', 'markClean', 'ro:false']);
    expect(h.calls).toContain('write:editing:true');
    expect(get(h.state).phase).toBe('editing');
    expect(get(readOnly)).toBe(false);
  });

  it('edit anyway failure stays locked with an error', async () => {
    const h = setup();
    await open(h, [entry()]);
    (h.deps.loadLatest as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    expect(await h.lock.editAnyway()).toBe(false);
    expect(get(h.state)).toMatchObject({ phase: 'locked', busy: false });
    expect(get(h.state).error).toBeTruthy();
    expect(get(readOnly)).toBe(true);
  });

  it('bfcache restore with nobody else editing re-claims', async () => {
    const h = setup();
    await open(h, []);
    h.lock.onPageHide();
    h.presence.writePresence.mockClear();
    h.lock.onPageShow(true);
    h.emit([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.presence.writePresence.mock.calls.map(c => c[2])).toEqual([{ mode: 'editing', claim: true }]);
    expect(get(h.state).phase).toBe('editing');
  });

  it('bfcache restore while someone else holds the lock goes to viewing', async () => {
    const h = setup();
    await open(h, []);
    h.lock.onPageHide();
    h.presence.writePresence.mockClear();
    h.lock.onPageShow(true);
    h.emit([entry()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.presence.writePresence.mock.calls.map(c => c[2])).toEqual([{ mode: 'viewing', claim: false }]);
    expect(get(h.state).phase).toBe('locked');
    expect(get(readOnly)).toBe(true);
  });

  it('removes presence and stops the heartbeat when leaving', async () => {
    const h = setup();
    await open(h, [entry()]);
    h.lock.update(src({ projectId: 'p2' }));
    expect(h.calls).toContain('unwatch');
    expect(h.calls).toContain('remove');
    h.lock.dispose();
    h.presence.writePresence.mockClear();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(h.presence.writePresence).not.toHaveBeenCalled();
    expect(get(readOnly)).toBe(false);
    expect(get(h.state).phase).toBe('off');
  });

  it('does nothing when signed out, untracked, or in a share view', async () => {
    for (const s of [src({ user: null }), src({ cloudTracked: false }), src({ shareView: true }), src({ projectId: null })]) {
      const h = setup();
      h.lock.update(s);
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.presence.watchPresence).not.toHaveBeenCalled();
      expect(h.presence.writePresence).not.toHaveBeenCalled();
      expect(h.presence.removePresence).not.toHaveBeenCalled();
    }
    const h = setup();
    h.lock.update({ ...src(), user: { uid: 'u1' } });
    const none = createEditLock({ ...h.deps, presence: null });
    none.update(src());
    expect(none.isActive()).toBe(false);
  });

  it('never touches share-view state', async () => {
    readOnly.set(true); // share view active
    const h = setup();
    await open(h, [entry()], src({ shareView: true }));
    expect(h.deps.setReadOnly).not.toHaveBeenCalled();
    expect(get(readOnlyReason)).toBe('share');
    // a lock that was active ends cleanly when a share view takes over
    readOnly.set(false);
    const g = setup();
    await open(g, [entry()]);
    expect(get(readOnlyReason)).toBe('lock');
    readOnly.set(true);
    expect(get(readOnlyReason)).toBe('share');
    g.lock.update(src({ shareView: true }));
    expect(get(readOnly)).toBe(true); // share still read-only
    readOnly.set(false); // leaving the share view
    expect(get(readOnly)).toBe(false);
    // and leaving the share view does not clear an active lock
    const k = setup();
    await open(k, [entry()]);
    readOnly.set(false);
    expect(get(readOnlyReason)).toBe('lock');
  });
});
