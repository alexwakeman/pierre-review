// THE BOT OBJECT AT ITS ONE GRAIN, on a THROWAWAY sqlite DB.
//
// `workspace_reviewers` (account, WORKSPACE, author) is now a single row carrying THREE facts that
// used to be spread over two tables:
//
//   JUDGEMENT  automated / role / confidence / source / reasons_json   — provenance: `source`
//   IDENTITY   kind / label                                            — provenance: `identity_source`
//   PRICE      monthly_cents                                           — no provenance; ONE writer
//
// This file replaces `bot-reviewer-grains.test.ts`, which pinned two semantics the workspace model
// deletes outright — "cost is an ACTOR fact" and "the judgement is PER REPO". Both are gone: a repo
// belongs to exactly one workspace, and every one of the three facts above is keyed to
// (account, workspace, actor). PRICE IS PER WORKSPACE: there is no fan-out writer, no INSERT seed
// and no cross-workspace coupling of any kind.
//
// ── WHY THE ASSERTIONS COME IN PAIRS ──────────────────────────────────────────────────────────
// Under 0042/0043 "a judgement write cannot touch identity" was a TABLE BOUNDARY. That boundary is
// gone. What replaces it is code discipline — a `set:` object narrowed per half, built fresh per
// workspace, honouring TWO provenance flags that now share one row. Discipline is not observable
// from a single-direction assertion, so every test below states what an edit DID and, separately,
// that the things it must not touch are BYTE-IDENTICAL afterwards. Where a whole row must be
// untouched (another workspace's row, Default's row after a delete) the comparison is the WHOLE
// row, `updated_at` included; where a row is legitimately written it is the named subset.
//
// ── MUTATION-PROVED ───────────────────────────────────────────────────────────────────────────
// A passing test is only evidence of intent. These assertions were verified by BREAKING the
// production code and confirming the specific test fails, then restoring it (see the per-test
// notes on the price confinement, the two provenance flags, and the deleteWorkspace re-home).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { readFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-workspace-reviewer-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let classifyReviewer: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Account 1's Default workspace (created by migration 0044 for every account that exists then).
let wsDefault = 0;
let repoHome = 0;

// ── INVARIANT 3: one actor, FOUR workspaces, one price edit ──
let wsCostA = 0;
let wsCostB = 0;
let wsCostC = 0;
let wsCostD = 0;
let costBot = 0;

// ── INVARIANTS 1 + 2: the two halves of the PATCH ──
let wsPatch = 0;
let patchBot = 0;

// ── INVARIANT 4: the two provenance flags, honoured independently, inside one row ──
let wsPinJudgement = 0; // source='manual', identity auto
let wsPinIdentity = 0; // identity_source='manual', judgement auto
let wsPinNeither = 0; // both auto — the control that proves the pass writes at all
let pinBot = 0;

// ── INVARIANT 5: the two resets ──
let wsReset = 0;
let resetBot = 0;

// ── INVARIANT 6: deleteWorkspace re-homes rows to Default ──
let wsDoomedSolo = 0; // its actor has NO row in Default → the row arrives intact
let wsDoomedCollide = 0; // its actor ALREADY has a Default row → Default's row wins untouched
let moveBot = 0;
let collideBot = 0;

let human = 0;

let seq = 0;

async function mkUser(login: string, githubType?: string): Promise<number> {
  const [row] = await db
    .insert(schema.users)
    .values({
      githubLogin: login,
      githubNodeId: `U_wsr_${login}`,
      isBot: githubType === 'Bot',
      ...(githubType ? { githubType } : {}),
    })
    .returning()
    .execute();
  return row.id as number;
}

async function mkRepo(name: string): Promise<number> {
  const [row] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_wsr_${name}` })
    .returning()
    .execute();
  return row.id as number;
}

// A workspace holding exactly one repo. `assignReposToWorkspace` MOVES it out of Default (the
// membership unique is what makes that structural), so after this the repo is in `name` only.
async function mkWorkspace(name: string, repoId: number): Promise<number> {
  const ws = await q.createWorkspace(1, name);
  await q.assignReposToWorkspace(ws.id, 1, [repoId]);
  return ws.id as number;
}

// One inline thread opened by `actorId` on a fresh PR in `repoId` — the FOOTPRINT a row is created
// from. Rows are NEVER fabricated for a pair with no footprint, so every actor that must appear
// needs one of these in the right repo.
async function seedThread(repoId: number, actorId: number): Promise<void> {
  seq += 1;
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_wsr_${seq}`,
      accountId: 1,
      repoId,
      number: seq,
      title: `fixture #${seq}`,
      state: 'open',
      mergeable: 'mergeable',
      isDraft: false,
      authorId: human,
      openedAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - DAY),
    })
    .returning()
    .execute();
  await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `RT_wsr_${seq}`,
      prId: pr.id,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: actorId,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
}

