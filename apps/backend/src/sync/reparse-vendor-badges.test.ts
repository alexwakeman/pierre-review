// The vendor-badge backfill, on a THROWAWAY sqlite DB with the severity-api's marker endpoint
// stubbed at the `fetch` boundary.
//
// THE ASSERTION THIS FILE EXISTS FOR is not "the badge arrived" — it is that NOTHING ELSE MOVED.
// The whole reason this command exists instead of `pnpm ml:enrich --reset` is that a reset
// re-scores the corpus against today's artifact and silently shifts every number on screen. So
// every case below snapshots the full label rows before and after and asserts they are
// byte-identical once the two vendor columns are removed — severity, severity_ord,
// severity_prob, categories, category_probs, is_summary, backend, model_version, body_hash,
// target_created_at, created_at AND updated_at. A regression that started writing one more
// column would look completely reasonable in a diff and fail here.
//
// Three more properties are pinned because each has a failure mode that is invisible in
// production:
//   • the vendor string is derived from the LOGIN, not `workspace_reviewers.kind` — the fixture
//     seeds deepsource-io with the stale `kind='in_house'` this repo's real dev DB carries, so a
//     refactor that read the stored kind would send no hint and recover nothing while looking
//     like the parser is broken;
//   • a null parse NEVER clears a stored badge — the endpoint answers null both for "the vendor
//     declared none" and for "I have no parser for this vendor", so clearing on null would let
//     a parser regression erase the column;
//   • a second run is a no-op — the sweep has no persisted "already re-parsed" marker (the only
//     place to put one is a column it may not write), so re-runnability IS the resumability
//     story.
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-reparse-badges-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
// The gate. Nothing is ever sent to this host — `fetch` is stubbed below — but it has to parse
// as http(s) or `isSeverityApiConfigured()` turns the whole sweep into a clean no-op.
process.env.SEVERITY_API_URL = 'http://127.0.0.1:8799';
process.env.ML_SEVERITY_DISABLED = 'false';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let config: any;
let closeDb: (() => void) | undefined;
let reparseVendorBadges: any;

const realFetch = globalThis.fetch;

interface SentRequest {
  url: string;
  comments: Array<{ id: number; body: string; vendor?: string }>;
}
/** Every request the module made, in order — reset by `installFetchStub`. */
let sent: SentRequest[] = [];
/** The requests the main fill case made, kept so the later cases can inspect them. */
let fillRequests: SentRequest[] = [];

const CURSOR_LEVELS: Record<string, string> = { High: 'major', Medium: 'minor', Low: 'nit' };
const CODEX_PRIORITIES: Record<string, string> = {
  '0': 'critical',
  '1': 'major',
  '2': 'minor',
  '3': 'nit',
};

/**
 * A stand-in for `packages/ml`'s `parse.markers` dispatch — the AGREED mapping, and only it.
 *
 * The real parser's own coverage lives in `packages/ml/tests/test_markers.py` (83 cases against
 * the live corpus). What this stub is for is the HOST side: that the right vendor string is
 * chosen per row, that the answer is keyed back by id, and that exactly two columns move.
 */
function parseMarker(
  vendor: string | null,
  body: string,
): { severity: string | null; confidence: string | null } {
  let severity: string | null = null;
  if (vendor === 'cursor') {
    // "**High Severity**" — the same High/Medium/Low vocabulary Copilot uses, mapped the same way.
    const m = /\*\*(High|Medium|Low) Severity\*\*/.exec(body);
    severity = m ? (CURSOR_LEVELS[m[1]!] ?? null) : null;
  } else if (vendor === 'codex') {
    // A shields.io P-badge: P0→critical, P1→major, P2→minor, P3→nit.
    const m = /!\[P(\d) Badge\]/.exec(body);
    severity = m ? (CODEX_PRIORITIES[m[1]!] ?? null) : null;
  } else if (vendor === 'deepsource') {
    // The severity rides the indicator SVG's filename, and maps BY NAME.
    const m = /severity_indicator_(minor|major|critical)\.svg/.exec(body);
    severity = m ? m[1]! : null;
  }
  return { severity, confidence: severity ? 'high' : null };
}

