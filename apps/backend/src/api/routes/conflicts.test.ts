// The six merge-conflict-resolver routes, on a THROWAWAY sqlite DB (the reopen-pr.test.ts
// pattern): env is set BEFORE importing config/client, the real routes, the real ownership check
// and the real query layer all run, and only the two expensive halves are stubbed — the model
// BUILD (a clone, two fetches and a merge-tree) and the LAND (a push).
//
// WHAT THIS PINS, and why each one is worth a fixture:
//
//   1. OWNERSHIP IS RE-CHECKED ON EVERY ROUTE, and another tenant's id is a 404 — the family
//      must not be an existence oracle. A `sessionId` is a CONCURRENCY token, never a capability.
//   2. WRITE PERMISSION IS RE-CHECKED ON EVERY ROUTE. The resolver ends in a push; a reader who
//      cannot push must not be able to start one, or to read another repo's source through it.
//   3. THE SESSION IS ONE PER PR. A second open re-attaches; a restart mints a new id and the
//      old one is `SessionExpired` — that is what stops decisions taken against a model that no
//      longer exists from landing.
//   4. THE PINS REFUSE SEPARATELY. head, base and the model hash are three different facts with
//      three different sentences, and a refusal writes NOTHING.
//   5. EVERY EXPENSIVE ROUTE ANSWERS 202 AND RUNS. A malformed request gets a real status code;
//      it never gets a terminal stream frame where an error belongs.
//   6. THE STREAM IS THE ONE CHANNEL — prepare progress and the commit's phases both.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-conflicts-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

import type {
  ConflictCommitBody,
  ConflictCommitResult,
  ConflictSession,
  ConflictSessionEvent,
} from '@pierre-review/shared';
import type { ConflictModel, ConflictModelFile, ConflictModelResult } from '../../conflict/model-types.js';

// The build. Spread the real module so `conflictFileEntries`/`conflictFileContent` — the wire
// projection this file asserts against — stay REAL; a stubbed projection would make every
// manifest assertion a test of the stub.
const buildConflictModel = vi.fn<(args: unknown) => Promise<ConflictModelResult | null>>();
vi.mock('../../conflict/model.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildConflictModel: (args: unknown) => buildConflictModel(args),
}));

// The push. Spread for the same reason: `landError` lives here and the route reads its `.code`.
const landConflictResolution = vi.fn<(args: any) => Promise<ConflictCommitResult>>();
vi.mock('../../conflict/land.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  landConflictResolution: (args: unknown) => landConflictResolution(args),
}));

// `merge-tree --write-tree` needs git 2.38. Stubbed so the suite does not depend on the machine's
// git, and flipped in one test to pin the 501.
const gitSupportsMergeTree = vi.fn(async () => true);
vi.mock('../../conflict/git.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitSupportsMergeTree: () => gitSupportsMergeTree(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let eq: any;
let landError: (code: string, message: string) => Error;
let resetSessions: () => void;

let writePrId = 0;
let readPrId = 0;
let foreignPrId = 0;

const now = Date.now();

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
        base: ['base()'],
        ours: ['ours()'],
        theirs: ['theirs()'],
        fingerprint: `fp-${index}-0`,
        wand: null,
        mergedLines: null,
      },
      {
        id: 1,
        kind: 'unchanged',
        base: ['tail()'],
        ours: [],
        theirs: [],
        fingerprint: `fp-${index}-1`,
        wand: null,
        mergedLines: null,
      },
    ],
    terminators: { base: true, ours: true, theirs: true },
    maxSideBytes: 16,
    stage2Mode: '100644',
    ...over,
  };
}

function model(over: Partial<ConflictModel> = {}): ConflictModel {
  return {
    accountId: 1,
    prId: writePrId,
    owner: 'acme',
    name: 'web',
    number: 1,
    headSha: 'headsha1',
    baseSha: 'basesha1',
    headRef: 'feature/x',
    baseRef: 'main',
    mergeBaseSha: 'mergebase1',
    mergeBaseIsVirtual: false,
    mergedTreeSha: 'tree1',
    files: [file(0)],
    totalConflictedPaths: 1,
    truncated: false,
    renameDetection: 'on',
    commitsAboveBase: 1,
    strategies: ['merge'],
    rebaseUnavailableReason: 'This branch has 4 commits — rebasing can conflict once per commit. Merge instead.',
    reservedBranchNames: ['main'],
    prBranchPushable: true,
    prBranchUnavailableReason: null,
    ...over,
  };
}

const ready = (m: ConflictModel = model()): ConflictModelResult => ({ status: 'ready', model: m });

