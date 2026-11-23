import { createHash } from 'node:crypto';
import type {
  ReleaseBlocker,
  ReleaseBlockersPrRef,
  ReleaseBlockersTicketRef,
  ReleaseCheckResult,
  ReleaseRepoCheck,
  ReleaseTagCheck,
  ReleaseTicketCheck,
} from '@pierre-review/shared';

// "EXPLAIN WHAT'S BLOCKING" — THE INPUT (docs/RELEASES.md § Explain what's blocking). PURE: the release
// check the server already folded (shared `foldReleaseCheck`) becomes plain lines for ONE model
// completion, plus the sets of tickets and pull requests the answer may cite. No GitHub, tracker or
// clock read.
//
//   • PER REPOSITORY: the last release, what can be released now, the newest version tag, and the NEWER
//     tags it cannot release, OLDEST FIRST. A newer tag's reasons are WHOLE (they include the ones it
//     inherits from earlier tags), so each listed tag gives its OWN reasons and the CUMULATIVE list of
//     what must be done before it can be released ("Needs"): a split is followed to its ROOT ticket, and
//     a split whose other half is in no tag yet needs a new version tag. Only tags that add a reason of
//     their own are listed (≤ TAGS_PER_REPO), plus the newest — the rest say the same thing.
//   • THE TICKETS that stop a tag (or are split), each with its status, assignee, open pull requests and
//     where it holds a repository back (from which tag); then the tickets whose only work is an open pull
//     request ("not in a tag yet").
//   • ⚠ UNTRUSTED TEXT: titles, statuses, names and tag names come from the tracker and GitHub. The whole
//     text sits inside ONE nonce fence (prompt.ts); here every value is one line and capped.
//   • THE HASH (stale): sha256 over RELEASE_BLOCKERS_VERSION + the text. No `Date.now()`-derived field:
//     dates are the tags' own commit days.

/** Bump with any change to the text or the prompt: every stored report reads stale. */
export const RELEASE_BLOCKERS_VERSION = 1;

const TAGS_PER_REPO = 15;
const TICKETS_MAX = 40;
const PRS_PER_TICKET = 6;

export interface ReleaseBlockersInput {
  /** The check is decided and some repository has newer tags it cannot release. */
  explainable: boolean;
  /** The lines that go inside the fence. */
  text: string;
  hash: string;
  /** Ticket key → the ticket (what the answer may cite). */
  tickets: Map<string, ReleaseBlockersTicketRef>;
  /** "repo #n" → the pull request (what the answer may cite). */
  prs: Map<string, ReleaseBlockersPrRef>;
  /** The releasable repositories' names. */
  repoNames: Set<string>;
  /** Every `#n` the text gives (pull requests and release points named by one). */
  numbers: Set<number>;
  /** "repo #n" for each release point a `prs`-basis repository names by its pull request. */
  releasePoints: Set<string>;
}

const one = (s: string | null | undefined, max = 120): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const day = (iso: string | null | undefined): string | null => (iso != null && iso.length >= 10 ? iso.slice(0, 10) : null);
export const prKey = (repoName: string, number: number): string => `${repoName} #${number}`;

/** The newer tags a repository cannot release, OLDEST first. */
function blockedTags(repo: ReleaseRepoCheck): ReleaseTagCheck[] {
  return repo.tags.filter((t) => !t.isCandidate && t.state === 'does_not_qualify').reverse();
}

/** A repository with something to explain: decided, and newer tags it cannot release. */
function explainableRepo(repo: ReleaseRepoCheck): boolean {
  return !repo.checking && (repo.status === 'candidate' || repo.status === 'none') && blockedTags(repo).length > 0;
}

/** What must be done before a tag can be released, from one of its reasons. */
function needOf(b: ReleaseBlocker): string | null {
  switch (b.kind) {
    case 'not_done':
    case 'open_pr':
      return b.key;
    case 'split':
      if (b.root != null) return b.root.blocker.key;
      return b.tagName == null ? `a new version tag in ${one(b.repoName, 80)} holding ${prKey(one(b.repoName, 80), b.number)}` : null;
    case 'checking':
      return null;
  }
}

/** The ticket a reason is ABOUT at its root (the one to act on). */
function rootIdentOf(b: ReleaseBlocker): string | null {
  if (b.kind === 'not_done' || b.kind === 'open_pr') return b.ident;
  if (b.kind === 'split') return b.root?.blocker.ident ?? null;
  return null;
}

