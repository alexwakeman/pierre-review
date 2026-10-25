// The demo's Claude spend budget (GET/PUT /api/ai/budget), HAND-WRITTEN rather than recorded: the
// real answer depends on the recording machine's own Claude login and live usage, which the demo
// must neither leak nor depend on. The demo reader is on a Claude subscription Claude reports as
// "max" (picked: Max 20x), with the budget ON at the default 5% share (the 5-hour share following
// it), of which Limn has used 2% this week — so the meter beside every Run button and the header's
// usage item show. Claude's own account reading: 5-hour session 12%, week 31%, Opus 9%, Sonnet 22%.
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
  type AiBudgetResponse,
  type AiBudgetSettings,
  type AiLedgerRow,
  type AiUsageReading,
} from '@pierre-review/shared';
import type { DemoReply, DemoRequest, DemoServer } from './server.js';
import { isRecord } from './util.js';

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

function response(srv: DemoServer): AiBudgetResponse {
  const settings = settingsOf(srv);
  const nowMs = srv.now();
  const reading = readingAt(nowMs);
  const ledger = ledgerAt(nowMs);
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  return {
    settings: aiBudgetSettingsView(settings, 'login'),
    isDefault: false,
    // The demo's workspaces draw diagrams automatically, with no recorded runs: the typical cycle.
    status: decideAiBudget({
      settings,
      route: 'login',
      reading,
      ledger,
      costs: { reviewMeanUsd: null, diagramMeanUsd: null, autoDiagrams: true },
      nowMs,
    }),
    usage: aiUsageView({ settings, route: 'login', reading, ledger, nowMs, todayFromMs: midnight.getTime() }),
  };
}

export function getAiBudget(_req: DemoRequest, srv: DemoServer): DemoReply {
  return { status: 200, body: response(srv) };
}

export function putAiBudget(req: DemoRequest, srv: DemoServer): DemoReply {
  const problem = validateAiBudgetBody(req.body);
  if (problem != null) return { status: 400, body: { error: 'InvalidAiBudget', message: problem } };
  const next = resolveAiBudgetSettings({ ...settingsOf(srv), ...(req.body as Partial<AiBudgetSettings>) });
  srv.overlay.stored.set(KEY, next);
  return { status: 200, body: response(srv) };
}
