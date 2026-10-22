// Bot-Triage Platform (WS8) pro_settings merge/round-trip tests. Like isolation.test.ts this file
// is NOT in the plugin's `typecheck` include (src only) and the package ships no test script; run
// it from a workspace that has vitest + better-sqlite3, e.g.:
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/settings-bots.test.ts
//
// Exercises the `bots` section end-to-end over a throwaway in-memory SQLite seeded with the real
// pro migrations (0005 → 0006 → 0007 → 0009): toPublicSettings DEFAULTS, a full write→read
// round-trip, autoResolveDays clamping, and partial-patch preservation.
// Seeding via the migration files also validates 0009's ALTER statements parse.
//
// ⚠ THE MIGRATIONS STILL CREATE COLUMNS THIS FILE NO LONGER MENTIONS, AND THAT IS THE POINT. The
// five detection settings (`bot_inhouse_detect` / `bot_auto_tag` / `bot_login_allowlist` /
// `bot_deep_detect` / `bot_ai_tiebreak`), the two Limn-attribution ones (`bot_tag_pierre` /
// `bot_pierre_footer`) and the AI-update policy (`ai_update_mode` / `ai_interval_minutes`) were
// removed from the wire, from `store.ts` and from the drizzle schema modules — but NOT from the
// database, exactly like `bot_auto_resolve*` before them. Nothing selects or writes them; the
// upsert simply stops naming them, so a row written under an older build keeps its values. That is
// why 0009 is still in the list above: it is the migration that adds most of them, and it must
// keep parsing.
//
// ⚠ `cost` IS NO LONGER WRITABLE. `ProSettingsUpdate.bots.cost` was removed when per-bot cost
// moved to the CORE bot row — today `workspace_reviewers.monthly_cents`, one price PER WORKSPACE
// (a per-login blob in this plugin's settings could not be edited or cleared from the row that
// displayed it). `ProSettings.bots.cost` survives as a DEPRECATED READ — the null-only ROI
// fallback for a costed login the migration could not attach to a bot row — so the cost tests
// below seed `bot_cost_json` DIRECTLY and only assert the parse. The seed itself now lives in
// plugin migration 0020 (0019 became a legal no-op once core 0045 dropped the two tables it
// wrote; see test/isolation.test.ts's "plugin migration 0020 Part A" block, which pins the
// rounding rule and all four malformed-JSON layers against the real file). Nothing in this
// package is typechecked by CI (the plugin tsconfig includes `src` only and there is no test
// script), so a stale `bots: { cost: … }` patch here would have compiled fine and silently done
// nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  readProSettings,
  readSettingsRow,
  reportModelOf,
  toPublicSettings,
  writeProSettings,
} from '../settings/store.js';
import type { ProContext } from '../contract.js';

// ⚠ HAND-CURATED, not "every migration" — this fixture builds the smallest schema the settings
// store touches. That makes it a standing obligation: any migration that adds a column
// `readProSettings`/`writeProSettings` NAMES must be appended here, or all eight tests fail with
// `SqliteError: no such column`. 0025 is here for exactly that reason (`pro_settings.report_model`);
// its CREATE TABLE for the period reports is inert in this fixture and costs nothing.
const MIGRATIONS = [
  '0005_pro_settings',
  '0006_issue_project_keys',
  '0007_comparison_mode',
  '0009_bot_settings',
  '0025_period_reports',
];

const ACCOUNT = 1;
let ctx: ProContext;
// The raw handle, so the cost tests can seed `bot_cost_json` directly — there is no write path
// through `writeProSettings` any more (see the header).
let raw: Database.Database;

beforeEach(() => {
  const sqlite = new Database(':memory:');
  for (const f of MIGRATIONS) {
    sqlite.exec(
      readFileSync(fileURLToPath(new URL(`../migrations/${f}.sql`, import.meta.url)), 'utf8'),
    );
  }
  raw = sqlite;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  ctx = { db, isPg: false } as unknown as ProContext;
});

