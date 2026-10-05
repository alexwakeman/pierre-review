// SETTLED BY A REPLY — the pure rule (settled-by-reply.ts). What this pins:
//   1. a posted finding whose thread was RESOLVED after someone else REPLIED, with no code change
//      under it, is settled — matched by stored comment id or by its body (Post review stores none);
//   2. ⚠ resolved WITHOUT a reply is NOT settled (resolving is a click, not evidence);
//   3. ⚠ a reply by the account's own login (Limn posts AS the reader) or by a bot does not count;
//   4. a commit touching the file after the comment, an outdated thread, or a commit whose files
//      were never synced all leave the finding on the old (follow-up) path;
//   5. a new finding repeating a settled one (same path, similar title) is dropped; one linked to a
//      still-open earlier finding is kept.
import { describe, expect, it } from 'vitest';
import {
  dropSettledReraises,
  findingThread,
  settledFindings,
  similarTitles,
  type SettleCommit,
  type SettleFinding,
  type SettleThread,
  type SettleThreadComment,
} from './settled-by-reply.js';

const ME = 'viewer-me';
const T0 = Date.UTC(2026, 9, 1, 10);
const at = (h: number): Date => new Date(T0 + h * 3600_000);

const finding = (over: Partial<SettleFinding> = {}): SettleFinding => ({
  id: 7,
  path: 'src/a.ts',
  title: 'Null dereference of `user` in loadUser',
  body: 'This dereferences `user` before the null check.',
  githubCommentId: null,
  ...over,
});

const comment = (over: Partial<SettleThreadComment> = {}): SettleThreadComment => ({
  databaseId: null,
  authorLogin: 'alice-dev',
  authorIsBot: false,
  body: 'text',
  createdAt: at(1),
  ...over,
});

const rootFor = (f: SettleFinding, over: Partial<SettleThreadComment> = {}): SettleThreadComment =>
  comment({
    authorLogin: ME,
    body: `${f.body}\n\n<!-- pierre:claude-review-finding v=1 -->`,
    createdAt: at(0),
    ...over,
  });

const thread = (comments: SettleThreadComment[], over: Partial<SettleThread> = {}): SettleThread => ({
  path: 'src/a.ts',
  isResolved: true,
  derivedState: 'resolved',
  isOutdated: false,
  comments,
  ...over,
});

const REPLY = comment({ body: 'Intentional: `user` is validated by the middleware upstream.' });