/** Open a session and wait for the (stubbed) build to settle. */
async function openReady(prId = writePrId, body: unknown = {}): Promise<ConflictSession> {
  const res = await app.inject({ method: 'POST', url: `/api/prs/${prId}/conflicts`, payload: body });
  expect(res.statusCode).toBe(202);
  const opened = res.json() as ConflictSession;
  await waitFor(async () => {
    const s = await manifest(prId, opened.sessionId);
    return s.statusCode === 200 && (s.json() as ConflictSession).status !== 'preparing';
  });
  return (await manifest(prId, opened.sessionId)).json() as ConflictSession;
}

const manifest = (prId: number, sessionId: string) =>
  app.inject({
    method: 'GET',
    url: `/api/prs/${prId}/conflicts?session=${encodeURIComponent(sessionId)}`,
  });

async function waitFor(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting');
}

function commitBody(session: ConflictSession, over: Partial<ConflictCommitBody> = {}): ConflictCommitBody {
  return {
    sessionId: session.sessionId,
    expectedHeadSha: session.headSha,
    expectedBaseSha: session.baseSha,
    modelHash: session.modelHash,
    strategy: 'merge',
    target: { kind: 'pr_branch' },
    // Region 1 is `unchanged` and takes no decision; region 0 is the contested one.
    files: [{ index: 0, decisions: [{ id: 0, decision: 'ours' }] }],
    ...over,
  };
}

const commit = (prId: number, body: unknown) =>
  app.inject({ method: 'POST', url: `/api/prs/${prId}/conflicts/commit`, payload: body });

const RESULT: ConflictCommitResult = {
  strategy: 'merge',
  branch: 'feature/x',
  pushedToPrBranch: true,
  commitSha: 'abcdef1',
  resolvedPaths: ['src/file0.ts'],
  skipped: [],
  stillConflicting: false,
  baseAdvanced: false,
  baseShaUsed: 'basesha1',
  autoMergeDisarmed: false,
  compareUrl: null,
  visible: true,
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ({ eq } = await import('drizzle-orm'));
  ({ landError } = (await import('../../conflict/land.js')) as any);
  resetSessions = (await import('../../conflict/session.js')).__testing.reset;

  const { accounts, repos, pullRequests, users } = schema;

  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice', isBot: false })
    .returning()
    .execute();

  const insertRepo = async (
    accountId: number,
    name: string,
    viewerPermission: string | null,
  ): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name,
        githubNodeId: `R_conflicts_${accountId}_${name}`,
        defaultBranchName: 'main',
        viewerPermission,
      })
      .returning()
      .execute();
    return r.id;
  };
  let n = 1;
  const insertPr = async (accountId: number, repoId: number, key: string): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_conflicts_${key}`,
        accountId,
        repoId,
        number: n++,
        title: `${key} fixture`,
        authorId: author.id,
        state: 'open',
        openedAt: new Date(now - 5 * 86_400_000),
        updatedAt: new Date(now - 3600_000),
        headSha: 'headsha1',
        headRefName: 'feature/x',
        baseRefName: 'main',
      })
      .returning()
      .execute();
    return row.id;
  };

  writePrId = await insertPr(1, await insertRepo(1, 'web', 'WRITE'), 'write');
  readPrId = await insertPr(1, await insertRepo(1, 'docs', 'READ'), 'read');

  // Account 2 owns a mirror-image PR — what keeps the isolation assertions from passing
  // vacuously (the row exists and is perfectly resolvable, by ITS owner).
  await db
    .insert(accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  foreignPrId = await insertPr(2, await insertRepo(2, 'web', 'ADMIN'), 'foreign');

  const { conflictRoutes } = await import('./conflicts.js');
  // `/api/me` rides along because the SPA's entry button reads exactly one field off it and
  // nothing else decides whether this family is reachable — see the assertion below.
  const { meRoutes } = await import('./me.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  await app.register(conflictRoutes);
  await app.register(meRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  resetSessions();
  buildConflictModel.mockReset();
  buildConflictModel.mockResolvedValue(ready());
  landConflictResolution.mockReset();
  landConflictResolution.mockResolvedValue(RESULT);
  gitSupportsMergeTree.mockReset();
  gitSupportsMergeTree.mockResolvedValue(true);
});

/* ═════════════════════════════ registration + gates ═════════════════════════════ */

describe('the family is registered in local mode', () => {
  it('routes all seven paths', () => {
    // The mirror of the cloud assertion in conflicts-cloud.test.ts. Without this half, "they
    // 404 in cloud" would be satisfied by a typo in every path.
    expect(app.hasRoute({ method: 'POST', url: '/api/prs/:id/conflicts' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/prs/:id/conflicts' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/prs/:id/conflicts/stream' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/api/prs/:id/conflicts/files/:fileIndex' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/prs/:id/conflicts/edit' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/api/prs/:id/conflicts/commit' })).toBe(true);
    expect(app.hasRoute({ method: 'DELETE', url: '/api/prs/:id/conflicts' })).toBe(true);
  });

  it('⚠ /api/me says the resolver is here — the ONE fact the entry button gates on', async () => {
    // `MeResponse.conflictResolver` is `!config.isCloud` and nothing else: no git probe, no
    // capability, no env var. The SPA's `conflictResolverEntryVisible` reads it as its fourth
    // arm, so a route family registered here with the flag reporting false would hide the only
    // entry into a working feature — built, gated and unreachable.
    const res = await app.inject({ method: 'GET', url: '/api/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json().conflictResolver).toBe(true);
  });
});

describe('ownership and permission', () => {
  it('404s every route on another account’s PR', async () => {
    const calls = [
      app.inject({ method: 'POST', url: `/api/prs/${foreignPrId}/conflicts`, payload: {} }),
      manifest(foreignPrId, 'whatever'),
      app.inject({ method: 'GET', url: `/api/prs/${foreignPrId}/conflicts/stream?session=x` }),
      app.inject({ method: 'GET', url: `/api/prs/${foreignPrId}/conflicts/files/0?session=x` }),
      // ⚠ THE ONE ROUTE THAT TAKES TEXT IS OWNERSHIP-CHECKED LIKE THE REST, AND FIRST. A
      // well-formed body, for the reason below.
      app.inject({
        method: 'POST',
        url: `/api/prs/${foreignPrId}/conflicts/edit`,
        payload: { sessionId: 'x', fileIndex: 0, regionId: 0, fingerprint: 'fp', text: 'mine' },
      }),
      // A WELL-FORMED body on purpose: the schema runs before the handler, so a malformed one
      // would 400 and prove nothing about ownership.
      commit(
        foreignPrId,
        commitBody({ sessionId: 'x', headSha: 'headsha1', baseSha: 'basesha1', modelHash: 'm'.repeat(64) } as ConflictSession),
      ),
      app.inject({ method: 'DELETE', url: `/api/prs/${foreignPrId}/conflicts?session=x` }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('NotFound');
    }
    // Nothing upstream was even considered.
    expect(buildConflictModel).not.toHaveBeenCalled();
  });

  it('403s a reader who cannot push, before any build', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/prs/${readPrId}/conflicts`, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'NotPermitted',
      message: 'You need write access to resolve conflicts on this pull request.',
    });
    expect(buildConflictModel).not.toHaveBeenCalled();
  });

  it('501s when git is too old to merge-tree, and says where to go instead', async () => {
    gitSupportsMergeTree.mockResolvedValue(false);
    const res = await app.inject({ method: 'POST', url: `/api/prs/${writePrId}/conflicts`, payload: {} });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({
      error: 'GitUnavailable',
      message: 'git isn’t available here. Resolve conflicts on GitHub.',
    });
    expect(buildConflictModel).not.toHaveBeenCalled();
  });
});

