// The demo's AI spend budget (GET/PUT /api/ai/budget), HAND-WRITTEN rather than recorded: the
// real answer depends on the recording machine's own sign-ins and live usage, which the demo must
// neither leak nor depend on. It judges the ACTIVE provider (provider.ts), as the server does.
//
// CLAUDE (the default). The demo reader is on a Claude subscription Claude reports as "max" (picked:
// Max 20x), with the budget ON at the default 5% share (the 5-hour share following it), of which Limn
// has used 2% this week — so the meter beside every Run button and the header's usage item show.
// Claude's own account reading: 5-hour session 12%, week 31%, Opus 9%, Sonnet 22%.
//
// CODEX (after Settings → AI → Codex). ChatGPT Plus, Codex's own windows: 5-hour 18%, week 34%.
// Limn's share is TOKEN-WEIGHTED (Limn's tokens in the window ÷ the account's × the window's figure):
// about 3% of the week and 1% of the 5-hour window. No US$ anywhere: a ChatGPT run has no price.
//
// The status and the usage view come from the SAME pure functions the server runs
// (`decideAiBudget`, `aiUsageView` in packages/shared), fed a simulated ledger and reading: lowering
// the share to 2% shows the paused toast and the two-press Run buttons; picking Max 5x raises the
// used share (same spend, smaller allowance). ⚠ Percentages only on the wire — the simulated spend
// below is internal, as it is on the server.

import {
  aiBudgetSettingsView,
  aiUsageView,
  decideAiBudget,
  resolveAiBudgetSettings,
  SUBSCRIPTION_ESTIMATES,
  validateAiBudgetBody,
  type AiAccountTokens,
  type AiBudgetResponse,
  type AiBudgetSettings,
  type AiLedgerRow,
  type AiUsageReading,
} from '@pierre-review/shared';
import type { DemoReply, DemoRequest, DemoServer } from './server.js';
import { isRecord } from './util.js';
import { activeProvider, aiState, DEMO_CODEX_PLAN } from './provider.js';

const KEY = 'ai-budget';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** What Claude "reports" in the demo. */
const REPORTED = 'max';
/** Limn's simulated runs this week: 24 runs adding up to 2% of Max 20x's estimated week (internal). */
const RUNS = 24;
const RUN_USD = (0.02 * SUBSCRIPTION_ESTIMATES.max20x.week) / RUNS;

const INITIAL: AiBudgetSettings = resolveAiBudgetSettings({ enabled: true, subscription: 'max20x' });

function settingsOf(srv: DemoServer): AiBudgetSettings {
  const s = srv.overlay.stored.get(KEY);
  return isRecord(s) ? resolveAiBudgetSettings(s as Partial<AiBudgetSettings>) : INITIAL;
}

/** Claude's account-wide reading, read 4 minutes ago: the week resets in 4 days, the session in 3 hours. */
function readingAt(nowMs: number): AiUsageReading {
  const observedAtMs = nowMs - 4 * MIN;
  const weekReset = nowMs + 4 * DAY;
  return {
    subscriptionType: REPORTED,
    fiveHour: { utilization: 12, resetsAtMs: nowMs + 3 * HOUR, observedAtMs },
    week: { utilization: 31, resetsAtMs: weekReset, observedAtMs },
    models: {
      seven_day_opus: { utilization: 9, resetsAtMs: weekReset, observedAtMs },
      seven_day_sonnet: { utilization: 22, resetsAtMs: weekReset, observedAtMs },
    },
  };
}

/** One run an hour ago, then one every 2½ hours back — all inside the week (it began 3 days ago). */
function ledgerAt(nowMs: number): AiLedgerRow[] {
  return Array.from({ length: RUNS }, (_, k) => ({
    atMs: nowMs - HOUR - k * 2.5 * HOUR,
    usd: RUN_USD,
    inputTokens: 42_000,
    outputTokens: 3_100,
  }));
}

// ── Codex ──
/** Limn's Codex runs this week: 10 of them, every 2½ hours back from 1 hour ago (tokens only, no US$). */
const CODEX_RUNS = 10;
const CODEX_RUN_TOKENS = { inputTokens: 41_000, outputTokens: 4_000 };
/** The ChatGPT account's own tokens over each window (Limn’s share: the week ≈ 3%, the 5 hours ≈ 1%). */
const CODEX_ACCOUNT_WEEK_TOKENS = 5_100_000;
const CODEX_ACCOUNT_FIVE_HOUR_TOKENS = 600_000;

