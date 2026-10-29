import { and, eq, inArray } from 'drizzle-orm';
import { RELATED_REPOS_MAX_PER_REPO } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
// detect.ts is pure (no DB at import), so it is safe to import here; tracker/runtime.ts is not.
import { extractTicketKeys, parseProjectKeys } from '../../tracker/detect.js';

// THE COMPANION CHANGE IN EACH RELATED REPO (docs/CLAUDE-REVIEW.md § Related repos), for a DEEP
// review's peers. The reader relates repos of one workspace in Settings (db/related-repos.ts); for a
// PR in one, each related repo yields AT MOST ONE peer, the first rule that matches:
//
//   1. an OPEN PR there whose head branch has the same name as this PR's        → 'same_branch'
//   2. an OPEN PR there whose title or branch carries one of this PR's ticket keys → 'same_ticket'
//   3. a BRANCH there of the same name, with no PR (one GitHub read)           → 'branch'
//   4. the repo's DEFAULT BRANCH, as plain reference                             → 'default_branch'
//
// DB only, except rule 3's one branch read per related repo (and only when 1 and 2 found nothing, and
// only while the review still has a slot for it: `maxChanges`). Never throws: peer context is
// optional; a failure costs the peer, never the review.
//
// ⚠ RULE 2'S KEYS ARE GUARDED (`sharedTicketKeys`). A lower-case branch key (`bmd-1048-…`) is
// structurally the same as an ordinary `word-number` branch (`fix-2-login`, `node-18`), the tracker's
// largest false-positive source (tracker/detect.ts). So: with the workspace's project keys set, only
// those prefixes count (exact, any case, title or branch); without them a shared key counts only when
// at least ONE of the two PRs writes it in upper case in its TITLE, as the tracker itself reads a
// title. `fix-2-login` and `fix-2-timeout` therefore never match each other.

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

/** Every ticket key a title or branch name carries. With the workspace's project keys
 *  (`allowKeys`), the tracker's exact reading of both (any case). Without them, the title as the
 *  tracker reads it (upper case only) plus the branch read UPPER-CASED, so a lower-case branch key
 *  (`bmd-1048-created-area-edit`) counts — which is why a match also needs `titleTicketKeysOf` on one
 *  side (`sharedTicketKeys`). */
export function ticketKeysOf(
  title: string | null | undefined,
  branch: string | null | undefined,
  allowKeys: readonly string[] | null = null,
): string[] {
  if (allowKeys && allowKeys.length > 0) return extractTicketKeys(title, branch, allowKeys, 'title_branch');
  const out = new Set<string>(extractTicketKeys(title, null));
  if (branch) for (const k of extractTicketKeys(branch.toUpperCase(), null)) out.add(k);
  return [...out];
}

/** The keys a TITLE names deliberately: written in upper case (or allow-listed), as the tracker reads
 *  a title. */
export function titleTicketKeysOf(title: string | null | undefined, allowKeys: readonly string[] | null = null): string[] {
  return extractTicketKeys(title, null, allowKeys && allowKeys.length > 0 ? allowKeys : null);
}

/** The ticket keys two PRs share, guarded (see the header): with project keys, any shared allow-listed
 *  key; without, only a shared key that at least one of the two titles writes in upper case. */
export function sharedTicketKeys(
  a: { title: string | null | undefined; branch: string | null | undefined },
  b: { title: string | null | undefined; branch: string | null | undefined },
  allowKeys: readonly string[] | null = null,
): string[] {
  const mine = new Set(ticketKeysOf(a.title, a.branch, allowKeys));
  const shared = ticketKeysOf(b.title, b.branch, allowKeys).filter((k) => mine.has(k));
  if (allowKeys && allowKeys.length > 0) return shared;
  const deliberate = new Set([...titleTicketKeysOf(a.title), ...titleTicketKeysOf(b.title)]);
  return shared.filter((k) => deliberate.has(k));
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

export interface RelatedRepoPeersOptions {
  // Repos already covered (lower-case owner/name): a ticket peer there IS the companion change.
  skipRepoKeys?: ReadonlySet<string>;
  // The review's shared peer cap. Each COVERED related repo takes one slot ahead of these changes
  // (reviewPeersFor leads with it), so at most `maxPeers − covered` changes are looked for; once that
  // many are found the walk stops — no rule-3 GitHub read is spent on a peer the cap would drop.
  maxPeers?: number;
}

export interface RelatedRepoCompanions {
  peers: RelatedRepoPeer[];
  // The related repos that `skipRepoKeys` covered (lower-case owner/name), so the caller can lead with
  // their ticket peers.
  coveredRepoKeys: string[];
}

/**
 * The related repos' companion changes for this PR, in the related repos' name order. Account- and
 * workspace-scoped: the relation must sit in the PR's repo's CURRENT workspace with both repos members
 * of it.
 */
export async function relatedRepoPeersFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  opts: RelatedRepoPeersOptions = {},
): Promise<RelatedRepoPeer[]> {
  return (await relatedRepoCompanions(ctx, accountId, prId, opts)).peers;
}

export interface RelatedRepoScope {
  // The PR's own repo, and its CURRENT workspace.
  self: {
    repoId: number;
    owner: string;
    name: string;
    title: string;
    headRefName: string | null;
    workspaceId: number;
  };
  // The repos related to it in that workspace, each a member of it NOW (any order).
  related: Array<{ id: number; owner: string; name: string; defaultBranch: string | null }>;
}