/* ═════════════════════════════ the session ═════════════════════════════ */

describe('opening', () => {
  it('answers 202 with a preparing session and settles it on the stubbed build', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/prs/${writePrId}/conflicts`, payload: {} });
    expect(res.statusCode).toBe(202);
    const opened = res.json() as ConflictSession;
    expect(opened.status).toBe('preparing');
    expect(opened.headSha).toBe('');

    await waitFor(async () => (await manifest(writePrId, opened.sessionId)).json().status === 'ready');
    const session = (await manifest(writePrId, opened.sessionId)).json() as ConflictSession;
    expect(session.headSha).toBe('headsha1');
    expect(session.files).toHaveLength(1);
    expect(session.modelHash).toHaveLength(64);
    // ⚠ THE SESSION ID REACHES THE BUILDER. It namespaces the fetch refs and names the two refs
    // the land path's teardown deletes; a builder called with a different one leaves them behind.
    expect((buildConflictModel.mock.calls[0]?.[0] as any).sessionId).toBe(opened.sessionId);
  });

  it('re-attaches a second open to the live session instead of building twice', async () => {
    const first = await openReady();
    const res = await app.inject({ method: 'POST', url: `/api/prs/${writePrId}/conflicts`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ConflictSession).sessionId).toBe(first.sessionId);
    expect(buildConflictModel).toHaveBeenCalledTimes(1);
  });

  it('builds again on restart, and the superseded id is expired', async () => {
    const first = await openReady();
    const second = await openReady(writePrId, { restart: true });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(buildConflictModel).toHaveBeenCalledTimes(2);

    const stale = await manifest(writePrId, first.sessionId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('SessionExpired');
  });

  it('settles a failed build into the session rather than leaving it preparing', async () => {
    buildConflictModel.mockResolvedValue({
      status: 'failed',
      code: 'too_many_files',
      message: 'This merge touches too many files.',
    });
    const session = await openReady();
    expect(session.status).toBe('failed');
    expect(session.error).toEqual({
      code: 'too_many_files',
      message: 'This merge touches too many files.',
    });
  });

  it('settles a THROWN build too — a spinner forever is the worse failure', async () => {
    buildConflictModel.mockRejectedValue(new Error('git exploded'));
    const session = await openReady();
    expect(session.status).toBe('failed');
    expect(session.error?.message).toBe('Couldn’t work out the conflicts in this pull request.');
  });

  it('starts every region at base when the body says autoApply:false', async () => {
    // ⚠ IT ALSO PROVES AJV IS NOT STRIPPING THE FLAG. `openSchema` carries
    // `additionalProperties: false`, so a field the schema does not declare is removed silently
    // and the SPA's "nothing is applied before you press something" becomes a no-op nothing
    // reports. The contact form's honeypot is the same defect one layer over.
    const oneSided: ConflictModelFile = file(0, {
      regions: [
        {
          id: 0,
          kind: 'ours_only',
          base: ['base()'],
          ours: ['ours()'],
          theirs: [],
          fingerprint: 'fp-one-sided',
          wand: { decision: 'ours', reason: 'only_ours' },
          mergedLines: null,
        },
      ],
    });
    buildConflictModel.mockResolvedValue(ready(model({ files: [oneSided] })));

    const on = await openReady(writePrId, {});
    const onContent = await app.inject({
      method: 'GET',
      url: `/api/prs/${writePrId}/conflicts/files/0?session=${on.sessionId}`,
    });
    // The knob still works the other way — it is the SPA's choice that changed, not the protocol.
    expect(onContent.json().regions[0].defaultDecision).toBe('ours');

    const off = await openReady(writePrId, { restart: true, autoApply: false });
    const offContent = await app.inject({
      method: 'GET',
      url: `/api/prs/${writePrId}/conflicts/files/0?session=${off.sessionId}`,
    });
    expect(offContent.json().regions[0].defaultDecision).toBe('base');
  });

  it('reports a conflict-free merge as `clean`, and does not invent work', async () => {
    buildConflictModel.mockResolvedValue({ status: 'clean', model: model({ files: [] }) });
    const session = await openReady();
    expect(session.status).toBe('clean');
    expect(session.files).toEqual([]);
  });
});

describe('one file’s regions', () => {
  it('serves them by INDEX, with the default decision the open asked for', async () => {
    const session = await openReady();
    const res = await app.inject({
      method: 'GET',
      url: `/api/prs/${writePrId}/conflicts/files/0?session=${session.sessionId}`,
    });
    expect(res.statusCode).toBe(200);
    const content = res.json();
    expect(content.path).toBe('src/file0.ts');
    expect(content.regions).toHaveLength(2);
    expect(content.regions[0].allowed).toContain('both_ours_first');
    // No path ever travels in a URL — the file is addressed by its index and answers with its
    // own path, which is display only.
    expect(content.index).toBe(0);
  });

  it('400s an index this model has no file for', async () => {
    const session = await openReady();
    const res = await app.inject({
      method: 'GET',
      url: `/api/prs/${writePrId}/conflicts/files/9?session=${session.sessionId}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'UnknownFileIndex',
      message: 'That file isn’t part of this session. Reopen the resolver.',
    });
  });
});

