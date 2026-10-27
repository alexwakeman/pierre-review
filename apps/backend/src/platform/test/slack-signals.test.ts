// ── THE TWO SLACK EVENT SIGNALS (plugin migration 0040) ─────────────────────────────────────
//
// "Claude Review ran" and "Pull request merged": per-workspace switches on the delivery row, OFF by
// default, claimed once and never retried. The review signal posts for AUTO reviews only.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-signals.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ProContext } from '../contract.js';
import * as settingsSchema from '../settings/schema.sqlite.js';
import * as slackSchema from '../slack/schema.sqlite.js';

const posted: { url: string; text: string; body: string }[] = [];
let failNextPost = false;
vi.mock('../slack/send.js', () => ({
  postToSlack: async (url: string, message: { text: string; blocks: unknown[] }) => {
    if (failNextPost) {
      failNextPost = false;
      throw new Error('Slack webhook responded 500');
    }
    posted.push({ url, text: message.text, body: JSON.stringify(message.blocks) });
  },
}));

const { onClaudeReviewCompleted, onPullRequestMerged } = await import('../slack/signals.js');
const { writeTarget } = await import('../slack/targets.js');

const migrationSql = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');

// Stubs of the CORE tables the signals read through `ctx.schema` — only the columns they read.
const core = {
  workspaces: sqliteTable('workspaces', {
    id: integer('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    name: text('name').notNull(),
  }),
  workspaceRepos: sqliteTable('workspace_repos', {
    id: integer('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    workspaceId: integer('workspace_id').notNull(),
    repoId: integer('repo_id').notNull(),
  }),
  repos: sqliteTable('repos', {
    id: integer('id').primaryKey(),
    owner: text('owner').notNull(),
    name: text('name').notNull(),
  }),
  users: sqliteTable('users', {
    id: integer('id').primaryKey(),
    githubLogin: text('github_login').notNull(),
  }),
  pullRequests: sqliteTable('pull_requests', {
    id: integer('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    repoId: integer('repo_id').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    authorId: integer('author_id'),
    mergedById: integer('merged_by_id'),
  }),
  claudeReviews: sqliteTable('claude_reviews', {
    id: integer('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    prId: integer('pr_id').notNull(),
    status: text('status').notNull(),
    verdict: text('verdict'),
    summary: text('summary'),
    reviewMode: text('review_mode'),
    model: text('model'),
    trigger: text('trigger'),
  }),
};

const WEBHOOK = 'https://hooks.slack.com/services/T1/B1/aaaaaaaaaaaa';
const BASE = 'https://limn.example';

describe('Slack event signals', () => {
  let sqlite: Database.Database;
  let ctx: ProContext;

  beforeEach(() => {
    posted.length = 0;
    failNextPost = false;
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text NOT NULL, is_default integer NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);
      CREATE TABLE workspace_repos (id integer PRIMARY KEY, account_id integer, workspace_id integer, repo_id integer);
      CREATE TABLE repos (id integer PRIMARY KEY, owner text, name text);
      CREATE TABLE users (id integer PRIMARY KEY, github_login text);
      CREATE TABLE pull_requests (id integer PRIMARY KEY, account_id integer, repo_id integer, number integer, title text, author_id integer, merged_by_id integer);
      CREATE TABLE claude_reviews (id integer PRIMARY KEY, account_id integer, pr_id integer, status text, verdict text, summary text, review_mode text, model text, trigger text NOT NULL DEFAULT 'manual');
      CREATE TABLE pro_settings (id integer PRIMARY KEY, account_id integer, slack_webhook_url text, slack_cadence text, slack_hour1 integer, slack_hour2 integer, slack_timezone text, slack_last_sent_at integer, slack_last_sent_slot text, bot_slack_digest integer);
      INSERT INTO workspaces VALUES (1, 1, 'Default', 1), (9, 2, 'Other', 1);
      INSERT INTO workspace_repos VALUES (1, 1, 1, 10), (2, 2, 9, 20);
      INSERT INTO repos VALUES (10, 'acme', 'api'), (20, 'other', 'x');
      INSERT INTO users VALUES (1, 'alice'), (2, 'bob');
      INSERT INTO pull_requests VALUES (100, 1, 10, 12, 'Fix <!channel> login', 1, 2), (200, 2, 20, 3, 'Theirs', 1, 2);
      INSERT INTO claude_reviews VALUES
        (5, 1, 100, 'succeeded', 'REQUEST_CHANGES', 'Two bugs in the token refresh.', 'worktree', 'claude-opus-5-5', 'auto'),
        (6, 1, 100, 'succeeded', 'COMMENT', 'Nothing to review.', 'skip', 'claude-opus-5-5', 'auto'),
        (7, 1, 100, 'failed', NULL, NULL, 'worktree', 'claude-opus-5-5', 'auto'),
        (8, 1, 100, 'succeeded', 'COMMENT', 'One nit.', 'worktree', 'gpt-6-astra', 'auto'),
        (9, 1, 100, 'succeeded', 'APPROVE', 'Looks fine.', 'worktree', 'claude-opus-5-5', 'manual');
    `);
    sqlite.exec(migrationSql('0030_workspace_slack_targets.sql'));
    sqlite.exec(migrationSql('0033_slack_target_bot_digest.sql'));
    sqlite.exec(migrationSql('0040_slack_event_signals.sql'));
    ctx = {
      db: drizzle(sqlite, { schema: { ...settingsSchema, ...slackSchema } }),
      log: { warn: () => {}, error: () => {}, info: () => {} },
      host: { version: '0', appWebUrl: BASE },
      schema: core,
    } as unknown as ProContext;
  });

  it('both signals are OFF by default — a configured webhook alone sends nothing', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 5, trigger: 'auto' });
    await onPullRequestMerged(ctx, { accountId: 1, repoId: 10, prId: 100 });
    expect(posted).toHaveLength(0);
  });

  it('review: verdict + summary, escaped, no findings; once per run', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyReviews: true });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 5, trigger: 'auto' });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 5, trigger: 'auto' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain('Request changes');
    expect(posted[0]!.body).toContain('Two bugs in the token refresh.');
    expect(posted[0]!.body).toContain('by @alice');
    expect(posted[0]!.body).not.toContain('<!channel>');
    expect(posted[0]!.body).toContain(`${BASE}/app/?workspace=1`);
    expect(posted[0]!.text).toBe('Claude Review ran on acme/api#12');
  });

  it('review: a run Codex made names Codex', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyReviews: true });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 8, trigger: 'auto' });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toBe('Codex Review ran on acme/api#12');
    expect(posted[0]!.body).toContain('Codex Review ran');
    expect(posted[0]!.body).not.toContain('Claude');
  });

  it('review: a skip-routed or failed run sends nothing', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyReviews: true });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 6, trigger: 'auto' });
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 7, trigger: 'auto' });
    expect(posted).toHaveLength(0);
  });

  it('⚠ AUTO REVIEWS ONLY: a run a person started posts nothing and leaves no notice row', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyReviews: true });
    const notices = () =>
      (sqlite.prepare("SELECT COUNT(*) AS n FROM slack_signal_notices WHERE kind = 'review'").get() as { n: number }).n;
    // A manual run, announced as manual.
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 9, trigger: 'manual' });
    // The stored row decides too: a manual row announced as auto still sends nothing…
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 9, trigger: 'auto' });
    // …and an auto row announced as manual sends nothing either.
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 5, trigger: 'manual' });
    expect(posted).toHaveLength(0);
    expect(notices()).toBe(0);
    // The auto run, announced as auto: exactly one post, one claim.
    await onClaudeReviewCompleted(ctx, { accountId: 1, prId: 100, reviewId: 5, trigger: 'auto' });
    expect(posted).toHaveLength(1);
    expect(notices()).toBe(1);
  });

  it('merge: names who merged it; once per PR forever, even after a failed post', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyMerges: true });
    failNextPost = true;
    await onPullRequestMerged(ctx, { accountId: 1, repoId: 10, prId: 100 });
    await onPullRequestMerged(ctx, { accountId: 1, repoId: 10, prId: 100 });
    expect(posted).toHaveLength(0); // claimed before the failed call; never retried
    sqlite.exec('DELETE FROM slack_signal_notices');
    await onPullRequestMerged(ctx, { accountId: 1, repoId: 10, prId: 100 });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toBe('@bob merged acme/api#12');
  });

  it('another tenant’s PR id resolves to nothing', async () => {
    await writeTarget(ctx, 1, 1, { webhookUrl: WEBHOOK, notifyMerges: true });
    await onPullRequestMerged(ctx, { accountId: 1, repoId: 10, prId: 200 });
    expect(posted).toHaveLength(0);
  });
});

describe('Slack routes', () => {
  it('the PUT keeps the two switches', async () => {
    const Fastify = (await import('fastify')).default;
    const { registerSlackRoutes } = await import('../slack/routes.js');
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text NOT NULL, is_default integer NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);
      CREATE TABLE pro_settings (id integer PRIMARY KEY, account_id integer, slack_webhook_url text, slack_cadence text, slack_hour1 integer, slack_hour2 integer, slack_timezone text, slack_last_sent_at integer, slack_last_sent_slot text, bot_slack_digest integer);
      INSERT INTO workspaces VALUES (1, 1, 'Default', 1);
    `);
    sqlite.exec(migrationSql('0030_workspace_slack_targets.sql'));
    sqlite.exec(migrationSql('0033_slack_target_bot_digest.sql'));
    sqlite.exec(migrationSql('0040_slack_event_signals.sql'));
    const ws = sqliteTable('workspaces', {
      id: integer('id').primaryKey(),
      accountId: integer('account_id').notNull(),
      name: text('name'),
      isDefault: integer('is_default').notNull(),
    });
    const ctx = {
      db: drizzle(sqlite, { schema: { ...settingsSchema } }),
      log: { warn: () => {}, error: () => {}, info: () => {} },
      host: { version: '0', },
      schema: { workspaces: ws },
      accountIdOf: () => 1,
      queries: { defaultWorkspaceId: async () => 1 },
    } as unknown as ProContext;
    {
      const app = Fastify({ ajv: { customOptions: { removeAdditional: 'all' } } });
      registerSlackRoutes(app, ctx, {} as never);
      await app.ready();
      const put = await app.inject({
        method: 'PUT',
        url: '/api/pro/slack/target?workspace=1',
        payload: { webhookUrl: WEBHOOK, notifyMerges: true, notifyReviews: true },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().target).toMatchObject({ notifyMerges: true, notifyReviews: true });
      await app.close();
    }
  });
});
