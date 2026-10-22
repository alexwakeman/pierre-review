import { and, eq } from 'drizzle-orm';
import type {
  InsightsRangeKey,
  ProSettings,
  ProSettingsUpdate,
  SlackDigestCadence,
  SprintComparisonMode,
  WorkspaceProSettings,
  WorkspaceProSettingsUpdate,
} from '@pierre-review/shared';
import type { ProContext } from '../contract.js';
import { proSchemaFor } from '../db.js';
import { DEFAULT_REPORT_MODEL, resolveReportModel, type ReportModel } from '../llm/seam.js';

// The raw pro_settings row (sqlite returns Date for timestamp columns; the number branch is a
// defensive fallback). Exposed to the feature modules (sprint window, Slack cron, ticket
// enricher); the public `ProSettings` mapper below strips the secret webhook URL.
//
// ⚠ IT MIRRORS THE DRIZZLE SCHEMA, WHICH NO LONGER DECLARES EVERY COLUMN THE TABLE HAS. The
// `ai_update_mode` / `ai_interval_minutes` and the detection + Limn-attribution `bot_*` columns are
// DORMANT: still in the database (no migration drops them — same treatment as
// `bot_auto_resolve*`), removed from the schema modules, and therefore not selected here.
export interface SettingsRow {
  accountId: number;
  // ⚠ NO `sprintCadenceDays` / `sprintStartAt` AND NO `issue*` FIELDS. Those five columns went
  // DORMANT with plugin migration 0031: the sprint cadence and the Jira/Linear tracker are
  // per-WORKSPACE facts with NO account-level default beneath them, held in
  // `pro_workspace_settings` and read through `readWorkspaceSettingsRow` / `resolveSprintCadence`
  // / `resolveWorkspaceIssue` below. The columns still exist in the database but the schema
  // modules no longer declare them, so `select()` never returns them and this interface must not
  // claim they arrive.
  // ⚠ NO `comparisonMode` EITHER. That column went DORMANT with plugin migration 0032: the
  // comparison-window mode is a per-WORKSPACE fact — it COMPOSES with the cadence, so reading the
  // two off different grains made one account setting produce two different window SHAPES — and it
  // lives on `pro_workspace_settings` beside the cadence, read through `resolveComparisonMode`.
  // Which model narrates the period-over-period report. null = the PRO_REPORT_MODEL config
  // default (`DEFAULT_REPORT_MODEL`); a per-run override on the generate body beats both.
  reportModel: string | null;
  // ⚠ NO `slack*` FIELDS. Those seven columns went DORMANT with plugin migration 0030 — the
  // digest is a PER-WORKSPACE delivery now, one row per (account, workspace) in
  // `workspace_slack_targets`, read and written through ../slack/targets.ts. The columns still
  // exist in the database but the schema module no longer declares them, so `select()` never
  // returns them and this interface must not claim they arrive.
  // ⚠ NO `botSlackDigest`. That column went DORMANT with plugin migration 0033 — the "Review bots"
  // block is a property of the DELIVERY now (`workspace_slack_targets.bot_digest`), because the
  // digest itself became per-workspace in 0030 and one account flag was deciding the CONTENT of N
  // separately-scheduled messages about N different teams' bots.
  // Bot-Triage Platform (WS8). All nullable in the DB; toPublicSettings fills the default on read.
  botAutoResolve: boolean | null;
  botAutoResolveDays: number | null;
  // @deprecated LEGACY, READ-ONLY (see parseCost). JSON string of {login, monthlyUsd}[] — plus an
  // older, unmigratable {kind, monthlyUsd} shape; null when unset. Nothing writes it.
  botCostJson: string | null;
}

// Per-BOT monthly cost entry, as it appears in the LEGACY bot_cost_json blob. Keyed by the
// reviewer's github login (not kind) so in-house bots that share kind 'in_house' were costed
// individually. The live price is CORE's per-workspace `workspace_reviewers.monthly_cents`.
interface BotCostEntry {
  login: string;
  monthlyUsd: number;
}

// (The csvToList/listToCsv pair that used to live here went with `bots.loginAllowlist`, the only
// comma-joined list column left on the wire. `issueProjectKeys` has its own parser.)

