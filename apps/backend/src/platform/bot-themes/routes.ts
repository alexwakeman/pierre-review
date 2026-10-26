import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { BotThemesResponse, BotThemesResult, BotWindowKind } from '@pierre-review/shared';
import type { BotScopeWire, ProContext } from '../contract.js';
import type { LlmClient } from '../llm/seam.js';
import { proSchemaFor } from '../db.js';
import { scopeKeyFor } from '../insights/workspace-scope.js';
import { resolveRequestScope } from '../insights/workspace-request.js';
import { DIGEST_MODEL } from '../llm/gate.js';
import { buildBotThemes } from './build.js';
import { runThemesLlm } from './prompt.js';
import { resolveThemeRefs } from '../themes/resolve.js';

// The Bots "What they're flagging" AI summary routes (Pro, Haiku) — the REVIVED Bot Themes panel,
// merged with the deterministic layer: build.ts computes every figure (per-bot volume + acted-on %,
// area split, per-theme comment counts), the model contributes only the themes + narrative (D4).
// It replaces the SynthesisCard mount on the main Bots view; the synthesis seam and its three
// drill-down cards are UNTOUCHED. STRICTLY a Pro feature — it self-gates on the AI-summary tier
// (DIGEST_ENABLED / the activityDigest capability), so a pure-OSS or flag-less run returns
// enabled:false and the SPA hides the panel; cloud per-account entitlement rides the automatic
// /api/pro/* 402 gate (staying under /api/pro/ is what keeps that automatic). Windowed like the
// ROI panel via `window`. Cost-safe on the SYNTHESIS shape (the legacy code predates it): the GET
// is a pure cache read; generation only on POST refresh, behind the per-account in-flight claim +
// min interval, the credit gate, and the $0-on-unchanged payload-hash cache in bot_theme_reports.
//
// RATE TIERS (pinned in core's rate-limit.test.ts): the POST lands on the /api/pro/ catch-all's
// `ai` pair; the GET stays on its plain `read` branch. DELIBERATE DEVIATION from the synthesis
// GET: no `stale` probe — probing would re-run the whole getBotReviewComments fold per open of
// the Bots tab, the exact cost that puts the synthesis GET on `search`. Freshness here is the
// manual Regenerate, free when the corpus is unchanged.
//
// SCOPE RESOLUTION, ONE RULE, TWO ROUTES: `resolveRequestScope(?workspace=)` — absent,
// unparseable, unknown or ANOTHER TENANT'S id all resolve to the account's DEFAULT workspace,
// never a 404 (host §5.1). Letting a foreign id through instead of defaulting would be wrong
// twice over: it would render an empty "nothing to summarise" in place of the Default workspace's
// real report, and the id would travel into `BotScopeWire.workspaceId`, where the host resolves
// the bot judgement — a workspace with no `workspace_reviewers` rows makes every automated
// reviewer read as a human, i.e. an empty corpus dressed up as an answer. `?repoIds=` survives as
// DATA NARROWING ONLY (the per-repo Bots console tab), intersected with the resolved membership
// exactly as behaviour-routes does — the raw query list never reaches the seam.

// rolling_90 joined the vocabulary at apiVersion 18 (after the legacy set was written);
// botAnalyticsWindow can hold it today, and silently degrading it to rolling_14 would cache the
// wrong population under the right client key.
const VALID_WINDOWS = new Set<string>([
  'rolling_7',
  'rolling_14',
  'rolling_30',
  'rolling_90',
  'sprint',
]);
function parseWindow(raw: string | undefined): BotWindowKind {
  return raw != null && VALID_WINDOWS.has(raw) ? (raw as BotWindowKind) : 'rolling_14';
}

// Comma-separated positive-int list → number[] | null (null = "no narrowing"). Mirrors
// behaviour-routes / core parseIntList — its result is NEVER a scope, only the narrow set.
// TOTAL over the wire: the refresh POST reads this off an UNVALIDATED JSON body, where the natural
// spelling is a real array (`{"repoIds":[3,1]}`), and a repeated `?repoIds=` query param reaches
// the handler as string[] — neither may 500. Any other shape reads as "no narrowing", the same
// answer an unparseable CSV already gets.
function parseIntList(raw?: unknown): number[] | null {
  const csv = Array.isArray(raw) ? raw.join(',') : typeof raw === 'string' ? raw : '';
  if (csv.trim() === '') return null;
  const ids = csv
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : null;
}

