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
// One budget per ACCOUNT (= per machine), never per workspace.
import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  AI_BUDGET_DAY_MS,
  AI_BUDGET_WEEK_MS,
  aiUsageView,
  decideAiBudget,
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
  type AiUsageWindowReading,
} from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { LOCAL_ACCOUNT_ID } from '../auth/account.js';
import { resolveAiCredential, agentAuthOptions } from './credentials.js';
import { ISOLATED_MCP } from './agent-isolation.js';
import {
  claudeExecutableOptions,
  getAiRuntimeStatus,
  loadAgentSdk,
  setAgentMessageObserver,
} from './runtime.js';

export const DAY_MS = AI_BUDGET_DAY_MS;
export const WEEK_MS = AI_BUDGET_WEEK_MS;
/** The window "typical cycle cost" is averaged over. */
export const CYCLE_COST_WINDOW_MS = 28 * DAY_MS;
/** The usage probe runs at most this often (the header polls every ~2 minutes while visible). */
export const PROBE_MIN_INTERVAL_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
/** At most this many per-model windows are kept from one reading. */
const MAX_MODEL_WINDOWS = 8;

// ---- the pure decision (packages/shared ai-budget.ts, so the static demo runs the same rules) ----

/** Re-exported under the names this module always had. */
export type LedgerRow = AiLedgerRow;
export type CycleCostInput = AiCycleCostInput;
export { decideAiBudget, rollingSpend, liveWeekReset, liveFiveHourReset, aiUsageView };

// ---- folding the SDK's usage reports (pure) ---------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Epoch seconds or ms → ms. */
function epochMs(v: unknown): number | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** A `rate_limit_event` utilisation is a 0–1 FRACTION (the CLI parses it from the rate-limit header):
 *  → 0–100, explicitly. Out of range or not a number → null. */
function eventFractionToPct(v: unknown): number | null {
  const n = num(v);
  if (n == null || n < 0 || n > 1.5) return null;
  return n * 100;
}

/** Claude's window keys this module keeps: the 5-hour, the week, and per-model weeks. */
const MODEL_WINDOW_KEY = /^seven_day_[a-z0-9_]{1,40}$/;

/** Put one window into a reading under Claude's key. Unknown keys are ignored. Pure. */
function withWindow(reading: AiUsageReading, key: string, w: AiUsageWindowReading): AiUsageReading {
  if (key === 'five_hour') return { ...reading, fiveHour: w };
  if (key === 'seven_day') return { ...reading, week: w };
  if (MODEL_WINDOW_KEY.test(key)) {
    const models = { ...(reading.models ?? {}) };
    if (!(key in models) && Object.keys(models).length >= MAX_MODEL_WINDOWS) return reading;
    models[key] = w;
    return { ...reading, models };
  }
  return reading;
}

const isWindowKey = (k: string): boolean => k === 'five_hour' || k === 'seven_day' || MODEL_WINDOW_KEY.test(k);

/**
 * Fold one Agent SDK message into the reading. Returns the NEW reading (the windows this message names
 * merged over the rest), or null when the message names none. Pure.
 *
 * Reads `rate_limit_event.rate_limit_info`: every window in `unifiedWindows` (when the CLI sends
 * them) and otherwise the one named by `rateLimitType` ('five_hour', 'seven_day', 'seven_day_opus',
 * …). Reset times arrive in epoch seconds. Utilisation is a fraction on this path.
 */
export function foldRateLimitEvent(
  reading: AiUsageReading | null,
  message: unknown,
  nowMs: number,
): AiUsageReading | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { type?: unknown; rate_limit_info?: unknown };
  if (m.type !== 'rate_limit_event' || !m.rate_limit_info || typeof m.rate_limit_info !== 'object') return null;
  const info = m.rate_limit_info as {
    status?: unknown;
    rateLimitType?: unknown;
    utilization?: unknown;
    resetsAt?: unknown;
    unifiedWindows?: unknown;
  };
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object'
    ? (info.unifiedWindows as Record<string, unknown>)
    : null;
  const sources: Array<[string, { utilization?: unknown; resetsAt?: unknown; status?: unknown }]> = [];
  if (unified) {
    for (const [k, v] of Object.entries(unified)) {
      if (isWindowKey(k) && v && typeof v === 'object') sources.push([k, v as { utilization?: unknown }]);
    }
  } else if (typeof info.rateLimitType === 'string' && isWindowKey(info.rateLimitType)) {
    sources.push([info.rateLimitType, info]);
  }
  let out: AiUsageReading = {};
  let any = false;
  for (const [key, src] of sources) {
    let utilization = eventFractionToPct(src.utilization);
    if (utilization == null && src.status === 'rejected') utilization = 100;
    const resetsAtMs = epochMs(src.resetsAt);
    if (utilization == null && resetsAtMs == null) continue;
    out = withWindow(out, key, { utilization, resetsAtMs, observedAtMs: nowMs });
    any = true;
  }
  return any ? mergeReadings(reading, out) : null;
}