// Parse/validate the stored cost JSON → a clean {login, monthlyUsd}[] (empty on junk/blank).
// Legacy kind-keyed entries (pre per-bot cost) lack a `login` and are silently dropped.
//
// FULLY LEGACY, AND READ-ONLY: `ProSettingsUpdate.bots.cost` was REMOVED and the paired
// `serializeCost` deleted with it, so NOTHING anywhere writes `bot_cost_json` — not this module,
// not the PUT route, not a migration. Cost lives on CORE's `workspace_reviewers.monthly_cents`,
// per WORKSPACE, edited inline on the very row that shows it (which this blob never was). Two live
// writers to one price is how the two silently disagree, so this one was retired rather than
// mirrored.
//
// What survives is the read. Plugin migration 0019 (now a no-op — core dropped the tables it wrote
// to) was ABSORBED by plugin 0020, which copies every entry it can MATCH straight into
// `workspace_reviewers.monthly_cents`, UPDATE-only and guarded on `monthly_cents IS NULL`, for
// every workspace row of that actor. It never INSERTs: a price needs a bot row to be displayed,
// edited or cleared on, and fabricating one would invent judgements nobody made. Entries it could
// not match (no bot row anywhere; the older kind-keyed blob shape, which names a BRAND and so has
// no actor to key on) keep driving the ROI panel through the client's read-time, null-only
// fallback — which is the only reason this parser still exists.
//
// RETIRE this function, `bot_cost_json`, `ProSettings.bots.cost` and that fallback one release
// after workspace cost ships, gated on `SELECT count(*) FROM pro_settings WHERE bot_cost_json IS
// NOT NULL` reaching zero. With no write path the set can only shrink.
function parseCost(raw: string | null): BotCostEntry[] {
  if (raw == null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: BotCostEntry[] = [];
  for (const e of parsed) {
    if (e != null && typeof e === 'object' && 'login' in e && 'monthlyUsd' in e) {
      const login = (e as { login: unknown }).login;
      const usd = (e as { monthlyUsd: unknown }).monthlyUsd;
      if (typeof login === 'string' && login.trim() !== '' && typeof usd === 'number' && Number.isFinite(usd))
        out.push({ login: login.trim(), monthlyUsd: Math.max(0, usd) });
    }
  }
  return out;
}

const toMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

// Exported for ../slack/targets.ts, which validates the same shapes at the WORKSPACE grain. One
// definition, two callers — a second copy is how the account form and the per-workspace form end
// up clamping an hour differently.
export const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)));

export const VALID_CADENCE: readonly SlackDigestCadence[] = ['off', 'daily', 'twice_daily'];
const VALID_COMPARISON: readonly SprintComparisonMode[] = ['rolling_7', 'rolling_14', 'sprint'];
const DEFAULT_COMPARISON: SprintComparisonMode = 'rolling_14';

// A date-only value (the sprint start) → a Date at UTC midnight, so cadence math is stable
// regardless of the server's timezone. Accepts 'YYYY-MM-DD' or a full ISO string; null on junk.
function startOfDay(iso: string): Date | null {
  const day = iso.slice(0, 10);
  const d = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeBaseUrl(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.trim().replace(/\/+$/, '');
  if (t === '') return null;
  if (!/^https?:\/\//i.test(t)) return null; // only accept absolute http(s) URLs
  return t;
}

// ---- SSRF guard on the Slack webhook URL ----
//
// This value is stored verbatim from `PUT /api/pro/settings` and later handed straight to
// `fetch()` by slack/send.ts, which made it a server-side request primitive: any authenticated
// Pro account could point it at `http://redis.railway.internal:6379/`, `http://127.0.0.1:…` or
// `http://169.254.169.254/` (the cloud metadata endpoint) and then hit `POST /api/pro/slack/test`
// — whose error message used to include the target's status AND the first 200 bytes of its
// response body. That is an internal port scanner with partial read, from inside the private
// network, for the price of a subscription.
//
// The fix is an ALLOWLIST at the point of storage, not a blocklist of bad hosts: Slack incoming
// webhooks have exactly one shape — `https://hooks.slack.com/services/T…/B…/…` — so anything
// else is either a mistake or an attack, and there is no legitimate case to preserve. Storing
// only valid values also means every downstream `fetch` is safe by construction rather than by
// each call site remembering to re-check.
//
// Returning null (rather than throwing) matches how every other field in this patch builder
// rejects bad input; routes.ts surfaces it as "not saved" and the UI shows the field empty.
//
// ⚠ IT STAYS HERE EVEN THOUGH THE SLACK CONFIG MOVED TO `workspace_slack_targets` (plugin 0030).
// It is the ONE allowlist, and it now has THREE callers: ../slack/targets.ts (the per-workspace
// write path — every new write routes through it, or the control would be bypassed at storage
// time), ../slack/send.ts (the SINK re-check, which is what makes the guarantee structural rather
// than dependent on call order) and test/slack-webhook-url.test.ts. Do not fork it.
const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

export function normalizeSlackWebhookUrl(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '') return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  // https only: a webhook carries the secret path segment, so plain http would leak it, and
  // restricting the scheme also rules out file:/gopher:/ftp: style redirect tricks.
  if (url.protocol !== 'https:') return null;
  // Exact host match. NOT `endsWith('slack.com')` — that would accept
  // `hooks.slack.com.evil.example`, which is the classic way this check gets written wrong.
  if (url.hostname.toLowerCase() !== SLACK_WEBHOOK_HOST) return null;
  // A real webhook is /services/<team>/<bot>/<token>; requiring the prefix stops the URL being
  // repurposed to hit some other endpoint on the same host.
  if (!url.pathname.startsWith('/services/')) return null;
  // Drop any query/fragment — nothing legitimate uses them here, and they are a place to hide
  // a redirect target.
  return `https://${SLACK_WEBHOOK_HOST}${url.pathname}`;
}

export async function readSettingsRow(
  ctx: ProContext,
  accountId: number,
): Promise<SettingsRow | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select()
    .from(pro.proSettings)
    .where(eq(pro.proSettings.accountId, accountId))
    .execute()) as SettingsRow[];
  return rows[0] ?? null;
}