// Min interval between BILLED generations per account — armed only when the model actually ran
// (a $0 payload-hash hit must never lock the account out), checked before claiming the slot.
// The legacy `lastRefreshAt` map (written, never read) is gone with the rest of that shape.
const MIN_INTERVAL_SEC = 15;

// Per-account serialisation + throttle state (the synthesis inFlightAccounts shape — module-level,
// ACCOUNT-keyed: the legacy account:workspace:window grain would let one account fan out N
// parallel Haiku calls by opening N scope/window combinations).
const inFlightAccounts = new Set<number>();
const lastBilledAtByAccount = new Map<number, number>();

/**
 * THE scope key — the `bot_theme_reports` row's identity under UNIQUE
 * (account_id, scope_key, window_kind); `window_kind` stays its own column, so per-repo and
 * cross-repo reports coexist as separate rows. `ws:<id>` when unnarrowed — byte-identical to the
 * legacy vocabulary, so the isolation-test seeds and the migration-0020 commentary stay true —
 * plus an `|r:<sorted deduped csv>` suffix ONLY when a narrowing is present (the synthesisScopeKey
 * serialisation). Keyed on the narrowing AS GIVEN, not the membership intersection: keying on the
 * intersection would re-mint the row whenever workspace membership drifts, and correctness never
 * rests on the key alone — the payload hash folds the actual cluster set.
 */
export function themesScopeKey(workspaceId: number, narrow: number[] | null): string {
  const base = scopeKeyFor(workspaceId);
  return narrow == null
    ? base
    : `${base}|r:${[...new Set(narrow)].sort((a, b) => a - b).join(',')}`;
}

/**
 * Per-theme deterministic comment count (D4): Σ of each cited cluster's code-computed `count`
 * over the theme's DEDUPLICATED memberIds. A model id outside the payload contributes 0 — the
 * synthesis "ids ⊆ input" validation posture: the model picks WHICH clusters, code says how many
 * comments they stand for. Exported for the unit test.
 */
export function themeCommentCount(memberIds: number[], countIndex: Map<number, number>): number {
  let sum = 0;
  for (const id of new Set(memberIds)) sum += countIndex.get(id) ?? 0;
  return sum;
}

interface ResolvedThemesScope {
  scope: BotScopeWire;
  scopeKey: string;
}

// Wire params → the narrowed scope + its canonical key. membership ∩ narrow preserves the
// `repoIds ⊆ membership` BotScopeWire invariant (behaviour-routes / resolveSynthesisScope —
// byte-for-byte their pattern); the KEY carries the raw narrowing, per themesScopeKey above.
// Params are `unknown`, not the Wire strings: both arrive off the refresh POST's unvalidated JSON
// body (and repeated query params arrive as arrays), so a non-string workspace must DEFAULT
// (host §5.1 — same as absent/unparseable) rather than throw in parseWorkspaceId.
async function resolveThemesScope(
  ctx: ProContext,
  accountId: number,
  workspaceRaw: unknown,
  repoIdsRaw: unknown,
): Promise<ResolvedThemesScope> {
  const resolved = await resolveRequestScope(
    ctx,
    accountId,
    typeof workspaceRaw === 'string' || typeof workspaceRaw === 'number' ? workspaceRaw : undefined,
  );
  const narrow = parseIntList(repoIdsRaw);
  const scope: BotScopeWire =
    narrow == null
      ? resolved
      : {
          workspaceId: resolved.workspaceId,
          repoIds: resolved.repoIds.filter((id) => narrow.includes(id)),
        };
  return { scope, scopeKey: themesScopeKey(resolved.workspaceId, narrow) };
}

/** Pure cache read (no rebuild, no billing) — the stored result JSON parsed back. EXPORTED for
 *  the isolation test (the accountId predicate is what it pins — the loadSynthesis precedent). */
