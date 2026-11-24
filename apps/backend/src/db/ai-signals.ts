// AI VENDOR SIGNALS, READ SIDE (docs/AI-ADOPTION-REPORT.md § Detection). The ONE entry point the
// adoption report has into detection: which AI coding tools touched each PR, and since when the
// detector has been reading this install's PRs.
//
// A PR's verdict is the UNION of
//   1. `pull_requests.ai_signals`  — the PR's own title, description, branch and author (sync);
//   2. every `commits.ai_signals`  — each commit's author, committer and message (sync);
//   3. Ensemble's OWN work, ON READ, as `{vendor: 'ensemble', source: 'ensemble'}`:
//      - `ai_fixes` rows with `pushed_at` set, by `pr_id` (account-scoped);
//      - `story_build_prs` (Implement story) by `pushed_pr_number`, or by `loop_pushed_sha` found in
//        the PR's stored commits — each resolved to a local PR ONLY within (accountId, repoId).
//        Implement's push is the READER'S PR: no ledger row and no trailer, so this is how it counts.
// ⚠ NOT `limn_actions` 'push' rows and NOT `commits.limn_pushed_by_user_id`: those also cover plain
// branch updates and hand-made conflict resolutions, which are not AI work.
//
// `scanned` is `ai_signals_version >= AI_SIGNALS_VERSION`: below it (or NULL) the PR's own and its
// commits' text has not been read by this detector, and the report must not count it as human.
import { and, eq, inArray, isNotNull, min, or } from 'drizzle-orm';
import {
  AI_SIGNALS_VERSION,
  mergeAiSignals,
  parseStoredAiSignals,
  type AiSignal,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { pullRequests, commits, aiFixes, storyBuildPrs } = schema;

/** SQLite's bound-variable ceiling is 32 766 on current builds; stay far below it. */
const ID_CHUNK = 500;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += ID_CHUNK) out.push(xs.slice(i, i + ID_CHUNK));
  return out;
}

export interface PrAiSignals {
  /** The detector has read this PR at the current version. False = unknown, never "no AI". */
  scanned: boolean;
  /** Union of every source, deduped on (vendor, source), canonical order. */
  signals: AiSignal[];
}

const ENSEMBLE_SIGNAL: AiSignal = { vendor: 'ensemble', source: 'ensemble' };

/**
 * The AI signals of each PR id that belongs to `accountId`. Ids that are not the account's (or do
 * not exist) are ABSENT from the map — never an empty entry. DB only.
 */