// The public read shape (GET /api/pro/settings). The webhook URL is NEVER returned — only
// whether one is stored. Defaults fill in for an account with no row / unset columns.
export function toPublicSettings(row: SettingsRow | null): ProSettings {
  return {
    sprint: {
      // ⚠ ALL THREE ARE ALWAYS null. The cadence pair went per-WORKSPACE in plugin 0031 and the
      // comparison mode in plugin 0032; all three account columns are dormant, so there is nothing
      // to read here. The fields survive on the wire type ONLY so the shape does not move under a
      // stale client (one reading `settings.sprint.comparisonMode` off an absent section would
      // throw).
      // ⚠ `comparisonMode: null` IS NOT `DEFAULT_COMPARISON`. Emitting the product default from a
      // route that no longer stores the setting would assert an account-wide mode that no
      // workspace need resolve to — a dormant grain answering questions, which is exactly what
      // 0032 ended. The live read is `WorkspaceProSettings.comparisonMode`.
      cadenceDays: null,
      startDate: null,
      comparisonMode: null,
    },
    // (No `slack` section. It moved to `GET/PUT /api/pro/slack/target?workspace=` — one row per
    // workspace, a different GRAIN, so it cannot share this account patch's one Save.)
    // ⚠ ALWAYS EMPTY, for the same reason as `sprint` above: the Jira/Linear tracker is a
    // per-WORKSPACE setting (plugin 0031) served by `GET /api/pro/settings/workspace`. Emitting the
    // empty shape rather than a stale one is deliberate — a dormant column read back onto the wire
    // is how a retired grain keeps answering questions.
    issue: { provider: null, baseUrl: null, projectKeys: [] },
    // Bot-Triage Platform (WS8). Null (unset) → the documented default.
    bots: {
      // ⚠ ALWAYS false, for the same reason as `sprint` above: the "Review bots" block is a
      // per-DELIVERY setting as of plugin 0033 (`SlackTarget.botDigest` on
      // GET/PUT /api/pro/slack/target?workspace=) and `pro_settings.bot_slack_digest` is dormant.
      // Retained only so the field set does not move under a stale client.
      slackDigest: false,
      autoResolve: row?.botAutoResolve ?? false,
      autoResolveDays: row?.botAutoResolveDays ?? 7,
      cost: parseCost(row?.botCostJson ?? null),
    },
  };
}

export async function readProSettings(
  ctx: ProContext,
  accountId: number,
): Promise<ProSettings> {
  return toPublicSettings(await readSettingsRow(ctx, accountId));
}

// The account's effective report model: the stored setting when it is still a SELECTABLE id,
// otherwise the config default. A stored value that has since left `REPORT_MODELS` degrades to the
// default rather than throwing — this is read on a free GET, and it is no longer hypothetical:
// Sonnet was retired as a choice, so every account that had pinned it lands here and quietly gets
// Haiku. (It is still PRICEABLE — its stored reports keep rendering their model and their spend;
// selection and pricing are two different tables, see llm/seam.ts.)
//
// ⚠ IT IS NOT ON `ProSettings`. The public settings shape is a settled wire type owned by
// `@pierre-review/shared`, which this slice does not own; the Reports surface reads the effective
// model off its OWN list response instead (see insights/period-routes.ts). Adding
// `ProSettings.reportModel` later is a two-line change — one field in shared, one line in
// `toPublicSettings` — if the settings modal ever wants to show the selector too.
export function reportModelOf(row: SettingsRow | null): ReportModel {
  return resolveReportModel(row?.reportModel ?? null) ?? DEFAULT_REPORT_MODEL;
}

export async function readReportModel(
  ctx: ProContext,
  accountId: number,
): Promise<ReportModel> {
  return reportModelOf(await readSettingsRow(ctx, accountId));
}

// The patch shape the PUT accepts. `ProSettingsUpdate` is the settled wire type and carries no
// `reportModel`; this INTERSECTION adds it without editing the shared package (which this slice
// does not own). Every existing caller still type-checks — the field is optional — and the
// property is listed in `updateSchema` in routes.ts, WITHOUT which ajv's
// `additionalProperties: false` would strip it silently and still answer 200.
export type ProSettingsPatch = ProSettingsUpdate & { reportModel?: string | null };

// The mutable columns (everything except id/accountId/createdAt and the cron-managed lastSent*).
interface MutableCols {
  reportModel: string | null;
  // (No `slack*` columns — dormant since plugin 0030. No `sprint*` or `issue*` columns — dormant
  // since plugin 0031, both facts per-WORKSPACE now. No `comparison_mode` — dormant since plugin
  // 0032, also per-WORKSPACE. No `bot_slack_digest` — dormant since plugin 0033, a per-DELIVERY
  // fact on `workspace_slack_targets`. See SettingsRow above.)
  botAutoResolve: boolean | null;
  botAutoResolveDays: number | null;
  botCostJson: string | null;
}