/** Codex's own reading, read 4 minutes ago: the week resets in 5 days, the 5-hour window in 2 hours. */
function codexReadingAt(nowMs: number): AiUsageReading {
  const observedAtMs = nowMs - 4 * MIN;
  return {
    subscriptionType: DEMO_CODEX_PLAN,
    fiveHour: { utilization: 18, resetsAtMs: nowMs + 2 * HOUR, observedAtMs },
    week: { utilization: 34, resetsAtMs: nowMs + 5 * DAY, observedAtMs },
  };
}

function codexLedgerAt(nowMs: number): AiLedgerRow[] {
  return Array.from({ length: CODEX_RUNS }, (_, k) => ({ atMs: nowMs - HOUR - k * 2.5 * HOUR, usd: 0, ...CODEX_RUN_TOKENS }));
}

/** The account's tokens over exactly the windows the reading names, up to its newest sample. */
function codexAccountTokensAt(nowMs: number, reading: AiUsageReading): AiAccountTokens {
  const toMs = nowMs - 4 * MIN;
  return {
    week: { tokens: CODEX_ACCOUNT_WEEK_TOKENS, fromMs: reading.week!.resetsAtMs! - 7 * DAY, inclusive: true, toMs },
    fiveHour: { tokens: CODEX_ACCOUNT_FIVE_HOUR_TOKENS, fromMs: reading.fiveHour!.resetsAtMs! - 5 * HOUR, inclusive: true, toMs },
  };
}

function response(srv: DemoServer, provider: 'claude' | 'codex' = activeProvider(srv)): AiBudgetResponse {
  const settings = settingsOf(srv);
  const nowMs = srv.now();
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const todayFromMs = midnight.getTime();
  // The demo's workspaces draw diagrams automatically, with no recorded runs: the typical cycle.
  const costs = { reviewMeanUsd: null, diagramMeanUsd: null, autoDiagrams: true };
  if (provider === 'codex') {
    // Signed out of Codex: no credential, so nothing to judge (the server's 'none' route).
    const route = aiState(srv).codexSignedIn ? ('login' as const) : ('none' as const);
    const reading = route === 'login' ? codexReadingAt(nowMs) : null;
    const ledger = codexLedgerAt(nowMs);
    const accountTokens = reading ? codexAccountTokensAt(nowMs, reading) : null;
    return {
      settings: aiBudgetSettingsView(settings, route),
      isDefault: false,
      status: decideAiBudget({ settings, route, reading, ledger, costs, nowMs, provider: 'codex', accountTokens }),
      usage: aiUsageView({ settings, route, reading, ledger, nowMs, todayFromMs, provider: 'codex', accountTokens }),
    };
  }
  const reading = readingAt(nowMs);
  const ledger = ledgerAt(nowMs);
  return {
    settings: aiBudgetSettingsView(settings, 'login'),
    isDefault: false,
    status: decideAiBudget({ settings, route: 'login', reading, ledger, costs, nowMs, provider: 'claude' }),
    usage: aiUsageView({ settings, route: 'login', reading, ledger, nowMs, todayFromMs, provider: 'claude' }),
  };
}

// `?provider=`: that provider's reading (a per-run model pick that is not the default), as on the server.
export function getAiBudget(req: DemoRequest, srv: DemoServer): DemoReply {
  const named = req.query.get('provider');
  return { status: 200, body: response(srv, named === 'claude' || named === 'codex' ? named : undefined) };
}

export function putAiBudget(req: DemoRequest, srv: DemoServer): DemoReply {
  const problem = validateAiBudgetBody(req.body);
  if (problem != null) return { status: 400, body: { error: 'InvalidAiBudget', message: problem } };
  const next = resolveAiBudgetSettings({ ...settingsOf(srv), ...(req.body as Partial<AiBudgetSettings>) });
  srv.overlay.stored.set(KEY, next);
  return { status: 200, body: response(srv) };
}