export async function loadReport(
  ctx: ProContext,
  accountId: number,
  scopeKey: string,
  window: BotWindowKind,
): Promise<BotThemesResult | null> {
  const pro = proSchemaFor();
  const rows = (await ctx.db
    .select({ resultJson: pro.botThemeReports.resultJson })
    .from(pro.botThemeReports)
    .where(
      and(
        eq(pro.botThemeReports.accountId, accountId),
        eq(pro.botThemeReports.scopeKey, scopeKey),
        eq(pro.botThemeReports.windowKind, window),
      ),
    )
    .execute()) as Array<{ resultJson: string }>;
  const row = rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.resultJson) as BotThemesResult;
  } catch {
    return null; // a corrupt cache row reads as "no report yet", never as an error
  }
}

interface GenerateOutcome {
  result: BotThemesResult | null;
  empty: boolean;
}

// Generate + persist (the ONE billing path). Returns { empty:true } when the scope/window has no
// bot comments; returns the cached result unbilled when the payload hash is unchanged.
async function generateReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  scope: BotScopeWire,
  scopeKey: string,
  window: BotWindowKind,
): Promise<GenerateOutcome> {
  const build = await buildBotThemes(ctx, accountId, scope, window, scopeKey);
  if (build == null || build.empty) return { result: null, empty: true };

  const pro = proSchemaFor();
  // $0-on-unchanged: a stored report whose payload hash matches → return it unbilled.
  const existing = (await ctx.db
    .select({
      payloadHash: pro.botThemeReports.payloadHash,
      resultJson: pro.botThemeReports.resultJson,
    })
    .from(pro.botThemeReports)
    .where(
      and(
        eq(pro.botThemeReports.accountId, accountId),
        eq(pro.botThemeReports.scopeKey, scopeKey),
        eq(pro.botThemeReports.windowKind, window),
      ),
    )
    .execute()) as Array<{ payloadHash: string; resultJson: string }>;
  const prev = existing[0];
  if (prev && prev.payloadHash === build.hash) {
    try {
      return { result: JSON.parse(prev.resultJson) as BotThemesResult, empty: false };
    } catch {
      /* fall through to regenerate on a corrupt cache row */
    }
  }

  const { parsed, costUsd, inputTokens, outputTokens, provider, model } = await runThemesLlm(llm, build);
  // The spend happened the moment the model answered — arm the min interval off that fact (never
  // off a cache hit above) and record it before anything else can fail. parseThemes is total, so
  // there is no throw path between the model call and here; the ledger write stays best-effort.
  lastBilledAtByAccount.set(accountId, Date.now());
  await ctx
    .recordAiUsage({
      accountId,
      seam: 'summary',
      feature: 'bot_themes',
      model: model ?? DIGEST_MODEL,
      provider,
      costUsd,
      inputTokens,
      outputTokens,
    })
    .catch(() => {});

  // Expand each theme's model-picked memberIds into concrete threads + clickable PR refs, then
  // zip in the deterministic per-theme comment count — resolveThemeRefs preserves theme order
  // (a .map), so the zip is by index. The model's `occurrences` stays on the wire as the
  // approximate fallback (stored pre-count rows, the human sibling).
  const resolved = await resolveThemeRefs(ctx, accountId, parsed.themes, build.memberIndex);
  const themes = resolved.map((t, i) => ({
    ...t,
    commentCount: themeCommentCount(parsed.themes[i]?.memberIds ?? [], build.countIndex),
  }));
  const now = new Date();
  // What answered (Phase 4): the stored row names the model that RAN and its provider.
  const ranModel = model ?? DIGEST_MODEL;
  const ranProvider = provider ?? 'claude';
  const result: BotThemesResult = {
    narrative: parsed.narrative,
    themes,
    bots: build.bots,
    byCategory: parsed.byCategory,
    bySeverity: parsed.bySeverity,
    byArea: build.byArea,
    coverage: build.coverage,
    generatedAt: now.toISOString(),
    model: ranModel,
  };
  const resultJson = JSON.stringify(result);

  await ctx.runTransaction(async (tx) => {
    await tx
      .insert(pro.botThemeReports)
      .values({
        accountId,
        scopeKey,
        windowKind: window,
        payloadHash: build.hash,
        resultJson,
        model: ranModel,
        provider: ranProvider,
        costUsd,
        inputTokens,
        outputTokens,
        generatedAt: now,
      })
      // ⚠ Target = the declared unique [accountId, scopeKey, windowKind]
      // (btr_account_scope_window, migration 0014). A stale target here type-checks and then
      // raises at the first real write — the 0042/0045 lesson.
      .onConflictDoUpdate({
        target: [
          pro.botThemeReports.accountId,
          pro.botThemeReports.scopeKey,
          pro.botThemeReports.windowKind,
        ],
        set: {
          payloadHash: build.hash,
          resultJson,
          model: ranModel,
          provider: ranProvider,
          costUsd,
          inputTokens,
          outputTokens,
          generatedAt: now,
        },
      })
      .execute();
  });

  return { result, empty: false };
}