// Merge a validated patch over the existing row, returning a fully-specified column set (so an
// upsert leaves unspecified fields at their prior value, and never touches lastSent*).
function merge(existing: SettingsRow | null, patch: ProSettingsPatch): MutableCols {
  const out: MutableCols = {
    // ⚠ SEEDED FROM `existing`, like every other column here. A field that is declared in
    // MutableCols but not seeded is NULLED by the upsert on any unrelated patch — the specific
    // way this 8-step checklist silently loses a setting.
    reportModel: existing?.reportModel ?? null,
    botAutoResolve: existing?.botAutoResolve ?? null,
    botAutoResolveDays: existing?.botAutoResolveDays ?? null,
    botCostJson: existing?.botCostJson ?? null,
  };

  // NO `patch.sprint` BRANCH AT ALL. `cadenceDays` / `startDate` went per-WORKSPACE in plugin 0031
  // and `comparisonMode` in plugin 0032, and all three columns here are dormant; routes.ts's body
  // schema no longer lists any of them, so a stale client sending one is SILENTLY STRIPPED and
  // still gets a 200 (the documented failure mode for every field retired from this patch). Their
  // replacement is `PUT /api/pro/settings/workspace` → `writeWorkspaceSettings`.
  if (patch.reportModel !== undefined) {
    // An unselectable id CLEARS the setting rather than storing it (the `normalizeBaseUrl` /
    // `normalizeSlackWebhookUrl` convention in this builder): the account falls back to the
    // config default, and nothing outside REPORT_MODELS can reach the metered path from storage.
    out.reportModel = resolveReportModel(patch.reportModel);
  }
  // NO `patch.slack` BRANCH — `ProSettingsUpdate.slack` was removed from the wire with plugin
  // migration 0030 and the columns are dormant. A stale client still sending one is SILENTLY
  // STRIPPED by routes.ts's `additionalProperties: false` body schema and the PUT still 200s
  // (the documented failure mode for every removed field here). Its replacement is
  // `PUT /api/pro/slack/target?workspace=`, at the workspace grain.
  // NO `patch.issue` BRANCH — the Jira/Linear tracker moved to the WORKSPACE grain in plugin 0031
  // and its columns here are dormant. Same silent-strip failure mode as `sprint` above; its
  // replacement is `PUT /api/pro/settings/workspace` → `writeWorkspaceSettings`.
  if (patch.bots) {
    const b = patch.bots;
    // NO detection / Limn-attribution BRANCHES — those five detection fields and the two
    // attribution fields were removed from `ProSettingsUpdate` and from the PUT body schema, and
    // their columns are dormant. `merge` does not carry them through from `existing` either
    // (unlike `botCostJson` below), because nothing reads them: the upsert simply stops naming
    // those columns, so whatever is stored is left exactly as it was.
    // NO `slackDigest` BRANCH — the "Review bots" block moved to the DELIVERY grain in plugin 0033
    // (`workspace_slack_targets.bot_digest`, written through `PUT /api/pro/slack/target?workspace=`)
    // and this column is dormant. Same silent-strip failure mode as the retired `sprint` fields.
    if (b.autoResolve !== undefined) out.botAutoResolve = !!b.autoResolve;
    if (b.autoResolveDays !== undefined) out.botAutoResolveDays = clampInt(b.autoResolveDays, 1, 90);
    // NO `cost` BRANCH, AND THERE IS NO WRITE PATH LEFT ANYWHERE — `ProSettingsUpdate.bots.cost`
    // is gone and its `serializeCost` twin was deleted with it. Per-bot cost is written per
    // WORKSPACE through `PUT /api/bot-reviewers/:userId/cost` into CORE's
    // `workspace_reviewers.monthly_cents`. `botCostJson` is still carried through `merge` from
    // `existing` above so an unrelated patch preserves the legacy blob the client's read-time,
    // null-only ROI fallback still reads (plugin migration 0020 absorbed the backfill; unmatched
    // logins keep driving that fallback). A stale client that keeps sending `bots.cost` is
    // SILENTLY STRIPPED by the PUT body schema (`additionalProperties: false`), not 400'd — the
    // right outcome (nothing changes, the request still succeeds), but silent, which is why it is
    // written down.
  }
  return out;
}

export async function writeProSettings(
  ctx: ProContext,
  accountId: number,
  patch: ProSettingsPatch,
): Promise<ProSettings> {
  const pro = proSchemaFor();
  const existing = await readSettingsRow(ctx, accountId);
  const cols = merge(existing, patch);
  const now = new Date();
  await ctx.db
    .insert(pro.proSettings)
    .values({ accountId, ...cols, updatedAt: now })
    .onConflictDoUpdate({
      target: pro.proSettings.accountId,
      set: { ...cols, updatedAt: now },
    })
    .execute();
  return readProSettings(ctx, accountId);
}