/** Parse the experimental usage method's answer. Its utilisation is ALREADY 0–100 (measured on a
 *  real login: `seven_day.utilization: 31`) and is kept as-is. Null on any shape mismatch. Pure. */
export function parseUsageProbe(resp: unknown, nowMs: number): AiUsageReading | null {
  if (!resp || typeof resp !== 'object') return null;
  const r = resp as { rate_limits_available?: unknown; rate_limits?: unknown; subscription_type?: unknown };
  const subscriptionType = typeof r.subscription_type === 'string' && r.subscription_type !== '' ? r.subscription_type : null;
  let out: AiUsageReading = {};
  let any = false;
  if (r.rate_limits_available === true && r.rate_limits && typeof r.rate_limits === 'object') {
    for (const [key, v] of Object.entries(r.rate_limits as Record<string, unknown>)) {
      if (!isWindowKey(key) || !v || typeof v !== 'object') continue;
      const o = v as { utilization?: unknown; resets_at?: unknown };
      const u = num(o.utilization);
      const t = typeof o.resets_at === 'string' ? Date.parse(o.resets_at) : NaN;
      const utilization = u != null && u >= 0 && u <= 150 ? u : null;
      const resetsAtMs = Number.isFinite(t) ? t : null;
      if (utilization == null && resetsAtMs == null) continue;
      out = withWindow(out, key, { utilization, resetsAtMs, observedAtMs: nowMs });
      any = true;
    }
  }
  if (!any && subscriptionType == null) return null;
  return { ...out, subscriptionType };
}

function storedWindow(v: unknown): AiUsageWindowReading | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as { utilization?: unknown; resetsAtMs?: unknown; observedAtMs?: unknown };
  const observedAtMs = num(w.observedAtMs);
  return observedAtMs == null ? null : { utilization: num(w.utilization), resetsAtMs: num(w.resetsAtMs), observedAtMs };
}

/** A stored reading of any age → today's shape. Never throws. */
export function normaliseStoredReading(raw: unknown): AiUsageReading | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { week?: unknown; fiveHour?: unknown; models?: unknown; subscriptionType?: unknown };
  const week = storedWindow(r.week);
  const fiveHour = storedWindow(r.fiveHour);
  let models: Record<string, AiUsageWindowReading> | null = null;
  if (r.models && typeof r.models === 'object') {
    for (const [k, v] of Object.entries(r.models as Record<string, unknown>).slice(0, MAX_MODEL_WINDOWS)) {
      const w = MODEL_WINDOW_KEY.test(k) ? storedWindow(v) : null;
      if (w) (models ??= {})[k] = w;
    }
  }
  const subscriptionType = typeof r.subscriptionType === 'string' ? r.subscriptionType : null;
  if (week == null && fiveHour == null && models == null && subscriptionType == null) return null;
  return { week, fiveHour, models, subscriptionType };
}

// ---- the reading: memory + persistence --------------------------------------------------------

let memReading: AiUsageReading | null | undefined; // undefined = not loaded yet

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

/** One window merged: the new one wins, but keeps the known reset when it read none. */
function mergeWindow(
  prev: AiUsageWindowReading | null | undefined,
  next: AiUsageWindowReading | null | undefined,
): AiUsageWindowReading | null {
  if (next == null) return prev ?? null;
  if (next.resetsAtMs == null && prev?.resetsAtMs != null) return { ...next, resetsAtMs: prev.resetsAtMs };
  return next;
}

/** Merge two readings (pure): each window independently; what `next` does not mention is kept (an
 *  event never names the subscription, and names one or two windows). */