/* ═════════════════════════ editing one region by hand ═════════════════════════ */

// ⚠ THE ONE ROUTE IN THE APP THAT ACCEPTS TYPED FILE CONTENT. Everything below is about the
// three things that keep that safe: it validates BEFORE it mints, so an id that exists is an id
// whose bytes were checked; it pins the text to the region's CONTENT, not just its address; and
// the commit still carries nothing but the id.
describe('editing one region by hand', () => {
  const edit = (prId: number, body: unknown) =>
    app.inject({ method: 'POST', url: `/api/prs/${prId}/conflicts/edit`, payload: body });

  /** A body for region 0 of file 0, whose fingerprint the fixture sets to `fp-0-0`. */
  const editBody = (session: ConflictSession, over: Record<string, unknown> = {}) => ({
    sessionId: session.sessionId,
    fileIndex: 0,
    regionId: 0,
    fingerprint: 'fp-0-0',
    text: 'typed-by-hand',
    ...over,
  });

  it('stores the text and hands back an opaque id, deciding nothing', async () => {
    const session = await openReady();
    const res = await edit(writePrId, editBody(session));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.edit.fileIndex).toBe(0);
    expect(body.edit.regionId).toBe(0);
    expect(typeof body.edit.editId).toBe('string');
    // ⚠ THE SERVER'S OWN SPLIT, ECHOED — so the centre pane renders the lines the commit will
    // splice rather than its own second opinion about where the text breaks.
    expect(body.edit.lines).toEqual(['typed-by-hand']);
    // The region is not decided by this. A commit that named no decision for it still refuses.
    const bare = await commit(writePrId, commitBody(session, { files: [{ index: 0, decisions: [] }] }));
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error).toBe('IncompleteDecisions');
  });

  it('splits on newlines, and an EMPTY box is zero lines', async () => {
    const session = await openReady();
    const many = await edit(writePrId, editBody(session, { text: 'one\ntwo\nthree' }));
    expect(many.json().edit.lines).toEqual(['one', 'two', 'three']);
    const none = await edit(writePrId, editBody(session, { text: '' }));
    expect(none.json().edit.lines).toEqual([]);
  });

  it('REFUSES on the fingerprint, which is the content pin beside the id’s address', async () => {
    // Without this, text written against one version of a region could be redeemed, after a
    // rebuild, against a region that kept its id and changed its bytes.
    const session = await openReady();
    const res = await edit(writePrId, editBody(session, { fingerprint: 'fp-stale' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: false,
      refusal: 'moved',
      message: 'This change moved while you were editing it. Reopen the resolver.',
    });
  });

  it('refuses an `unchanged` region — context lines are read-only', async () => {
    // Region 1 of the fixture file is context. Keeping it unanswerable is what let this ship
    // without bumping `CONFLICT_MODEL_VERSION`.
    const session = await openReady();
    const res = await edit(writePrId, editBody(session, { regionId: 1, fingerprint: 'fp-0-1' }));
    expect(res.json().refusal).toBe('not_editable');
  });

  it('refuses a lone surrogate and a surviving conflict marker', async () => {
    const session = await openReady();
    // ⚠ `Buffer.from(text,'utf8')` substitutes U+FFFD for a lone surrogate SILENTLY, so without
    // this the committed bytes are not the bytes anybody saw.
    const surrogate = await edit(writePrId, editBody(session, { text: 'a\uD800b' }));
    expect(surrogate.json().refusal).toBe('not_text');
    // ⚠ Nothing downstream inspects the bytes: the land path's guard proves each conflicted path
    // was OVERWRITTEN, never that what overwrote it is clean.
    const marked = await edit(writePrId, editBody(session, { text: '<<<<<<< HEAD\nmine' }));
    expect(marked.json().refusal).toBe('markers');
  });

  it('refuses text over the cap, and mints nothing when it does', async () => {
    const session = await openReady();
    const res = await edit(writePrId, editBody(session, { text: 'x'.repeat(50_000) }));
    expect(res.json().refusal).toBe('too_long');
    expect(res.json().edit).toBeUndefined();
  });

  it('answers 409 SessionExpired for a dead session, like every other route here', async () => {
    const session = await openReady();
    const res = await edit(writePrId, editBody(session, { sessionId: 'not-a-session' }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('SessionExpired');
  });

  it('403s a reader who cannot push, before it looks at the text', async () => {
    const res = await edit(readPrId, {
      sessionId: 'x',
      fileIndex: 0,
      regionId: 0,
      fingerprint: 'fp',
      text: 'mine',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NotPermitted');
  });

  it('⚠ AJV DOES NOT STRIP `editId` FROM THE COMMIT BODY', async () => {
    // The per-decision item is `additionalProperties: false`, so a field the schema does not
    // name is removed SILENTLY — the commit would then resolve an edited region with no id at
    // all and answer `UnknownEdit` about an edit that is sitting right there in the session.
    // The same defect already bit `autoApply` on the open schema and the contact form's
    // honeypot one feature over, which is why this is an assertion rather than a comment.
    const session = await openReady();
    const minted = (await edit(writePrId, editBody(session))).json().edit.editId as string;
    const res = await commit(
      writePrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'edited', editId: minted }] }],
      }),
    );
    expect(res.statusCode).toBe(202);
    const sent = landConflictResolution.mock.calls[0]?.[0] as any;
    expect(sent.body.files[0].decisions[0]).toEqual({
      id: 0,
      decision: 'edited',
      editId: minted,
    });
    // ...and the land path is handed the store the id addresses, not just the id.
    expect(sent.edits.get(minted)).toEqual({
      fileIndex: 0,
      regionId: 0,
      lines: ['typed-by-hand'],
      endsWithNewline: true,
    });
  });

  it('refuses the commit when the id is not one this session minted', async () => {
    const session = await openReady();
    const res = await commit(
      writePrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'edited', editId: 'made-up' }] }],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'UnknownEdit',
      message: 'One of your edits has expired. Make it again.',
    });
    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('⚠ a SUPERSEDED handle stays redeemable — re-saving may not kill what Undo points at', async () => {
    // ⚠ THIS TEST IS THE INVERSE OF THE ONE IT REPLACES, AND THE OLD REASONING IS RECORDED RATHER
    // THAN DELETED. `storeEdit` used to DELETE the region's previous edit on the argument that "a
    // region has one current text, so nothing references the old id". True of the region, false of
    // the handles: `ResolverPanes`' undo stack files `previousEditId` when a decision is replaced,
    // so a second save followed by one Ctrl+Z restored an id the server had just destroyed. The
    // pane could not tell (its line map is append-only), so the region went on rendering as
    // decided — and the WHOLE commit then came back `UnknownEdit`, naming no file and no region,
    // on a board where everything looked answered. Two tabs on one PR did it across the process.
    const session = await openReady();
    const first = (await edit(writePrId, editBody(session))).json().edit.editId as string;
    const second = (await edit(writePrId, editBody(session, { text: 'second go' }))).json().edit
      .editId as string;
    expect(second).not.toBe(first);
    const undone = await commit(
      writePrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'edited', editId: first }] }],
      }),
    );
    expect(undone.statusCode).toBe(202);
    const sent = landConflictResolution.mock.calls[0]?.[0] as any;
    expect(sent.edits.get(first)?.lines).toEqual(['typed-by-hand']);
    // Both live at once, addressing the two texts they were minted for.
    expect(sent.edits.get(second)?.lines).toEqual(['second go']);
  });

  it('⚠ a `too_many_edits` refusal MINTS NOTHING AND DESTROYS NOTHING', async () => {
    // The budget used to be summed AFTER the region's previous edit was deleted, so a save that
    // overran the cap took the reader's already-accepted edit with it on the way to refusing —
    // leaving the store pointing at a handle the server no longer had, and the commit answering
    // the same unlocatable `UnknownEdit`. A refusal is a no-op or the route's own contract
    // ("a refusal mints nothing, so there is no handle to redeem") is not true.
    const session = await openReady();
    const first = (await edit(writePrId, editBody(session))).json().edit.editId as string;
    const big = 'x'.repeat(4000);
    let refused: Record<string, unknown> | null = null;
    for (let i = 0; i < 200 && refused == null; i += 1) {
      const body = (await edit(writePrId, editBody(session, { text: big }))).json();
      if (body.ok === false) refused = body;
    }
    expect(refused).toEqual({
      ok: false,
      refusal: 'too_many_edits',
      message: 'This session is holding as many edits as it can. Commit what you have.',
    });
    const res = await commit(
      writePrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'edited', editId: first }] }],
      }),
    );
    expect(res.statusCode).toBe(202);
  });

  it('⚠ re-imposes the region’s CRLF, which the textarea already stripped', async () => {
    // A textarea's API value normalises every CRLF to a bare LF before React can see a keystroke,
    // so one character typed into a Windows-authored file used to rewrite the WHOLE hunk's line
    // endings — every line of the diff changed, and a genuinely wrong file in any repo carrying
    // `* text eol=crlf`. The client cannot send the CRs; it never had them.
    buildConflictModel.mockResolvedValue(
      ready(
        model({
          files: [
            file(0, {
              regions: [
                {
                  id: 0,
                  kind: 'conflict',
                  base: ['base()\r'],
                  ours: ['ours()\r'],
                  theirs: ['theirs()\r'],
                  fingerprint: 'fp-0-0',
                  wand: null,
                  mergedLines: null,
                },
              ],
            }),
          ],
        }),
      ),
    );
    const session = await openReady();
    const res = await edit(writePrId, editBody(session, { text: 'one\ntwo' }));
    expect(res.json().edit.lines).toEqual(['one\r', 'two\r']);
  });

  it('⚠ keeps a BOM file’s FIRST region editable, and refuses U+FEFF anywhere else', async () => {
    // `model.ts` decodes with `ignoreBOM: true` on purpose, so a BOM file's first line really does
    // begin U+FEFF and the textarea really is seeded with it. The blanket `not_text` refusal made
    // that region permanently unsaveable, with a sentence ("Retype the odd one out") naming a
    // zero-width character — and the only escape, retyping the hunk, silently stripped the BOM.
    buildConflictModel.mockResolvedValue(
      ready(
        model({
          files: [
            file(0, {
              regions: [
                {
                  id: 0,
                  kind: 'conflict',
                  base: ['﻿base()'],
                  ours: ['﻿ours()'],
                  theirs: ['﻿theirs()'],
                  fingerprint: 'fp-0-0',
                  wand: null,
                  mergedLines: null,
                },
                {
                  id: 1,
                  kind: 'conflict',
                  base: ['tail()'],
                  ours: ['our-tail()'],
                  theirs: ['their-tail()'],
                  fingerprint: 'fp-0-1',
                  wand: null,
                  mergedLines: null,
                },
              ],
            }),
          ],
        }),
      ),
    );
    const session = await openReady();
    const kept = await edit(writePrId, editBody(session, { text: '﻿using System;' }));
    expect(kept.json().edit.lines).toEqual(['﻿using System;']);
    // ⚠ AND IT IS RE-ATTACHED WHEN THE READER LOST IT. They cannot have dropped it deliberately.
    const restored = await edit(writePrId, editBody(session, { text: 'using System;' }));
    expect(restored.json().edit.lines).toEqual(['﻿using System;']);
    // A BOM in the middle is still junk...
    const middle = await edit(writePrId, editBody(session, { text: 'a﻿b' }));
    expect(middle.json().refusal).toBe('not_text');
    // ...and so is one on a region that does not start the file.
    const later = await edit(
      writePrId,
      editBody(session, { regionId: 1, fingerprint: 'fp-0-1', text: '﻿x' }),
    );
    expect(later.json().refusal).toBe('not_text');
  });

  it('does not let one tenant’s id be redeemed against another’s session', async () => {
    // Belt to `getSession`'s braces: the id is minted inside a record keyed `(accountId, prId)`,
    // so a foreign caller cannot even reach the store to look one up.
    const session = await openReady();
    const minted = (await edit(writePrId, editBody(session))).json().edit.editId as string;
    const res = await commit(
      foreignPrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'edited', editId: minted }] }],
      }),
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('closing', () => {
  it('204s and frees the session, and 204s again on a session that is already gone', async () => {
    const session = await openReady();
    const first = await app.inject({
      method: 'DELETE',
      url: `/api/prs/${writePrId}/conflicts?session=${session.sessionId}`,
    });
    expect(first.statusCode).toBe(204);
    expect((await manifest(writePrId, session.sessionId)).statusCode).toBe(409);
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/prs/${writePrId}/conflicts?session=${session.sessionId}`,
    });
    expect(second.statusCode).toBe(204);
  });
});

/* ═════════════════════════════ the commit ═════════════════════════════ */

describe('the commit’s synchronous refusals', () => {
  it('refuses a superseded session id before anything is pushed', async () => {
    const first = await openReady();
    await openReady(writePrId, { restart: true });
    const res = await commit(writePrId, commitBody(first));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'SessionExpired',
      message: 'This session is no longer open. Reopen it and take your decisions again.',
    });
    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('refuses the three pins SEPARATELY — head, base and the model itself', async () => {
    const session = await openReady();

    const moved = await commit(writePrId, commitBody(session, { expectedHeadSha: 'other' }));
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error).toBe('HeadMoved');
    expect(moved.json().message).toContain('feature/x');

    const based = await commit(writePrId, commitBody(session, { expectedBaseSha: 'other' }));
    expect(based.statusCode).toBe(409);
    expect(based.json().error).toBe('BaseMoved');
    expect(based.json().message).toContain('main');

    const stale = await commit(writePrId, commitBody(session, { modelHash: 'nope' }));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('ModelStale');

    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('refuses a rebase the model never offered, in the model’s own words', async () => {
    const session = await openReady();
    const res = await commit(writePrId, commitBody(session, { strategy: 'rebase' }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'RebaseNotOffered',
      message: 'This branch has 4 commits — rebasing can conflict once per commit. Merge instead.',
    });
  });

  it('refuses a new branch named after the base branch, and says which it is', async () => {
    const session = await openReady();
    const res = await commit(
      writePrId,
      commitBody(session, { target: { kind: 'new_branch', branch: 'MAIN', openPr: true } }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'ReservedBranch',
      message: 'MAIN is this PR’s base branch. Pick another name.',
    });
    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('refuses a branch name git will not take', async () => {
    const session = await openReady();
    const res = await commit(
      writePrId,
      commitBody(session, { target: { kind: 'new_branch', branch: 'bad..name', openPr: false } }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('InvalidBranch');
    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('names the file that still has an undecided change', async () => {
    const session = await openReady();
    const res = await commit(writePrId, commitBody(session, { files: [{ index: 0, decisions: [] }] }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'IncompleteDecisions',
      message: 'src/file0.ts still has 1 conflict to decide.',
    });
  });

  it('refuses a suggestion id this session never minted', async () => {
    const session = await openReady();
    const res = await commit(
      writePrId,
      commitBody(session, {
        files: [{ index: 0, decisions: [{ id: 0, decision: 'suggestion', suggestionId: 'made-up' }] }],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'UnknownSuggestion',
      message: 'That suggestion has expired. Ask Claude again.',
    });
    expect(landConflictResolution).not.toHaveBeenCalled();
  });

  it('refuses a file index this model does not have', async () => {
    const session = await openReady();
    const res = await commit(
      writePrId,
      commitBody(session, { files: [{ index: 7, decisions: [{ id: 0, decision: 'ours' }] }] }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('UnknownFileIndex');
  });
});

describe('the commit itself', () => {
  it('answers 202 and reports the result on the session', async () => {
    const session = await openReady();
    const res = await commit(writePrId, commitBody(session));
    expect(res.statusCode).toBe(202);
    expect((res.json() as ConflictSession).commit).toMatchObject({
      status: 'running',
      phase: 'preparing',
    });

    await waitFor(async () => {
      const s = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
      return s.commit?.status === 'done';
    });
    const done = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
    expect(done.commit?.result).toEqual(RESULT);
    // The SAME session id the model was built with: it names the two refs teardown deletes.
    expect(landConflictResolution.mock.calls[0]?.[0].sessionId).toBe(session.sessionId);
  });

  it('puts the land path’s own code and sentence straight onto the session', async () => {
    landConflictResolution.mockRejectedValue(
      landError('HeadMoved', 'The pull request moved to abc1234 while this was open.'),
    );
    const session = await openReady();
    expect((await commit(writePrId, commitBody(session))).statusCode).toBe(202);
    await waitFor(async () => {
      const s = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
      return s.commit?.status === 'failed';
    });
    const failed = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
    expect(failed.commit?.error).toEqual({
      code: 'HeadMoved',
      message: 'The pull request moved to abc1234 while this was open.',
    });
  });

  it('does not leak an unrecognised throw as a wire code', async () => {
    landConflictResolution.mockRejectedValue(new Error('EACCES /Users/someone/.ssh/id_rsa'));
    const session = await openReady();
    await commit(writePrId, commitBody(session));
    await waitFor(async () => {
      const s = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
      return s.commit?.status === 'failed';
    });
    const failed = (await manifest(writePrId, session.sessionId)).json() as ConflictSession;
    expect(failed.commit?.error?.code).toBe('GitFailed');
    expect(failed.commit?.error?.message).toBe('The resolved commit didn’t reach GitHub.');
  });

  it('refuses a SECOND commit while the first is in flight — a second push is not a retry', async () => {
    const session = await openReady();
    // One mutable record rather than a `let`: TypeScript narrows a `let` assigned only inside a
    // callback down to its initializer's type, so calling it later is an error on `never` (the
    // reactions.ts precedent).
    const gate: { release: (() => void) | null } = { release: null };
    landConflictResolution.mockImplementation(
      () =>
        new Promise<ConflictCommitResult>((resolve) => {
          gate.release = () => resolve(RESULT);
        }),
    );
    expect((await commit(writePrId, commitBody(session))).statusCode).toBe(202);
    const second = await commit(writePrId, commitBody(session));
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('Busy');
    expect(landConflictResolution).toHaveBeenCalledTimes(1);
    gate.release?.();
  });
});

/* ═════════════════════════════ the stream ═════════════════════════════ */

describe('the one stream', () => {
  it('snapshots on subscribe and carries the commit’s phases on the same channel', async () => {
    const session = await openReady();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const ac = new AbortController();
      const res = await fetch(
        `${address}/api/prs/${writePrId}/conflicts/stream?session=${session.sessionId}`,
        { signal: ac.signal },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const events = readEvents(res, ac);

      // Frame 1 is the snapshot, always — a client that subscribes after the build finished
      // still learns the state rather than waiting for a change that already happened.
      const snapshot = await events.next();
      expect(snapshot.type).toBe('snapshot');

      const gate: { release: (() => void) | null } = { release: null };
      landConflictResolution.mockImplementation(
        (args: any) =>
          new Promise<ConflictCommitResult>((resolve) => {
            args.onPhase('pushing');
            gate.release = () => resolve(RESULT);
          }),
      );
      await commit(writePrId, commitBody(session));

      const progress = await events.next();
      expect(progress).toMatchObject({ type: 'commit_progress' });
      expect((progress as any).session.commit.phase).toBe('pushing');

      gate.release?.();
      const done = await events.next();
      expect(done).toMatchObject({ type: 'commit_done', result: RESULT });
      ac.abort();
    } finally {
      await app.close();
      // Fastify cannot be re-listened after close; the remaining suites use `inject`, which
      // does not need a socket. This block is last on purpose.
    }
  });
});

/** Read `data:` frames off an SSE response one at a time. */
function readEvents(res: Response, ac: AbortController) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const queue: ConflictSessionEvent[] = [];
  return {
    async next(ms = 3000): Promise<ConflictSessionEvent> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const queued = queue.shift();
        if (queued) return queued;
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut = buf.indexOf('\n\n');
        while (cut !== -1) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of block.split('\n')) {
            if (line.startsWith('data:')) queue.push(JSON.parse(line.slice(5).trim()));
          }
          cut = buf.indexOf('\n\n');
        }
      }
      ac.abort();
      throw new Error('no event arrived');
    },
  };
}
