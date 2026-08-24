// db/actor-lanes.ts — WHO did the work, on a THROWAWAY sqlite DB.
//
// THE TWO CONTRACTS THIS FILE EXISTS FOR, both of which shipped wrong on first attempt and were
// caught by probing the real database rather than by reading the code:
//
//  • ONE ACTOR, ONE LANE — even when it is TWO USER ROWS. Real accounts carry `dependabot` AND
//    `dependabot[bot]`, `github-actions` AND `github-actions[bot]`, with CONFLICTING automated
//    flags: on the measured account one of each pair sat at `automated: 0`, i.e. counted as a
//    human. A lane that trusts a single signal splits one actor across two lanes and under-counts
//    both. Resolution is the UNION of the workspace verdict, `users.isBot` and the login
//    vocabularies, with `[bot]`-suffix normalisation doing the joining.
//
//  • `kind: 'in_house'` IS NOT EVIDENCE OF AI REVIEW. The shared type calls it "the account's own
//    AI", but on the live database 25 of 37 such rows were assigned by `source: 'github_type'` —
//    the fallback for "this is a GitHub App and we don't know the brand" — and that bucket holds
//    sonarqubecloud, dependabot[bot], github-actions[bot], gitguardian, socket-security,
//    google-cla and jit-ci. Treating it as AI review put `github-actions[bot]` in `ai_review`
//    while its twin `github-actions` sat in `quality_gate`, inflating the one number a team would
//    use to judge whether their review tooling earns its licence by 384 automated approvals.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-actor-lanes-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let lanes: any;
let scope: any;
const id: Record<string, number> = {};

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_PATH}${suffix}`);
    } catch {
      /* first run */
    }
  }
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  const al = await import('./actor-lanes.js');
  lanes = al.resolveActorLanes;

  // Account 1 already exists — migration 0008 seeds it.
  const { repos, users, workspaces, workspaceRepos, workspaceReviewers } = schema;
  // A Default workspace already exists for account 1 (the partial unique index allows exactly
  // one), so add a second, non-default one rather than fighting it.
  const ws = (
    await db
      .insert(workspaces)
      .values({ accountId: 1, name: 'Lanes', isDefault: false })
      .returning()
      .execute()
  )[0].id;
  const repo = (
    await db
      .insert(repos)
      .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_al' })
      .returning()
      .execute()
  )[0].id;
  await db.insert(workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId: repo }).execute();
  scope = { workspaceId: ws, repoIds: [repo] };

  const mkUser = async (key: string, login: string, isBot: boolean) => {
    id[key] = (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_al_${key}`, isBot })
        .returning()
        .execute()
    )[0].id;
  };

  await mkUser('human', 'alice', false);
  // THE DUPLICATED IDENTITIES, reproduced exactly as the live database holds them.
  await mkUser('depBare', 'dependabot', true);
  await mkUser('depApp', 'dependabot[bot]', true);
  await mkUser('ghaBare', 'github-actions', true);
  await mkUser('ghaApp', 'github-actions[bot]', true);
  await mkUser('sonar', 'sonarqubecloud', true);
  await mkUser('rabbit', 'coderabbitai', true);
  // An automation nobody has branded — the `in_house` fallback bucket.
  await mkUser('unknownApp', 'some-ci-app', true);
  // A human a person explicitly vouched for, whose login LOOKS bot-ish.
  await mkUser('manualHuman', 'buildmaster', true);
  // ── The lanes added alongside the wider ReviewerRole ─────────────────────────────────────
  await mkUser('agent', 'devin-ai-integration[bot]', true);
  await mkUser('mergeQueue', 'mergify[bot]', true);
  await mkUser('cla', 'google-cla', true);
  // Vocabulary says code_agent; a HUMAN said it reviews. The human must win.
  await mkUser('reclassified', 'imgbot', true);
  // No vocabulary knows this login; a human roled it by hand. Nothing else can place it.
  await mkUser('manualAgent', 'acme-helper', true);

  // Stored verdicts, mirroring the live shapes:
  //  - the App half of each duplicate is `automated: 1`, the bare half is NOT classified at all
  //    (which is how one of them ended up reading as a human);
  //  - the unbranded App gets `kind: 'in_house'` from the githubType heuristic;
  //  - one row is a genuine manual "this is a person".
  const rv = (over: Record<string, unknown>) => ({
    accountId: 1,
    workspaceId: ws,
    automated: true,
    role: 'review',
    confidence: 'high',
    source: 'github_type',
    identitySource: 'auto',
    ...over,
  });
  await db
    .insert(workspaceReviewers)
    .values([
      rv({ authorUserId: id.depApp, kind: 'in_house' }),
      rv({ authorUserId: id.ghaApp, kind: 'in_house' }),
      rv({ authorUserId: id.sonar, kind: 'in_house', role: 'quality_check' }),
      rv({ authorUserId: id.rabbit, kind: 'coderabbit' }),
      rv({ authorUserId: id.unknownApp, kind: 'in_house' }),
      rv({ authorUserId: id.manualHuman, automated: false, source: 'manual', kind: null }),
      // ⚠ `role: 'review'` AND `source: 'github_type'` — a DERIVED default, not a judgement.
      // This is the shape every already-classified actor carries on an install that predates the
      // wider role union, and it is the reason migration 0053 exists. The login vocabulary must
      // beat it, or a code agent stays filed under AI review forever.
      rv({ authorUserId: id.agent, kind: 'in_house' }),
      rv({ authorUserId: id.mergeQueue, kind: 'in_house' }),
      rv({ authorUserId: id.cla, kind: 'in_house' }),
      // A human overruling the vocabulary, and a human placing a login the vocabulary cannot.
      rv({ authorUserId: id.reclassified, role: 'review', source: 'manual', kind: 'vendor' }),
      rv({ authorUserId: id.manualAgent, role: 'code_agent', source: 'manual', kind: null }),
    ])
    .execute();
});