// The listing is what LAZILY creates a row for an actor with a footprint and no row in this
// workspace. Routed through the real scope resolver so the repoIds narrowing is bounded by the
// workspace's membership exactly as a request would be.
async function listWs(workspaceId: number): Promise<any> {
  const scope = await q.resolveWorkspaceScope(1, workspaceId);
  return q.listDetectedReviewers(1, scope);
}

// THE RAW STORED ROW — never the wire object. Every "byte-identical" claim below is about what is
// in the table, because the wire form re-derives `label` and hides `monthly_cents` behind a
// division.
async function rawRow(workspaceId: number, userId: number): Promise<any> {
  const rows = await db.select().from(schema.workspaceReviewers).execute();
  return (
    rows.find(
      (r: any) =>
        r.accountId === 1 && r.workspaceId === workspaceId && r.authorUserId === userId,
    ) ?? null
  );
}

async function memberships(): Promise<{ repoId: number; workspaceId: number }[]> {
  const rows = await db.select().from(schema.workspaceRepos).execute();
  return rows
    .filter((r: any) => r.accountId === 1)
    .map((r: any) => ({ repoId: r.repoId, workspaceId: r.workspaceId }));
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  ({ classifyReviewer } = await import('../sync/reviewer-classify.js'));
  await runMigrations();

  human = await mkUser('dana-h');
  // KNOWN VENDOR LOGINS throughout: a vendor is the case the identity half exists for (brand
  // colour + name), and it gives the classifier a strong, deterministic opinion to revert — which
  // is what makes "a manual flag survived a full pass" a real assertion rather than a vacuous one.
  costBot = await mkUser('sourcery-ai', 'Bot');
  patchBot = await mkUser('korbit-ai', 'Bot');
  pinBot = await mkUser('coderabbitai', 'Bot');
  resetBot = await mkUser('ellipsis-dev', 'Bot');
  moveBot = await mkUser('bito-code-review', 'Bot');
  collideBot = await mkUser('baz-reviewer', 'Bot');

  repoHome = await mkRepo('home');
  wsDefault = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);

  const repoCostA = await mkRepo('cost-a');
  const repoCostB = await mkRepo('cost-b');
  const repoCostC = await mkRepo('cost-c');
  const repoCostD = await mkRepo('cost-d');
  wsCostA = await mkWorkspace('Cost A', repoCostA);
  wsCostB = await mkWorkspace('Cost B', repoCostB);
  wsCostC = await mkWorkspace('Cost C', repoCostC);
  wsCostD = await mkWorkspace('Cost D', repoCostD);
  for (const r of [repoCostA, repoCostB, repoCostC, repoCostD]) await seedThread(r, costBot);

  const repoPatch = await mkRepo('patch');
  wsPatch = await mkWorkspace('Patch', repoPatch);
  await seedThread(repoPatch, patchBot);

  const repoPinJ = await mkRepo('pin-j');
  const repoPinI = await mkRepo('pin-i');
  const repoPinN = await mkRepo('pin-n');
  wsPinJudgement = await mkWorkspace('Pin judgement', repoPinJ);
  wsPinIdentity = await mkWorkspace('Pin identity', repoPinI);
  wsPinNeither = await mkWorkspace('Pin neither', repoPinN);
  for (const r of [repoPinJ, repoPinI, repoPinN]) await seedThread(r, pinBot);

  const repoReset = await mkRepo('reset');
  wsReset = await mkWorkspace('Reset', repoReset);
  await seedThread(repoReset, resetBot);

  const repoSolo = await mkRepo('doomed-solo');
  wsDoomedSolo = await mkWorkspace('Doomed solo', repoSolo);
  await seedThread(repoSolo, moveBot);

  const repoCollide = await mkRepo('doomed-collide');
  wsDoomedCollide = await mkWorkspace('Doomed collide', repoCollide);
  await seedThread(repoCollide, collideBot);
  // collideBot ALSO works in Default's repo, so Default can legitimately hold its own row at its
  // own price — the collision the re-home has to decide.
  await seedThread(repoHome, collideBot);
});

