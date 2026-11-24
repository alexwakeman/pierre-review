// THE TEAM POLICY (docs/TEAM-POLICY.md): the shared parser, the snapshot's observation, the store and
// the licence gate. Throwaway sqlite, no GitHub.
//
// What this pins:
//   1. The parser is STRICT: an unknown key, a wrong type or a missing version makes the whole file
//      invalid, with every problem in words. A policy can only restrict.
//   2. The snapshot's observation: a partial response or no repository changes nothing; a null blob is
//      "no file"; a directory or binary blob is a problem, not a crash.
//   3. The store: undefined leaves the row, null deletes it (only GitHub's positive "no file"), text is
//      parsed and kept with its problems.
//   4. The gate: a policy is APPLIED only with a valid key or a running evaluation. A fake context
//      reads no policy.
//   5. Dependency automation: off, or only the trusted bots the policy names.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  describeTeamPolicy,
  orgFeaturesUnlocked,
  parseTeamPolicy,
  policyAllowsAiApproval,
  policyAllowsAutomation,
  policyTrustedBots,
  resolvePolicyClash,
  strictestTeamPolicy,
  type TeamPolicy,
} from '@pierre-review/shared';
import { teamPolicyObservation } from '../sync/branch-status.js';
import { verdictGate } from '../review/claude-review/auto-post.js';

