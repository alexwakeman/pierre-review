import { and, eq, inArray } from 'drizzle-orm';
import type { ReviewRunPeer } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';
import type { PriorFindingForFollowUp } from './follow-up.js';
import { relatedRepoScope } from './related-repos.js';
import { judgeableReplies } from './reply-text.js';

// THE PULL REQUESTS A REPLY POINTS TO (docs/CLAUDE-REVIEW.md § The replies pass). "Fixed on the
// backend in DEFRA/bng-metric-backend#556" can only be checked against #556's code, so the replies
// pass checks that PR out, read-only, beside the PR's own: its HEAD while it is open, the DEFAULT
// BRANCH once it is merged (what it landed). A closed, unmerged PR fixed nothing and is ignored.
//
// ⚠ A REPLY IS UNTRUSTED TEXT. The scanner reads a bounded prefix of each reply with three patterns
// whose every quantifier is bounded (no nesting, no unbounded repetition), so it is linear in the
// text; it returns at most LINKS_PER_REPLY links per reply. A link counts ONLY when it names the
// PR's own repo or a repo RELATED to it in the PR's current workspace (`relatedRepoScope`), and only
// when Limn has that PR stored: nothing here ever makes Limn fetch an arbitrary repository. At most
// REPLIES_LINKED_PR_MAX linked PRs per pass, the most severe thread's newest reply first.

/** At most this many linked PRs are checked out per pass. */
export const REPLIES_LINKED_PR_MAX = 2;
/** How much of one reply the scanner reads. */
export const LINK_SCAN_CHARS = 10_000;
/** At most this many links are taken from one reply. */
export const LINKS_PER_REPLY = 8;

/** One link as written: owner and name are absent when the reply left them out (`name#N`, `#N`). */
export interface PrLink {
  owner: string | null;
  name: string | null;
  number: number;
}

// GitHub's own limits: a login is ≤ 39 characters, a repo name ≤ 100, and a PR number here ≤ 7 digits.
const OWNER = '[A-Za-z0-9-]{1,39}';
const NAME = '[A-Za-z0-9._-]{1,100}';
const NUM = '[0-9]{1,7}';
// https://github.com/owner/name/pull/N
const URL_RE = new RegExp(`github\\.com/(${OWNER})/(${NAME})/pull/(${NUM})(?![0-9])`, 'gi');
// owner/name#N or name#N, not glued to a word or a path before it.
const QUALIFIED_RE = new RegExp(`(?<![A-Za-z0-9._/-])(?:(${OWNER})/)?(${NAME})#(${NUM})(?![A-Za-z0-9_])`, 'g');
// #N on its own (this PR's repo), not glued to a word before it (`abc#1`, `##1`, a URL fragment).
const BARE_RE = new RegExp(`(?<![A-Za-z0-9._/#&-])#(${NUM})(?![A-Za-z0-9_])`, 'g');

/**
 * The PR links in one reply, in the order they appear, deduplicated, at most LINKS_PER_REPLY. Pure,
 * linear and bounded (see the header).
 */
