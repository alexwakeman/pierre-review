// ── THE PER-WORKSPACE SLACK DIGEST (plugin migration 0030) ──────────────────────────────────
//
// The digest used to be ONE message per account, covering the DEFAULT workspace only. It is now
// one message per SELECTED WORKSPACE, capped, and that change reversed a documented cost
// reduction. This suite pins the four things the change could break silently.
//
//   1. PER-WORKSPACE DEDUPE. `slack_last_sent_slot` was ONE column per account. Under a
//      per-workspace sweep a single marker means a restart part-way through RE-SENDS the
//      workspaces that already went out and, once the marker advances, SKIPS the ones still owed a
//      digest. Both halves are asserted, including a mid-sweep crash.
//   2. THE UPGRADE PATH. Migration 0030 copies each account's configured webhook into a row for
//      its DEFAULT workspace — INCLUDING the dedupe marker. Without that carry-across, the first
//      sweep after an upgrade posts today's already-delivered digest a second time.
//   3. THE CAP, WHICH SURVIVED THE PICKER. The multi-select is gone — a target is configured one
//      workspace at a time — so the cron's population is now "every workspace that HAS a row"
//      rather than a submitted list. The cap did not become decorative: it is the bound on how
//      many workspaces one sweep BILLS for, so it REFUSES the write that would ADD the row past
//      it and TRUNCATES in the sweep (nobody is there to be told, and an unbounded loop is a
//      bill). Opposite trades, on purpose.
//   4. THE SSRF ALLOWLIST ON THE WRITE PATH. `normalizeSlackWebhookUrl` is a storage-time
//      control; a write path that skips it bypasses it entirely.
//   5. THE SINGLE-WORKSPACE WRITE. `writeTarget` touches exactly the workspace it is given and
//      `deleteTarget` is the only way a row goes away — a save can no longer cancel a delivery by
//      omitting it from a list.
//
// Plus the deep links, which must work on a LOCAL install — the mode the feature was asked for.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/slack-targets.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SLACK_TARGET_WORKSPACE_CAP } from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import * as settingsSchema from '../settings/schema.sqlite.js';

// The sweep's two outbound edges are stubbed so the suite drives the REAL scheduling, dedupe and
// stamping code without a model or a network. Everything else — the rows, the queries, the
// upserts, the markers — is the production path against a real SQLite file.
const posted: { url: string; text: string }[] = [];
let failNextPost = false;
vi.mock('../slack/send.js', () => ({
  postToSlack: async (url: string, message: { text: string }) => {
    if (failNextPost) {
      failNextPost = false;
      throw new Error('Slack webhook responded 500');
    }
    posted.push({ url, text: message.text });
  },
}));
let buildCalls: Array<{ accountId: number; workspaceId: number }> = [];
let buildHangs: number | null = null;
vi.mock('../slack/report.js', () => ({
  buildSlackReport: async (
    _ctx: unknown,
    _llm: unknown,
    accountId: number,
    workspaceId: number,
  ) => {
    buildCalls.push({ accountId, workspaceId });
    if (buildHangs === workspaceId) throw new Error('generation blew up mid-sweep');
    return { blocks: [], text: `ws${workspaceId}` };
  },
}));

const { sweepTargets, cappedTargets, dueSlot } = await import('../slack/cron.js');
const {
  SlackTargetBadWebhookError,
  SlackTargetCapError,
  SlackTargetMissingWebhookError,
  deleteTarget,
  readTarget,
  readTargetRows,
  writeTarget,
} = await import('../slack/targets.js');
const { appBase, repoLink, workspaceLink } = await import('../slack/links.js');
const { eraseProByAccountId } = await import('../retention.js');

function migrationSql(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), 'utf8');
}

// The CORE `workspaces` table as the plugin sees it through `ctx.schema.workspaces`. A stub for a
// table core owns, not a second definition of it — `ctx.schema` is typed `Record<string, any>` in
// the contract, so a column core dropped would still TYPECHECK here and fail only as malformed SQL
// at runtime. Only the three columns this feature reads.
const coreWorkspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey(),
  accountId: integer('account_id').notNull(),
  name: text('name').notNull(),
});

const WEBHOOK_A = 'https://hooks.slack.com/services/T1/B1/aaaaaaaaaaaa';
const WEBHOOK_B = 'https://hooks.slack.com/services/T2/B2/bbbbbbbbbbbb';