const DB_PATH = vi.hoisted(() => {
  const path = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-team-policy.sqlite`;
  process.env.DATABASE_URL = path;
  process.env.DISABLE_SCHEDULER = 'true';
  return path;
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-24T12:00:00Z');

describe('parseTeamPolicy', () => {
  it('reads a full policy', () => {
    const r = parseTeamPolicy(
      JSON.stringify({
        $schema: 'https://ensemble.ac/policy.schema.json',
        version: 1,
        automation: { auto_review: false, auto_post: true, auto_push: false },
        ai: { approve: false },
        dependencies: { trusted_bots: ['Dependabot[bot]', 'dependabot[bot]'] },
        note: 'Agreed at the platform guild.',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.policy.automation).toEqual({ auto_review: false, auto_post: true, auto_push: false });
    expect(r.policy.ai.approve).toBe(false);
    expect(r.policy.dependencies.trustedBots).toEqual(['dependabot[bot]']);
    expect(describeTeamPolicy(r.policy)).toEqual([
      'Auto review is off.',
      'Nothing is pushed automatically.',
      'An AI review never approves; an approval is posted as a comment.',
      'Dependency automation trusts only dependabot[bot].',
    ]);
  });

  it('is strict: a typo invalidates the whole file and says where', () => {
    const r = parseTeamPolicy(JSON.stringify({ version: 1, automation: { auto_reviews: false, auto_post: 'no' }, extra: 1 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(' ')).toMatch(/unknown key "extra"/);
    expect(r.errors.join(' ')).toMatch(/"automation": unknown key "auto_reviews"/);
    expect(r.errors.join(' ')).toMatch(/"automation.auto_post" must be true or false/);
  });

  it('refuses rules that are not in version 1 yet (providers, spend caps)', () => {
    const r = parseTeamPolicy(JSON.stringify({ version: 1, ai: { providers: ['claude'], max_run_usd: 3 } }));
    expect(r.ok).toBe(false);
  });

  it('refuses bad JSON, a non-object, a wrong version and bad logins', () => {
    expect(parseTeamPolicy('{').ok).toBe(false);
    expect(parseTeamPolicy('[]').ok).toBe(false);
    expect(parseTeamPolicy('{"version": 2}').ok).toBe(false);
    expect(parseTeamPolicy('{}').ok).toBe(false);
    expect(parseTeamPolicy(JSON.stringify({ version: 1, dependencies: { trusted_bots: ['not a login!'] } })).ok).toBe(false);
  });

  it('can only restrict: missing rules and `true` leave everything allowed', () => {
    const r = parseTeamPolicy('{"version": 1, "automation": {"auto_fix": true}}');
    expect(r.ok).toBe(true);
    const p = r.ok ? r.policy : null;
    for (const a of ['auto_review', 'auto_post', 'auto_fix', 'auto_push', 'auto_resolve', 'dependencies'] as const) {
      expect(policyAllowsAutomation(p, a)).toBe(true);
      expect(policyAllowsAutomation(null, a)).toBe(true);
    }
    expect(policyAllowsAiApproval(p)).toBe(true);
    expect(policyTrustedBots(p, ['dependabot[bot]'])).toEqual(['dependabot[bot]']);
    expect(describeTeamPolicy(p!)).toEqual([]);
  });

  it('trusted bots narrow the reader’s list, never widen it', () => {
    const p = parseTeamPolicy(JSON.stringify({ version: 1, dependencies: { trusted_bots: ['renovate[bot]', 'snyk-bot'] } }));
    const policy = p.ok ? p.policy : null;
    expect(policyTrustedBots(policy, ['dependabot[bot]', 'renovate[bot]'])).toEqual(['renovate[bot]']);
  });
});

describe('when repositories’ policies differ (resolvePolicyClash)', () => {
  const p = (json: object): TeamPolicy => {
    const r = parseTeamPolicy(JSON.stringify({ version: 1, ...json }));
    if (!r.ok) throw new Error(r.errors.join(' '));
    return r.policy;
  };
  const noPush = p({ automation: { auto_push: false }, note: 'a' });
  const noPushOtherNote = p({ automation: { auto_push: false }, note: 'b' });
  const noApprove = p({ ai: { approve: false }, dependencies: { trusted_bots: ['dependabot[bot]', 'renovate[bot]'] } });
  const renovateOnly = p({ dependencies: { trusted_bots: ['renovate[bot]'] } });

  it('agreeing policies (the note aside) are not a clash', () => {
    expect(resolvePolicyClash([noPush, noPushOtherNote], noApprove)).toEqual({ policy: noPush, source: 'agreed' });
    expect(resolvePolicyClash([null, null], noApprove)).toEqual({ policy: null, source: 'agreed' });
  });

  it('a clash with no workspace choice takes the strictest rule from each', () => {
    const r = resolvePolicyClash([noPush, noApprove, renovateOnly, null], null);
    expect(r.source).toBe('strictest');
    expect(r.policy?.automation.auto_push).toBe(false);
    expect(r.policy?.ai.approve).toBe(false);
    expect(r.policy?.dependencies.trustedBots).toEqual(['renovate[bot]']);
  });

  it('a clash with a workspace choice applies the chosen policy, overriding the others', () => {
    expect(resolvePolicyClash([noPush, null], renovateOnly)).toEqual({ policy: renovateOnly, source: 'chosen' });
    expect(policyAllowsAutomation(resolvePolicyClash([noPush, null], renovateOnly).policy, 'auto_push')).toBe(true);
  });

  it('strictest of nothing restricts nothing', () => {
    expect(describeTeamPolicy(strictestTeamPolicy([]))).toEqual([]);
  });
});

describe('orgFeaturesUnlocked', () => {
  const status = (licence: unknown, evaluationEndsAt: string | null) =>
    ({ licence, reminder: { evaluationEndsAt } }) as Parameters<typeof orgFeaturesUnlocked>[0];
  it('a valid key, or a running evaluation; nothing else', () => {
    expect(orgFeaturesUnlocked(status({ ok: true, org: 'A', seats: 5, expires: '2027-01-01', source: 'manual' }, null), NOW)).toBe(true);
    expect(orgFeaturesUnlocked(status(null, new Date(NOW + DAY).toISOString()), NOW)).toBe(true);
    expect(orgFeaturesUnlocked(status(null, new Date(NOW - DAY).toISOString()), NOW)).toBe(false);
    expect(orgFeaturesUnlocked(status({ ok: false, problem: 'expired' }, null), NOW)).toBe(false);
    expect(orgFeaturesUnlocked(status(null, null), NOW)).toBe(false);
  });
});

describe('teamPolicyObservation (the default-branch snapshot)', () => {
  const resp = (teamPolicy: unknown) => ({ repository: { teamPolicy } }) as never;
  it('a partial response or no repository changes nothing', () => {
    expect(teamPolicyObservation(resp(null), true, 'abc')).toBeUndefined();
    expect(teamPolicyObservation({ repository: null } as never, false, 'abc')).toBeUndefined();
    expect(teamPolicyObservation({ repository: {} } as never, false, 'abc')).toBeUndefined();
  });
  it('a null blob on a clean response is "no file"', () => {
    expect(teamPolicyObservation(resp(null), false, 'abc')).toEqual({ text: null, commitOid: 'abc' });
  });
  it('a file is passed as text; a directory or binary blob is a problem', () => {
    expect(teamPolicyObservation(resp({ __typename: 'Blob', text: '{}', isBinary: false, isTruncated: false }), false, 'abc')).toEqual({
      text: '{}',
      commitOid: 'abc',
    });
    expect(teamPolicyObservation(resp({ __typename: 'Tree' }), false, 'abc')?.unreadable).toMatch(/not a file/);
    expect(teamPolicyObservation(resp({ __typename: 'Blob', text: null, isBinary: true }), false, 'abc')?.unreadable).toMatch(/text/);
  });
});

describe('verdictGate under a policy', () => {
  it('holds an APPROVE as a COMMENT, with its own reason; a request for changes still goes', () => {
    expect(verdictGate('APPROVE', { authorIsMe: false, ownLatest: 'none', policyNoApprove: true })).toEqual({
      wanted: 'APPROVE',
      submitted: 'COMMENT',
      heldReason: 'team_policy',
    });
    expect(verdictGate('REQUEST_CHANGES', { authorIsMe: false, ownLatest: 'none', policyNoApprove: true }).submitted).toBe('REQUEST_CHANGES');
    expect(verdictGate('APPROVE', { authorIsMe: false, ownLatest: 'none' }).submitted).toBe('APPROVE');
  });
});

describe('the store and the gate (sqlite)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any;
  let schema: any;
  let closeDb: (() => Promise<void>) | undefined;
  let store: typeof import('./team-policy.js');
  let repoId = 0;
  let botPr = 0;
  let personPr = 0;

  beforeAll(async () => {
    const { runMigrations } = await import('./run-migrations.js');
    const client = await import('./client.js');
    db = client.db;
    schema = client.schema;
    closeDb = client.closeDb;
    await runMigrations();
    await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
    await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_b', githubLogin: 'b', isLocal: false }).onConflictDoNothing().execute();
    const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_web' }).returning().execute();
    repoId = r.id;
    const [dep] = await db.insert(schema.users).values({ githubLogin: 'dependabot[bot]', isBot: true }).returning().execute();
    const [ren] = await db.insert(schema.users).values({ githubLogin: 'renovate[bot]', isBot: true }).returning().execute();
    const mk = async (n: number, authorId: number) =>
      (
        await db
          .insert(schema.pullRequests)
          .values({
            accountId: 1,
            repoId,
            githubNodeId: `PR_${n}`,
            number: n,
            title: `PR ${n}`,
            state: 'open',
            authorId,
            openedAt: new Date(NOW - DAY),
            updatedAt: new Date(NOW - DAY),
          })
          .returning()
          .execute()
      )[0].id as number;
    botPr = await mk(1, dep.id);
    personPr = await mk(2, ren.id);
    store = await import('./team-policy.js');
  });

  afterAll(async () => {
    await closeDb?.();
    for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  });

  const evaluating = async (on: boolean) =>
    db
      .update(schema.accounts)
      .set({ licenceEvaluationEndsAt: on ? new Date(Date.now() + DAY) : null })
      .where((await import('drizzle-orm')).eq(schema.accounts.id, 1))
      .execute();

  it('undefined changes nothing; text is parsed and kept; null (GitHub: no file) deletes', async () => {
    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "automation": {"auto_review": false}}', commitOid: 'c1' });
    await store.recordRepoTeamPolicy(1, repoId, undefined);
    let s = (await store.storedRepoTeamPolicies(1, [repoId])).get(repoId);
    expect(s?.policy).toMatchObject({ automation: { auto_review: false } });
    expect(s?.commitOid).toBe('c1');

    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "nope": true}', commitOid: 'c2' });
    s = (await store.storedRepoTeamPolicies(1, [repoId])).get(repoId);
    expect(s?.policy).toBeNull();
    expect(s?.errors.join(' ')).toMatch(/unknown key "nope"/);

    await store.recordRepoTeamPolicy(1, repoId, { text: '', commitOid: 'c3', unreadable: 'The file could not be read as text.' });
    expect((await store.storedRepoTeamPolicies(1, [repoId])).get(repoId)?.errors).toEqual(['The file could not be read as text.']);

    await store.recordRepoTeamPolicy(1, repoId, { text: null, commitOid: 'c4' });
    expect((await store.storedRepoTeamPolicies(1, [repoId])).has(repoId)).toBe(false);
  });

  it('is applied only with a valid key or a running evaluation', async () => {
    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "automation": {"auto_review": false}}', commitOid: 'c5' });
    await evaluating(false);
    expect(await store.effectiveRepoTeamPolicy(1, repoId)).toBeNull();
    expect(await store.policyAllowsAutoReview(undefined, 1, botPr)).toBe(true);
    // A stored key this copy cannot verify (no public key) does not unlock it.
    await db.update(schema.accounts).set({ licenceKey: 'ENS1.e30.AAAA' }).execute();
    expect(await store.effectiveRepoTeamPolicy(1, repoId)).toBeNull();
    await db.update(schema.accounts).set({ licenceKey: null }).execute();

    await evaluating(true);
    expect(await store.effectiveRepoTeamPolicy(1, repoId)).toMatchObject({ automation: { auto_review: false } });
    expect(await store.policyAllowsAutoReview(undefined, 1, botPr)).toBe(false);
  });

  it('reads nothing for another account or through a fake context', async () => {
    await evaluating(true);
    expect(await store.effectiveRepoTeamPolicy(2, repoId)).toBeNull();
    expect(await store.effectivePrTeamPolicy(2, botPr)).toBeNull();
    expect(await store.effectivePrTeamPolicy(1, botPr, {})).toBeNull();
    expect(await store.effectivePrTeamPolicy(1, botPr, { db, schema })).toMatchObject({ automation: { auto_review: false } });
  });

  it('dependency automation: off, or only the bots the policy trusts', async () => {
    await evaluating(true);
    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1}', commitOid: 'c6' });
    expect(await store.dependencyActionAllowedByPolicy(1, botPr)).toBe(true);

    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "dependencies": {"trusted_bots": ["dependabot[bot]"]}}', commitOid: 'c7' });
    expect(await store.dependencyActionAllowedByPolicy(1, botPr)).toBe(true);
    expect(await store.dependencyActionAllowedByPolicy(1, personPr)).toBe(false);

    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "automation": {"dependencies": false}}', commitOid: 'c8' });
    expect(await store.dependencyActionAllowedByPolicy(1, botPr)).toBe(false);

    // Without a key or evaluation the policy is not applied.
    await evaluating(false);
    expect(await store.dependencyActionAllowedByPolicy(1, botPr)).toBe(true);
  });

  it('the workspace’s choice: only a member repo; it decides a clash; cleared, the strictest rule applies', async () => {
    await evaluating(true);
    const { eq } = await import('drizzle-orm');
    const [ws] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Team A' }).returning().execute();
    const [api] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
    const [other] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'other', githubNodeId: 'R_other' }).returning().execute();
    for (const id of [repoId, api.id]) {
      await db.delete(schema.workspaceRepos).where(eq(schema.workspaceRepos.repoId, id)).execute();
      await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws.id, repoId: id }).execute();
    }
    await store.recordRepoTeamPolicy(1, repoId, { text: '{"version": 1, "automation": {"auto_push": false}}', commitOid: 'w1' });
    await store.recordRepoTeamPolicy(1, api.id, { text: '{"version": 1}', commitOid: 'a1' });

    // No choice: they differ, so the strictest rule applies (auto push off).
    let r = await store.effectiveMultiRepoTeamPolicy(1, ws.id, [repoId, api.id]);
    expect(r.source).toBe('strictest');
    expect(policyAllowsAutomation(r.policy, 'auto_push')).toBe(false);

    // A repo outside the workspace, or another account's workspace, is refused.
    expect(await store.setWorkspaceClashChoice(1, ws.id, other.id)).toBe(false);
    expect(await store.setWorkspaceClashChoice(2, ws.id, api.id)).toBe(false);

    // The workspace chooses acme/api's policy: it overrides acme/web's.
    expect(await store.setWorkspaceClashChoice(1, ws.id, api.id)).toBe(true);
    expect(await store.workspaceClashChoice(1, ws.id)).toBe(api.id);
    r = await store.effectiveMultiRepoTeamPolicy(1, ws.id, [repoId, api.id]);
    expect(r).toMatchObject({ source: 'chosen', chosenRepoId: api.id });
    expect(policyAllowsAutomation(r.policy, 'auto_push')).toBe(true);
    // Single-repo work is not a clash: acme/web's own rule still applies to its PRs.
    expect(policyAllowsAutomation(await store.effectiveRepoTeamPolicy(1, repoId), 'auto_push')).toBe(false);

    // The chosen repo's file turns invalid: the strictest rule applies until it is fixed.
    await store.recordRepoTeamPolicy(1, api.id, { text: '{"version": 1, "typo": 1}', commitOid: 'a2' });
    r = await store.effectiveMultiRepoTeamPolicy(1, ws.id, [repoId, api.id]);
    expect(r.source).toBe('strictest');

    // Cleared.
    expect(await store.setWorkspaceClashChoice(1, ws.id, null)).toBe(true);
    expect(await store.workspaceClashChoice(1, ws.id)).toBeNull();

    // Without a key or evaluation, nothing applies.
    await evaluating(false);
    expect((await store.effectiveMultiRepoTeamPolicy(1, ws.id, [repoId, api.id])).policy).toBeNull();
  });

  it('a policy object never carries more than the parser made', () => {
    const p: TeamPolicy = { version: 1, automation: {}, ai: {}, dependencies: {} };
    expect(describeTeamPolicy(p)).toEqual([]);
  });
});