// ── THE PER-WORKSPACE Pro CONFIG: the sprint cadence (and the comparison mode) ───────────────
//
// (The issue tracker shared this row from plugin 0031 to apiVersion 23, when it moved to CORE
// `workspace_trackers` — core's boot-time move copied the values out and NULLed the `issue_*` and
// `jira_*` columns here, which are now DORMANT: undeclared in both schema modules, never read or
// written. Same treatment as every retired column on this row.)
//
// ONE table (`pro_workspace_settings`, keyed (account_id, workspace_id)), ONE row per workspace,
// ONE writer (`writeWorkspaceSettings`). Both settings are properties of the TEAM: two teams
// sharing an account run different sprints and frequently track work in different Jira/Linear
// projects.
//
// ⚠ THERE IS NO ACCOUNT-LEVEL FALLBACK UNDER EITHER OF THEM (plugin migration 0031). The cadence
// used to fall back to `pro_settings.sprint_*` through one resolver; that fallback is GONE and
// both account columns are dormant, as are the three `issue_*` ones. TWO STATES, NO CHAIN — which
// is what CLAUDE.md's "a fact lives at exactly ONE grain" asks for, and it removes the class of bug
// where `0`, `null` and "inherit" have to be told apart with `??` rather than `||`.
//
// ⚠ "NO CADENCE" IS THE PRODUCT DEFAULT, AND IT IS NOT A NUMBER. A workspace with no stored
// cadence has no sprint grid: `resolveComparisonWindow` degrades a `'sprint'` mode to the
// rolling-14 window and the Reports sprint grain refuses. That is exactly what an unconfigured
// account already did — the removed fallback pointed at an account pair that was itself null for
// most accounts. Do NOT introduce a default sprint length here; there has never been one.
export interface SprintCadence {
  /** Sprint length in days; null = this workspace has no sprint. */
  cadenceDays: number | null;
  /** The PHASE ANCHOR (a sprint's start day, UTC midnight) in epoch ms; null = not configured. */
  startAtMs: number | null;
}

/** The raw `pro_workspace_settings` row (sqlite returns Date for timestamps; the number branch is
 *  defensive). One read serves both settings — the route, the enricher and every window resolver
 *  go through it, so a workspace's config is never two round trips. */
export interface WorkspaceSettingsRow {
  sprintCadenceDays: number | null;
  sprintStartAt: Date | number | null;
  /** 'rolling_7' | 'rolling_14' | 'sprint'; null = unset → the product default. Plugin 0032. */
  comparisonMode: SprintComparisonMode | null;
  // (auto_review_enabled / _at, plugin 0036, are DORMANT: auto Claude review moved to core
  // `workspaces` with Claude Review — plugin 0037 copied the values across. Never read here.)
}


/** The `pro_workspace_settings` row for one workspace, or null. */
export async function readWorkspaceSettingsRow(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceSettingsRow | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select({
      sprintCadenceDays: pro.proWorkspaceSettings.sprintCadenceDays,
      sprintStartAt: pro.proWorkspaceSettings.sprintStartAt,
      comparisonMode: pro.proWorkspaceSettings.comparisonMode,
    })
    .from(pro.proWorkspaceSettings)
    .where(
      and(
        eq(pro.proWorkspaceSettings.accountId, accountId),
        eq(pro.proWorkspaceSettings.workspaceId, workspaceId),
      ),
    )
    .execute()) as WorkspaceSettingsRow[];
  return rows[0] ?? null;
}

/** The stored row → the public per-workspace shape (GET /api/pro/settings/workspace). */
export function toWorkspaceProSettings(
  workspaceId: number,
  row: WorkspaceSettingsRow | null,
): WorkspaceProSettings {
  const days = row?.sprintCadenceDays ?? null;
  const startMs = toMs(row?.sprintStartAt ?? null);
  return {
    workspaceId,
    cadenceDays: days != null && days >= 1 ? days : null,
    startDate: startMs == null ? null : new Date(startMs).toISOString(),
    comparisonMode: comparisonModeOf(row),
  };
}

/**
 * ⚠ THE ONE COMPARISON-MODE RESOLVER (plugin migration 0032), and the twin of
 * `resolveSprintCadence` below — same row, same two-state rule.
 *
 * A stored mode, or the PRODUCT DEFAULT `'rolling_14'`. There is NOTHING beneath it: the account
 * column is dormant and no inheritance chain replaced it. A junk value (only reachable by a
 * hand-written UPDATE — the writer validates) reads as the default rather than travelling on, so
 * two spellings of "unset" cannot answer differently.
 *
 * ⚠ IT IS READ OFF THE SAME ROW AS THE CADENCE, AND THAT IS THE POINT. The mode COMPOSES with the
 * cadence — `'sprint'` is a sprint-POSITION window on a workspace that has one and a rolling
 * FORTNIGHT on a workspace that does not — so reading the pair from two grains is what made one
 * account setting produce two different window shapes with nothing on screen naming which.
 */