/**
 * The relation set of a PR's repo: the PR's repo, its current workspace, and the repos related to it
 * there (both members of that workspace now; a stale row is never read). Account-scoped. null when
 * the PR is not this account's or its repo has no workspace. Throws on a DB error (callers catch).
 * The ONE reading of the relation, shared by the companion walk and the replies pass's linked PRs.
 */
export async function relatedRepoScope(ctx: AgentContext, accountId: number, prId: number): Promise<RelatedRepoScope | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = ctx.schema as any;
  const { pullRequests: prs, repos, workspaceRepos, repoRelations } = s;
  const self = (
    await ctx.db
      .select({ repoId: prs.repoId, title: prs.title, headRefName: prs.headRefName, owner: repos.owner, name: repos.name })
      .from(prs)
      .innerJoin(repos, eq(repos.id, prs.repoId))
      .where(and(eq(prs.id, prId), eq(repos.accountId, accountId)))
      .limit(1)
      .execute()
  )[0] as { repoId: number; title: string; headRefName: string | null; owner: string; name: string } | undefined;
  if (!self) return null;
  const membership = (
    await ctx.db
      .select({ workspaceId: workspaceRepos.workspaceId })
      .from(workspaceRepos)
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.repoId, self.repoId)))
      .limit(1)
      .execute()
  )[0] as { workspaceId: number } | undefined;
  if (!membership) return null;
  const out: RelatedRepoScope = { self: { ...self, workspaceId: membership.workspaceId }, related: [] };
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
  if (relatedIds.length === 0) return out;
  // Only repos that are members of the SAME workspace now (a stale row is never read).
  out.related = (await ctx.db
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
    .execute()) as RelatedRepoScope['related'];
  return out;
}

/** `relatedRepoPeersFor`, plus which related repos a ticket peer already covers. Never throws. */
export async function relatedRepoCompanions(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  opts: RelatedRepoPeersOptions = {},
): Promise<RelatedRepoCompanions> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = ctx.schema as any;
  const { pullRequests: prs, workspaceTrackers } = s;
  const none: RelatedRepoCompanions = { peers: [], coveredRepoKeys: [] };
  try {
    const scope = await relatedRepoScope(ctx, accountId, prId);
    if (!scope) return none;
    const { self, related: repoRows } = scope;
    const membership = { workspaceId: self.workspaceId };
    const keyOf = (r: { owner: string; name: string }): string => `${r.owner}/${r.name}`.toLowerCase();
    const sorted = repoRows.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
    const coveredRepoKeys = sorted.filter((r) => opts.skipRepoKeys?.has(keyOf(r))).map(keyOf);
    const related = sorted.filter((r) => !opts.skipRepoKeys?.has(keyOf(r))).slice(0, RELATED_REPOS_MAX_PER_REPO);
    // How many changes the review can still use (see RelatedRepoPeersOptions.maxPeers).
    const maxChanges = opts.maxPeers == null ? Infinity : Math.max(0, opts.maxPeers - coveredRepoKeys.length);
    if (related.length === 0 || maxChanges === 0) return { peers: [], coveredRepoKeys };

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

    // The workspace's project keys make rule 2 exact (tracker/detect.ts); none ⇒ the guarded fallback.
    // A failed read costs the precision only (the guarded fallback still applies), never the peers.
    let allowKeys: string[] = [];
    try {
      const trackerRow = (
        await ctx.db
          .select({ projectKeys: workspaceTrackers.projectKeys })
          .from(workspaceTrackers)
          .where(and(eq(workspaceTrackers.accountId, accountId), eq(workspaceTrackers.workspaceId, membership.workspaceId)))
          .limit(1)
          .execute()
      )[0] as { projectKeys: string | null } | undefined;
      allowKeys = parseProjectKeys(trackerRow?.projectKeys ?? null);
    } catch {
      allowKeys = [];
    }

    const branch = self.headRefName?.trim() || null;
    const me = { title: self.title, branch };
    const out: RelatedRepoPeer[] = [];
    let changes = 0;
    for (const r of related) {
      // The cap is full: every later change would be dropped, so read no more (no rule-3 GitHub read).
      if (changes >= maxChanges) break;
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
        out.push(asPeer(sameBranch, 'same_branch', sharedTicketKeys(me, { title: sameBranch.title, branch: sameBranch.headRefName }, allowKeys)));
        changes++;
        continue;
      }
      // 2. Same ticket key, guarded (the header; most keys shared, then newest).
      let best: { c: CandidatePr; shared: string[] } | null = null;
      for (const c of open) {
        const shared = sharedTicketKeys(me, { title: c.title, branch: c.headRefName }, allowKeys);
        if (shared.length > 0 && (best == null || shared.length > best.shared.length)) best = { c, shared };
      }
      if (best) {
        out.push(asPeer(best.c, 'same_ticket', best.shared));
        changes++;
        continue;
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
          changes++;
          continue;
        }
      }
      // 4. The default branch, as plain reference.
      out.push({ ...base, match: 'default_branch', branch: r.defaultBranch ?? null, pr: null, ticketKeys: [] });
    }
    return { peers: out, coveredRepoKeys };
  } catch (err) {
    ctx.log.warn(
      `claude review pr ${prId}: related repos not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return none;
  }
}
