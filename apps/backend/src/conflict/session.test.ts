// The resolver session store: the concurrency rules, the TTL, and the wire projection.
//
// Worth a fixture rather than a comment, because every failure here is silent:
//   - a claim that is not atomic starts two clones for one click and neither is wrong on screen;
//   - a `restart` that keeps the old id lands decisions taken against a model that no longer
//     exists, with the right-looking session on the wire;
//   - a session reaped while its job is running leaves the job writing into a record nobody
//     holds and the overlay waiting on a stream that will never speak again;
//   - a `fullyResolvable` that ignores `truncated` promises a clean merge on a PR the commit
//     will leave conflicted.
import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = '/tmp/pierre-conflict-session-test.sqlite';
process.env.DEPLOYMENT_MODE = 'local';
process.env.DISABLE_SCHEDULER = 'true';

import type { ConflictSessionEvent } from '@pierre-review/shared';
import {
  claimCommitSlot,
  claimSession,
  dropSession,
  getSession,
  peekSession,
  sessionView,
  settleFailed,
  settleReady,
  storeSuggestion,
  subscribe,
  __testing,
} from './session.js';
import type { ConflictModel, ConflictModelFile } from './model-types.js';

const ACCOUNT = 1;
const PR = 42;

function file(index: number, over: Partial<ConflictModelFile> = {}): ConflictModelFile {
  return {
    index,
    path: `src/file${index}.ts`,
    relatedPaths: [],
    unsupported: null,
    unsupportedLabel: null,
    regions: [
      {
        id: 0,
        kind: 'conflict',
        base: ['a'],
        ours: ['b'],
        theirs: ['c'],
        fingerprint: `fp${index}`,
        wand: null,
        mergedLines: null,
      },
    ],
    terminators: { base: true, ours: true, theirs: true },
    maxSideBytes: 8,
    stage2Mode: '100644',
    ...over,
  };
}

function model(over: Partial<ConflictModel> = {}): ConflictModel {
  return {
    accountId: ACCOUNT,
    prId: PR,
    owner: 'acme',
    name: 'web',
    number: 7,
    headSha: 'head1234',
    baseSha: 'base1234',
    headRef: 'feature/x',
    baseRef: 'main',
    mergeBaseSha: 'mb123456',
    mergeBaseIsVirtual: false,
    mergedTreeSha: 'tree1234',
    files: [file(0)],
    totalConflictedPaths: 1,
    truncated: false,
    renameDetection: 'on',
    commitsAboveBase: 1,
    strategies: ['merge', 'rebase'],
    rebaseUnavailableReason: null,
    reservedBranchNames: ['main'],
    prBranchPushable: true,
    prBranchUnavailableReason: null,
    ...over,
  };
}

const open = (opts: { restart?: boolean; autoApply?: boolean } = {}, now = Date.now()) =>
  claimSession(ACCOUNT, PR, { restart: opts.restart ?? false, autoApply: opts.autoApply ?? true }, now);

beforeEach(() => {
  __testing.reset();
});

describe('claiming the open slot', () => {
  it('creates one session per (account, PR) and re-attaches every later open to it', () => {
    const first = open();
    expect(first.kind).toBe('created');
    const second = open();
    expect(second.kind).toBe('reused');
    // ⚠ THE SAME RECORD, not a copy: a second tab must not get a second clone, and it must not
    // get a session id the commit path will call expired.
    expect(second.session?.sessionId).toBe(first.session?.sessionId);
    expect(__testing.sessions.size).toBe(1);
  });

  it('refuses a restart while a build is running, and re-attaches a plain open to it', () => {
    const first = open();
    expect(first.kind).toBe('created');
    // Still `openRunning` — there is nothing to cancel a build with, and abandoning it would
    // leave a clone and two fetches running for a record nobody will read.
    expect(open({ restart: true }).kind).toBe('busy');
    expect(open().kind).toBe('reused');
  });

  it('mints a NEW id on a restart of a settled session', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(first.session, model(), 'hash-a', false);
    const restarted = open({ restart: true });
    expect(restarted.kind).toBe('created');
    expect(restarted.session?.sessionId).not.toBe(first.session.sessionId);
    // The superseded id is now unusable — which is exactly what makes a commit against the old
    // model `SessionExpired` rather than a push of bytes nobody chose.
    expect(getSession(ACCOUNT, PR, first.session.sessionId)).toBeNull();
  });

  it('caps the machine at two concurrent git jobs', () => {
    expect(claimSession(ACCOUNT, 1, { restart: false, autoApply: true }).kind).toBe('created');
    expect(claimSession(ACCOUNT, 2, { restart: false, autoApply: true }).kind).toBe('created');
    const third = claimSession(ACCOUNT, 3, { restart: false, autoApply: true });
    expect(third).toEqual({ kind: 'busy', session: null, reason: 'capacity' });
  });

  it('keeps one account out of another account’s session', () => {
    const mine = open();
    if (mine.kind !== 'created') throw new Error('expected a fresh session');
    // The routes 404 before they get here; this pins the store itself, so a route that forgot
    // would still not hand over the model.
    expect(getSession(2, PR, mine.session.sessionId)).toBeNull();
    expect(peekSession(2, PR)).toBeNull();
  });
});