afterAll(() => closeDb?.());

// ── 0. THE FIXTURE IS REAL ───────────────────────────────────────────────────────────────────
// Everything below reads a stored row. If the lazy classifier never wrote one, every assertion
// would pass vacuously against `undefined`.
describe('the fixture is real (nothing below is vacuous)', () => {
  it('the listing creates ONE row per (workspace, actor) with a footprint', async () => {
    const resp = await listWs(wsCostA);
    expect(resp.workspaceId).toBe(wsCostA);
    const wire = resp.reviewers.find((r: any) => r.userId === costBot);
    expect(wire).toBeDefined();
    expect(wire.automated).toBe(true);
    expect(wire.kind).toBe('sourcery');
    // A brand-new row has NO price. There is nothing to inherit from — see invariant 3.
    expect(wire.costMonthlyUsd).toBeNull();

    const row = await rawRow(wsCostA, costBot);
    expect(row).not.toBeNull();
    expect(row.source).toBe('vendor_login');
    expect(row.identitySource).toBe('auto');
    expect(row.monthlyCents).toBeNull();

    // …and exactly one row, not one per repo. There is no grain below the workspace any more.
    const all = (await db.select().from(schema.workspaceReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.workspaceId === wsCostA && r.authorUserId === costBot,
    );
    expect(all).toHaveLength(1);
  });
});

// ── 1. A JUDGEMENT WRITE TOUCHES ONLY THE JUDGEMENT ──────────────────────────────────────────
describe('invariant 1 — a judgement patch leaves identity AND price byte-identical', () => {
  it('automated/role move; kind, label, identity_source and monthly_cents do not', async () => {
    await listWs(wsPatch);
    // Give the row a HUMAN-SET identity and a price first — the two things a judgement write must
    // not be able to reach. A row whose identity is still auto-derived cannot prove the point:
    // re-deriving it would land on the same values and look untouched.
    await q.setWorkspaceReviewer(1, patchBot, {
      workspaceId: wsPatch,
      kind: 'greptile',
      label: 'Actually Greptile',
    });
    await q.setReviewerCost(1, patchBot, wsPatch, 42.5);
    const before = await rawRow(wsPatch, patchBot);
    expect(before.identitySource).toBe('manual');
    expect(before.monthlyCents).toBe(4250);

    const wire = await q.setWorkspaceReviewer(1, patchBot, {
      workspaceId: wsPatch,
      automated: false,
      role: 'quality_check',
    });
    expect(wire).not.toBeNull();

    const after = await rawRow(wsPatch, patchBot);
    // What the patch DID.
    expect(after.automated).toBe(false);
    expect(after.role).toBe('quality_check');
    expect(after.source).toBe('manual');
    expect(after.confidence).toBe('high');
    // …AND what it must not have touched, byte for byte.
    expect(after.kind).toBe(before.kind);
    expect(after.label).toBe(before.label);
    expect(after.identitySource).toBe(before.identitySource);
    expect(after.monthlyCents).toBe(before.monthlyCents);
    // The wire form agrees (the route echoes this object).
    expect(wire.kind).toBe('greptile');
    expect(wire.label).toBe('Actually Greptile');
    expect(wire.identitySource).toBe('manual');
    expect(wire.costMonthlyUsd).toBe(42.5);
  });

  it('a role-ONLY patch still stamps source:manual (a visible pin beats a silent revert)', async () => {
    const wire = await q.setWorkspaceReviewer(1, patchBot, {
      workspaceId: wsPatch,
      role: 'review',
    });
    expect(wire.role).toBe('review');
    expect(wire.isManualOverride).toBe(true);
    const row = await rawRow(wsPatch, patchBot);
    expect(row.source).toBe('manual');
    expect(row.identitySource).toBe('manual'); // still the human's, untouched by a role edit
  });
});

// ── 2. AN IDENTITY WRITE TOUCHES ONLY THE IDENTITY ───────────────────────────────────────────
describe('invariant 2 — an identity patch leaves judgement AND price byte-identical', () => {
  it('kind/label move; automated, role, confidence, source, reasons and cost do not', async () => {
    const before = await rawRow(wsPatch, patchBot);
    // The judgement is a HUMAN'S here (source:'manual' from the tests above), which is the case
    // that matters: gating identity on the judgement flag is the bug this pairing exists to catch.
    expect(before.source).toBe('manual');

    const wire = await q.setWorkspaceReviewer(1, patchBot, {
      workspaceId: wsPatch,
      kind: 'korbit',
      label: 'Korbit (renamed)',
    });
    expect(wire).not.toBeNull();

    const after = await rawRow(wsPatch, patchBot);
    expect(after.kind).toBe('korbit');
    expect(after.label).toBe('Korbit (renamed)');
    expect(after.identitySource).toBe('manual');
    // …and the whole judgement half plus the price, byte for byte.
    expect(after.automated).toBe(before.automated);
    expect(after.role).toBe(before.role);
    expect(after.confidence).toBe(before.confidence);
    expect(after.source).toBe(before.source);
    expect(after.reasonsJson).toEqual(before.reasonsJson);
    expect(after.monthlyCents).toBe(before.monthlyCents);
  });

  it('clearing the vendor name (kind:null) is still identity-only', async () => {
    const before = await rawRow(wsPatch, patchBot);
    await q.setWorkspaceReviewer(1, patchBot, { workspaceId: wsPatch, kind: null, label: null });
    const after = await rawRow(wsPatch, patchBot);
    expect(after.kind).toBeNull();
    expect(after.label).toBeNull();
    expect(after.automated).toBe(before.automated);
    expect(after.source).toBe(before.source);
    expect(after.monthlyCents).toBe(before.monthlyCents);
  });
});

// ── 3. THE PRICE IS CONFINED TO ITS WORKSPACE ────────────────────────────────────────────────
// MUTATION-PROVED. Dropping `eq(workspaceReviewers.workspaceId, workspaceId)` from
// setReviewerCost's UPDATE predicate — the single most plausible mistake, since the other two
// predicates already look like a complete key — makes this block fail on B and C.
describe('invariant 3 — setReviewerCost writes ONE column in ONE workspace', () => {
  it('setting a price in A leaves B (a different price) and C (NULL) byte-identical', async () => {
    await listWs(wsCostB);
    await listWs(wsCostC);
    // B holds a DIFFERENT price and C holds none — the two states a fan-out would corrupt
    // differently, and the reason both are here.
    await q.setReviewerCost(1, costBot, wsCostB, 7);
    const beforeA = await rawRow(wsCostA, costBot);
    const beforeB = await rawRow(wsCostB, costBot);
    const beforeC = await rawRow(wsCostC, costBot);
    expect(beforeB.monthlyCents).toBe(700);
    expect(beforeC.monthlyCents).toBeNull();

    await q.setReviewerCost(1, costBot, wsCostA, 120);

    // WHOLE ROWS, `updated_at` included: these two must not have been written at all.
    expect(await rawRow(wsCostB, costBot)).toEqual(beforeB);
    expect(await rawRow(wsCostC, costBot)).toEqual(beforeC);

    // A took the price and NOTHING ELSE (the timestamp is the one legitimate co-write).
    const afterA = await rawRow(wsCostA, costBot);
    expect(afterA.monthlyCents).toBe(12000);
    expect({ ...afterA, monthlyCents: null, updatedAt: null }).toEqual({
      ...beforeA,
      monthlyCents: null,
      updatedAt: null,
    });
  });

  it('a row created LATER in a fourth workspace comes up with NO price (no INSERT seed)', async () => {
    // The actor is priced in two workspaces by now. If anything seeded a new row from a sibling —
    // "the account already pays $120 for CodeRabbit" — this is where it would show.
    expect((await rawRow(wsCostA, costBot)).monthlyCents).toBe(12000);
    expect(await rawRow(wsCostD, costBot)).toBeNull();
    await listWs(wsCostD);
    const fresh = await rawRow(wsCostD, costBot);
    expect(fresh).not.toBeNull();
    expect(fresh.monthlyCents).toBeNull();
  });

  it('clearing a price is a COLUMN write, never a row delete', async () => {
    const before = await rawRow(wsCostB, costBot);
    await q.setReviewerCost(1, costBot, wsCostB, null);
    const after = await rawRow(wsCostB, costBot);
    expect(after).not.toBeNull(); // the row also carries the judgement + the identity
    expect(after.monthlyCents).toBeNull();
    expect(after.kind).toBe(before.kind);
    expect(after.automated).toBe(before.automated);
    // 0 is a REAL price ("we pay nothing"), not a synonym for cleared.
    await q.setReviewerCost(1, costBot, wsCostB, 0);
    expect((await rawRow(wsCostB, costBot)).monthlyCents).toBe(0);
    const wire = (await listWs(wsCostB)).reviewers.find((r: any) => r.userId === costBot);
    expect(wire.costMonthlyUsd).toBe(0);
  });

  it('the price is bounded at the int4 cents ceiling (pg raises where sqlite would not)', async () => {
    await q.setReviewerCost(1, costBot, wsCostB, 99_999_999_999);
    expect((await rawRow(wsCostB, costBot)).monthlyCents).toBe(2_147_483_647);
    await q.setReviewerCost(1, costBot, wsCostB, 0);
  });
});

// ── 4. ONE FULL CLASSIFICATION PASS, TWO FLAGS, ONE ROW ──────────────────────────────────────
// THE SINGLE MOST IMPORTANT TEST IN THIS FILE. The 0042/0043 table boundary used to enforce this
// structurally; it is now `persist()`'s per-half `set:` narrowing, and nothing but this pins it.
//
// MUTATION-PROVED, three ways:
//   • `existing?.source !== 'manual'` → `true` in persist(): the manual "not a bot" is overwritten
//     and this block fails.
//   • `existing?.identitySource !== 'manual'` → `true`: the human's vendor name is reverted and
//     this block fails.
//   • `(set as any).monthlyCents = null` inside persist(): the price assertions fail — i.e. just
//     opening the Bots tab would wipe the money the user typed.
describe('invariant 4 — a full classifyReviewer pass honours both provenance flags, and no price', () => {
  it('pins one workspace by judgement, another by identity, leaves a third free', async () => {
    for (const ws of [wsPinJudgement, wsPinIdentity, wsPinNeither]) await listWs(ws);

    // A human says "not a bot" in ONE workspace — the judgement half only.
    await q.setWorkspaceReviewer(1, pinBot, { workspaceId: wsPinJudgement, automated: false });
    // A human RENAMES the vendor in ANOTHER — the identity half only.
    await q.setWorkspaceReviewer(1, pinBot, {
      workspaceId: wsPinIdentity,
      kind: 'greptile',
      label: 'Actually Greptile',
    });
    // Money in all three, at three different values, so a fan-out or a wipe is visible wherever
    // it happens.
    await q.setReviewerCost(1, pinBot, wsPinJudgement, 10);
    await q.setReviewerCost(1, pinBot, wsPinIdentity, 20);
    await q.setReviewerCost(1, pinBot, wsPinNeither, 30);

    const beforeJ = await rawRow(wsPinJudgement, pinBot);
    const beforeI = await rawRow(wsPinIdentity, pinBot);
    expect(beforeJ.source).toBe('manual');
    expect(beforeJ.identitySource).toBe('auto'); // the OTHER half is still detection's
    expect(beforeI.identitySource).toBe('manual');
    expect(beforeI.source).toBe('vendor_login'); // …and here it is the judgement that is free

    // ONE derivation, written to every one of the actor's workspaces — the real sync/lazy path.
    // `coderabbitai` is a known vendor login, so the pass wants to say automated/coderabbit
    // everywhere; both human edits are things it would otherwise revert.
    await classifyReviewer(
      1,
      { id: pinBot, githubLogin: 'coderabbitai', githubType: 'Bot', isBot: true },
      {},
      [wsPinJudgement, wsPinIdentity, wsPinNeither],
    );

    const afterJ = await rawRow(wsPinJudgement, pinBot);
    const afterI = await rawRow(wsPinIdentity, pinBot);
    const afterN = await rawRow(wsPinNeither, pinBot);

    // (a) the manual JUDGEMENT survived …
    expect(afterJ.automated).toBe(false);
    expect(afterJ.source).toBe('manual');
    expect(afterJ.reasonsJson).toEqual(beforeJ.reasonsJson);
    // … while the IDENTITY in the very same row re-derived, because its own flag is 'auto'.
    expect(afterJ.kind).toBe('coderabbit');
    expect(afterJ.identitySource).toBe('auto');

    // (b) the manual IDENTITY survived …
    expect(afterI.kind).toBe('greptile');
    expect(afterI.label).toBe('Actually Greptile');
    expect(afterI.identitySource).toBe('manual');
    // … while the JUDGEMENT in the same row re-derived.
    expect(afterI.source).toBe('vendor_login');
    expect(afterI.automated).toBe(true);

    // (c) the control: an untouched workspace takes the full verdict, so the pass really did run
    // and (a)/(b) are not passing because nothing happened.
    expect(afterN.source).toBe('vendor_login');
    expect(afterN.kind).toBe('coderabbit');
    expect(afterN.label).toBe('CodeRabbit');

    // (d) NOT ONE PRICE MOVED. The classifier does not name the column; this is the assertion
    // that would catch it growing one.
    expect(afterJ.monthlyCents).toBe(1000);
    expect(afterI.monthlyCents).toBe(2000);
    expect(afterN.monthlyCents).toBe(3000);
  });

  it('a second pass is idempotent — one row per workspace, prices still intact', async () => {
    await classifyReviewer(
      1,
      { id: pinBot, githubLogin: 'coderabbitai', githubType: 'Bot', isBot: true },
      {},
      [wsPinJudgement, wsPinIdentity, wsPinNeither],
    );
    const rows = (await db.select().from(schema.workspaceReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === pinBot,
    );
    expect(rows).toHaveLength(3); // the 3-column ON CONFLICT target really is the unique index
    expect(rows.map((r: any) => r.monthlyCents).sort((a: number, b: number) => a - b)).toEqual([
      1000, 2000, 3000,
    ]);
  });

  it('the price column is named NOWHERE in the classifier, and in ONE UPDATE in the query layer', () => {
    // A GREP, deliberately, because the guarantee is STRUCTURAL rather than behavioural: the
    // classifier runs LAZILY from listDetectedReviewers, so a stray cost key there would wipe
    // money just by opening the Bots tab, for every actor on the page, with no error anywhere.
    //
    // NOTE THE STRICTNESS: even a COMMENT naming the column fails this. That is the intent — the
    // absence has to stay greppable, and `ReviewerSetValues` types it out of existence precisely
    // so nobody needs to write the name here to reason about it.
    const classifySrc = readFileSync(
      new URL('../sync/reviewer-classify.ts', import.meta.url),
      'utf8',
    );
    expect(classifySrc).not.toMatch(/monthlyCents|monthly_cents/);

    // …and in queries.ts exactly ONE UPDATE of this table names it: `setReviewerCost`. The other
    // two (resetJudgement, resetIdentity) must not — losing a price as a side effect of resetting
    // a classification is the coupling the whole contract keeps separated. The deleteWorkspace
    // re-home DOES carry it, in an INSERT `values`, which is the point of invariant 6.
    const queriesSrc = readFileSync(new URL('./queries.ts', import.meta.url), 'utf8');
    const updates = queriesSrc
      .split('.update(workspaceReviewers)')
      .slice(1)
      .map((seg) => seg.slice(0, seg.indexOf('.execute()')));
    // Non-vacuity, not a census: the count is deliberately a FLOOR so adding a legitimate fourth
    // UPDATE is not a spurious CI failure that reads exactly like a real regression.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.filter((u) => u.includes('monthlyCents'))).toHaveLength(1);

    // The PATCH handler's `set:` object cannot reach the column either.
    const patchStart = queriesSrc.indexOf('export async function setWorkspaceReviewer(');
    const patchEnd = queriesSrc.indexOf('export async function resetWorkspaceReviewerJudgement(');
    expect(patchStart).toBeGreaterThan(0);
    expect(patchEnd).toBeGreaterThan(patchStart);
    expect(queriesSrc.slice(patchStart, patchEnd)).not.toMatch(/monthlyCents/);
  });
});

// ── 5. THE TWO RESETS ────────────────────────────────────────────────────────────────────────
describe('invariant 5 — each reset RE-DERIVES its own half and leaves the other alone', () => {
  it('resetJudgement hands automated/role back to detection; identity and price survive', async () => {
    await listWs(wsReset);
    await q.setWorkspaceReviewer(1, resetBot, {
      workspaceId: wsReset,
      kind: 'qodo',
      label: 'Hand-named',
    });
    await q.setReviewerCost(1, resetBot, wsReset, 15);
    await q.setWorkspaceReviewer(1, resetBot, { workspaceId: wsReset, automated: false });
    const before = await rawRow(wsReset, resetBot);
    expect(before.source).toBe('manual');
    expect(before.automated).toBe(false);

    const wire = await q.resetWorkspaceReviewerJudgement(1, resetBot, wsReset);
    expect(wire).not.toBeNull();
    const after = await rawRow(wsReset, resetBot);
    // RE-DERIVED, not merely cleared: a clear-only reset would leave the human's `automated:false`
    // sitting under an 'auto' label — a stale opinion wearing the wrong provenance.
    expect(after.source).toBe('vendor_login');
    expect(after.automated).toBe(true);
    expect(after.confidence).toBe('high');
    // The row is UPDATED, never deleted — it carries the other two facts.
    expect(after.id).toBe(before.id);
    expect(after.kind).toBe('qodo');
    expect(after.label).toBe('Hand-named');
    expect(after.identitySource).toBe('manual');
    expect(after.monthlyCents).toBe(1500);
  });

  it('resetIdentity re-derives the vendor (never nameless) and KEEPS the price', async () => {
    // Pin the judgement first, so this also proves the reset does not reach across the row.
    await q.setWorkspaceReviewer(1, resetBot, {
      workspaceId: wsReset,
      automated: true,
      role: 'quality_check',
    });
    const before = await rawRow(wsReset, resetBot);
    expect(before.source).toBe('manual');
    expect(before.identitySource).toBe('manual');
    expect(before.monthlyCents).toBe(1500);

    const wire = await q.resetWorkspaceReviewerIdentity(1, resetBot, wsReset);
    expect(wire).not.toBeNull();
    const after = await rawRow(wsReset, resetBot);
    // NON-NULL AGAIN. The `[]`-argument bug would leave kind null for good: the lazy pass only
    // fires on a MISSING row, so nothing would ever re-derive it and "Reset name" would read as
    // "delete the vendor".
    expect(after.kind).toBe('ellipsis');
    expect(after.label).toBe('Ellipsis');
    expect(after.identitySource).toBe('auto');
    expect(wire.kind).toBe('ellipsis');
    // The judgement half is the human's and stays that way …
    expect(after.source).toBe('manual');
    expect(after.role).toBe('quality_check');
    expect(after.automated).toBe(true);
    // … and un-naming a vendor says NOTHING about what it costs.
    expect(after.monthlyCents).toBe(1500);
    expect(wire.costMonthlyUsd).toBe(15);
  });

  it('both resets 404 (null) for a foreign workspace and for an actor with no row there', async () => {
    expect(await q.resetWorkspaceReviewerJudgement(1, resetBot, 999_999)).toBeNull();
    expect(await q.resetWorkspaceReviewerIdentity(1, resetBot, 999_999)).toBeNull();
    expect(await q.resetWorkspaceReviewerIdentity(1, costBot, wsReset)).toBeNull();
    expect(await q.setReviewerCost(1, costBot, wsReset, 5)).toBeNull();
  });
});

// ── 6. deleteWorkspace RE-HOMES THE REVIEWER ROWS ────────────────────────────────────────────
// Two cascades fire from `workspaces` and only one is recoverable: losing `workspace_repos` leaves
// the repos invisible until the next repair, but losing `workspace_reviewers` destroys every
// manual verdict, every hand-typed vendor name and every price, with no undo.
//
// BOTH CASES ARE HERE ON PURPOSE. The collision case ALONE cannot distinguish "re-homed, then
// skipped on conflict" from "never re-homed at all" — they produce the identical end state.
//
// MUTATION-PROVED: deleting the re-home INSERT loop fails the solo case; turning its
// `onConflictDoNothing` into an `onConflictDoUpdate` fails the collision case.
describe('invariant 6 — deleteWorkspace re-homes repos AND reviewer rows to Default', () => {
  it('an actor ABSENT from Default arrives there intact, price included', async () => {
    await listWs(wsDoomedSolo);
    await q.setWorkspaceReviewer(1, moveBot, { workspaceId: wsDoomedSolo, automated: false });
    await q.setReviewerCost(1, moveBot, wsDoomedSolo, 77);
    const before = await rawRow(wsDoomedSolo, moveBot);
    expect(before.monthlyCents).toBe(7700);
    expect(await rawRow(wsDefault, moveBot)).toBeNull(); // nothing to collide with

    expect(await q.deleteWorkspace(wsDoomedSolo, 1)).toBe('deleted');

    const rehomed = await rawRow(wsDefault, moveBot);
    expect(rehomed).not.toBeNull();
    expect(rehomed.monthlyCents).toBe(7700);
    // Everything else came across verbatim — only the row's own identity columns differ.
    expect({ ...rehomed, id: 0, workspaceId: 0 }).toEqual({ ...before, id: 0, workspaceId: 0 });
    // …and the doomed workspace's row is gone, not orphaned.
    expect(await rawRow(wsDoomedSolo, moveBot)).toBeNull();

    // The repo landed in Default too, with exactly one membership row (9.11: a repo with none is
    // invisible to every workspace-scoped read, silently).
    const mem = await memberships();
    const soloRepo = mem.filter((m) => m.workspaceId === wsDefault);
    expect(soloRepo.length).toBeGreaterThanOrEqual(2); // repoHome + the re-homed one
    const ids = mem.map((m) => m.repoId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate membership rows
    const repoRows = await db.select().from(schema.repos).execute();
    expect(ids.length).toBe(repoRows.filter((r: any) => r.accountId === 1).length);
  });

  it("on a collision Default's existing row WINS and is byte-identical afterwards", async () => {
    // Default holds its own row for this actor, at its own price and its own vendor name.
    await listWs(wsDefault);
    await q.setWorkspaceReviewer(1, collideBot, {
      workspaceId: wsDefault,
      label: 'Default naming',
    });
    await q.setReviewerCost(1, collideBot, wsDefault, 5);
    const defaultBefore = await rawRow(wsDefault, collideBot);
    expect(defaultBefore.monthlyCents).toBe(500);

    // The doomed workspace holds a DIFFERENT price and a DIFFERENT name for the same actor.
    await listWs(wsDoomedCollide);
    await q.setWorkspaceReviewer(1, collideBot, {
      workspaceId: wsDoomedCollide,
      label: 'Doomed naming',
    });
    await q.setReviewerCost(1, collideBot, wsDoomedCollide, 999);
    expect((await rawRow(wsDoomedCollide, collideBot)).monthlyCents).toBe(99_900);

    expect(await q.deleteWorkspace(wsDoomedCollide, 1)).toBe('deleted');

    // WHOLE ROW, `updated_at` included. Overwriting a price the user set in Default as a side
    // effect of deleting a DIFFERENT workspace would be strictly worse than losing the doomed
    // one's, and would have no undo.
    expect(await rawRow(wsDefault, collideBot)).toEqual(defaultBefore);
    expect(await rawRow(wsDoomedCollide, collideBot)).toBeNull();

    // Exactly one row survives for this actor — the re-home is not additive.
    const rows = (await db.select().from(schema.workspaceReviewers).execute()).filter(
      (r: any) => r.accountId === 1 && r.authorUserId === collideBot,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workspaceId).toBe(wsDefault);
  });

  it('the Default workspace is renameable but NOT deletable', async () => {
    expect(await q.deleteWorkspace(wsDefault, 1)).toBe('is_default');
    expect(await q.renameWorkspace(wsDefault, 1, 'Everything')).toBe(true);
    const list = await q.listWorkspaces(1);
    const def = list.find((w: any) => w.isDefault);
    expect(def.name).toBe('Everything');
    expect(def.id).toBe(wsDefault);
    // A foreign/unknown id is a 404, never a cross-tenant delete.
    expect(await q.deleteWorkspace(999_999, 1)).toBe('not_found');
  });
});