// Write the legacy blob straight onto the row (upserting it if this account has none yet).
function seedLegacyCostJson(json: string | null): void {
  raw
    .prepare(
      `INSERT INTO pro_settings (account_id, bot_cost_json) VALUES (?, ?)
         ON CONFLICT(account_id) DO UPDATE SET bot_cost_json = excluded.bot_cost_json`,
    )
    .run(ACCOUNT, json);
}

describe('toPublicSettings — bots defaults', () => {
  it('an unset account gets the documented bot defaults', () => {
    const bots = toPublicSettings(null).bots;
    // An EXACT match, deliberately: it is what pins that the removed detection / attribution keys
    // are gone from the WIRE and not merely unrendered.
    expect(bots).toEqual({
      slackDigest: false,
      autoResolve: false,
      autoResolveDays: 7,
      cost: [],
    });
  });

  it('the whole read shape carries no aiUpdate section', () => {
    // Same reason as above, one level up: the AI-summary update policy is not a wire field any
    // more, so a client cannot resurrect it by sending one.
    expect('aiUpdate' in toPublicSettings(null)).toBe(false);
  });

  it('a stored account with no bot columns still reads the defaults', async () => {
    // A write that touches only the sprint section leaves the bot columns null → defaults.
    await writeProSettings(ctx, ACCOUNT, { sprint: { cadenceDays: 14 } });
    const bots = (await readProSettings(ctx, ACCOUNT)).bots;
    expect(bots.slackDigest).toBe(false);
    expect(bots.autoResolveDays).toBe(7);
    expect(bots.cost).toEqual([]);
  });
});