describe('the TTL', () => {
  it('drops an idle session and keeps one that is still being used', () => {
    const t0 = 1_000_000;
    const first = open({}, t0);
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(first.session, model(), 'hash-a', false);
    const ttl = first.session.expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(0);

    // A read pushes the expiry out: an open resolver in use is not idle.
    const later = Date.now() + ttl - 1000;
    expect(getSession(ACCOUNT, PR, first.session.sessionId, later)).not.toBeNull();
    expect(peekSession(ACCOUNT, PR, later + ttl - 1000)).not.toBeNull();
    // Past it with nobody reading, it is gone.
    expect(peekSession(ACCOUNT, PR, later + ttl * 3)).toBeNull();
  });

  it('never reaps a session whose job is still running', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    // `openRunning` is still true — the build is in flight.
    expect(peekSession(ACCOUNT, PR, Date.now() + 86_400_000)).not.toBeNull();
    settleReady(first.session, model(), 'hash-a', false);
    expect(peekSession(ACCOUNT, PR, Date.now() + 86_400_000)).toBeNull();
  });
});

describe('dropping a session', () => {
  it('drops the named id, ignores a superseded one, and holds on to a running job', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    // A job is in flight: closing the overlay must not leave a push writing into a record
    // nobody holds.
    expect(dropSession(ACCOUNT, PR, first.session.sessionId)).toBe(false);
    settleReady(first.session, model(), 'hash-a', false);
    expect(dropSession(ACCOUNT, PR, 'some-other-id')).toBe(false);
    expect(dropSession(ACCOUNT, PR, first.session.sessionId)).toBe(true);
    expect(peekSession(ACCOUNT, PR)).toBeNull();
  });
});

describe('the commit slot', () => {
  it('is claimed once and refuses the second click', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(first.session, model(), 'hash-a', false);
    const slot = claimCommitSlot(first.session);
    expect(slot.ok).toBe(true);
    expect(first.session.commit).toEqual({
      status: 'running',
      phase: 'preparing',
      result: null,
      error: null,
    });
    expect(claimCommitSlot(first.session)).toEqual({ ok: false, reason: 'pr' });
  });
});

describe('the stream', () => {
  it('emits progress and terminal frames, and tells a live stream when the session goes', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    const seen: ConflictSessionEvent[] = [];
    const unsub = subscribe(first.session, (e) => seen.push(e));

    settleFailed(first.session, 'too_many_files', 'Too many files.');
    expect(seen.map((e) => e.type)).toEqual(['failed']);

    dropSession(ACCOUNT, PR, first.session.sessionId);
    expect(seen.at(-1)?.type).toBe('done');
    unsub();
  });

  it('does not let one broken socket take the job down', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    subscribe(first.session, () => {
      throw new Error('socket gone');
    });
    const seen: ConflictSessionEvent[] = [];
    subscribe(first.session, (e) => seen.push(e));
    expect(() => settleReady(first.session, model(), 'hash-a', false)).not.toThrow();
    expect(seen.map((e) => e.type)).toEqual(['ready']);
  });
});

describe('suggestions', () => {
  it('stores lines under an opaque id, scoped to the session that minted it', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    const id = storeSuggestion(first.session, {
      fileIndex: 0,
      regionId: 0,
      lines: ['merged()'],
      endsWithNewline: true,
    });
    expect(first.session.suggestions.get(id)?.lines).toEqual(['merged()']);
    settleReady(first.session, model(), 'hash-a', false);
    const restarted = open({ restart: true });
    if (restarted.kind !== 'created') throw new Error('expected a fresh session');
    // ⚠ A new model is a new session. The old handle is `UnknownSuggestion` at the commit —
    // never a splice of text nobody looked at into a file nobody reviewed.
    expect(restarted.session.suggestions.has(id)).toBe(false);
  });
});

describe('the wire projection', () => {
  it('carries empty pins while preparing and the real ones once ready', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    const preparing = sessionView(first.session);
    expect(preparing.status).toBe('preparing');
    expect(preparing.headSha).toBe('');
    expect(preparing.files).toEqual([]);

    settleReady(first.session, model(), 'hash-a', false);
    const ready = sessionView(first.session);
    expect(ready.status).toBe('ready');
    expect(ready.headSha).toBe('head1234');
    expect(ready.modelHash).toBe('hash-a');
    expect(ready.baseRef).toBe('main');
    expect(ready.files).toHaveLength(1);
    expect(ready.strategies).toEqual(['merge', 'rebase']);
  });

  it('never carries a region — the manifest is counts and pins', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(first.session, model(), 'hash-a', false);
    const view = sessionView(first.session);
    expect(JSON.stringify(view)).not.toContain('fp0');
    expect(view.files[0]).toMatchObject({ index: 0, regionCount: 1, conflictCount: 1 });
  });

  it('lists the unsupported files and refuses to call the merge fully resolvable', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    settleReady(
      first.session,
      model({
        files: [
          file(0),
          file(1, { unsupported: 'binary', unsupportedLabel: 'Binary file', regions: [] }),
        ],
        totalConflictedPaths: 2,
      }),
      'hash-a',
      false,
    );
    const view = sessionView(first.session);
    expect(view.unsupportedIndexes).toEqual([1]);
    expect(view.fullyResolvable).toBe(false);
  });

  it('⚠ counts TRUNCATION as not-fully-resolvable, not just a refused file', () => {
    const first = open();
    if (first.kind !== 'created') throw new Error('expected a fresh session');
    // Every file we DID extract is resolvable — and there are conflicted paths we never
    // reached. A commit leaves this PR conflicted just as surely as a binary file would, so
    // the panel must be allowed to say so.
    settleReady(
      first.session,
      model({ truncated: true, totalConflictedPaths: 90 }),
      'hash-a',
      false,
    );
    const view = sessionView(first.session);
    expect(view.unsupportedIndexes).toEqual([]);
    expect(view.fullyResolvable).toBe(false);
    expect(view.truncated).toBe(true);
    expect(view.totalConflictedPaths).toBe(90);
  });
});