export function extractPrLinks(text: string): PrLink[] {
  const t = text.slice(0, LINK_SCAN_CHARS);
  const found: Array<PrLink & { at: number }> = [];
  for (const m of t.matchAll(URL_RE)) found.push({ owner: m[1]!, name: m[2]!, number: Number(m[3]), at: m.index ?? 0 });
  for (const m of t.matchAll(QUALIFIED_RE)) {
    found.push({ owner: m[1] ?? null, name: m[2]!, number: Number(m[3]), at: m.index ?? 0 });
  }
  for (const m of t.matchAll(BARE_RE)) found.push({ owner: null, name: null, number: Number(m[1]), at: m.index ?? 0 });
  found.sort((a, b) => a.at - b.at);
  const out: PrLink[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (!(f.number > 0)) continue;
    const key = `${f.owner ?? ''}/${f.name ?? ''}#${f.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner: f.owner, name: f.name, number: f.number });
    if (out.length >= LINKS_PER_REPLY) break;
  }
  return out;
}

/** A repo a link may name: the PR's own, or one related to it. */
export interface LinkableRepo {
  repoId: number;
  owner: string;
  name: string;
  defaultBranch: string | null;
}

/**
 * Which allowed repo a link names, or null. `owner/name#N` and a URL must name an allowed repo
 * exactly (any case); `name#N` an allowed repo of the PR's own owner; `#N` the PR's own repo. Pure.
 */
export function repoOfLink(link: PrLink, self: LinkableRepo, allowed: readonly LinkableRepo[]): LinkableRepo | null {
  const lc = (s: string): string => s.toLowerCase();
  if (link.name == null) return self;
  const owner = link.owner ?? self.owner;
  return [self, ...allowed].find((r) => lc(r.owner) === lc(owner) && lc(r.name) === lc(link.name!)) ?? null;
}

/** A linked PR the pass checks out. */
export interface LinkedPr {
  // L1, L2 — its ref in the prompt and its checkout's.
  ref: string;
  prId: number;
  repoId: number;
  owner: string;
  name: string;
  repoFullName: string;
  number: number;
  title: string;
  state: 'open' | 'merged';
  // Open: its head commit (checked out there). Merged: null (the default branch is checked out).
  headSha: string | null;
  defaultBranch: string | null;
  // The threads (finding ids) whose replies link it.
  findingIds: number[];
}

/** The linked PR as a checkout request (`checkOutPeers`): open → its head, merged → the default branch. */
export function linkedRunPeer(l: LinkedPr): ReviewRunPeer {
  return l.state === 'open' && l.headSha
    ? { ref: l.ref, owner: l.owner, name: l.name, prNumber: l.number, headSha: l.headSha }
    : { ref: l.ref, owner: l.owner, name: l.name, kind: 'default_branch', branch: l.defaultBranch };
}

/** The linked PRs each thread's replies point to, by finding id (refs only those that were kept). */
export function linkedRefsByFinding(linked: readonly LinkedPr[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const l of linked) {
    for (const id of l.findingIds) out.set(id, [...(out.get(id) ?? []), l.ref]);
  }
  return out;
}

/**
 * The PRs the judged replies link to, at most REPLIES_LINKED_PR_MAX, refs L1… in priority order:
 * `findings` in the order the pass sends them, each thread's NEWEST person's reply first. Only the
 * PR's own repo and its related repos (in its current workspace); only PRs Limn has stored, open or
 * merged, and never the PR itself. DB only. Never throws: a failure costs the linked PRs, never the
 * pass.
 */
export async function linkedPrsFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  findings: readonly PriorFindingForFollowUp[],
): Promise<LinkedPr[]> {
  try {
    // Every thread's links first (pure), so a pass with no links reads nothing more.
    const perThread = findings.map((f) => ({
      findingId: f.id,
      links: [...judgeableReplies(f.thread?.replies)]
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .flatMap((r) => extractPrLinks(r.body)),
    }));
    if (perThread.every((t) => t.links.length === 0)) return [];
    const scope = await relatedRepoScope(ctx, accountId, prId);
    if (!scope) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { pullRequests: prs, repos } = ctx.schema as any;
    const selfRepo = (
      await ctx.db
        .select({ defaultBranch: repos.defaultBranch })
        .from(repos)
        .where(and(eq(repos.id, scope.self.repoId), eq(repos.accountId, accountId)))
        .limit(1)
        .execute()
    )[0] as { defaultBranch: string | null } | undefined;
    const self: LinkableRepo = {
      repoId: scope.self.repoId,
      owner: scope.self.owner,
      name: scope.self.name,
      defaultBranch: selfRepo?.defaultBranch ?? null,
    };
    const allowed: LinkableRepo[] = scope.related.map((r) => ({ repoId: r.id, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch }));
    // Resolve each link to an allowed repo; the wanted (repo, number) pairs, in priority order.
    const wanted: Array<{ repo: LinkableRepo; number: number; findingId: number }> = [];
    for (const t of perThread) {
      for (const l of t.links) {
        const repo = repoOfLink(l, self, allowed);
        if (repo) wanted.push({ repo, number: l.number, findingId: t.findingId });
      }
    }
    if (wanted.length === 0) return [];
    const rows = (await ctx.db
      .select({ id: prs.id, repoId: prs.repoId, number: prs.number, title: prs.title, state: prs.state, headSha: prs.headSha })
      .from(prs)
      .where(
        and(
          eq(prs.accountId, accountId),
          inArray(prs.repoId, [...new Set(wanted.map((w) => w.repo.repoId))]),
          inArray(prs.number, [...new Set(wanted.map((w) => w.number))]),
        ),
      )
      .execute()) as Array<{ id: number; repoId: number; number: number; title: string | null; state: string; headSha: string | null }>;
    const byKey = new Map(rows.map((r) => [`${r.repoId}#${r.number}`, r]));
    const out: LinkedPr[] = [];
    for (const w of wanted) {
      const row = byKey.get(`${w.repo.repoId}#${w.number}`);
      if (!row || row.id === prId) continue;
      if (row.state !== 'merged' && !(row.state === 'open' && row.headSha)) continue;
      const have = out.find((o) => o.prId === row.id);
      if (have) {
        if (!have.findingIds.includes(w.findingId)) have.findingIds.push(w.findingId);
        continue;
      }
      if (out.length >= REPLIES_LINKED_PR_MAX) continue;
      out.push({
        ref: `L${out.length + 1}`,
        prId: row.id,
        repoId: w.repo.repoId,
        owner: w.repo.owner,
        name: w.repo.name,
        repoFullName: `${w.repo.owner}/${w.repo.name}`,
        number: row.number,
        title: row.title ?? '',
        state: row.state === 'open' ? 'open' : 'merged',
        headSha: row.state === 'open' ? row.headSha : null,
        defaultBranch: w.repo.defaultBranch,
        findingIds: [w.findingId],
      });
    }
    return out;
  } catch (err) {
    ctx.log.warn(`replies check pr ${prId}: linked PRs not read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