describe('writeProSettings — bots round-trip', () => {
  it('persists every LIVE bot field flipped off its default', async () => {
    await writeProSettings(ctx, ACCOUNT, {
      bots: {
        autoResolve: true,
        autoResolveDays: 21,
      },
    });
    const bots = (await readProSettings(ctx, ACCOUNT)).bots;
    expect(bots).toEqual({
      // ⚠ NOT WRITABLE AND ALWAYS false AS OF PLUGIN 0033. The "Review bots" block is a property
      // of the DELIVERY now (`SlackTarget.botDigest`, one row per workspace), because the digest
      // itself became per-workspace in 0030 — at which point one account flag was deciding the
      // CONTENT of N separately-scheduled messages about N different teams' bots.
      slackDigest: false,
      autoResolve: true,
      autoResolveDays: 21,
      // No cost was seeded and none can be PATCHED any more — the field reads empty.
      cost: [],
    });
  });

  it('drops a legacy kind-keyed cost entry on the way OUT (the read fallback)', async () => {
    // Rows written before the login-keyed rewrite carry {kind, monthlyUsd}. They cannot be
    // attributed to a reviewer, so parseCost drops them — a silently mis-costed bot is worse than
    // an uncosted one. Seeded directly: there is no write path to this blob any more.
    seedLegacyCostJson(
      JSON.stringify([
        { kind: 'coderabbit', monthlyUsd: 30 },
        { login: 'coderabbitai', monthlyUsd: 30 },
      ]),
    );
    expect((await readProSettings(ctx, ACCOUNT)).bots.cost).toEqual([
      { login: 'coderabbitai', monthlyUsd: 30 },
    ]);
  });

  it('a bots patch NEVER writes cost, and leaves a stored legacy blob intact', async () => {
    seedLegacyCostJson(JSON.stringify([{ login: 'coderabbitai', monthlyUsd: 30 }]));
    await writeProSettings(ctx, ACCOUNT, {
      // A stale client still sending `cost` is stripped by the route's additionalProperties:false;
      // `merge` has no branch for it either, so even smuggled past the schema it does nothing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bots: { autoResolve: true, cost: [{ login: 'coderabbitai', monthlyUsd: 999 }] } as any,
    });
    const bots = (await readProSettings(ctx, ACCOUNT)).bots;
    expect(bots.autoResolve).toBe(true);
    // The $999 patch was ignored AND the pre-existing blob survived the unrelated write.
    expect(bots.cost).toEqual([{ login: 'coderabbitai', monthlyUsd: 30 }]);
  });

  it('a REMOVED key smuggled past the schema changes nothing and does not throw', async () => {
    // The removed detection / attribution keys reach the store only if something bypasses the PUT
    // body schema (which strips them). `merge` has no branch for any of them, so the write is a
    // no-op on those columns rather than a crash or a silent resurrection.
    await writeProSettings(ctx, ACCOUNT, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bots: { aiTiebreak: true, loginAllowlist: ['*-ci'], pierreFooter: true } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aiUpdate: { mode: 'on_change' } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const settings = await readProSettings(ctx, ACCOUNT);
    expect(settings.bots).toEqual({
      slackDigest: false,
      autoResolve: false,
      autoResolveDays: 7,
      cost: [],
    });
    expect('aiUpdate' in settings).toBe(false);
  });

  it('clamps autoResolveDays to 1..90', async () => {
    await writeProSettings(ctx, ACCOUNT, { bots: { autoResolveDays: 999 } });
    expect((await readProSettings(ctx, ACCOUNT)).bots.autoResolveDays).toBe(90);

    await writeProSettings(ctx, ACCOUNT, { bots: { autoResolveDays: 0 } });
    expect((await readProSettings(ctx, ACCOUNT)).bots.autoResolveDays).toBe(1);
  });

  it('a blank / malformed cost blob reads as an empty list, never a throw', async () => {
    // The blob is hand-editable and predates several shape changes, so the read must degrade
    // rather than break the whole settings response.
    seedLegacyCostJson('not json at all');
    expect((await readProSettings(ctx, ACCOUNT)).bots.cost).toEqual([]);
    seedLegacyCostJson('{"login":"x","monthlyUsd":1}'); // an object, not an array
    expect((await readProSettings(ctx, ACCOUNT)).bots.cost).toEqual([]);
    seedLegacyCostJson(JSON.stringify([{ login: 'copilot', monthlyUsd: 'twelve' }]));
    expect((await readProSettings(ctx, ACCOUNT)).bots.cost).toEqual([]);
    // …and a well-formed one still parses, so the three assertions above are not vacuous.
    seedLegacyCostJson(JSON.stringify([{ login: 'copilot', monthlyUsd: 12 }]));
    expect((await readProSettings(ctx, ACCOUNT)).bots.cost).toEqual([
      { login: 'copilot', monthlyUsd: 12 },
    ]);
  });

  it('a partial bots patch preserves prior bot values and leaves other sections intact', async () => {
    await writeProSettings(ctx, ACCOUNT, {
      reportModel: 'claude-haiku-5-5',
      bots: { autoResolveDays: 14 },
    });
    // A second patch touching only autoResolve must not reset autoResolveDays.
    await writeProSettings(ctx, ACCOUNT, { bots: { autoResolve: true } });

    const settings = await readProSettings(ctx, ACCOUNT);
    expect(settings.bots.autoResolveDays).toBe(14);
    expect(settings.bots.autoResolve).toBe(true);
    // ⚠ THE NEIGHBOUR THIS ASSERTS AGAINST HAS MOVED FOUR TIMES, and every move narrowed what
    // `pro_settings` holds. It was `slack.cadence` until plugin 0030 (the digest went
    // per-workspace); `issue.provider` until 0031 (the tracker and the sprint cadence went too);
    // `sprint.comparisonMode` until 0032 (the comparison MODE went — it COMPOSES with the cadence,
    // so one account setting was producing two window shapes). What is genuinely left at the
    // ACCOUNT grain is the narration MODEL, so that is the neighbour now. If a future change
    // leaves nothing beside `bots`, delete this assertion rather than inventing one.
    expect(reportModelOf(await readSettingsRow(ctx, ACCOUNT))).toBe('claude-haiku-5-5');
  });

  it('the retired account-grain sections read EMPTY rather than stale', async () => {
    // ⚠ THE DORMANT COLUMNS MUST NOT LEAK BACK ONTO THE WIRE. `sprint_cadence_days` /
    // `sprint_start_at` / `issue_*` still EXIST in the database (plugin 0031 drops nothing), and
    // an account upgraded from before the split still has values in them. `toPublicSettings` emits
    // the EMPTY shape for both sections — a dormant column read back onto the wire is how a retired
    // grain keeps answering questions the UI then offers to "edit".
    raw
      .prepare(
        'INSERT INTO pro_settings (account_id, sprint_cadence_days, sprint_start_at, ' +
          'issue_provider, issue_base_url, comparison_mode, bot_slack_digest) VALUES (?,?,?,?,?,?,?) ' +
          'ON CONFLICT(account_id) DO UPDATE SET ' +
          'sprint_cadence_days = excluded.sprint_cadence_days, ' +
          'sprint_start_at = excluded.sprint_start_at, ' +
          'issue_provider = excluded.issue_provider, issue_base_url = excluded.issue_base_url, ' +
          'comparison_mode = excluded.comparison_mode, ' +
          'bot_slack_digest = excluded.bot_slack_digest',
      )
      .run(ACCOUNT, 21, 1, 'jira', 'https://x.atlassian.net', 'sprint', 1);
    const settings = await readProSettings(ctx, ACCOUNT);
    expect(settings.sprint.cadenceDays).toBeNull();
    expect(settings.sprint.startDate).toBeNull();
    expect(settings.issue).toEqual({ provider: null, baseUrl: null, projectKeys: [] });
    // ⚠ `comparisonMode` READS null, NOT 'rolling_14'. The column is dormant as of plugin 0032 and
    // the live value is per-WORKSPACE; emitting the product default here would assert an
    // account-wide mode no workspace need resolve to — a dormant grain still answering questions.
    expect(settings.sprint.comparisonMode).toBeNull();
    // ⚠ …and the stored bot-digest flag reads FALSE rather than travelling. Dormant as of plugin
    // 0033; the live value is on each `workspace_slack_targets` row, which 0033 backfilled.
    expect(settings.bots.slackDigest).toBe(false);
  });

  it('a removed `sprint.cadenceDays` / `issue` patch is inert, not destructive', async () => {
    // A STALE CLIENT still sending the account-wide sprint pair and the account-wide tracker. Both
    // left the wire in plugin 0031; the route's body schema strips them
    // (`additionalProperties: false` + ajv `removeAdditional`) and `merge()` has no branch for
    // either. What must NOT happen is the patch nulling a neighbouring column on its way through.
    await writeProSettings(ctx, ACCOUNT, { bots: { autoResolveDays: 14 } });
    await writeProSettings(ctx, ACCOUNT, {
      sprint: { cadenceDays: 7, startDate: '2026-01-01', comparisonMode: 'sprint' },
      issue: { provider: 'jira', baseUrl: 'https://x.atlassian.net' },
      bots: { slackDigest: true },
    } as Parameters<typeof writeProSettings>[2]);
    const settings = await readProSettings(ctx, ACCOUNT);
    // ⚠ THE WHOLE `sprint` SECTION IS INERT NOW — `comparisonMode` was its last live field until
    // plugin 0032 moved it to the workspace row. Nothing in it saves, and nothing in it reads back.
    expect(settings.sprint.comparisonMode).toBeNull();
    expect(settings.sprint.cadenceDays).toBeNull();
    expect(settings.issue.provider).toBeNull();
    // The retired bot-digest flag is inert too (plugin 0033).
    expect(settings.bots.slackDigest).toBe(false);
    // …and the unrelated neighbour survived every one of those no-ops.
    expect(settings.bots.autoResolveDays).toBe(14);
  });

  it('a removed `slack` section on the patch is inert, not destructive', async () => {
    // A STALE CLIENT still sending the account-wide Slack shape. `ProSettingsUpdate.slack` is gone
    // from the wire, the route's body schema strips it (`additionalProperties: false` + ajv
    // `removeAdditional`) and `merge` has no branch for it — so it must change nothing at all
    // rather than, say, nulling a column on its way past.
    await writeProSettings(ctx, ACCOUNT, { bots: { autoResolve: true } });
    await writeProSettings(ctx, ACCOUNT, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      slack: { cadence: 'daily', webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
    } as any);
    const settings = await readProSettings(ctx, ACCOUNT);
    expect(settings.bots.autoResolve).toBe(true);
    expect('slack' in settings).toBe(false);
  });
});