function installFetchStub(): void {
  sent = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const payload = JSON.parse(String(init?.body ?? '{}'));
    sent.push({ url: String(input), comments: payload.comments });
    const results = payload.comments.map((c: any) => {
      const answer = parseMarker(c.vendor ?? null, c.body);
      return {
        id: c.id,
        vendor_severity: answer.severity,
        vendor_severity_confidence: answer.confidence,
      };
    });
    return new Response(JSON.stringify({ results, count: results.length }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Every label row with the two columns this command owns REMOVED — the "nothing else" view. */
async function otherColumns(): Promise<any[]> {
  const rows = await db.select().from(schema.mlCommentLabels).execute();
  return rows
    .sort((a: any, b: any) => a.id - b.id)
    .map((r: any) => {
      const { vendorSeverity, vendorSeverityConfidence, ...rest } = r;
      return rest;
    });
}

async function labelByTarget(kind: string, targetId: number): Promise<any> {
  const rows = await db.select().from(schema.mlCommentLabels).execute();
  return rows.find((r: any) => r.targetKind === kind && r.targetId === targetId);
}

// ── The fixture: the three vendors' REAL body shapes, measured from this repo's dev DB ──────
const CURSOR_BODY = (level: string) =>
  `### Race condition in the retry loop\n\n**${level} Severity**\n\n` +
  '<!-- DESCRIPTION START -->The second attempt reuses the closed handle.<!-- DESCRIPTION END -->\n' +
  '<!-- BUGBOT_BUG_ID: 3f2a1c6e-1111-4c6a-9a11-000000000001 -->';
const CURSOR_SUMMARY = '<!-- BUGBOT_REVIEW -->\nReviewed 4 files. No blocking issues found.';
const CODEX_BODY = (p: string) =>
  `**<sub><sub>![${p} Badge](https://img.shields.io/badge/${p}-yellow?style=flat)</sub></sub>  ` +
  'Unbounded loop on malformed input**\n\nThe parser never advances on a zero-length token.';
const DEEPSOURCE_BODY = (level: string) =>
  '<!-- DeepSource: id=abc123 --><h3><picture><source media="(prefers-color-scheme: dark)" ' +
  `srcset="https://static.deepsource.com/comment_artifacts/dark/severity_indicator_${level}.svg?v=2"/>` +
  '</picture> Unused assignment</h3>\n\nThe value assigned here is never read.';
const IN_HOUSE_BODY = '**High Severity** — our own bot says this looks wrong.';

interface Target {
  kind: 'review_comment' | 'pr_comment' | 'review';
  id: number;
  vendorExpected: string | null;
  severityExpected: string | null;
}
const targets: Record<string, Target> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  config = (await import('../config.js')).config;
  reparseVendorBadges = (await import('./reparse-vendor-badges.js')).reparseVendorBadges;
  const queries = (await import('../db/queries.js')) as any;
  const { upsertMlLabels } = (await import('../db/ml-labels.js')) as any;
  await runMigrations();

  const at = new Date('2026-08-01T12:00:00Z');
  const {
    accounts,
    repos,
    pullRequests,
    users,
    reviewThreads,
    reviewComments,
    prComments,
    reviews,
    workspaceReviewers,
  } = schema;

  await db
    .insert(accounts)
    .values({ githubUserId: 'U_acct', githubLogin: 'owner', isLocal: true })
    .execute();
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_badge' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_badge',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'pr',
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_badge',
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      createdAt: at,
    })
    .returning()
    .execute();

  const mkUser = async (login: string) =>
    (
      await db
        .insert(users)
        .values({ githubNodeId: `U_${login}`, githubLogin: login, isBot: true })
        .returning()
        .execute()
    )[0].id as number;
  const cursorId = await mkUser('cursor');
  const codexId = await mkUser('chatgpt-codex-connector');
  const deepsourceId = await mkUser('deepsource-io');
  const inHouseId = await mkUser('acme-internal-linter');

  // ⚠ THE STALENESS TRAP, seeded on purpose. This is exactly what the real dev DB holds:
  // deepsource-io classified before its login joined REVIEW_BOTS, so its stored vendor identity
  // is `in_house` — which maps to NO hint. The sweep must ignore this row entirely and derive
  // 'deepsource' from the login.
  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  const workspaceId = (await queries.workspaceScopeForRepo(1, repo.id)).workspaceId;
  await db
    .insert(workspaceReviewers)
    .values({
      accountId: 1,
      workspaceId,
      authorUserId: deepsourceId,
      automated: true,
      confidence: 'high',
      source: 'github_type',
      kind: 'in_house',
    })
    .execute();

  // The three vendors are spread across the three TARGET KINDS so all three body lookups in
  // `bodiesFor` are exercised (they are three separate queries; a copy-paste slip in one is
  // otherwise silent). Which kind a vendor really posts under is irrelevant to this module.
  let node = 0;
  const mkReviewComment = async (authorId: number, body: string) =>
    (
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: `RC_${node++}`,
          threadId: thread.id,
          prId: pr.id,
          authorId,
          body,
          createdAt: at,
        })
        .returning()
        .execute()
    )[0].id as number;
  const mkPrComment = async (authorId: number, body: string) =>
    (
      await db
        .insert(prComments)
        .values({ githubNodeId: `PC_${node++}`, prId: pr.id, authorId, body, createdAt: at })
        .returning()
        .execute()
    )[0].id as number;
  const mkReview = async (authorId: number, body: string) =>
    (
      await db
        .insert(reviews)
        .values({
          githubNodeId: `RV_${node++}`,
          prId: pr.id,
          authorId,
          state: 'commented',
          body,
          submittedAt: at,
        })
        .returning()
        .execute()
    )[0].id as number;

  const add = async (
    key: string,
    kind: Target['kind'],
    authorId: number,
    body: string,
    vendorExpected: string | null,
    severityExpected: string | null,
    seededVendorSeverity: string | null = null,
  ) => {
    const id =
      kind === 'review_comment'
        ? await mkReviewComment(authorId, body)
        : kind === 'pr_comment'
          ? await mkPrComment(authorId, body)
          : await mkReview(authorId, body);
    targets[key] = { kind, id, vendorExpected, severityExpected };
    await upsertMlLabels([
      {
        accountId: 1,
        repoId: repo.id,
        prId: pr.id,
        targetKind: kind,
        targetId: id,
        authorUserId: authorId,
        // OUR severity is deliberately 'nit' on rows whose vendor badge says major/critical.
        // The disagreement IS the product, so a sweep that "helpfully" reconciled the two would
        // pass a weaker test; here it fails the byte-identical assertion.
        severity: 'nit',
        severityOrd: 0,
        severityProb: 0.42,
        categories: ['correctness_bug'],
        categoryProbs: { correctness_bug: 0.42 },
        vendorSeverity: seededVendorSeverity,
        vendorSeverityConfidence: seededVendorSeverity ? 'high' : null,
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'v2-2026-07',
        bodyHash: `hash-${key}`,
        targetCreatedAt: at,
      },
    ]);
  };

  await add('cursorHigh', 'review_comment', cursorId, CURSOR_BODY('High'), 'cursor', 'major');
  await add('cursorMedium', 'review_comment', cursorId, CURSOR_BODY('Medium'), 'cursor', 'minor');
  await add('cursorLow', 'review_comment', cursorId, CURSOR_BODY('Low'), 'cursor', 'nit');
  // A real Cursor comment that declares NOTHING (its roll-up). Must stay NULL forever.
  await add('cursorSummary', 'review_comment', cursorId, CURSOR_SUMMARY, 'cursor', null);
  await add('codexP0', 'pr_comment', codexId, CODEX_BODY('P0'), 'codex', 'critical');
  await add('codexP1', 'pr_comment', codexId, CODEX_BODY('P1'), 'codex', 'major');
  await add('codexP2', 'pr_comment', codexId, CODEX_BODY('P2'), 'codex', 'minor');
  await add('codexP3', 'pr_comment', codexId, CODEX_BODY('P3'), 'codex', 'nit');
  await add('dsMinor', 'review', deepsourceId, DEEPSOURCE_BODY('minor'), 'deepsource', 'minor');
  await add('dsMajor', 'review', deepsourceId, DEEPSOURCE_BODY('major'), 'deepsource', 'major');
  await add(
    'dsCritical',
    'review',
    deepsourceId,
    DEEPSOURCE_BODY('critical'),
    'deepsource',
    'critical',
  );
  // An in-house bot whose body LOOKS like a Cursor badge. It has no vendor identity, so it must
  // never be sent at all — reading a severity off it would attribute a claim to a vendor that
  // does not exist.
  await add('inHouse', 'review_comment', inHouseId, IN_HOUSE_BODY, null, null);
  // Already badged, and its body no longer carries a marker (a rolled-back parser, a vendor that
  // dropped its badge). Only reachable with `--all`; the badge must SURVIVE.
  await add(
    'dsAlreadyBadged',
    'review',
    deepsourceId,
    'Plain prose with no indicator svg at all.',
    'deepsource',
    null,
    'critical',
  );
});

