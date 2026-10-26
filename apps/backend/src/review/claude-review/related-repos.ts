import { and, eq, inArray } from 'drizzle-orm';
import { RELATED_REPOS_MAX_PER_REPO } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { extractTicketKeys } from '../../tracker/detect.js';

// THE COMPANION CHANGE IN EACH RELATED REPO (docs/CLAUDE-REVIEW.md § Related repos), for a DEEP
// review's peers. The reader relates repos of one workspace in Settings (db/related-repos.ts); for a
// PR in one, each related repo yields AT MOST ONE peer, the first rule that matches:
//
//   1. an OPEN PR there whose head branch has the same name as this PR's        → 'same_branch'
//   2. an OPEN PR there whose title or branch carries one of this PR's ticket keys → 'same_ticket'
//   3. a BRANCH there of the same name, with no PR (one GitHub read)           → 'branch'
//   4. the repo's DEFAULT BRANCH, as plain reference                             → 'default_branch'
//
// DB only, except rule 3's one branch read per related repo (and only when 1 and 2 found nothing).
// Never throws: peer context is optional; a failure costs the peer, never the review.

export type RelatedPeerMatch = 'same_branch' | 'same_ticket' | 'branch' | 'default_branch';

export interface RelatedRepoPeer {
  match: RelatedPeerMatch;
  repoId: number;
  owner: string;
  name: string;
  repoFullName: string;
  // The branch this peer is about: the PR's head branch (rules 1–2), the same-named branch (3), the
  // default branch (4; null when the repo's default branch is not known — the remote's HEAD is read).
  branch: string | null;
  // Rules 1–2 only.
  pr: {
    prId: number;
    number: number;
    title: string;
    headSha: string;
    files: string[];
  } | null;
  // The ticket keys it shares with this PR (rule 2), else [].
  ticketKeys: string[];
}

/** Every ticket key a title or branch name carries — case-insensitive, both sources. The tracker's
 *  own extraction (tracker/detect.ts), run over the UPPER-CASED text so a lower-case branch key
 *  (`bmd-1048-created-area-edit`) counts. Only ever compared with another PR's keys, in a repo the
 *  reader related by hand, so the looser reading cannot link two unrelated changes on its own. */
export function ticketKeysOf(title: string | null | undefined, branch: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const text of [title, branch]) {
    if (!text) continue;
    for (const k of extractTicketKeys(text.toUpperCase(), null)) out.add(k);
  }
  return [...out];
}

interface CandidatePr {
  prId: number;
  repoId: number;
  number: number;
  title: string;
  headRefName: string | null;
  headSha: string | null;
  files: unknown;
}

const filesOf = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((f) => (f as { path?: unknown })?.path).filter((x): x is string => typeof x === 'string' && x !== '')
    : [];

/**
 * The related repos' companion changes for this PR, in the related repos' name order. Account- and
 * workspace-scoped: the relation must sit in the PR's repo's CURRENT workspace with both repos members
 * of it. `skipRepoKeys` (lower-case owner/name): repos already covered (a ticket peer there IS the companion change).
 */