// 09:00 UTC on 2026-07-06 → slot "2026-07-06T09".
const NOW = Date.parse('2026-07-06T09:30:00.000Z');
const SLOT = '2026-07-06T09';
const NEXT_DAY = Date.parse('2026-07-07T09:30:00.000Z');

const llm: LlmClient = {
  async complete() {
    return { text: '', inputTokens: 0, outputTokens: 0, costUsd: 0 };
  },
} as unknown as LlmClient;

describe('the per-workspace Slack digest', () => {
  let sqlite: Database.Database;
  let ctx: ProContext;
  let warnings: number;

  // The core tables the plugin reaches through `ctx.schema`, as stubs. `workspaces` carries the
  // (id, account_id) unique index the migration's named composite FK leans on.
  const seedCore = (): void => {
    sqlite.exec(
      'CREATE TABLE workspaces (id integer PRIMARY KEY, account_id integer NOT NULL, name text NOT NULL, is_default integer NOT NULL DEFAULT 0);' +
        'CREATE UNIQUE INDEX workspaces_id_account ON workspaces (id, account_id);',
    );
    sqlite
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?,?,?,?)')
      .run(1, 1, 'Default', 1);
    for (const [id, name] of [
      [2, 'Platform'],
      [3, 'Mobile'],
      [4, 'Data'],
    ] as [number, string][]) {
      sqlite
        .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?,?,?,0)')
        .run(id, 1, name);
    }
    // A SECOND TENANT. Its workspace id must never be writable or readable from account 1.
    sqlite
      .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?,?,?,?)')
      .run(90, 2, 'Other tenant default', 1);
  };

  // `pro_settings` as it exists BEFORE 0030 — the seven slack_* columns still live. The drizzle
  // schema no longer declares them, which is exactly why the migration has to move the data.
  const seedProSettings = (opts: {
    webhook: string | null;
    cadence?: string;
    hour1?: number;
    lastSlot?: string | null;
  }): void => {
    sqlite.exec(
      'CREATE TABLE pro_settings (' +
        'id integer PRIMARY KEY AUTOINCREMENT, account_id integer NOT NULL, ' +
        'sprint_cadence_days integer, sprint_start_at integer, comparison_mode text, report_model text, ' +
        'slack_webhook_url text, slack_cadence text, slack_hour1 integer, slack_hour2 integer, ' +
        'slack_timezone text, slack_last_sent_at integer, slack_last_sent_slot text, ' +
        'issue_provider text, issue_base_url text, issue_project_keys text, ' +
        'bot_slack_digest integer, bot_auto_resolve integer, bot_auto_resolve_days integer, bot_cost_json text, ' +
        'created_at integer NOT NULL DEFAULT (unixepoch()), updated_at integer NOT NULL DEFAULT (unixepoch()));' +
        'CREATE UNIQUE INDEX pro_settings_account ON pro_settings (account_id);',
    );
    sqlite
      .prepare(
        'INSERT INTO pro_settings (account_id, slack_webhook_url, slack_cadence, slack_hour1, slack_last_sent_slot) VALUES (?,?,?,?,?)',
      )
      .run(1, opts.webhook, opts.cadence ?? 'daily', opts.hour1 ?? 9, opts.lastSlot ?? null);
  };

  // ⚠ EVERY MIGRATION THAT OWNS THIS TABLE, IN FILENAME ORDER — the order the host's
  // runPluginMigrations applies them in. 0033 adds `bot_digest` and MIGRATES the account-wide
  // `pro_settings.bot_slack_digest` onto every existing target row; 0040 adds the two event
  // signals' switches and their sent-marker table.
  const applyMigration = (): void => {
    sqlite.exec(migrationSql('0030_workspace_slack_targets.sql'));
    sqlite.exec(migrationSql('0033_slack_target_bot_digest.sql'));
    sqlite.exec(migrationSql('0040_slack_event_signals.sql'));
  };

  const makeCtx = (appWebUrl?: string): ProContext =>
    ({
      db: drizzle(sqlite, { schema: { ...settingsSchema } }),
      log: {
        warn: () => {
          warnings += 1;
        },
        error: () => {},
        info: () => {},
      },
      host: {
        version: '0.0.0',
        ...(appWebUrl === undefined ? {} : { appWebUrl }),
      },
      schema: { workspaces: coreWorkspaces },
    }) as unknown as ProContext;

  const target = (workspaceId: number, webhookUrl: string): void => {
    sqlite
      .prepare(
        'INSERT INTO workspace_slack_targets (account_id, workspace_id, webhook_url, cadence, hour1) VALUES (?,?,?,?,?)',
      )
      .run(1, workspaceId, webhookUrl, 'daily', 9);
  };

  const markers = (): Array<{ workspace_id: number; last_sent_slot: string | null }> =>
    sqlite
      .prepare(
        'SELECT workspace_id, last_sent_slot FROM workspace_slack_targets ORDER BY workspace_id',
      )
      .all() as Array<{ workspace_id: number; last_sent_slot: string | null }>;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    posted.length = 0;
    buildCalls = [];
    buildHangs = null;
    failNextPost = false;
    warnings = 0;
    seedCore();
  });

  // ── 1. PER-WORKSPACE DEDUPE ───────────────────────────────────────────────────────────────
  describe('dedupe is per (account, workspace)', () => {
    beforeEach(() => {
      seedProSettings({ webhook: null });
      applyMigration();
      ctx = makeCtx('http://localhost:4000');
      target(1, WEBHOOK_A);
      target(2, WEBHOOK_A);
      target(3, WEBHOOK_B);
    });

    it('sends every due workspace exactly once, then nothing on a second sweep', async () => {
      await sweepTargets(ctx, llm, NOW);
      expect(buildCalls.map((c) => c.workspaceId).sort()).toEqual([1, 2, 3]);
      expect(posted).toHaveLength(3);
      expect(markers()).toEqual([
        { workspace_id: 1, last_sent_slot: SLOT },
        { workspace_id: 2, last_sent_slot: SLOT },
        { workspace_id: 3, last_sent_slot: SLOT },
      ]);

      // The same slot again — the 15-minute cron ticks four times an hour, so this is the ordinary
      // case, not an edge one.
      posted.length = 0;
      await sweepTargets(ctx, llm, NOW + 20 * 60_000);
      expect(posted).toHaveLength(0);
    });

    it('⚠ A RESTART MID-SWEEP RE-SENDS NOTHING AND SKIPS NOTHING', async () => {
      // Workspace 2's generation blows up: its marker is NOT stamped, workspaces 1 and 3 still go.
      // With ONE marker per account this is the exact shape that breaks — 1 and 3 advance the
      // shared marker, and 2 is silently skipped forever.
      buildHangs = 2;
      await sweepTargets(ctx, llm, NOW);
      expect(posted.map((p) => p.text).sort()).toEqual(['ws1', 'ws3']);
      expect(markers()).toEqual([
        { workspace_id: 1, last_sent_slot: SLOT },
        { workspace_id: 2, last_sent_slot: null },
        { workspace_id: 3, last_sent_slot: SLOT },
      ]);
      expect(warnings).toBe(1);

      // "Restart": the next tick. Only the workspace that missed its slot is retried, and the two
      // that succeeded are NOT re-sent.
      buildHangs = null;
      posted.length = 0;
      buildCalls = [];
      await sweepTargets(ctx, llm, NOW + 15 * 60_000);
      expect(buildCalls.map((c) => c.workspaceId)).toEqual([2]);
      expect(posted.map((p) => p.text)).toEqual(['ws2']);
      expect(markers().every((m) => m.last_sent_slot === SLOT)).toBe(true);
    });

    it('a POST that Slack rejects leaves the marker unstamped, so the slot is retried', async () => {
      // ⚠ THE STAMP SITS AFTER THE POST. A digest that never reached Slack must not be recorded as
      // delivered — that is a silently-missing report, which is worse than a duplicate.
      failNextPost = true;
      await sweepTargets(ctx, llm, NOW);
      const unstamped = markers().filter((m) => m.last_sent_slot == null);
      expect(unstamped).toHaveLength(1);
    });

    it('the next day is a new slot for every workspace', async () => {
      await sweepTargets(ctx, llm, NOW);
      posted.length = 0;
      await sweepTargets(ctx, llm, NEXT_DAY);
      expect(posted).toHaveLength(3);
      expect(markers().every((m) => m.last_sent_slot === '2026-07-07T09')).toBe(true);
    });

    it('a workspace whose cadence is off is never due', () => {
      expect(
        dueSlot({ cadence: 'off', hour1: 9, hour2: 16, timezone: null, lastSentSlot: null }, NOW),
      ).toBeNull();
      expect(
        dueSlot({ cadence: null, hour1: 9, hour2: 16, timezone: null, lastSentSlot: null }, NOW),
      ).toBeNull();
    });
  });

  // ── 2. THE UPGRADE PATH ───────────────────────────────────────────────────────────────────
  describe('migration 0030 moves the account-wide config onto the Default workspace', () => {
    it('copies the webhook, the schedule AND the dedupe marker', () => {
      seedProSettings({ webhook: WEBHOOK_A, cadence: 'twice_daily', hour1: 8, lastSlot: SLOT });
      applyMigration();
      const rows = sqlite
        .prepare('SELECT * FROM workspace_slack_targets')
        .all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.workspace_id).toBe(1); // the account's DEFAULT workspace
      expect(rows[0]!.webhook_url).toBe(WEBHOOK_A);
      expect(rows[0]!.cadence).toBe('twice_daily');
      expect(rows[0]!.hour1).toBe(8);
      // ⚠ THE LOAD-BEARING ONE.
      expect(rows[0]!.last_sent_slot).toBe(SLOT);
    });

    it('⚠ THE FIRST SWEEP AFTER AN UPGRADE DOES NOT RE-SEND AN ALREADY-DELIVERED SLOT', async () => {
      // The exact production hazard: the account was delivered its 09:00 digest by the OLD
      // account-wide cron, the process restarts onto this build, and the migration runs. A row
      // created without the carried marker is "never sent" and posts the same digest again.
      seedProSettings({ webhook: WEBHOOK_A, cadence: 'daily', hour1: 9, lastSlot: SLOT });
      applyMigration();
      ctx = makeCtx('http://localhost:4000');
      await sweepTargets(ctx, llm, NOW);
      expect(posted).toHaveLength(0);
    });

    it('trims a pasted URL — matching the pg twin’s btrim(), verified by hand on PostgreSQL 16', () => {
      seedProSettings({ webhook: `  ${WEBHOOK_A}  ` });
      applyMigration();
      const row = sqlite
        .prepare('SELECT webhook_url FROM workspace_slack_targets')
        .get() as { webhook_url: string };
      expect(row.webhook_url).toBe(WEBHOOK_A);
    });

    it('an account with no webhook configured gets no row', () => {
      seedProSettings({ webhook: '   ' });
      applyMigration();
      expect(sqlite.prepare('SELECT count(*) c FROM workspace_slack_targets').get()).toEqual({
        c: 0,
      });
    });

    it('replays cleanly — the second application is a no-op, not a duplicate', () => {
      seedProSettings({ webhook: WEBHOOK_A, lastSlot: SLOT });
      applyMigration();
      // ⚠ 0030's FILE ONLY, not `applyMigration()`. 0033's bare `ALTER TABLE … ADD COLUMN` is
      // deliberately NOT blind-replayable in SQLite (there is no `ADD COLUMN IF NOT EXISTS`;
      // run-once is guaranteed by `pro_migrations`, and the pg twin uses `IF NOT EXISTS` because
      // a failing plugin pg migration is downgraded to a warning that drops the plugin to OSS
      // mode). What 0030 promises is that its DATA half cannot duplicate a delivery.
      sqlite.exec(migrationSql('0030_workspace_slack_targets.sql'));
      expect(sqlite.prepare('SELECT count(*) c FROM workspace_slack_targets').get()).toEqual({
        c: 1,
      });
    });
  });

  // ── 2b. MIGRATION 0033: THE BOT BLOCK BECOMES A PROPERTY OF THE DELIVERY ───────────────────
  //
  // The account flag `pro_settings.bot_slack_digest` decided whether the deterministic "Review
  // bots" block appeared. Once the digest itself went per-workspace (0030), that one flag was
  // deciding the CONTENT of N independently-scheduled messages about N different teams' bots.
  // 0033 moves it onto the row that IS the delivery — and MIGRATES the existing value, because an
  // account with the toggle ON must not silently lose its block on upgrade.
  describe('migration 0033 moves the bot-digest flag onto the delivery', () => {
    const setAccountFlag = (on: boolean): void => {
      sqlite.prepare('UPDATE pro_settings SET bot_slack_digest = ? WHERE account_id = 1').run(on ? 1 : 0);
    };
    const digests = (): Array<{ workspace_id: number; bot_digest: number | null }> =>
      sqlite
        .prepare('SELECT workspace_id, bot_digest FROM workspace_slack_targets ORDER BY workspace_id')
        .all() as Array<{ workspace_id: number; bot_digest: number | null }>;

    it('⚠ AN ACCOUNT WITH THE FLAG ON KEEPS ITS BLOCK — on EVERY existing target row', () => {
      // Two deliveries already exist (0030's Default-workspace copy plus one added since). Both
      // must come out of the migration with the block on: the flag applied to the digest, and the
      // digest is now these rows.
      seedProSettings({ webhook: WEBHOOK_A, lastSlot: SLOT });
      setAccountFlag(true);
      sqlite.exec(migrationSql('0030_workspace_slack_targets.sql'));
      target(2, WEBHOOK_B);
      sqlite.exec(migrationSql('0033_slack_target_bot_digest.sql'));
      expect(digests()).toEqual([
        { workspace_id: 1, bot_digest: 1 },
        { workspace_id: 2, bot_digest: 1 },
      ]);
    });

    it('an account with the flag OFF gains nothing — null reads as false', async () => {
      seedProSettings({ webhook: WEBHOOK_A, lastSlot: SLOT });
      setAccountFlag(false);
      applyMigration();
      expect(digests()).toEqual([{ workspace_id: 1, bot_digest: null }]);
      // …and the READ projects that null to the documented default rather than travelling it: a
      // row that predates 0033 and a row that never set the flag are the same fact.
      ctx = makeCtx();
      expect((await readTarget(ctx, 1, 1)).target?.botDigest).toBe(false);
    });

    it('⚠ IT IS AN UPDATE, NEVER AN INSERT — an account with no delivery gains no row', () => {
      // A ROW IS A DELIVERY. Inserting one would invent a Slack destination nobody configured,
      // and could not be done honestly anyway: `webhook_url` is NOT NULL and there is no URL to
      // invent. An account that had the flag on but no target rows was receiving nothing, and
      // still is.
      seedProSettings({ webhook: null });
      setAccountFlag(true);
      applyMigration();
      expect(sqlite.prepare('SELECT count(*) c FROM workspace_slack_targets').get()).toEqual({
        c: 0,
      });
    });

    it('the DATA half is idempotent — a hand re-run of the UPDATE changes nothing', () => {
      seedProSettings({ webhook: WEBHOOK_A, lastSlot: SLOT });
      setAccountFlag(true);
      applyMigration();
      const sql = migrationSql('0033_slack_target_bot_digest.sql');
      const dataHalf = sql.slice(sql.indexOf('UPDATE workspace_slack_targets'));
      sqlite.exec(dataHalf);
      expect(digests()).toEqual([{ workspace_id: 1, bot_digest: 1 }]);
    });
  });

  // ── 3. THE CAP ────────────────────────────────────────────────────────────────────────────
  describe('the workspace cap', () => {
    beforeEach(() => {
      seedProSettings({ webhook: null });
      applyMigration();
      ctx = makeCtx();
      // Enough workspaces to exceed the cap.
      for (let id = 10; id < 10 + SLACK_TARGET_WORKSPACE_CAP + 3; id += 1) {
        sqlite
          .prepare('INSERT INTO workspaces (id, account_id, name, is_default) VALUES (?,?,?,0)')
          .run(id, 1, `ws-${id}`);
      }
    });

    // Fill the account up to (but not past) the cap, one workspace at a time — the only way a
    // target is created now.
    const fillToCap = async (): Promise<void> => {
      for (let i = 0; i < SLACK_TARGET_WORKSPACE_CAP; i += 1) {
        await writeTarget(ctx, 1, 10 + i, { webhookUrl: WEBHOOK_A });
      }
    };

    it('accepts exactly the cap, one workspace at a time', async () => {
      await fillToCap();
      expect(await readTargetRows(ctx, 1)).toHaveLength(SLACK_TARGET_WORKSPACE_CAP);
    });

    it('⚠ REFUSES the write that would ADD a row past the cap, and stores nothing', async () => {
      await fillToCap();
      await expect(
        writeTarget(ctx, 1, 10 + SLACK_TARGET_WORKSPACE_CAP, { webhookUrl: WEBHOOK_A }),
      ).rejects.toBeInstanceOf(SlackTargetCapError);
      expect(await readTargetRows(ctx, 1)).toHaveLength(SLACK_TARGET_WORKSPACE_CAP);
      // The message names the number, because a cap the user cannot see is a cap that surprises
      // them on an invoice.
      await expect(
        writeTarget(ctx, 1, 10 + SLACK_TARGET_WORKSPACE_CAP, { webhookUrl: WEBHOOK_A }),
      ).rejects.toThrow(String(SLACK_TARGET_WORKSPACE_CAP));
    });

    it('⚠ EDITING AN EXISTING ROW AT THE CAP IS STILL ALLOWED', async () => {
      // The cap bounds how many workspaces are BILLED, i.e. how many rows exist. Editing one adds
      // no cost — and an account that is at (or somehow over) the bound must still be able to
      // change a schedule or turn a delivery off, which a blanket refusal would prevent.
      await fillToCap();
      await writeTarget(ctx, 1, 10, { cadence: 'off' });
      expect((await readTargetRows(ctx, 1)).find((r) => r.workspaceId === 10)!.cadence).toBe('off');
    });

    it('a DELETE frees a slot', async () => {
      await fillToCap();
      await deleteTarget(ctx, 1, 10);
      await writeTarget(ctx, 1, 10 + SLACK_TARGET_WORKSPACE_CAP, { webhookUrl: WEBHOOK_A });
      expect(await readTargetRows(ctx, 1)).toHaveLength(SLACK_TARGET_WORKSPACE_CAP);
    });

    it('⚠ THE CAP IS DISCLOSED ON THE READ, not only enforced on the write', async () => {
      // With no picker there is no screen listing every delivery, so `configuredCount` / `cap` on
      // the per-workspace read is the ONLY way a reader learns they are near the bound before a
      // Save is refused.
      await fillToCap();
      const view = await readTarget(ctx, 1, 10);
      expect(view.cap).toBe(SLACK_TARGET_WORKSPACE_CAP);
      expect(view.configuredCount).toBe(SLACK_TARGET_WORKSPACE_CAP);
    });

    it('the sweep TRUNCATES instead — the opposite trade, and per account', () => {
      const rows = Array.from({ length: SLACK_TARGET_WORKSPACE_CAP + 5 }, (_, i) => ({
        accountId: 1,
        workspaceId: 100 - i, // deliberately out of order
        webhookUrl: WEBHOOK_A,
        cadence: 'daily' as const,
        hour1: 9,
        hour2: 16,
        timezone: null,
        lastSentAt: null,
        lastSentSlot: null,
        botDigest: false,
        notifyReviews: false,
        notifyMerges: false,
      }));
      // A second account's rows must not be counted against the first's cap.
      rows.push({ ...rows[0]!, accountId: 2, workspaceId: 90 });
      const capped = cappedTargets(rows);
      expect(capped.filter((r) => r.accountId === 1)).toHaveLength(SLACK_TARGET_WORKSPACE_CAP);
      expect(capped.filter((r) => r.accountId === 2)).toHaveLength(1);
      // Stable order (workspace id), so the same workspaces survive every tick rather than
      // rotating and half-delivering to everybody.
      expect(capped[0]!.workspaceId).toBeLessThan(capped[1]!.workspaceId);
    });
  });

  // ── 4. THE SSRF ALLOWLIST, ON THE NEW WRITE PATH ──────────────────────────────────────────
  describe('the webhook allowlist on the per-workspace write path', () => {
    beforeEach(() => {
      seedProSettings({ webhook: null });
      applyMigration();
      ctx = makeCtx();
    });

    for (const [label, url] of [
      ['cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
      ['private network service', 'http://redis.railway.internal:6379/'],
      ['suffix-confusion host', 'https://hooks.slack.com.evil.example/services/T1/B1/a'],
      ['userinfo trick', 'https://hooks.slack.com@evil.example/services/T1/B1/a'],
      ['plain http Slack', 'http://hooks.slack.com/services/T1/B1/a'],
      ['right host, wrong path', 'https://hooks.slack.com/api/chat.postMessage'],
    ] as [string, string][]) {
      it(`refuses ${label}, and stores nothing`, async () => {
        await expect(
          writeTarget(ctx, 1, 2, { webhookUrl: url }),
        ).rejects.toBeInstanceOf(SlackTargetBadWebhookError);
        expect(await readTargetRows(ctx, 1)).toHaveLength(0);
      });
    }

    it('normalises what it does accept (query/fragment stripped)', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: `  ${WEBHOOK_A}?x=1#y \n` });
      expect((await readTargetRows(ctx, 1))[0]!.webhookUrl).toBe(WEBHOOK_A);
    });

    it('a bad URL never overwrites a good stored one', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      await expect(
        writeTarget(ctx, 1, 2, { webhookUrl: 'http://127.0.0.1:6379/', cadence: 'off' }),
      ).rejects.toBeInstanceOf(SlackTargetBadWebhookError);
      const row = (await readTargetRows(ctx, 1))[0]!;
      expect(row.webhookUrl).toBe(WEBHOOK_A);
      // ⚠ AND THE REST OF THE PATCH DID NOT LAND EITHER. The URL is validated before anything is
      // written, so a refused save changes nothing at all.
      expect(row.cadence).toBe('daily');
    });
  });

  // ── 5. THE SINGLE-WORKSPACE WRITE PATH ────────────────────────────────────────────────────
  describe('writeTarget / deleteTarget', () => {
    beforeEach(() => {
      seedProSettings({ webhook: null });
      applyMigration();
      ctx = makeCtx();
    });

    it('⚠ TOUCHES ONLY THE WORKSPACE IT IS GIVEN — a save cannot cancel a sibling', async () => {
      // The behaviour this REPLACES: the old whole-selection PUT deleted every workspace absent
      // from the submitted list, so any client bug that shortened the list silently cancelled
      // deliveries. Writing workspace 3 must leave workspace 2 exactly as it was.
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A, cadence: 'twice_daily' });
      await writeTarget(ctx, 1, 3, { webhookUrl: WEBHOOK_B });
      const rows = await readTargetRows(ctx, 1);
      expect(rows.map((r) => r.workspaceId)).toEqual([2, 3]);
      expect(rows[0]!.cadence).toBe('twice_daily');
      expect(rows[0]!.webhookUrl).toBe(WEBHOOK_A);
    });

    it('DELETE is the off switch, and it removes exactly one row', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      await writeTarget(ctx, 1, 3, { webhookUrl: WEBHOOK_B });
      await deleteTarget(ctx, 1, 2);
      expect((await readTargetRows(ctx, 1)).map((r) => r.workspaceId)).toEqual([3]);
    });

    it('an omitted webhookUrl KEEPS the stored secret (the field is write-only)', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      await writeTarget(ctx, 1, 2, { cadence: 'twice_daily', hour1: 7 });
      const row = (await readTargetRows(ctx, 1))[0]!;
      expect(row.webhookUrl).toBe(WEBHOOK_A);
      expect(row.cadence).toBe('twice_daily');
      expect(row.hour1).toBe(7);
    });

    it('a NEW workspace with no webhook is refused — an undeliverable row would just be skipped', async () => {
      await expect(writeTarget(ctx, 1, 2, {})).rejects.toBeInstanceOf(
        SlackTargetMissingWebhookError,
      );
      expect(await readTargetRows(ctx, 1)).toHaveLength(0);
    });

    it('⚠ does NOT touch the dedupe markers — they are the cron’s, not the user’s', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      sqlite
        .prepare('UPDATE workspace_slack_targets SET last_sent_slot = ? WHERE workspace_id = 2')
        .run(SLOT);
      await writeTarget(ctx, 1, 2, { cadence: 'daily', hour1: 9 });
      expect((await readTargetRows(ctx, 1))[0]!.lastSentSlot).toBe(SLOT);
    });

    it('⚠ THE BOT-DIGEST FLAG IS PER DELIVERY, AND A PARTIAL PATCH PRESERVES IT', async () => {
      // Plugin 0033. `values` is spread into BOTH the insert and the `set:`, so a column named
      // there but not seeded from `prior` is NULLED on any unrelated patch — the same hazard
      // `mergeWorkspace` documents one table over, and the reason this assertion exists.
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A, botDigest: true });
      expect((await readTarget(ctx, 1, 2)).target?.botDigest).toBe(true);
      // An edit that says nothing about the block must not turn it off.
      await writeTarget(ctx, 1, 2, { cadence: 'twice_daily', hour2: 17 });
      expect((await readTarget(ctx, 1, 2)).target?.botDigest).toBe(true);
      // …and it is genuinely switchable, so the assertion above is not vacuous.
      await writeTarget(ctx, 1, 2, { botDigest: false });
      expect((await readTarget(ctx, 1, 2)).target?.botDigest).toBe(false);
    });

    it('⚠ TWO DELIVERIES CARRY TWO INDEPENDENT BOT FLAGS — the whole point of the move', async () => {
      // The account flag this replaces could not express this: one team drowning in bot comments
      // wants the block, a team with no bots gets a section about somebody else's problem.
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A, botDigest: true });
      await writeTarget(ctx, 1, 3, { webhookUrl: WEBHOOK_B, botDigest: false });
      expect((await readTarget(ctx, 1, 2)).target?.botDigest).toBe(true);
      expect((await readTarget(ctx, 1, 3)).target?.botDigest).toBe(false);
    });

    it('⚠ A DELETE TAKES THE MARKER WITH IT, so re-configuring later delivers again', async () => {
      // Turning a workspace off and back on is a NEW delivery. A surviving marker would silently
      // swallow the first digest of the new arrangement — the failure mode that looks like "the
      // Slack integration just doesn't work" and cannot be diagnosed from the UI.
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      sqlite
        .prepare('UPDATE workspace_slack_targets SET last_sent_slot = ? WHERE workspace_id = 2')
        .run(SLOT);
      await deleteTarget(ctx, 1, 2);
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      expect((await readTargetRows(ctx, 1))[0]!.lastSentSlot).toBeNull();
    });

    it('the read never returns the webhook URL', async () => {
      await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
      const view = await readTarget(ctx, 1, 2);
      expect(view.target).toMatchObject({
        workspaceId: 2,
        workspaceName: 'Platform',
        configured: true,
      });
      expect(JSON.stringify(view)).not.toContain('hooks.slack.com');
    });

    it('an unconfigured workspace reads as `target: null`, not an empty row', async () => {
      const view = await readTarget(ctx, 1, 3);
      expect(view).toMatchObject({ workspaceId: 3, workspaceName: 'Mobile', target: null });
      expect(view.configuredCount).toBe(0);
    });

    it('⚠ A CROSS-TENANT WORKSPACE ID LEAKS NOTHING, not even the name', async () => {
      // The route resolves `?workspace=` to an id this account owns before reaching here, so this
      // is the defence in depth beneath that: workspace 90 belongs to account 2, and reading it as
      // account 1 must not surface its name. (The named composite FK is the third layer, on the
      // write.)
      const view = await readTarget(ctx, 1, 90);
      expect(view.workspaceName).toBe('(unknown workspace)');
      expect(view.target).toBeNull();
    });
  });

  // ── 6. HOUSEKEEPING: erasure ──────────────────────────────────────────────────────────────
  it('account erasure deletes the targets — core cannot see this table at all', async () => {
    seedProSettings({ webhook: null });
    applyMigration();
    ctx = makeCtx();
    await writeTarget(ctx, 1, 2, { webhookUrl: WEBHOOK_A });
    // The hook sweeps every plugin table; the ones this stub DB does not have simply log and
    // continue (each delete is independent by design), so the assertion is about ours.
    await eraseProByAccountId(ctx, 1);
    expect(await readTargetRows(ctx, 1)).toHaveLength(0);
  });
});

