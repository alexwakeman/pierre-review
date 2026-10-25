// THE CLAUDE SPEND BUDGET — the ONE decision and the ONE gate (packages/shared ai-budget.ts holds
// the types, the defaults, the subscription rule and the estimate table).
//
//   decideAiBudget(input)          PURE. Settings + credential route + the latest usage reading +
//                                  Limn's own recorded spend (ai_usage) + its typical cycle cost →
//                                  AiBudgetStatus.
//   aiBudgetStatus(accountId)      gathers those inputs (and, when useful, runs the cached usage
//                                  probe) and calls decideAiBudget. Never throws.
//   allowAutomaticRun(accountId)   THE GATE. Every AUTOMATIC model run asks it first (auto review and
//                                  its thread checks, auto fix, the CI and ticket review sweepers,
//                                  the post-review diagrams, the sprint after-read chain, the Slack
//                                  digest's sprint summary). Over budget ⇒ the run is SKIPPED, not
//                                  queued: the sweepers re-derive what is due every tick, so it
//                                  becomes due again by itself once the week resets.
//                                  Logged once per pause, never per tick.
//
// A run the READER starts is never refused here — the SPA reads GET /api/ai/budget and asks for a
// second press.
//
// SUBSCRIPTION: Limn's SHARE of the week = its own ai_usage spend in the current week ÷ the
// subscription's estimated weekly allowance (SUBSCRIPTION_ESTIMATES); likewise of the 5-hour session
// (the setting follows the weekly share unless the reader set its own). Over when EITHER share reaches
// its setting. Each window is [reset − length, reset) when Claude's reset has been read and is still
// ahead, otherwise rolling. The pure rules live in packages/shared (`decideAiBudget`, `aiUsageView`)
// so the static demo runs the same ones; the status carries percentages only.
//
// THE USAGE READING (login route only) gives the subscription type, the reset times and the header's
// account-wide figures — it never blocks. Two sources fold into ONE latest reading, kept in memory and
// persisted on `accounts.ai_budget_reading` so a restart keeps it:
//   • every agent run's `rate_limit_event` (ai/runtime.ts taps every Query): the 5-hour, weekly and
//     per-model weekly windows' resets and utilisation — a 0–1 FRACTION on this path (the CLI's
//     header parsing), converted to 0–100 HERE, explicitly;
//   • a cheap probe through the Agent SDK's EXPERIMENTAL usage method (login route, at most every
//     PROBE_MIN_INTERVAL_MS, a 20s timeout, in the BACKGROUND — a request never waits for it): the
//     subscription type and every window, utilisation ALREADY 0–100 (measured on a real login) and
//     kept as-is. A failure keeps the last reading.
// There is no shared "≤ 1 means a fraction" guess: each path knows its own scale. Any throw or shape
// mismatch is "no reading" — the windows are then rolling and the subscription is the reader's pick.
//
// CODEX (docs/CODEX-PLAN.md § 8.1): the budget judges the ACTIVE provider. On a ChatGPT sign-in the
// reading is the app-server's `account/rateLimits/read` (ai/codex/app-server.ts — in memory, probed in
// the background at most every 5 minutes), and Limn's share of each window is TOKEN-WEIGHTED: its own
// codex ai_usage tokens ÷ the account's tokens in that window (`account/usage/read`) × the window's
// whole-percent usedPercent. Same gate, same settings, percentages only. An API key is weekly US$.
//
// One budget per ACCOUNT (= per machine), never per workspace.
import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  AI_BUDGET_DAY_MS,
  AI_BUDGET_WEEK_MS,
  aiUsageView,
  budgetWindowStart,
  decideAiBudget,
  type AiAccountTokens,
  type AiAccountTokenSpan,
  liveFiveHourReset,
  liveWeekReset,
  resolveAiBudgetSettings,
  rollingSpend,
  type AiBudgetSettings,
  type AiBudgetStatus,
  type AiCycleCostInput,
  type AiLedgerRow,
  type AiUsageReading,
  type AiUsageView,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { getActiveProvider, getProvider, type AgentProvider, type AgentProviderId } from './provider.js';
import {
  foldRateLimitEvent,
  mergeReadings,
  normaliseStoredReading,
  parseUsageProbe,
} from './providers/claude-usage.js';
import { setAgentMessageObserver } from './runtime.js';
import { codexAccountTokens, codexRateLimitsCached, kickCodexProbe } from './codex/app-server.js';

export const DAY_MS = AI_BUDGET_DAY_MS;
export const WEEK_MS = AI_BUDGET_WEEK_MS;
/** The window "typical cycle cost" is averaged over. */
export const CYCLE_COST_WINDOW_MS = 28 * DAY_MS;
/** The usage probe runs at most this often (the header polls every ~2 minutes while visible). */
export const PROBE_MIN_INTERVAL_MS = 5 * 60 * 1000;