export function comparisonModeOf(row: WorkspaceSettingsRow | null): SprintComparisonMode {
  const mode = row?.comparisonMode ?? null;
  return mode != null && VALID_COMPARISON.includes(mode) ? mode : DEFAULT_COMPARISON;
}

/** The cadence half of the same row. Split out so ONE read can answer both without a second
 *  round trip — see `getComparisonWindow`. A cadence < 1 is "no cadence", like a missing row. */
export function cadenceOf(row: WorkspaceSettingsRow | null): SprintCadence {
  const days = row?.sprintCadenceDays ?? null;
  if (days == null || days < 1) return { cadenceDays: null, startAtMs: null };
  return { cadenceDays: days, startAtMs: toMs(row?.sprintStartAt ?? null) };
}

export async function readWorkspaceProSettings(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<WorkspaceProSettings> {
  return toWorkspaceProSettings(
    workspaceId,
    await readWorkspaceSettingsRow(ctx, accountId, workspaceId),
  );
}

/**
 * ⚠ THE ONE CADENCE RESOLVER. Every consumer goes through it — the Reports grid, the Insights
 * comparison window, the chat's `sprint` chip, the sprint report, the preset prompts and the Slack
 * digest.
 *
 * It reads ONE row and answers from it. A row whose `sprint_cadence_days` is null (or < 1) is
 * treated as no row at all: that IS "this workspace has no sprint", and since plugin 0031 there is
 * nothing beneath it to fall back to.
 *
 * ⚠ A NULL PAIR AND A MISSING ROW MUST STAY EQUIVALENT. The row also holds the issue tracker, so
 * clearing a cadence NULLS the pair rather than deleting the row (see `writeWorkspaceSettings`) —
 * if those two states ever answered differently, clearing a cadence would behave differently
 * depending on whether the workspace happened to have a tracker configured.
 */
export async function resolveSprintCadence(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<SprintCadence> {
  return cadenceOf(await readWorkspaceSettingsRow(ctx, accountId, workspaceId));
}

/** This workspace's comparison-window mode. One row, one read — see `comparisonModeOf`. */
export async function resolveComparisonMode(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
): Promise<SprintComparisonMode> {
  return comparisonModeOf(await readWorkspaceSettingsRow(ctx, accountId, workspaceId));
}

// The mutable columns of `pro_workspace_settings` — everything except id/accountId/workspaceId and
// the timestamps.
interface WorkspaceMutableCols {
  sprintCadenceDays: number | null;
  sprintStartAt: Date | null;
  comparisonMode: SprintComparisonMode | null;
}

/**
 * Merge a validated patch over the existing row, returning a FULLY-SPECIFIED column set.
 *
 * ⚠ EVERY COLUMN IS SEEDED FROM `existing`, exactly like the account-level `merge()` above. A
 * column declared in `WorkspaceMutableCols` but not seeded here is NULLED by the upsert on any
 * unrelated patch — which on this row means editing the sprint cadence would silently wipe the
 * issue tracker. That is the specific hazard of folding two settings into one row, and seeding is
 * the whole mitigation.
 *
 * ⚠ AND `settings/routes.ts`'s body schema is `additionalProperties: false` with ajv
 * `removeAdditional`: a field added here but not listed there is SILENTLY STRIPPED and the PUT
 * still answers 200.
 */
export function mergeWorkspace(
  existing: WorkspaceSettingsRow | null,
  patch: WorkspaceProSettingsUpdate,
): WorkspaceMutableCols {
  const startMs = toMs(existing?.sprintStartAt ?? null);
  const out: WorkspaceMutableCols = {
    sprintCadenceDays: existing?.sprintCadenceDays ?? null,
    sprintStartAt: startMs == null ? null : new Date(startMs),
    // ⚠ SEEDED FROM `existing` like every other column — the third setting on this row as of
    // plugin 0032, and therefore the newest way an unrelated patch could NULL a neighbour.
    comparisonMode: existing?.comparisonMode ?? null,
  };

  if (patch.sprint) {
    // `cadenceDays: null` CLEARS — it NULLS THE PAIR. It does NOT delete the row, because the row
    // now also holds the tracker; a delete would take an unrelated setting with it.
    out.sprintCadenceDays =
      patch.sprint.cadenceDays == null ? null : clampInt(patch.sprint.cadenceDays, 1, 90);
    if (out.sprintCadenceDays == null) {
      // Clearing the cadence clears its phase anchor too — an anchor with no length names no
      // boundary, and leaving one behind would silently re-phase a cadence set later.
      out.sprintStartAt = null;
    } else if ('startDate' in patch.sprint) {
      // An OMITTED `startDate` keeps whatever is stored, so a cadence-only edit does not silently
      // re-phase the grid; sent as null clears the anchor.
      out.sprintStartAt = patch.sprint.startDate ? startOfDay(patch.sprint.startDate) : null;
    }
  }

  // TOP-LEVEL, not inside `patch.sprint`: that section declares `cadenceDays` REQUIRED so that
  // clearing a cadence is always an explicit ask, which would make a mode-only patch impossible to
  // express. There is no "clear" — the mode always has a value, and writing 'rolling_14' IS the
  // product default. A junk value is IGNORED (the field is left as stored) rather than written.
  if (patch.comparisonMode !== undefined && VALID_COMPARISON.includes(patch.comparisonMode))
    out.comparisonMode = patch.comparisonMode;

  return out;
}

/**
 * The ONE writer of `pro_workspace_settings`. A partial patch over ONE workspace's row.
 *
 * ⚠ IT NEVER DELETES. Its predecessor `writeWorkspaceCadence` DELETED the row to express "follow
 * the account default"; there is no account default any more, and the row now carries the issue
 * tracker as well, so a delete would destroy an unrelated setting. Clearing a cadence writes NULLs.
 * A row whose every column is null is harmless and reads identically to no row.
 */
export async function writeWorkspaceSettings(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  patch: WorkspaceProSettingsUpdate,
): Promise<WorkspaceProSettings> {
  const pro = proSchemaFor();
  const existing = await readWorkspaceSettingsRow(ctx, accountId, workspaceId);
  const cols = mergeWorkspace(existing, patch);
  const now = new Date();
  await ctx.db
    .insert(pro.proWorkspaceSettings)
    .values({ accountId, workspaceId, ...cols, updatedAt: now })
    .onConflictDoUpdate({
      // ⚠ EXACTLY the table's unique index (`pws_account_ws`). A stale target type-checks
      // perfectly and raises "no unique or exclusion constraint matching the ON CONFLICT
      // specification" at RUNTIME, in both dialects, only when a row is actually written.
      target: [pro.proWorkspaceSettings.accountId, pro.proWorkspaceSettings.workspaceId],
      set: { ...cols, updatedAt: now },
    })
    .execute();
  return readWorkspaceProSettings(ctx, accountId, workspaceId);
}

// The current sprint window (auto-rolling): [start + k·cadence, start + (k+1)·cadence) containing
// `now`, k = floor((now − start) / cadence). Returns null when sprint config is incomplete, so
// callers fall back to the host's default Insights window. Exported for the sprint + Slack features.
//
// ⚠ IT TAKES A RESOLVED `SprintCadence`, NEVER A `SettingsRow`. That signature is the enforcement:
// a caller cannot reach the account columns without going through `resolveSprintCadence`, so a
// surface can no longer be quietly account-grained by reading the row it already had in hand.
export function currentSprintWindow(
  cadence: SprintCadence,
  nowMs: number,
): { fromMs: number; toMs: number } | null {
  const { cadenceDays, startAtMs } = cadence;
  if (cadenceDays == null || cadenceDays < 1 || startAtMs == null) return null;
  const cadenceMs = cadenceDays * 86_400_000;
  const k = Math.floor((nowMs - startAtMs) / cadenceMs);
  const fromMs = startAtMs + Math.max(0, k) * cadenceMs;
  return { fromMs, toMs: fromMs + cadenceMs };
}

// The comparison window fed to getWorkspaceInsights / the workspace flow metrics, carrying the MODE
// so the metrics
// can label value/previous correctly. Always resolves to a window (never undefined):
//  - 'rolling_7' / 'rolling_14' → the trailing N days ending now (its own preceding N days are the
//    "previous" — the core elapsed-match yields exactly that since toMs === now → elapsed = full).
//  - 'sprint' → the auto-rolling sprint window (toMs in the future → the core elapsed-match compares
//    this sprint SO FAR vs the same slice of the previous sprint); falls back to rolling_14 when no
//    sprint is configured, so "disable sprints" (clear cadence+start) just leaves a rolling tracker.
//
// ⚠ THE MODE AND THE CADENCE ARE BOTH PER-WORKSPACE, AND THEY COME OFF THE SAME ROW (plugin
// migration 0032). The old split — mode on the account, cadence on the workspace — rested on the
// claim that 'rolling_7 vs rolling_14 vs sprint' is "a reading preference with no per-team
// meaning". The four lines below falsify it: under 'sprint' a workspace WITH a cadence gets a
// sprint-POSITION window and one WITHOUT silently gets a rolling FORTNIGHT, so ONE account setting
// produced two different window SHAPES across a single reader's workspaces with nothing on screen
// naming which. The two COMPOSE, so they are stored together and resolved together.
//
// ⚠ THIS FUNCTION TAKES A RESOLVED MODE, NEVER A `SettingsRow`. Same enforcement as
// `currentSprintWindow`'s `SprintCadence`: a caller cannot reach an account row from here, so the
// window can no longer quietly become account-grained.
export interface ComparisonWindow {
  fromMs: number;
  toMs: number;
  mode: SprintComparisonMode;
}

function rollingWindow(nowMs: number, days: number, mode: SprintComparisonMode): ComparisonWindow {
  return { fromMs: nowMs - days * 86_400_000, toMs: nowMs, mode };
}

export function resolveComparisonWindow(
  mode: SprintComparisonMode,
  cadence: SprintCadence,
  nowMs: number,
): ComparisonWindow {
  if (mode === 'sprint') {
    const w = currentSprintWindow(cadence, nowMs);
    if (w) return { ...w, mode: 'sprint' };
    // 'sprint' chosen but no sprint configured → graceful fallback to the rolling default.
    return rollingWindow(nowMs, 14, 'rolling_14');
  }
  return rollingWindow(nowMs, mode === 'rolling_7' ? 7 : 14, mode);
}

// Convenience for the Insights / sprint-report / Slack paths.
//
// ⚠ `workspaceId` IS REQUIRED, and that is the whole point. Every call site holds a resolved scope
// (or, on the two cron paths, the account's Default workspace id) BEFORE it needs a window, so
// there is no honest reason for this function to answer without one — and an optional parameter
// here is exactly how a surface silently goes back to reading somebody else's fortnight. As of
// plugin 0032 BOTH inputs come from that workspace's own row.
export async function getComparisonWindow(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  nowMs: number = Date.now(),
): Promise<ComparisonWindow> {
  // ONE read, both facts. It used to be two — an account row for the mode and a workspace row for
  // the cadence — and folding them onto one row (plugin 0032) makes it structurally impossible for
  // the two halves of a window to come from different grains.
  const row = await readWorkspaceSettingsRow(ctx, accountId, workspaceId);
  return resolveComparisonWindow(comparisonModeOf(row), cadenceOf(row), nowMs);
}

// ---- the Insights chat's per-QUESTION range ------------------------------------------------
//
// Everything above resolves the account's CONFIGURED window — the one the flow metrics, the sprint
// report and the Slack digest all share. The chat is different: the user picks a range per question
// from the FilterBar's Range chips, and that choice is an override that never writes back to
// settings. `range == null` means "no override", i.e. exactly the configured window, so the two
// paths agree by construction rather than by two copies of the same ternary.
export interface ChatWindow {
  fromMs: number;
  toMs: number;
  kind: InsightsRangeKey; // what was USED
  requested?: InsightsRangeKey; // set ONLY when it differs from `kind` (see below)
}

const ROLLING_DAYS: Record<Exclude<InsightsRangeKey, 'sprint' | 'period'>, number> = {
  '7d': 7,
  '14d': 14,
  '30d': 30,
  '90d': 90,
};

// The configured mode expressed in the chat's vocabulary — the default chip when no range is sent.
const MODE_AS_RANGE: Record<SprintComparisonMode, InsightsRangeKey> = {
  rolling_7: '7d',
  rolling_14: '14d',
  sprint: 'sprint',
};

export function resolveInsightsRange(
  mode: SprintComparisonMode,
  cadence: SprintCadence,
  nowMs: number,
  range: InsightsRangeKey | null | undefined,
): ChatWindow {
  const asked: InsightsRangeKey = range ?? MODE_AS_RANGE[mode];
  // 'period' is BOUNDS-CARRIED: it only means anything alongside the explicit `{fromMs, toMs}`
  // the chat route resolves BEFORE this function is ever consulted (chatWindowFor in
  // insights/chat.ts). A bare `range: 'period'` — a raw API call, or bounds that failed
  // validation — names no window at all, so it cannot be honoured: fall back to the account's
  // configured window and carry the ask, exactly like the unconfigured-'sprint' case below.
  if (asked === 'period') {
    const w = resolveInsightsRange(mode, cadence, nowMs, null);
    return { ...w, requested: 'period' };
  }
  if (asked === 'sprint') {
    const w = currentSprintWindow(cadence, nowMs);
    // 'sprint' with no cadence+start configured. The SPA only offers the chip when both are
    // stored, so this is reachable via a direct API call or a settings change mid-session — but it
    // must still answer, and it must not caption a rolling fortnight "Sprint to date". Report what
    // was actually used and carry the ask alongside it.
    if (!w) return { fromMs: nowMs - 14 * 86_400_000, toMs: nowMs, kind: '14d', requested: 'sprint' };
    return { ...w, kind: 'sprint' };
  }
  return { fromMs: nowMs - ROLLING_DAYS[asked] * 86_400_000, toMs: nowMs, kind: asked };
}

// ⚠ `workspaceId` IS REQUIRED here for the same reason as `getComparisonWindow`: the 'sprint' chip
// answers about THIS workspace's sprint, and the chat route already holds the resolved scope.
export async function getInsightsRangeWindow(
  ctx: ProContext,
  accountId: number,
  workspaceId: number,
  range: InsightsRangeKey | null | undefined,
  nowMs: number = Date.now(),
): Promise<ChatWindow> {
  // ONE read, both facts — see `getComparisonWindow`. The chat's default chip and the configured
  // window are the same resolution by construction, which is the property `insights-range.test.ts`
  // pins.
  const row = await readWorkspaceSettingsRow(ctx, accountId, workspaceId);
  return resolveInsightsRange(comparisonModeOf(row), cadenceOf(row), nowMs, range);
}