afterAll(() => {
  globalThis.fetch = realFetch;
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('vendor-badge re-parse', () => {
  it('is a clean no-op when SEVERITY_API_URL is unset', async () => {
    const url = config.severityApiUrl;
    config.severityApiUrl = '';
    installFetchStub();
    try {
      const stats = await reparseVendorBadges();
      expect(stats.scanned).toBe(0);
      expect(stats.updated).toBe(0);
      // THE gate: not one request, not one row read.
      expect(sent).toHaveLength(0);
    } finally {
      config.severityApiUrl = url;
    }
  });

  it('reports what it would do under --dry-run and writes nothing', async () => {
    installFetchStub();
    const before = await otherColumns();
    const beforeBadges = await db.select().from(schema.mlCommentLabels).execute();
    const stats = await reparseVendorBadges({ dryRun: true });
    expect(stats.gained).toBe(10); // 11 badged bodies minus the one already badged (not selected)
    expect(stats.updated).toBe(10);
    const after = await db.select().from(schema.mlCommentLabels).execute();
    expect(after.sort((a: any, b: any) => a.id - b.id)).toEqual(
      beforeBadges.sort((a: any, b: any) => a.id - b.id),
    );
    expect(await otherColumns()).toEqual(before);
  });

  it('fills every badge per the agreed mapping', async () => {
    installFetchStub();
    const before = await otherColumns();
    const stats = await reparseVendorBadges();
    // Kept for the two cases below: after this run every badgeable row is badged, so a fresh
    // sweep would send almost nothing and there would be no requests left to inspect. Captured
    // BEFORE the first assertion, or a failure here cascades into two unrelated cases reporting
    // an empty request log (which is what happened when this file was mutation-tested).
    fillRequests = sent;

    expect(stats.gained).toBe(10);
    expect(stats.updated).toBe(10);
    expect(stats.changed).toBe(0);
    expect(stats.failures).toBe(0);
    // The Cursor roll-up declared nothing and stays that way. That is a RESULT, not a gap.
    expect(stats.noClaim).toBe(1);

    for (const [key, t] of Object.entries(targets)) {
      if (key === 'dsAlreadyBadged') continue; // not selected by the default sweep
      const label = await labelByTarget(t.kind, t.id);
      expect(label.vendorSeverity, key).toBe(t.severityExpected);
      expect(label.vendorSeverityConfidence, key).toBe(t.severityExpected ? 'high' : null);
    }

    // ⚠ THE SAFETY ASSERTION. Every other column, on every row, byte-identical.
    expect(await otherColumns()).toEqual(before);
  });

  it('derives the vendor from the LOGIN, never the stale stored kind', async () => {
    // deepsource-io's `workspace_reviewers` row says `kind='in_house'` (seeded above). Reading it
    // would send no hint and recover none of its badges.
    const byId = new Map<number, string | undefined>();
    for (const req of fillRequests) for (const c of req.comments) byId.set(c.id, c.vendor);
    const vendors = new Set([...byId.values()]);
    expect(vendors).toEqual(new Set(['cursor', 'codex', 'deepsource']));

    // ...and the in-house bot is not merely unhinted, it is never SENT. Its body carries a
    // Cursor-shaped badge, so sending it with no hint would still be wrong the day the parser
    // learns a vendor-less fallback.
    const inHouse = targets.inHouse!;
    const label = await labelByTarget(inHouse.kind, inHouse.id);
    expect(label.vendorSeverity).toBeNull();
    const bodies = fillRequests.flatMap((r) => r.comments.map((c) => c.body));
    expect(bodies).not.toContain(IN_HOUSE_BODY);
  });

  it('sends the FULL body to the marker endpoint', () => {
    // No tokenizer runs here, so the 6 000-char scoring cap must not be applied: a marker below
    // the cut would read as "the vendor declared none", which is the one answer this feature
    // cannot afford to fake. The fixture bodies are short, so what is pinned is that they arrive
    // whole and untrimmed.
    const sentBodies = new Set(fillRequests.flatMap((r) => r.comments.map((c) => c.body)));
    expect(sentBodies.has(CURSOR_BODY('High'))).toBe(true);
    expect(sentBodies.has(DEEPSOURCE_BODY('critical'))).toBe(true);
    expect(fillRequests[0]!.url).toContain('/markers/vendor-severity');
  });

  it('changes nothing on a second run', async () => {
    installFetchStub();
    const before = await db.select().from(schema.mlCommentLabels).execute();
    const stats = await reparseVendorBadges();
    expect(stats.updated).toBe(0);
    expect(stats.gained).toBe(0);
    // Only the row that legitimately declares nothing is still selectable (it is still NULL), so
    // the sweep is cheap on re-run rather than free. That is the documented trade: there is no
    // "already re-parsed" marker, because the only place to keep one is a column this command
    // may not write.
    expect(stats.scanned).toBe(1);
    const after = await db.select().from(schema.mlCommentLabels).execute();
    expect(after.sort((a: any, b: any) => a.id - b.id)).toEqual(
      before.sort((a: any, b: any) => a.id - b.id),
    );
  });

  it('never clears an existing badge when the re-parse finds none', async () => {
    installFetchStub();
    const before = await otherColumns();
    // --all reaches the already-badged row, whose body no longer carries a marker.
    const stats = await reparseVendorBadges({ includeBadged: true });
    const badged = targets.dsAlreadyBadged!;
    const label = await labelByTarget(badged.kind, badged.id);
    expect(label.vendorSeverity).toBe('critical');
    expect(label.vendorSeverityConfidence).toBe('high');
    // Every other row re-parses to exactly what it already holds, so nothing is written at all.
    expect(stats.updated).toBe(0);
    expect(stats.unchanged).toBe(10);
    expect(stats.noClaim).toBe(2); // the Cursor roll-up + the un-markered already-badged row
    expect(await otherColumns()).toEqual(before);
  });

  it('CHANGES a badge when --all re-parses it to a different one', async () => {
    installFetchStub();
    const before = await otherColumns();
    const t = targets.cursorHigh!;
    // Pretend the parser was fixed and now reads this body as a nit.
    await db
      .update(schema.mlCommentLabels)
      .set({ vendorSeverity: 'nit' })
      .where(
        and(
          eq(schema.mlCommentLabels.targetKind, t.kind),
          eq(schema.mlCommentLabels.targetId, t.id),
        ),
      )
      .execute();
    const stats = await reparseVendorBadges({ includeBadged: true });
    expect(stats.changed).toBe(1);
    expect(stats.gained).toBe(0);
    expect((await labelByTarget(t.kind, t.id)).vendorSeverity).toBe('major');
    // The snapshot was taken with the row already forced to 'nit', so the vendor columns are
    // stripped either way — everything else still has to match.
    expect(await otherColumns()).toEqual(before);
  });

  it('reports failures instead of throwing when the service is unreachable', async () => {
    const stub = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    try {
      const before = await otherColumns();
      const stats = await reparseVendorBadges({ includeBadged: true });
      expect(stats.failures).toBeGreaterThan(0);
      expect(stats.updated).toBe(0);
      // A sweep that threw here would leave the operator unable to tell "nothing to do" from
      // "the service is down", and a half-written corpus behind it.
      expect(await otherColumns()).toEqual(before);
    } finally {
      globalThis.fetch = stub;
    }
  });

  it('leaves a row untouched when the service answers without its id', async () => {
    installFetchStub();
    const t = targets.cursorSummary!;
    const before = await otherColumns();
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
      const payload = JSON.parse(String(init?.body ?? '{}'));
      // The contract break: results with no ids at all.
      const results = payload.comments.map(() => ({
        vendor_severity: 'critical',
        vendor_severity_confidence: 'high',
      }));
      return new Response(JSON.stringify({ results, count: results.length }), { status: 200 });
    }) as typeof fetch;
    try {
      const stats = await reparseVendorBadges();
      // Counted as skipped, NOT as "no claim": an unanswered row must not look like an ordinary
      // result, or a broken service reads as a corpus that simply carries no badges.
      expect(stats.skipped).toBeGreaterThan(0);
      expect(stats.updated).toBe(0);
      expect((await labelByTarget(t.kind, t.id)).vendorSeverity).toBeNull();
      expect(await otherColumns()).toEqual(before);
    } finally {
      globalThis.fetch = stub;
    }
  });
});