export function mergeReadings(prev: AiUsageReading | null, next: AiUsageReading): AiUsageReading {
  const models: Record<string, AiUsageWindowReading> = { ...(prev?.models ?? {}) };
  for (const [k, w] of Object.entries(next.models ?? {})) {
    const merged = mergeWindow(models[k], w);
    if (merged && (k in models || Object.keys(models).length < MAX_MODEL_WINDOWS)) models[k] = merged;
  }
  return {
    week: mergeWindow(prev?.week, next.week),
    fiveHour: mergeWindow(prev?.fiveHour, next.fiveHour),
    models: Object.keys(models).length === 0 ? null : models,
    subscriptionType: next.subscriptionType ?? prev?.subscriptionType ?? null,
  };
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

/** The observer ai/runtime.ts calls with every agent message. */
export function noteAgentMessage(message: unknown, nowMs: number = Date.now()): void {
  const next = foldRateLimitEvent(null, message, nowMs);
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

let lastProbeAtMs = 0;
let probeInFlight: Promise<void> | null = null;

export type UsageProbe = () => Promise<unknown>;

/** Ask the Agent SDK's experimental usage method. Spawns the CLI with an empty input stream (no model
 *  call), asks, closes. Throws on anything unexpected; the caller swallows. */
const sdkUsageProbe: UsageProbe = async () => {
  const sdk = await loadAgentSdk();
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  // An input stream that never yields a turn: the CLI starts, answers control requests, and spends
  // nothing.
  async function* noTurns(): AsyncGenerator<never> {
    await held;
  }
  const q = sdk.query({
    prompt: noTurns(),
    options: {
      allowedTools: [],
      settingSources: [],
      ...ISOLATED_MCP,
      ...claudeExecutableOptions(),
      ...agentAuthOptions(),
    },
  });
  try {
    const method = (q as unknown as Record<string, unknown>)
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== 'function') throw new Error('usage method not available');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        (method as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('usage probe timed out')), PROBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
    try {
      (q as unknown as { close?: () => void }).close?.();
    } catch {
      /* already gone */
    }
  }
};

let probeImpl: UsageProbe = sdkUsageProbe;
/** Test hook. */
export function _setUsageProbeForTest(p: UsageProbe | null): void {
  probeImpl = p ?? sdkUsageProbe;
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
export function kickUsageProbe(nowMs: number = Date.now()): Promise<void> | null {
  if (probeInFlight) return probeInFlight;
  if (nowMs - lastProbeAtMs < PROBE_MIN_INTERVAL_MS) return null;
  if (probeImpl === sdkUsageProbe && getAiRuntimeStatus().runtime !== 'ready') return null;
  lastProbeAtMs = nowMs;
  probeInFlight = (async () => {
    try {
      await loadReading();
      const parsed = parseUsageProbe(await probeImpl(), Date.now());
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

async function readLedger(accountId: number, sinceMs: number): Promise<LedgerRow[]> {
  const { aiUsage } = schema;
  const rows = await db
    .select({ at: aiUsage.occurredAt, usd: aiUsage.costUsd, inTok: aiUsage.inputTokens, outTok: aiUsage.outputTokens })
    .from(aiUsage)
    .where(and(eq(aiUsage.accountId, accountId), gte(aiUsage.occurredAt, new Date(sinceMs))))
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
export async function readCycleCosts(accountId: number, nowMs: number): Promise<CycleCostInput> {
  const { aiUsage, workspaces } = schema;
  const [rows, ws] = await Promise.all([
    db
      .select({ feature: aiUsage.feature, usd: aiUsage.costUsd })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.accountId, accountId),
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
  const route = resolveAiCredential().route;
  const { settings, isDefault } = await readAiBudgetSettings(accountId);
  const probe = opts.probe ?? 'when_on';
  if (route === 'login' && (probe === 'always' || (probe === 'when_on' && settings.enabled))) kickUsageProbe(nowMs);
  const [reading, ledger, costs] = await Promise.all([
    route === 'login' ? loadReading() : Promise.resolve(null),
    readLedger(accountId, Math.min(nowMs - WEEK_MS, localMidnightMs(nowMs))),
    settings.enabled && route === 'login' ? readCycleCosts(accountId, nowMs) : Promise.resolve(NO_CYCLE_COSTS),
  ]);
  return {
    settings,
    isDefault,
    status: decideAiBudget({ settings, route, reading, ledger, costs, nowMs }),
    usage: aiUsageView({ settings, route, reading, ledger, nowMs, todayFromMs: localMidnightMs(nowMs) }),
  };
}

/** The budget's status for an account. Never throws: a failed read is "off" (never blocks). */
export async function aiBudgetStatus(accountId: number, opts: AiBudgetStatusOptions = {}): Promise<AiBudgetStatus> {
  try {
    return (await aiBudgetSnapshot(accountId, opts)).status;
  } catch {
    return OFF_STATUS(resolveAiCredential().route);
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