// ---- the pure decision (packages/shared ai-budget.ts, so the static demo runs the same rules) ----

/** Re-exported under the names this module always had. */
export type LedgerRow = AiLedgerRow;
export type CycleCostInput = AiCycleCostInput;
export { decideAiBudget, rollingSpend, liveWeekReset, liveFiveHourReset, aiUsageView };
// Claude's reading folds live in ai/providers/claude-usage.ts since the provider seam; re-exported
// here under the names this module always had.
export { foldRateLimitEvent, mergeReadings, normaliseStoredReading, parseUsageProbe };

// ---- the reading: ONE normalised AiUsageReading per provider (docs/CODEX-PLAN.md § 8.1) ----------
//
// Claude's is kept in memory and persisted on `accounts.ai_budget_reading`, so a restart keeps it.
// No other provider has a reading yet (Phase 2 gives Codex its own): `readingFor` answers null for it.

let memReading: AiUsageReading | null | undefined; // Claude's; undefined = not loaded yet

async function loadReading(): Promise<AiUsageReading | null> {
  if (memReading !== undefined) return memReading;
  try {
    const rows = await db
      .select({ r: schema.accounts.aiBudgetReading })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, LOCAL_ACCOUNT_ID))
      .limit(1)
      .execute();
    memReading = normaliseStoredReading(rows[0]?.r);
  } catch {
    memReading = null;
  }
  return memReading;
}

/**
 * The provider's latest normalised reading. Codex's is the app-server probe's CACHE
 * (ai/codex/app-server.ts) — in memory only: the probe refreshes it in the background within seconds
 * of a restart, and until then the reading is unknown, which never blocks.
 */
async function readingFor(provider: AgentProvider): Promise<AiUsageReading | null> {
  if (provider.id === 'codex') return codexRateLimitsCached();
  return loadReading();
}

/** Codex on a ChatGPT sign-in: the account's tokens in each budget window (from the probe's cache). */
async function codexAccountTokensFor(reading: AiUsageReading | null, nowMs: number): Promise<AiAccountTokens> {
  const span = async (which: 'week' | 'five_hour'): Promise<AiAccountTokenSpan | null> =>
    codexAccountTokens({ fromMs: budgetWindowStart(reading, nowMs, which).fromMs, toMs: nowMs });
  const [week, fiveHour] = await Promise.all([span('week'), span('five_hour')]);
  return { week, fiveHour };
}

function storeReading(next: AiUsageReading): void {
  memReading = mergeReadings(memReading ?? null, next);
  const value = memReading;
  void db
    .update(schema.accounts)
    .set({ aiBudgetReading: value })
    .where(eq(schema.accounts.id, LOCAL_ACCOUNT_ID))
    .execute()
    .catch(() => {
      /* in memory still; the next reading tries again */
    });
}

/** The observer ai/runtime.ts calls with every agent message (the Agent SDK's, so Claude's). */
export function noteAgentMessage(message: unknown, nowMs: number = Date.now()): void {
  const next = getProvider('claude').usage.readingFromMessage(message, nowMs);
  if (next == null) return;
  // ⚠ Merge over the PERSISTED reading, never over "not loaded yet": a run's event arriving before
  // the boot load finished would otherwise overwrite the stored subscription type and the other
  // windows (storeReading merges `next` over what is in memory).
  if (memReading === undefined) {
    void loadReading().then(() => storeReading(next));
    return;
  }
  storeReading(next);
}

/** Install the observer. Called once at boot when AI is on. */
export function installAiBudgetObserver(): void {
  void loadReading();
  setAgentMessageObserver((m) => noteAgentMessage(m));
}

// ---- the usage probe ----------------------------------------------------------------------------
//
// The probe itself is the provider's (`provider.usage.probe`; Claude's is the Agent SDK's
// experimental usage method, in ai/providers/claude.ts). Only Claude's reading is stored.

let lastProbeAtMs = 0;
let probeInFlight: Promise<void> | null = null;

export type UsageProbe = () => Promise<unknown>;

let probeOverride: UsageProbe | null = null;
/** Test hook. */
export function _setUsageProbeForTest(p: UsageProbe | null): void {
  probeOverride = p;
  lastProbeAtMs = 0;
  probeInFlight = null;
}
/** Test hook. */
export function _resetAiBudgetForTest(): void {
  memReading = undefined;
  lastProbeAtMs = 0;
  probeInFlight = null;
  pausedAccounts.clear();
}

/** Start the probe IN THE BACKGROUND when it can help: login route (the caller checks), runtime
 *  ready, not run in the last PROBE_MIN_INTERVAL_MS. Single-flight. Never throws, never awaited by a
 *  request: the caller serves the cached reading. Returns the in-flight promise for tests. */