// ── THE APP DEEP LINKS ──────────────────────────────────────────────────────────────────────
describe('deep links back into the app', () => {
  const withBase = (appWebUrl?: string): ProContext =>
    ({
      host: { version: '0', ...(appWebUrl === undefined ? {} : { appWebUrl }) },
    }) as unknown as ProContext;

  it('⚠ WORKS ON A LOCAL INSTALL — the mode the feature was asked for', () => {
    // core config.ts resolves `appWebUrl` to the SPA origin — :4000 when this server serves the
    // unset, which is every local install. A plugin-side `process.env.APP_BASE_URL` read would
    // have produced an empty base and a hostless link here.
    const ctx = withBase('http://localhost:4000');
    expect(workspaceLink(ctx, 3)).toBe('http://localhost:4000/app/?view=activity&workspace=3&activityRepo=feed');
    expect(repoLink(ctx, 3, 42)).toBe(
      'http://localhost:4000/app/?view=activity&workspace=3&activityRepo=42',
    );
  });

  it('works in cloud, and tolerates a trailing slash', () => {
    const ctx = withBase('https://app.example.com/');
    expect(workspaceLink(ctx, 7)).toBe('https://app.example.com/app/?view=activity&workspace=7&activityRepo=feed');
  });

  it('degrades to NO LINK rather than a broken one when the host published no base', () => {
    // An older host (the seam is optional, so apiVersion stays 21) — one line of the digest is
    // plainer; nothing else changes.
    expect(appBase(withBase())).toBeNull();
    expect(workspaceLink(withBase(), 1)).toBeNull();
    expect(repoLink(withBase(''), 1, 2)).toBeNull();
    expect(workspaceLink(withBase('not-a-url'), 1)).toBeNull();
  });
});