export async function relatedRepoPeersFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  opts: { skipRepoKeys?: ReadonlySet<string> } = {},
): Promise<RelatedRepoPeer[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = ctx.schema as any;
  const { pullRequests: prs, repos, workspaceRepos, repoRelations } = s;
  try {
    const self = (
      await ctx.db
        .select({ repoId: prs.repoId, title: prs.title, headRefName: prs.headRefName })
        .from(prs)
        .innerJoin(repos, eq(repos.id, prs.repoId))
        .where(and(eq(prs.id, prId), eq(repos.accountId, accountId)))
        .limit(1)
        .execute()
    )[0] as { repoId: number; title: string; headRefName: string | null } | undefined;
    if (!self) return [];
    const membership = (
      await ctx.db
        .select({ workspaceId: workspaceRepos.workspaceId })
        .from(workspaceRepos)
        .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.repoId, self.repoId)))
        .limit(1)
        .execute()
    )[0] as { workspaceId: number } | undefined;
    if (!membership) return [];
    const relRows = (await ctx.db
      .select({ relatedRepoId: repoRelations.relatedRepoId })
      .from(repoRelations)
      .where(
        and(
          eq(repoRelations.accountId, accountId),
          eq(repoRelations.workspaceId, membership.workspaceId),
          eq(repoRelations.repoId, self.repoId),
        ),
      )
      .execute()) as Array<{ relatedRepoId: number }>;
    const relatedIds = [...new Set(relRows.map((r) => r.relatedRepoId))].filter((id) => id !== self.repoId);
    if (relatedIds.length === 0) return [];
    // Only repos that are members of the SAME workspace now (a stale row is never read).
    const repoRows = (await ctx.db
      .select({ id: repos.id, owner: repos.owner, name: repos.name, defaultBranch: repos.defaultBranch })
      .from(repos)
      .innerJoin(workspaceRepos, eq(workspaceRepos.repoId, repos.id))
      .where(
        and(
          eq(repos.accountId, accountId),
          inArray(repos.id, relatedIds),
          eq(workspaceRepos.accountId, accountId),
          eq(workspaceRepos.workspaceId, membership.workspaceId),
        ),
      )
      .execute()) as Array<{ id: number; owner: string; name: string; defaultBranch: string | null }>;
    const related = repoRows
      .filter((r) => !opts.skipRepoKeys?.has(`${r.owner}/${r.name}`.toLowerCase()))
      .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`))
      .slice(0, RELATED_REPOS_MAX_PER_REPO);
    if (related.length === 0) return [];

    const candidates = (await ctx.db
      .select({
        prId: prs.id,
        repoId: prs.repoId,
        number: prs.number,
        title: prs.title,
        headRefName: prs.headRefName,
        headSha: prs.headSha,
        files: prs.files,
      })
      .from(prs)
      .where(
        and(
          eq(prs.accountId, accountId),
          inArray(
            prs.repoId,
            related.map((r) => r.id),
          ),
          eq(prs.state, 'open'),
        ),
      )
      .execute()) as CandidatePr[];

    const branch = self.headRefName?.trim() || null;
    const keys = new Set(ticketKeysOf(self.title, branch));
    const out: RelatedRepoPeer[] = [];
    for (const r of related) {
      const base = { repoId: r.id, owner: r.owner, name: r.name, repoFullName: `${r.owner}/${r.name}` };
      // Newest first, so a tie goes to the latest PR.
      const open = candidates
        .filter((c) => c.repoId === r.id && c.headSha)
        .sort((a, b) => b.number - a.number);
      const asPeer = (c: CandidatePr, match: 'same_branch' | 'same_ticket', shared: string[]): RelatedRepoPeer => ({
        ...base,
        match,
        branch: c.headRefName,
        pr: { prId: c.prId, number: c.number, title: c.title, headSha: c.headSha!, files: filesOf(c.files) },
        ticketKeys: shared,
      });
      // 1. Same head branch name.
      const sameBranch = branch ? open.find((c) => c.headRefName === branch) : undefined;
      if (sameBranch) {
        out.push(asPeer(sameBranch, 'same_branch', ticketKeysOf(sameBranch.title, sameBranch.headRefName).filter((k) => keys.has(k))));
        continue;
      }
      // 2. Same ticket key (most keys shared, then newest).
      if (keys.size > 0) {
        let best: { c: CandidatePr; shared: string[] } | null = null;
        for (const c of open) {
          const shared = ticketKeysOf(c.title, c.headRefName).filter((k) => keys.has(k));
          if (shared.length > 0 && (best == null || shared.length > best.shared.length)) best = { c, shared };
        }
        if (best) {
          out.push(asPeer(best.c, 'same_ticket', best.shared));
          continue;
        }
      }
      // 3. A branch of the same name with no PR (not the default branch itself: that is rule 4).
      const lookup = ctx.github.fetchBranchHeadSha;
      if (branch && branch !== r.defaultBranch && lookup) {
        let sha: string | null = null;
        try {
          sha = await lookup(accountId, { owner: r.owner, name: r.name, branch });
        } catch {
          sha = null;
        }
        if (sha) {
          out.push({ ...base, match: 'branch', branch, pr: null, ticketKeys: [] });
          continue;
        }
      }
      // 4. The default branch, as plain reference.
      out.push({ ...base, match: 'default_branch', branch: r.defaultBranch ?? null, pr: null, ticketKeys: [] });
    }
    return out;
  } catch (err) {
    ctx.log.warn(
      `claude review pr ${prId}: related repos not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