// The serialised, throttled, credit-gated refresh — the single billing entry.
async function refreshReport(
  ctx: ProContext,
  llm: LlmClient,
  accountId: number,
  scope: BotScopeWire,
  scopeKey: string,
  window: BotWindowKind,
): Promise<BotThemesResponse> {
  const cached = async (flag: 'throttled' | 'creditsExhausted'): Promise<BotThemesResponse> => {
    const base: BotThemesResponse = {
      enabled: true,
      result: await loadReport(ctx, accountId, scopeKey, window),
    };
    if (flag === 'throttled') base.throttled = true;
    else base.creditsExhausted = true;
    return base;
  };

  // Serialisation: one generation per account at a time (a no-op click reads as `throttled`).
  // The slot is claimed SYNCHRONOUSLY here — no await may sit between the has() and the add(),
  // or two concurrent POSTs both pass the check, both miss the not-yet-written hash cache, and
  // both bill (the legacy code awaited the credit check in exactly that gap). The credit check
  // therefore runs INSIDE the try/finally: a blocked call holds the guard only for the duration
  // of that one lookup, and the finally releases it on every path.
  if (inFlightAccounts.has(accountId)) return cached('throttled');
  // Min interval between BILLED generations — armed only when money actually moved (in
  // generateReport, right after the model answered).
  const last = lastBilledAtByAccount.get(accountId) ?? 0;
  if (Date.now() - last < MIN_INTERVAL_SEC * 1000) return cached('throttled');
  inFlightAccounts.add(accountId);
  try {
    // NB: no auth pre-check here — a missing credential surfaces as the mutation error, exactly
    // like the sprint report (the SPA swaps the button first, via AiRunGate).
    const { result, empty } = await generateReport(ctx, llm, accountId, scope, scopeKey, window);
    // A gone-quiet scope/window touches NOTHING server-side (the stored row survives), so answer
    // with the stored report — the cached(...) shape. Returning `result:null` here had the client
    // setQueryData a "No summary yet" box over the report it was showing, which the next GET
    // refetch then resurrected: a flicker whose CTA invited repeating the same no-op.
    return {
      enabled: true,
      result: empty ? await loadReport(ctx, accountId, scopeKey, window) : result,
      empty: empty || undefined,
    };
  } finally {
    inFlightAccounts.delete(accountId);
  }
}

export function registerBotThemesRoutes(
  app: FastifyInstance,
  ctx: ProContext,
  llm: LlmClient,
): void {
  const disabled = (): BotThemesResponse => ({ enabled: false, result: null });

  type Wire = { workspace?: string; window?: string; repoIds?: string };

  // Cached report (free — one indexed row, no rebuild, no billing, and DELIBERATELY no stale
  // probe; see the module comment). `workspace` (<id>; absent → Default), `window`
  // (rolling_7/14/30/90 | sprint), `repoIds` (CSV narrowing).
  app.get<{ Querystring: Wire }>('/api/pro/bot-themes', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const { scopeKey } = await resolveThemesScope(
      ctx,
      accountId,
      req.query.workspace,
      req.query.repoIds,
    );
    const window = parseWindow(req.query.window);
    const resp: BotThemesResponse = {
      enabled: true,
      result: await loadReport(ctx, accountId, scopeKey, window),
    };
    return reply.send(resp);
  });

  // Generate (the only billing path). Params ride the query string OR the body.
  app.post<{ Querystring: Wire; Body?: Wire }>('/api/pro/bot-themes/refresh', async (req, reply) => {
    const accountId = ctx.accountIdOf(req);
    const { scope, scopeKey } = await resolveThemesScope(
      ctx,
      accountId,
      req.query.workspace ?? req.body?.workspace,
      req.query.repoIds ?? req.body?.repoIds,
    );
    const window = parseWindow(req.query.window ?? req.body?.window);
    return reply.send(await refreshReport(ctx, llm, accountId, scope, scopeKey, window));
  });
}
