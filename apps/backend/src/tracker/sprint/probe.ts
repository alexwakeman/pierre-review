import { and, eq, inArray } from 'drizzle-orm';
import type { SprintSource } from '@pierre-review/shared';
import { githubAccessFor, type TrackerContext } from '../context.js';
import { prepareTrackerCall } from '../calls.js';
import { JiraFetchError } from '../jira/fetch.js';
import { githubGraphql, noteGithubBudget } from '../github/reader.js';
import { autoDetectedWorkspaces, githubIssuesRepos, readWorkspaceTrackerRow, trackerAccessOf } from '../settings.js';
import type { GithubCallAccess } from '../types.js';
import { accessFingerprint, backoffCode } from '../worker.js';
import {
  GITHUB_ITERATION_SCAN_QUERY,
  GITHUB_MILESTONES_QUERY,
  SPRINT_GITHUB_REPOS_MAX,
  isMissingScope,
  pickIteration,
  pickMilestone,
  projectsGraphql,
  sightingsOf,
  splitRepo,
  type ScanData,
} from './github.js';
import { workspaceRepoNames } from './project-keys.js';

// ── THE SPRINT-SOURCE PROBE (docs/TRACKERS.md § The sprint-source probe) ──────────────────────────
//
// This Sprint's default in Settings → Features (`hasSprintSource`, db/feature-gates.ts) learns of a
// GitHub milestone or Projects iteration from a sprint READ — and the read is demand-gated: it runs
// only after the tab was opened. On a new install whose tracker is GitHub Issues (the automatic
// default), the tab would therefore never appear by itself. The probe closes that loop CHEAPLY, on the
// tracker worker's own cadence (./../worker.ts `runTrackerTick`), ⚠ NEVER ON A VIEW:
//
//   • only a workspace whose EFFECTIVE tracker is GitHub Issues, with NO successful sprint read
//     (`sprint_reads.read_at` NULL — once a read exists, its own source is the answer);
//   • only for an account that is not an existing install (its defaults show everything anyway);
//   • at most once per workspace per `SPRINT_PROBE_INTERVAL_MS`, at most `SPRINT_PROBE_WORKSPACES`
//     workspaces per tick, at most `SPRINT_GITHUB_REPOS_MAX` repos each (issue repos first);
//   • never for a workspace the ticket worker has backed off (a refused token, a rate limit).
//
// What it asks, cheapest first, stopping at the first hit: each repo's open milestones (one small
// query; a milestone due today or later counts — undated and overdue ones do not), then each repo's
// recently updated issues' Projects iterations (the read's own scan query; a CURRENT iteration
// counts). Projects need `read:project`: a missing scope ends the iteration half SILENTLY — milestones
// only. Nothing is listed, nothing is stored but the answer: `sprint_reads.probe_checked_at` and
// `probe_source_json` (an 'iteration' or a dated 'milestone' `SprintSource`, or NULL). A failed probe
// (rate limit, network) stamps the attempt and keeps the last answer. Logs carry account, workspace
// and a code only.

/** A workspace is probed again after this long. */
export const SPRINT_PROBE_INTERVAL_MS = 6 * 60 * 60_000;
/** Workspaces probed per tick at most. */
export const SPRINT_PROBE_WORKSPACES = 2;

const EPOCH = new Date(0);

export type SprintProber = (gh: GithubCallAccess, repos: readonly string[], nowMs: number) => Promise<SprintSource | null>;

/**
 * Does any of these repos (≤ SPRINT_GITHUB_REPOS_MAX, in order) have an open milestone due today or
 * later, or sit in a current Projects iteration? The first hit, as the `SprintSource` a read would
 * name; null for none. Throws `JiraFetchError` on a rate limit / refused token / network failure.
 */