export async function getPrAiSignals(
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, PrAiSignals>> {
  const out = new Map<number, PrAiSignals>();
  const wanted = [...new Set(prIds.filter((id) => Number.isInteger(id)))];
  if (wanted.length === 0) return out;

  // 1. The account's PRs among the ids (the ownership gate for everything below).
  const prs: { id: number; repoId: number; number: number; aiSignals: string | null; aiSignalsVersion: number | null }[] = [];
  for (const ids of chunks(wanted)) {
    prs.push(
      ...(await db
        .select({
          id: pullRequests.id,
          repoId: pullRequests.repoId,
          number: pullRequests.number,
          aiSignals: pullRequests.aiSignals,
          aiSignalsVersion: pullRequests.aiSignalsVersion,
        })
        .from(pullRequests)
        .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, ids)))
        .execute()),
    );
  }
  if (prs.length === 0) return out;
  const owned = prs.map((p) => p.id);
  const lists = new Map<number, (readonly AiSignal[] | null)[]>();
  for (const p of prs) lists.set(p.id, [parseStoredAiSignals(p.aiSignals)]);

  // 2. Every scanned commit of those PRs (`commits` has no account column: the owned ids gate it).
  for (const ids of chunks(owned)) {
    const rows = await db
      .select({ prId: commits.prId, aiSignals: commits.aiSignals })
      .from(commits)
      .where(and(inArray(commits.prId, ids), isNotNull(commits.aiSignals)))
      .execute();
    for (const r of rows) lists.get(r.prId)?.push(parseStoredAiSignals(r.aiSignals));
  }

  // 3a. AI Fix pushes, by pr_id, account-scoped.
  const ensemble = new Set<number>();
  for (const ids of chunks(owned)) {
    const rows = await db
      .selectDistinct({ prId: aiFixes.prId })
      .from(aiFixes)
      .where(and(eq(aiFixes.accountId, accountId), inArray(aiFixes.prId, ids), isNotNull(aiFixes.pushedAt)))
      .execute();
    for (const r of rows) ensemble.add(r.prId);
  }

  // 3b. Implement story pushes, resolved within (accountId, repoId) only.
  const repoIds = [...new Set(prs.map((p) => p.repoId))];
  const byRepoNumber = new Map(prs.map((p) => [`${p.repoId}:${p.number}`, p.id] as const));
  const repoOf = new Map(prs.map((p) => [p.id, p.repoId] as const));
  const loopShas = new Map<string, Set<number>>(); // sha → repo ids that pushed it
  for (const ids of chunks(repoIds)) {
    const rows = await db
      .select({
        repoId: storyBuildPrs.repoId,
        pushedPrNumber: storyBuildPrs.pushedPrNumber,
        loopPushedSha: storyBuildPrs.loopPushedSha,
      })
      .from(storyBuildPrs)
      .where(
        and(
          eq(storyBuildPrs.accountId, accountId),
          inArray(storyBuildPrs.repoId, ids),
          or(isNotNull(storyBuildPrs.pushedPrNumber), isNotNull(storyBuildPrs.loopPushedSha)),
        ),
      )
      .execute();
    for (const r of rows) {
      if (r.pushedPrNumber != null) {
        const prId = byRepoNumber.get(`${r.repoId}:${r.pushedPrNumber}`);
        if (prId != null) ensemble.add(prId);
      }
      if (r.loopPushedSha != null && r.loopPushedSha !== '') {
        const sha = r.loopPushedSha.toLowerCase();
        const set = loopShas.get(sha) ?? new Set<number>();
        set.add(r.repoId);
        loopShas.set(sha, set);
      }
    }
  }
  if (loopShas.size > 0) {
    const shas = [...loopShas.keys()];
    for (const ids of chunks(owned)) {
      for (const s of chunks(shas)) {
        const rows = await db
          .select({ prId: commits.prId, sha: commits.sha })
          .from(commits)
          .where(and(inArray(commits.prId, ids), inArray(commits.sha, s)))
          .execute();
        for (const r of rows) {
          // The same repo as the build that pushed it: a sha is never matched across repos.
          if (loopShas.get(r.sha.toLowerCase())?.has(repoOf.get(r.prId) ?? -1)) ensemble.add(r.prId);
        }
      }
    }
  }

  for (const p of prs) {
    const l = lists.get(p.id) ?? [];
    if (ensemble.has(p.id)) l.push([ENSEMBLE_SIGNAL]);
    out.set(p.id, {
      scanned: p.aiSignalsVersion != null && p.aiSignalsVersion >= AI_SIGNALS_VERSION,
      signals: mergeAiSignals(...l),
    });
  }
  return out;
}

/**
 * The earliest `ai_signals_checked_at` among the account's PRs in these repos, as epoch ms; null when
 * none was ever scanned (or no repo is given). The report states coverage from this minus the
 * backfill's 90 days (sync/backfill-ai-signals.ts `AI_SIGNALS_BACKFILL_DAYS`).
 */
export async function aiSignalsFirstScanMs(accountId: number, repoIds: readonly number[]): Promise<number | null> {
  const wanted = [...new Set(repoIds.filter((id) => Number.isInteger(id)))];
  let first: number | null = null;
  for (const ids of chunks(wanted)) {
    const [row] = await db
      .select({ first: min(pullRequests.aiSignalsCheckedAt) })
      .from(pullRequests)
      .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, ids)))
      .execute();
    const v = row?.first;
    const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v * 1000 : null;
    if (ms != null && Number.isFinite(ms) && (first == null || ms < first)) first = ms;
  }
  return first;
}