export function kickUsageProbe(nowMs: number = Date.now(), provider: AgentProvider = getActiveProvider()): Promise<void> | null {
  // Codex's probe is the app-server's own (account, windows and token counts in one process), with
  // the same 5-minute floor and single flight.
  if (provider.id === 'codex') return provider.usage.probeReady() ? kickCodexProbe({ nowMs }) : null;
  if (provider.id !== 'claude') return null;
  if (probeInFlight) return probeInFlight;
  if (nowMs - lastProbeAtMs < PROBE_MIN_INTERVAL_MS) return null;
  if (probeOverride == null && !provider.usage.probeReady()) return null;
  lastProbeAtMs = nowMs;
  const probe = probeOverride ?? (() => provider.usage.probe());
  probeInFlight = (async () => {
    try {
      await loadReading();
      const parsed = provider.usage.readingFromProbe(await probe(), Date.now());
      if (parsed) storeReading(parsed);
    } catch {
      /* no reading — the last one stays */
    } finally {
      probeInFlight = null;
    }
  })();
  return probeInFlight;
}

// ---- settings -----------------------------------------------------------------------------------

export async function readAiBudgetSettings(
  accountId: number,
): Promise<{ settings: AiBudgetSettings; isDefault: boolean }> {
  const rows = await db
    .select({ s: schema.accounts.aiBudgetSettings })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1)
    .execute();
  const raw = (rows[0]?.s as Partial<AiBudgetSettings> | null | undefined) ?? null;
  return { settings: resolveAiBudgetSettings(raw), isDefault: raw == null };
}

/** Merge a VALIDATED body over the stored settings and store the whole resolved object. */
export async function writeAiBudgetSettings(
  accountId: number,
  body: Partial<AiBudgetSettings>,
): Promise<AiBudgetSettings> {
  const { settings: current } = await readAiBudgetSettings(accountId);
  const next = resolveAiBudgetSettings({ ...current, ...body });
  await db
    .update(schema.accounts)
    .set({ aiBudgetSettings: next })
    .where(eq(schema.accounts.id, accountId))
    .execute();
  return next;
}

// ---- the status and the gate ----------------------------------------------------------------------

/** Limn's recorded spend since `sinceMs` — ONE provider's rows only (a budget is per provider). */
async function readLedger(accountId: number, sinceMs: number, providerId: AgentProviderId): Promise<LedgerRow[]> {
  const { aiUsage } = schema;
  const rows = await db
    .select({ at: aiUsage.occurredAt, usd: aiUsage.costUsd, inTok: aiUsage.inputTokens, outTok: aiUsage.outputTokens })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.accountId, accountId),
        eq(aiUsage.provider, providerId),
        gte(aiUsage.occurredAt, new Date(sinceMs)),
      ),
    )
    .execute();
  return rows.map((r) => ({
    atMs: (r.at as Date).getTime(),
    usd: Number(r.usd) || 0,
    inputTokens: r.inTok ?? null,
    outputTokens: r.outTok ?? null,
  }));
}

/** The account's typical automatic-review cycle: the mean recorded cost of a Claude review and of a
 *  diagram run over the last 28 days, and whether any of its workspaces draws diagrams by itself. */
export async function readCycleCosts(
  accountId: number,
  nowMs: number,
  providerId: AgentProviderId = 'claude',
): Promise<CycleCostInput> {
  const { aiUsage, workspaces } = schema;
  const [rows, ws] = await Promise.all([
    db
      .select({ feature: aiUsage.feature, usd: aiUsage.costUsd })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.accountId, accountId),
          eq(aiUsage.provider, providerId),
          inArray(aiUsage.feature, ['claude_review', 'sequence_diagram']),
          gte(aiUsage.occurredAt, new Date(nowMs - CYCLE_COST_WINDOW_MS)),
        ),
      )
      .execute(),
    db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.accountId, accountId), eq(workspaces.autoDiagramsEnabled, true)))
      .limit(1)
      .execute(),
  ]);
  const mean = (feature: string): number | null => {
    const xs = rows.filter((r) => r.feature === feature).map((r) => Number(r.usd)).filter((n) => Number.isFinite(n));
    return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  return { reviewMeanUsd: mean('claude_review'), diagramMeanUsd: mean('sequence_diagram'), autoDiagrams: ws.length > 0 };
}

const NO_CYCLE_COSTS: CycleCostInput = { reviewMeanUsd: null, diagramMeanUsd: null, autoDiagrams: false };