export const probeGithubSprintSource: SprintProber = async (gh, repos, nowMs) => {
  const read = repos
    .map((full) => ({ full, parts: splitRepo(full) }))
    .filter((r): r is { full: string; parts: { owner: string; name: string } } => r.parts != null)
    .slice(0, SPRINT_GITHUB_REPOS_MAX);
  if (read.length === 0) return null;
  // 1. MILESTONES — one small query per repo.
  for (const r of read) {
    const { data } = await githubGraphql<{
      repository?: { milestones?: { nodes?: Array<{ title?: unknown; dueOn?: unknown; number?: unknown } | null> | null } | null } | null;
      rateLimit?: { remaining?: number | null; resetAt?: string | null } | null;
    }>(gh, GITHUB_MILESTONES_QUERY, { owner: r.parts.owner, name: r.parts.name });
    noteGithubBudget(gh.accountId, data?.rateLimit);
    const milestones = (data?.repository?.milestones?.nodes ?? []).flatMap((m) =>
      m != null && typeof m.title === 'string' && typeof m.number === 'number'
        ? [{ title: m.title.trim().slice(0, 200), dueOn: typeof m.dueOn === 'string' ? m.dueOn : null, number: m.number }]
        : [],
    );
    // Only a DATED milestone makes a sprint (`isSprintSource`): drop the undated before picking.
    const pick = pickMilestone([{ repo: r.full, milestones: milestones.filter((m) => m.dueOn != null) }], nowMs);
    if (pick?.dueOn != null) return { kind: 'milestone', provider: 'github', name: pick.title, dueOn: pick.dueOn, repos: [r.full] };
  }
  // 2. PROJECTS ITERATIONS — the read's own scan query; a missing scope ends this half silently.
  for (const r of read) {
    const { data, errors } = await projectsGraphql<ScanData>(gh, GITHUB_ITERATION_SCAN_QUERY, { owner: r.parts.owner, name: r.parts.name });
    noteGithubBudget(gh.accountId, data?.rateLimit);
    if (isMissingScope(errors)) return null;
    const pick = pickIteration(sightingsOf(r.full, data), nowMs);
    if (pick != null) {
      return {
        kind: 'iteration',
        provider: 'github',
        name: pick.title,
        project: pick.projectTitle,
        field: pick.fieldName,
        startsOn: pick.startsAt.toISOString().slice(0, 10),
        endsOn: pick.endsAt.toISOString().slice(0, 10),
        repos: [r.full],
      };
    }
  }
  return null;
};

export interface SprintProbeOptions {
  now?: () => number;
  /** Test seam: the GitHub questions. */
  prober?: SprintProber;
}

function codeOf(err: unknown): string {
  if (err instanceof JiraFetchError) return err.code === 'http' && err.status === 429 ? 'rate_limited' : err.code;
  return 'unknown';
}

