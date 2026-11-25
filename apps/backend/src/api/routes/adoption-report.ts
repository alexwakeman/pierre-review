import type { FastifyInstance } from 'fastify';
import type { AiAdoptionReport } from '@pierre-review/shared';
import { config } from '../../config.js';
import { buildAiAdoptionReport } from '../../db/adoption-report.js';
import { accountIdOf } from '../plugins/auth.js';

// REPORTS → DOWNLOAD REPORT: the figures (docs/AI-ADOPTION-REPORT.md § Routes; the fold is
// db/adoption-report.ts, the wire packages/shared ai-adoption-report.ts).
//
//   GET /api/reports/ai-adoption?workspace=<id> → AiAdoptionReport
//
// CORE and ALWAYS REGISTERED (AI off too: the report then carries template commentary only and its
// cost slide says "AI is off"). DB only: no model, no GitHub. The SPA reads it on the reader's press,
// never on mount, and builds the PDF in the browser.
//
// `?workspace=` is THE scope parameter: absent, unparseable, unknown or another account's id ⇒ the
// Default workspace, never a 404; the resolved id is echoed as `workspaceId`. No `?repoIds=`: Reports
// covers the whole workspace.
//
// THE MEMO. The computed report is kept in process, keyed `accountId:workspaceId:generatedAt`, so the
// commentary route (review/adoption-report/routes.ts) reads the SAME figures the PDF shows. It never
// trusts figures from the client. The TTL (two minutes) SLIDES: every commentary read of an entry
// renews it, so a download whose slides take longer than two minutes in all (a slow provider) keeps
// its figures. ⚠ A MISS NEVER RECOMPUTES: a fresh report would carry a NEW `generatedAt` (so every
// later slide would miss again and rerun the whole fold) and figures that may differ from the PDF's.
// The commentary route answers a miss with the template (`reason: 'stale'`) and makes no call.
//
// Rate tier: `search` + `read`, exact path (`tierFor`): one request runs the period metrics twice,
// the Chronology fold twice, the bot analytics twice, the usage ledger four times and one merged-PR
// scan with its signals and approvals.

const MEMO_TTL_MS = 2 * 60_000;
const MEMO_MAX = 32;
const memo = new Map<string, { report: AiAdoptionReport; expiresAt: number }>();

const memoKey = (accountId: number, workspaceId: number, generatedAt: string): string => `${accountId}:${workspaceId}:${generatedAt}`;

function remember(accountId: number, report: AiAdoptionReport, nowMs: number): void {
  for (const [k, v] of memo) if (v.expiresAt <= nowMs) memo.delete(k);
  while (memo.size >= MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest == null) break;
    memo.delete(oldest);
  }
  memo.set(memoKey(accountId, report.workspaceId, report.generatedAt), { report, expiresAt: nowMs + MEMO_TTL_MS });
}

/** Compute the report now (and remember it). `config.aiEnabled` decides the cost slide. */
export async function computeAdoptionReport(accountId: number, workspace: string | number | null | undefined, nowMs = Date.now()): Promise<AiAdoptionReport> {
  const aiEnabled = config.aiEnabled;
  const report = await buildAiAdoptionReport(accountId, workspace, nowMs, {
    aiEnabled,
    // Lazy: the cost unit reads the AI budget (only with AI on).
    costRate: aiEnabled ? async () => (await import('./ai-usage-report.js')).costRate(accountId, nowMs) : undefined,
  });
  remember(accountId, report, nowMs);
  return report;
}

/**
 * The remembered report for this generatedAt (its TTL renewed), or null when it is gone — expired,
 * evicted, or from before a restart. ⚠ Never recomputes (see THE MEMO above).
 */
export function adoptionReportFor(accountId: number, workspaceId: number, generatedAt: string, nowMs = Date.now()): AiAdoptionReport | null {
  const key = memoKey(accountId, workspaceId, generatedAt);
  const hit = memo.get(key);
  if (hit == null) return null;
  if (hit.expiresAt <= nowMs) {
    memo.delete(key);
    return null;
  }
  hit.expiresAt = nowMs + MEMO_TTL_MS;
  return hit.report;
}

/** Tests only: forget every remembered report. */
export function clearAdoptionReportMemoForTests(): void {
  memo.clear();
}

export async function adoptionReportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/reports/ai-adoption', async (req): Promise<AiAdoptionReport> => {
    const q = req.query as { workspace?: string };
    return computeAdoptionReport(accountIdOf(req), q.workspace);
  });
}