export interface AiBudgetStatusOptions {
  /**
   * Start the usage probe in the background (never awaited): 'always' = on the login route whatever
   * the budget (GET /api/ai/budget — the header shows Claude's own figures even with the budget
   * off); 'when_on' = only while the budget is on (the gate; the default); false = never.
   */
  probe?: 'always' | 'when_on' | false;
  nowMs?: number;
}

const OFF_STATUS = (route: AiBudgetStatus['route']): AiBudgetStatus => ({
  enabled: false,
  mode: 'off',
  route,
  subscription: null,
  apiKey: null,
  overBudget: false,
  limitedBy: null,
  reason: null,
  resumesAt: null,
});

/** Local midnight on this machine (the server IS the reader's machine), for "today". */
function localMidnightMs(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface AiBudgetSnapshot {
  settings: AiBudgetSettings;
  isDefault: boolean;
  status: AiBudgetStatus;
  usage: AiUsageView;
}

/**
 * Everything GET /api/ai/budget returns, from ONE set of reads: the settings, the decision and the
 * header's usage view. Serves the CACHED reading; the probe (when asked) refreshes it in the
 * background for the next call.
 */
export async function aiBudgetSnapshot(accountId: number, opts: AiBudgetStatusOptions = {}): Promise<AiBudgetSnapshot> {
  const nowMs = opts.nowMs ?? Date.now();
  // THE ACTIVE PROVIDER's budget (docs/CODEX-PLAN.md § 8.1): its credential route, its reading,
  // its rows of the ledger. Only Claude in Phase 1.
  const provider = getActiveProvider();
  const route = provider.credentialRoute();
  const { settings, isDefault } = await readAiBudgetSettings(accountId);
  const probe = opts.probe ?? 'when_on';
  if (route === 'login' && (probe === 'always' || (probe === 'when_on' && settings.enabled))) kickUsageProbe(nowMs, provider);
  const isCodex = provider.id === 'codex';
  const [reading, ledger, costs] = await Promise.all([
    route === 'login' ? readingFor(provider) : Promise.resolve(null),
    readLedger(accountId, Math.min(nowMs - WEEK_MS, localMidnightMs(nowMs)), provider.id),
    settings.enabled && route === 'login' && !isCodex
      ? readCycleCosts(accountId, nowMs, provider.id)
      : Promise.resolve(NO_CYCLE_COSTS),
  ]);
  // Codex's share is TOKEN-WEIGHTED (packages/shared ai-budget.ts): the account's tokens over the
  // SAME windows the fold counts Limn's in.
  const accountTokens = isCodex && route === 'login' ? await codexAccountTokensFor(reading, nowMs) : null;
  const providerId = provider.id;
  return {
    settings,
    isDefault,
    status: decideAiBudget({ settings, route, reading, ledger, costs, nowMs, provider: providerId, accountTokens }),
    usage: aiUsageView({
      settings,
      route,
      reading,
      ledger,
      nowMs,
      todayFromMs: localMidnightMs(nowMs),
      provider: providerId,
      accountTokens,
    }),
  };
}

/** The budget's status for an account. Never throws: a failed read is "off" (never blocks). */
export async function aiBudgetStatus(accountId: number, opts: AiBudgetStatusOptions = {}): Promise<AiBudgetStatus> {
  try {
    return (await aiBudgetSnapshot(accountId, opts)).status;
  } catch {
    return OFF_STATUS(getActiveProvider().credentialRoute());
  }
}

// account → when its current pause was first logged (log once per pause).
const pausedAccounts = new Map<number, number>();

export interface AiBudgetLog {
  info(msg: string): void;
}

/**
 * THE GATE before every AUTOMATIC model run. True ⇒ go. False ⇒ skip this run (do not queue it);
 * the caller's next tick asks again. `what` names the run for the one log line.
 */
export async function allowAutomaticRun(
  accountId: number,
  what: string,
  log?: AiBudgetLog,
  statusOf: (accountId: number) => Promise<AiBudgetStatus> = (a) => aiBudgetStatus(a),
): Promise<boolean> {
  const status = await statusOf(accountId);
  if (!status.overBudget) {
    if (pausedAccounts.delete(accountId)) log?.info('claude budget: back under the limit, automatic runs resume');
    return true;
  }
  if (!pausedAccounts.has(accountId)) {
    pausedAccounts.set(accountId, Date.now());
    log?.info(
      `claude budget: automatic runs paused (${what} skipped)${status.resumesAt ? `; resumes about ${status.resumesAt}` : ''}`,
    );
  }
  return false;
}

/** The seam AgentContext and ProContext carry. */
export interface AiBudgetGate {
  allowAutomaticRun(accountId: number, what: string): Promise<boolean>;
}

export function buildAiBudgetGate(log?: AiBudgetLog): AiBudgetGate {
  return { allowAutomaticRun: (accountId, what) => allowAutomaticRun(accountId, what, log) };
}