/** The GitHub Issues workspaces (stored choice or the automatic default), every account. */
async function githubWorkspaces(ctx: TrackerContext): Promise<Array<{ accountId: number; workspaceId: number }>> {
  const t = ctx.schema.workspaceTrackers;
  const stored = (await ctx.db
    .select({ accountId: t.accountId, workspaceId: t.workspaceId })
    .from(t)
    .where(eq(t.provider, 'github'))
    .execute()) as Array<{ accountId: number; workspaceId: number }>;
  const seen = new Set<string>();
  const out: Array<{ accountId: number; workspaceId: number }> = [];
  for (const w of [...stored, ...(await autoDetectedWorkspaces(ctx, null))]) {
    const k = `${w.accountId}|${w.workspaceId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}

/**
 * The workspaces due a probe now, in order (never probed first, then the oldest probe), at most
 * `limit`. Pure over its inputs. Exported for its test.
 */
export function dueProbes(
  candidates: ReadonlyArray<{ accountId: number; workspaceId: number }>,
  rows: ReadonlyArray<{ accountId: number; workspaceId: number; readAt: Date | null; probeCheckedAt: Date | null }>,
  existingInstalls: ReadonlySet<number>,
  nowMs: number,
  limit: number = SPRINT_PROBE_WORKSPACES,
): Array<{ accountId: number; workspaceId: number }> {
  const byKey = new Map(rows.map((r) => [`${r.accountId}|${r.workspaceId}`, r] as const));
  return candidates
    .filter((c) => !existingInstalls.has(c.accountId))
    .map((c) => ({ c, row: byKey.get(`${c.accountId}|${c.workspaceId}`) }))
    .filter(({ row }) => row?.readAt == null && (row?.probeCheckedAt == null || nowMs - row.probeCheckedAt.getTime() >= SPRINT_PROBE_INTERVAL_MS))
    .sort((a, b) => (a.row?.probeCheckedAt?.getTime() ?? -1) - (b.row?.probeCheckedAt?.getTime() ?? -1))
    .slice(0, Math.max(0, limit))
    .map(({ c }) => c);
}

/** Store one probe's answer (`source` undefined = a failed attempt: stamp it, keep the last answer). */
async function storeProbe(ctx: TrackerContext, accountId: number, workspaceId: number, at: Date, source: SprintSource | null | undefined): Promise<void> {
  const sr = ctx.schema.sprintReads;
  const set = source === undefined ? { probeCheckedAt: at } : { probeCheckedAt: at, probeSourceJson: source };
  await ctx.db
    .insert(sr)
    // A new row is NOT a view: `viewed_at` epoch 0 keeps it out of the demand-gated read.
    .values({ accountId, workspaceId, nextReadAt: EPOCH, viewedAt: EPOCH, ...set })
    .onConflictDoUpdate({ target: [sr.accountId, sr.workspaceId], set })
    .execute();
}

/** Probe ONE workspace. Returns what was stored (undefined = not asked or failed). Never throws. */
export async function probeWorkspaceSprintSource(
  ctx: TrackerContext,
  accountId: number,
  workspaceId: number,
  opts: SprintProbeOptions = {},
): Promise<SprintSource | null | undefined> {
  const now = opts.now ?? Date.now;
  const at = new Date(now());
  try {
    const row = await readWorkspaceTrackerRow(ctx, accountId, workspaceId);
    const access = trackerAccessOf(ctx.host, row);
    if (access.issue.provider !== 'github') return undefined;
    const prepared = prepareTrackerCall(access, { github: githubAccessFor(ctx, accountId) });
    if (!prepared.ok || prepared.call.github == null) {
      await storeProbe(ctx, accountId, workspaceId, at, undefined);
      return undefined;
    }
    if (backoffCode(accountId, workspaceId, accessFingerprint(prepared.call), at.getTime()) != null) return undefined;
    const withIssues = await githubIssuesRepos(ctx, accountId, workspaceId);
    const repos = [...new Set([...withIssues, ...(await workspaceRepoNames(ctx, accountId, workspaceId))])].slice(0, SPRINT_GITHUB_REPOS_MAX);
    const source = await (opts.prober ?? probeGithubSprintSource)(prepared.call.github, repos, at.getTime());
    await storeProbe(ctx, accountId, workspaceId, at, source);
    return source;
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, code: codeOf(err), route: 'tracker-sprint-probe' }, 'sprint source probe failed (non-fatal)');
    try {
      await storeProbe(ctx, accountId, workspaceId, at, undefined);
    } catch {
      /* the next due tick asks again */
    }
    return undefined;
  }
}

/** The tick body (called by the tracker worker's tick, never by a route). Never throws. */
export async function runSprintProbeTick(ctx: TrackerContext, opts: SprintProbeOptions = {}): Promise<number> {
  // A narrow test context (the ticket worker's own tests) carries no sprint tables: nothing to probe.
  if (ctx.schema.sprintReads == null || ctx.schema.workspaceTrackers == null) return 0;
  const now = opts.now ?? Date.now;
  try {
    const candidates = await githubWorkspaces(ctx);
    if (candidates.length === 0) return 0;
    const accountIds = [...new Set(candidates.map((c) => c.accountId))];
    const sr = ctx.schema.sprintReads;
    const rows = (await ctx.db
      .select({ accountId: sr.accountId, workspaceId: sr.workspaceId, readAt: sr.readAt, probeCheckedAt: sr.probeCheckedAt })
      .from(sr)
      .where(inArray(sr.accountId, accountIds))
      .execute()) as Array<{ accountId: number; workspaceId: number; readAt: Date | null; probeCheckedAt: Date | null }>;
    const existing = new Set<number>();
    const a = ctx.schema.accounts;
    if (a?.featuresExistingInstall != null) {
      const accs = (await ctx.db
        .select({ id: a.id })
        .from(a)
        .where(and(inArray(a.id, accountIds), eq(a.featuresExistingInstall, true)))
        .execute()) as Array<{ id: number }>;
      for (const x of accs) existing.add(x.id);
    }
    const due = dueProbes(candidates, rows, existing, now());
    for (const w of due) await probeWorkspaceSprintSource(ctx, w.accountId, w.workspaceId, opts);
    return due.length;
  } catch (err) {
    ctx.log.warn({ code: codeOf(err), route: 'tracker-sprint-probe' }, 'sprint probe tick failed (non-fatal)');
    return 0;
  }
}