/** One reason as a plain line (no titles: the ticket lines carry them). */
function reasonLine(b: ReleaseBlocker): string {
  const from = b.fromTag != null ? ` (from ${one(b.fromTag, 60)})` : '';
  switch (b.kind) {
    case 'not_done':
      return `${b.key}${from} is ${one(b.statusName, 60) || 'not Complete'}`;
    case 'open_pr':
      return `${b.key}${from} has an open pull request: ${b.prs.map((p) => prKey(one(p.repoName, 80), p.number)).join(', ')}`;
    case 'checking':
      return b.key == null ? 'its history is still being read' : `${b.key}${from} is not read yet`;
    case 'split': {
      const where = b.tagName != null ? `in ${one(b.tagName, 60)}` : 'not in a tag yet';
      const root =
        b.root != null ? `; that tag waits on ${one(b.root.repoName, 80)} ${one(b.root.tagName, 60)}, where ${reasonLine({ ...b.root.blocker, fromTag: null })}` : '';
      return `${b.key}${from} is Complete but would ship without ${prKey(one(b.repoName, 80), b.number)} (${where})${root}`;
    }
  }
}

/** Build the input from the check. Pure. */
export function releaseBlockersInput(check: ReleaseCheckResult): ReleaseBlockersInput {
  const anyChecking = check.repos.some((r) => r.checking);
  const explainable = !anyChecking && check.repos.some(explainableRepo);
  const byIdent = new Map(check.tickets.map((t) => [t.ident, t]));
  const repoById = new Map(check.repos.map((r) => [r.repoId, r]));
  const tickets = new Map<string, ReleaseBlockersTicketRef>();
  const prs = new Map<string, ReleaseBlockersPrRef>();
  const numbers = new Set<number>();
  const releasePoints = new Set<string>();
  const repoNames = new Set(check.repos.map((r) => r.name));
  const prTitle = new Map<string, string>();
  for (const p of check.prs) {
    const r = repoById.get(p.repoId);
    if (r != null) prTitle.set(prKey(r.name, p.number), p.title);
  }
  for (const t of check.tickets) for (const p of t.pullRequests) prTitle.set(prKey(p.repoName, p.number), p.title);
  const addPr = (repoName: string, number: number, url: string, prId: number | null): void => {
    numbers.add(number);
    const k = prKey(repoName, number);
    if (!prs.has(k)) prs.set(k, { repoName, number, title: prTitle.get(k) ?? null, url, prId });
  };
  const addTicket = (ident: string, key: string): void => {
    if (tickets.has(key)) return;
    const t = byIdent.get(ident);
    tickets.set(key, { ident, key, title: t?.title ?? null, url: t?.url ?? null });
  };

  /** ident → per repository, the OLDEST tag it holds back. */
  const holds = new Map<string, Map<string, string>>();
  /** Tickets named by a reason, in first-seen order. */
  const named: string[] = [];
  const note = (ident: string): void => {
    if (!named.includes(ident)) named.push(ident);
  };

  const lines: string[] = [];
  lines.push(`Tracker: ${one(check.trackerName, 40) || 'none'}`);
  for (const repo of check.repos) {
    lines.push('');
    const prsBasis = repo.basis === 'prs';
    lines.push(`Repository: ${one(repo.name, 80)}${prsBasis ? ' (released from merged pull requests: a release point is named by its pull request, e.g. #539)' : ''}`);
    lines.push(`- Last release: ${repo.baseline != null ? one(repo.baseline.name, 60) : 'none yet'}`);
    if (repo.checking || repo.status === 'checking') {
      lines.push('- Still being checked: nothing is decided yet.');
      continue;
    }
    if (repo.status === 'nothing_new') {
      lines.push(repo.nothingNewReason === 'no_tags' ? '- No version tags on main yet.' : '- Nothing new since the last release.');
      continue;
    }
    lines.push(
      `- Can be released now: ${repo.candidate != null ? `${one(repo.candidate.name, 60)}${day(repo.candidate.committedAt) != null ? ` (${day(repo.candidate.committedAt)})` : ''}` : 'nothing'}`,
    );
    if (repo.latestVersion != null) lines.push(`- Newest ${prsBasis ? 'release point' : 'version tag'}: ${one(repo.latestVersion.name, 60)}${day(repo.latestVersion.committedAt) != null ? ` (${day(repo.latestVersion.committedAt)})` : ''}`);
    const blocked = blockedTags(repo);
    if (blocked.length === 0) continue;
    lines.push(`- Newer ${prsBasis ? 'release points' : 'tags'} that cannot be released, oldest first (${blocked.length} in all; releasing one ships everything below it):`);
    const needs: string[] = [];
    let listed = 0;
    let skipped = 0;
    blocked.forEach((tag, i) => {
      for (const b of tag.blockers) {
        const need = needOf(b);
        if (need != null && !needs.includes(need)) needs.push(need);
        const root = rootIdentOf(b);
        if (root != null) {
          note(root);
          const m = holds.get(root) ?? new Map<string, string>();
          if (!m.has(repo.name)) m.set(repo.name, tag.name);
          holds.set(root, m);
        }
        if (b.kind === 'split') {
          note(b.ident);
          addPr(b.repoName, b.number, b.url, null);
        }
        if (b.kind === 'open_pr') for (const p of b.prs) addPr(p.repoName, p.number, p.url, p.prId);
        if (b.kind === 'split' && b.root?.blocker.kind === 'open_pr') for (const p of b.root.blocker.prs) addPr(p.repoName, p.number, p.url, p.prId);
      }
      if (prsBasis) {
        const n = Number(tag.name.replace(/^#/, ''));
        if (Number.isSafeInteger(n)) {
          numbers.add(n);
          releasePoints.add(prKey(repo.name, n));
        }
      }
      const own = tag.blockers.filter((b) => b.fromTag == null && b.kind !== 'checking');
      const newest = i === blocked.length - 1;
      if ((own.length === 0 || listed >= TAGS_PER_REPO) && !newest) {
        skipped += 1;
        return;
      }
      if (skipped > 0) lines.push(`  - (${skipped} more in between, not listed: their reasons are in the lines around them or past the list's limit)`);
      skipped = 0;
      listed += 1;
      const d = day(tag.committedAt);
      const reasons = own.length > 0 ? own.map(reasonLine).join('; ') : 'no reason of its own';
      lines.push(`  - ${one(tag.name, 60)}${d != null ? ` (${d})` : ''}${newest ? ', the newest' : ''}: ${reasons}.`);
      lines.push(`    Needs before it can be released: ${needs.length > 0 ? needs.join(', ') : 'nothing known'}.`);
    });
  }

  // Tickets with only open work (in no tag yet): in flight, they unlock no tag.
  const untagged = check.tickets.filter((t) => t.repos.length === 0 && t.openPrs.length > 0 && !named.includes(t.ident));
  const ticketLine = (t: ReleaseTicketCheck): string => {
    const parts = [`${t.key} “${one(t.title, 120)}”`];
    parts.push(t.cancelled === true ? 'Cancelled' : t.done ? `${one(t.statusName, 60) || 'Complete'} (Complete)` : one(t.statusName, 60) || 'status not read');
    if (t.assigneeName != null) parts.push(`assigned to ${one(t.assigneeName, 60)}`);
    const open = t.pullRequests.filter((p) => p.open).slice(0, PRS_PER_TICKET);
    for (const p of open) addPr(p.repoName, p.number, p.url, p.prId);
    if (open.length > 0) parts.push(`open pull requests: ${open.map((p) => `${prKey(one(p.repoName, 80), p.number)} “${one(p.title, 100)}”`).join(', ')}`);
    const merged = t.pullRequests.filter((p) => !p.open && p.mergedAt != null).slice(0, PRS_PER_TICKET);
    // The text names them, so the answer may cite them too.
    for (const p of merged) addPr(p.repoName, p.number, p.url, p.prId);
    if (merged.length > 0) {
      parts.push(`merged: ${merged.map((p) => `${prKey(one(p.repoName, 80), p.number)} (${p.tagName != null ? `in ${one(p.tagName, 60)}` : 'not in a tag yet'})`).join(', ')}`);
    }
    const h = holds.get(t.ident);
    if (h != null && h.size > 0) parts.push(`holds back: ${[...h.entries()].map(([repo, tag]) => `${one(repo, 80)} from ${one(tag, 60)}`).join(', ')}`);
    return `- ${parts.join(' · ')}`;
  };
  const shownNamed = named.map((i) => byIdent.get(i)).filter((t): t is ReleaseTicketCheck => t != null).slice(0, TICKETS_MAX);
  if (shownNamed.length > 0) {
    lines.push('', 'Tickets that hold a release back:');
    for (const t of shownNamed) {
      addTicket(t.ident, t.key);
      lines.push(ticketLine(t));
    }
  }
  const shownUntagged = untagged.slice(0, Math.max(0, TICKETS_MAX - shownNamed.length));
  if (shownUntagged.length > 0) {
    lines.push('', 'In flight, not in a tag yet (only an open pull request):');
    for (const t of shownUntagged) {
      addTicket(t.ident, t.key);
      lines.push(ticketLine(t));
    }
  }
  // Every ticket a listed reason names may be cited (also past the ticket lines' cap).
  for (const repo of check.repos) {
    for (const tag of blockedTags(repo)) {
      for (const b of tag.blockers) {
        if (b.kind === 'checking') continue;
        addTicket(b.ident, b.key);
        if (b.kind === 'split' && b.root != null) addTicket(b.root.blocker.ident, b.root.blocker.key);
      }
    }
  }
  const text = lines.join('\n');
  const hash = createHash('sha256').update(`v${RELEASE_BLOCKERS_VERSION}\n${text}`).digest('hex');
  return { explainable, text, hash, tickets, prs, repoNames, numbers, releasePoints };
}