afterAll(() => {
  closeDb?.();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB_PATH}${suffix}`);
    } catch {
      /* already gone */
    }
  }
});

describe('resolveActorLanes', () => {
  const resolve = () => lanes(1, scope);

  it('puts BOTH rows of a duplicated identity in the SAME lane', async () => {
    const r = await resolve();
    // Dependabot: the App row is classified, the bare row is not — and they must still agree.
    expect(r.laneOf(id.depApp)).toBe('dependency');
    expect(r.laneOf(id.depBare)).toBe('dependency');
    // github-actions: this is the pair that actually split, because the App row's `in_house`
    // classification was being read as evidence of AI review.
    expect(r.laneOf(id.ghaApp)).toBe('quality_gate');
    expect(r.laneOf(id.ghaBare)).toBe('quality_gate');
    expect(r.laneOf(id.ghaApp)).toBe(r.laneOf(id.ghaBare));
  });

  it('does not treat the unbranded `in_house` fallback as AI review', async () => {
    const r = await resolve();
    expect(r.laneOf(id.unknownApp)).toBe('quality_gate');
    expect(r.laneOf(id.unknownApp)).not.toBe('ai_review');
  });

  it('keeps the AI-review lane to actors that genuinely review', async () => {
    const r = await resolve();
    expect(r.laneOf(id.rabbit)).toBe('ai_review');
    // …and nothing leaked in that a person did not put there.
    //
    // `reclassified` (login `imgbot`, in CODE_AGENT_BOTS) is here ON PURPOSE: a human marked it a
    // review bot in this workspace, and a manual judgement is the one signal that outranks the
    // vocabularies. It is the ONLY member of this lane besides the genuine vendor, which is the
    // real assertion — an actor reaches `ai_review` by being a known reviewer or by someone
    // saying so, and never by falling through a default.
    const aiIds = [...r.lane.entries()]
      .filter(([, lane]: [number, string]) => lane === 'ai_review')
      .map(([userId]: [number, string]) => userId)
      .sort((a: number, b: number) => a - b);
    expect(aiIds).toEqual([id.rabbit!, id.reclassified!].sort((a, b) => a - b));
  });

  it('routes a quality gate by its stored role, not its brand', async () => {
    const r = await resolve();
    expect(r.laneOf(id.sonar)).toBe('quality_gate');
  });

  it('leaves a human a human, and an unclassified id defaults to human', async () => {
    const r = await resolve();
    expect(r.laneOf(id.human)).toBe('human');
    expect(r.laneOf(999_999)).toBe('human');
    expect(r.laneOf(null)).toBe('human');
  });

  // A person saying "this is a person" is the one judgement that beats every automated signal —
  // including a bot-ish login and the global isBot flag. That rule is load-bearing elsewhere in
  // the codebase and must not be weakened by the union above.
  it('honours an explicit manual human over every automation signal', async () => {
    const r = await resolve();
    expect(r.laneOf(id.manualHuman)).toBe('human');
    expect(r.automatedIds.has(id.manualHuman)).toBe(false);
  });


  // ── The lanes and precedence rules added with the wider ReviewerRole ────────────────────
  it('routes each new automation family to its own lane', async () => {
    const r = await resolve();
    expect(r.laneOf(id.agent)).toBe('code_agent');
    expect(r.laneOf(id.mergeQueue)).toBe('release');
    expect(r.laneOf(id.cla)).toBe('housekeeping');
  });

  // ⚠ THE RULE MIGRATION 0053 EXISTS TO SUPPORT, asserted from the other side.
  it('lets a known login beat a DERIVED `review` role', async () => {
    // `agent` carries `role: 'review'` with `source: 'github_type'` — the shape every actor
    // classified before the role union widened still has in the database. That stored byte means
    // "we had no other option", not "this reviews", so it must not out-rank a login we
    // positively recognise. If it did, Devin would sit in the AI-review lane on every existing
    // install no matter how many vocabularies were added to the code.
    const r = await resolve();
    expect(r.laneOf(id.agent)).not.toBe('ai_review');
    expect(r.laneOf(id.agent)).toBe('code_agent');
  });

  // ...and the exact opposite when a PERSON typed it.
  it('lets a MANUAL role beat the login vocabulary, in both directions', async () => {
    const r = await resolve();
    // `imgbot` is in CODE_AGENT_BOTS, but a human marked it a review bot in this workspace.
    // Same stored column as the case above, opposite provenance, opposite answer — which is
    // exactly why `manualRoleUserIds` reads `source` rather than the resolver trusting `role`.
    expect(r.laneOf(id.reclassified)).toBe('ai_review');
    // `acme-helper` is in no vocabulary at all; without the manual role it would fall through to
    // the quality-gate default. The user's choice is the only thing that can place it.
    expect(r.laneOf(id.manualAgent)).toBe('code_agent');
    expect(r.laneOf(id.manualAgent)).not.toBe('quality_gate');
  });

  it('mirrors the shared REVIEWER_ROLE_LANE map exactly', async () => {
    // The backend cannot value-import shared at runtime, so the role -> lane map is spelled in
    // both packages. A test can import shared for real, which is what keeps them identical: a
    // drift here would file a user's chosen role under a different lane than the picker promised.
    const { REVIEWER_ROLE_LANE, REVIEWER_ROLES, ACTOR_LANES } = await import(
      '@pierre-review/shared'
    );
    const al = await import('./actor-lanes.js');
    // Every role maps to a real lane, and no role maps to `human` — a human is not a reviewer.
    for (const role of REVIEWER_ROLES) {
      expect(ACTOR_LANES).toContain(REVIEWER_ROLE_LANE[role]);
      expect(REVIEWER_ROLE_LANE[role]).not.toBe('human');
    }
    // And every lane except `human` is reachable from some role, so no lane is undrawable.
    const reachable = new Set(
      REVIEWER_ROLES.map((role) => REVIEWER_ROLE_LANE[role] as string),
    );
    for (const lane of ACTOR_LANES) {
      if (lane === 'human') continue;
      expect(reachable.has(lane), `lane '${lane}' has no role that produces it`).toBe(true);
    }
    expect(typeof al.resolveActorLanes).toBe('function');
  });

  it('reports every automated id it classified, and no humans', async () => {
    const r = await resolve();
    for (const key of ['depBare', 'depApp', 'ghaBare', 'ghaApp', 'sonar', 'rabbit', 'unknownApp']) {
      expect(r.automatedIds.has(id[key]!)).toBe(true);
    }
    expect(r.automatedIds.has(id.human!)).toBe(false);
  });
});
