import { and, eq } from 'drizzle-orm';
import type { ReleaseBlockersReport, ReleaseBlockersState, ReleaseCheckResult } from '@pierre-review/shared';
import { releaseBlockersInput } from '../releases/blockers-input.js';
import { db, schema } from './client.js';

// "EXPLAIN WHAT'S BLOCKING" — the ONE store (migration 0217; docs/RELEASES.md § Explain what's blocking).
// ONE row per (account, workspace): the last report, the hash of the input it was written from, and
// what ran. The state GET /api/releases carries is DERIVED here on every read: `explainable` and the
// current input hash come from the check the read already folded (pure, no clock), `stale` = the hashes
// differ. Nothing re-runs on its own.

const t = schema.releaseBlockerReports;

/** The stored report for a workspace (null = none yet), with its input hash. */
export async function getReleaseBlockersReport(
  accountId: number,
  workspaceId: number,
): Promise<{ inputHash: string; report: ReleaseBlockersReport } | null> {
  const row = (
    await db
      .select()
      .from(t)
      .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
      .limit(1)
      .execute()
  )[0];
  if (row == null) return null;
  const body = (row.reportJson ?? {}) as Partial<ReleaseBlockersReport>;
  if (typeof body.headline !== 'string') return null;
  return {
    inputHash: row.inputHash,
    report: {
      headline: body.headline,
      steps: Array.isArray(body.steps) ? body.steps : [],
      repos: Array.isArray(body.repos) ? body.repos : [],
      dropped: typeof body.dropped === 'number' ? body.dropped : 0,
      writtenAt: row.writtenAt.toISOString(),
      model: row.model,
      provider: row.provider === 'codex' ? 'codex' : row.provider === 'claude' ? 'claude' : null,
      costUsd: row.costUsd,
    },
  };
}

export interface StoreReleaseBlockersReport {
  inputHash: string;
  report: Pick<ReleaseBlockersReport, 'headline' | 'steps' | 'repos' | 'dropped'>;
  model: string | null;
  provider: 'claude' | 'codex' | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  writtenAt: Date;
}

/** Replace the workspace's report. */
export async function storeReleaseBlockersReport(accountId: number, workspaceId: number, r: StoreReleaseBlockersReport): Promise<void> {
  const values = {
    inputHash: r.inputHash,
    reportJson: { headline: r.report.headline, steps: r.report.steps, repos: r.report.repos, dropped: r.report.dropped },
    model: r.model,
    provider: r.provider,
    costUsd: r.costUsd,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    writtenAt: r.writtenAt,
  };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: { ...values } })
    .execute();
}

/** The state GET /api/releases carries, from the check it already folded. */
export async function releaseBlockersStateFor(accountId: number, workspaceId: number, check: ReleaseCheckResult | null): Promise<ReleaseBlockersState> {
  const stored = await getReleaseBlockersReport(accountId, workspaceId);
  const input = check != null ? releaseBlockersInput(check) : null;
  return {
    explainable: input?.explainable === true,
    report: stored?.report ?? null,
    stale: stored != null && (input == null || input.hash !== stored.inputHash),
  };
}