describe('settledFindings', () => {
  it('settles a finding resolved after another person replied, with no code change', () => {
    const f = finding();
    const out = settledFindings([f], [thread([rootFor(f), REPLY])], [], ME);
    expect(out).toEqual([
      {
        id: 7,
        path: 'src/a.ts',
        title: f.title,
        replyAuthor: 'alice-dev',
        reply: 'Intentional: `user` is validated by the middleware upstream.',
      },
    ]);
  });

  it('matches the thread by stored GitHub id even when the comment was edited on GitHub', () => {
    const f = finding({ githubCommentId: '555' });
    const root = rootFor(f, { databaseId: '555', body: 'Reworded on GitHub.' });
    expect(settledFindings([f], [thread([root, REPLY])], [], ME).map((s) => s.id)).toEqual([7]);
  });

  it('⚠ resolved with NO reply is not settled (resolving is a click)', () => {
    const f = finding();
    expect(settledFindings([f], [thread([rootFor(f)])], [], ME)).toEqual([]);
  });

  it('an unresolved thread is not settled, reply or not', () => {
    const f = finding();
    expect(
      settledFindings([f], [thread([rootFor(f), REPLY], { isResolved: false, derivedState: 'replied_unresolved' })], [], ME),
    ).toEqual([]);
  });

  it("⚠ a reply by Limn itself (the account's own login) does not count", () => {
    const f = finding();
    const ownReply = comment({ authorLogin: 'Viewer-Me', body: 'Follow-up from Limn.\n\n<!-- pierre:claude-review-finding v=1 -->' });
    expect(settledFindings([f], [thread([rootFor(f), ownReply])], [], ME)).toEqual([]);
    // …nor a plain reply under that login: Limn posts AS the reader, so the login is ours.
    const plain = comment({ authorLogin: ME, body: 'Intentional.' });
    expect(settledFindings([f], [thread([rootFor(f), plain])], [], ME)).toEqual([]);
  });

  it('a bot reply, an unknown author or a blank reply does not count', () => {
    const f = finding();
    const bot = comment({ authorLogin: 'coderabbitai[bot]', authorIsBot: true });
    const unknown = comment({ authorLogin: null });
    const blank = comment({ body: '   ' });
    for (const r of [bot, unknown, blank]) {
      expect(settledFindings([f], [thread([rootFor(f), r])], [], ME)).toEqual([]);
    }
  });

  it('a commit touching the file after the comment hands it to the follow-up (the "fixed" path)', () => {
    const f = finding();
    const t = thread([rootFor(f), REPLY]);
    const touching: SettleCommit = { committedAt: at(2), paths: ['src/a.ts'] };
    expect(settledFindings([f], [t], [touching], ME)).toEqual([]);
    // A commit BEFORE the comment, or on another file, changes nothing.
    const before: SettleCommit = { committedAt: at(-1), paths: ['src/a.ts'] };
    const other: SettleCommit = { committedAt: at(2), paths: ['src/b.ts'] };
    expect(settledFindings([f], [t], [before, other], ME).map((s) => s.id)).toEqual([7]);
    // Files never synced ⇒ we do not know ⇒ not settled.
    const unknown: SettleCommit = { committedAt: at(2), paths: null };
    expect(settledFindings([f], [t], [unknown], ME)).toEqual([]);
  });

  it('an outdated thread (the code under it changed) is not settled', () => {
    const f = finding();
    expect(settledFindings([f], [thread([rootFor(f), REPLY], { isOutdated: true })], [], ME)).toEqual([]);
  });

  it("a thread opened by someone else, or on another path, is not the finding's", () => {
    const f = finding();
    expect(findingThread(f, [thread([rootFor(f, { authorLogin: 'bob' }), REPLY])], ME)).toBeNull();
    expect(findingThread(f, [thread([rootFor(f), REPLY], { path: 'src/b.ts' })], ME)).toBeNull();
    expect(findingThread(f, [thread([rootFor(f), REPLY])], null)).toBeNull();
  });
});

describe('re-raise of a settled finding', () => {
  const settled = [{ id: 7, path: 'src/a.ts', title: 'Null dereference of `user` in loadUser' }];

  it('similar titles: folded equality or word overlap', () => {
    expect(similarTitles('Null dereference of `user` in loadUser', 'null dereference of user in loadUser.')).toBe(true);
    expect(similarTitles('Null dereference of user in loadUser', 'Possible null dereference of user in loadUser')).toBe(true);
    expect(similarTitles('Null dereference of user in loadUser', 'SQL injection in the search query')).toBe(false);
  });

  it('drops an unlinked repeat on the same path; keeps another path, another point and a linked re-raise', () => {
    const repeat = { path: 'src/a.ts', title: 'Possible null dereference of user in loadUser', priorFindingId: null };
    const otherPath = { path: 'src/b.ts', title: 'Null dereference of user in loadUser', priorFindingId: null };
    const otherPoint = { path: 'src/a.ts', title: 'Missing await on save()', priorFindingId: null };
    const linked = { path: 'src/a.ts', title: 'Null dereference of user in loadUser', priorFindingId: 3 };
    const { kept, dropped } = dropSettledReraises([repeat, otherPath, otherPoint, linked], settled);
    expect(dropped).toEqual([repeat]);
    expect(kept).toEqual([otherPath, otherPoint, linked]);
  });

  it('nothing settled ⇒ everything kept', () => {
    const f = { path: 'src/a.ts', title: 'x', priorFindingId: null };
    expect(dropSettledReraises([f], [])).toEqual({ kept: [f], dropped: [] });
  });
});
