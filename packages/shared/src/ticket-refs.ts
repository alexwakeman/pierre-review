import { GITHUB_TRACKER_ROOT, canonicalTicketKey, githubIssueKey, isGithubIssueKey, jiraApiRoot, linearSiteRoot } from './claude-review.js';
import type { TrackerProvider } from './types.js';

// ── PASTED TICKET REFERENCES (docs/TRACKERS.md § Adding a ticket by hand) ──────────────────────────
//
// The Story check's paste box takes one or more ticket URLs or keys — `PROJ-123`, `owner/repo#12`,
// `#12`, `https://acme.atlassian.net/browse/PROJ-123`, `https://github.com/o/r/issues/12`,
// `https://linear.app/acme/issue/ENG-4/slug` — and the server links each one it can read to the PR.
// This file is the ONE parser: the SPA runs it to draw chips, the server runs it again on what the
// request carries (`POST /api/prs/:id/tracker-ticket/resolve`) and decides against the PR's
// WORKSPACE tracker. Roots go through the shared folds (`jiraApiRoot`, `linearSiteRoot`,
// `GITHUB_TRACKER_ROOT`) — never a second copy.

/** The most references one request (and one paste box) carries. */
export const TICKET_REFS_MAX = 10;
/** The longest single reference accepted. */
export const TICKET_REF_MAX_CHARS = 2000;

export type ParsedTicketRef =
  // A bare key: `PROJ-123` (Jira or Linear — the workspace decides) or `owner/repo#12` (GitHub).
  | { kind: 'key'; shape: 'prefix' | 'github'; key: string }
  // `#12` — an issue in the pull request's own repository (GitHub Issues only).
  | { kind: 'issue_number'; number: number }
  // A link. `loose`: a Jira board link (`?selectedIssue=KEY`) or a Jira Cloud issue view
  // (`…/issues/KEY`) whose root is only the host — it matches a workspace whose site starts there.
  | { kind: 'url'; provider: 'jira' | 'github' | 'linear'; root: string; key: string; loose: boolean }
  | { kind: 'invalid' };

/** Split a paste into references: commas, semicolons and whitespace separate; duplicates go. */
export function splitTicketRefs(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/[\s,;]+/)) {
    const raw = part.trim().replace(/^[<(]+|[>).]+$/g, '');
    if (raw === '') continue;
    const k = refDedupeKey(raw);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(raw);
  }
  return out;
}

/** Two spellings of the same reference compare equal (case, a trailing slash). */
export function refDedupeKey(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}

const URL_RE = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?(#\S*)?$/i;
const PREFIX_KEY_RE = /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/;

/** One reference → what it names. Pure; never throws. */
export function parseTicketRef(input: string): ParsedTicketRef {
  const raw = (input ?? '').trim();
  if (raw === '' || raw.length > TICKET_REF_MAX_CHARS) return { kind: 'invalid' };
  const num = /^#(\d{1,9})$/.exec(raw);
  if (num) return { kind: 'issue_number', number: Number(num[1]) };
  const u = URL_RE.exec(raw);
  if (u == null) {
    const key = canonicalTicketKey(raw);
    if (key == null) return { kind: 'invalid' };
    return { kind: 'key', shape: isGithubIssueKey(key) ? 'github' : 'prefix', key };
  }
  const scheme = u[1]!.toLowerCase();
  const host = u[2]!.toLowerCase();
  const segs = (u[3] ?? '').split('/').filter((s) => s !== '');
  if (host === 'github.com' || host === 'www.github.com') {
    // /owner/repo/issues/12 — a pull request link is not an issue.
    if (segs.length < 4 || segs[2]!.toLowerCase() !== 'issues' || !/^\d{1,9}$/.test(segs[3]!)) return { kind: 'invalid' };
    const key = githubIssueKey(`${segs[0]}/${segs[1]}`, Number(segs[3]));
    return key == null ? { kind: 'invalid' } : { kind: 'url', provider: 'github', root: GITHUB_TRACKER_ROOT, key, loose: false };
  }
  if (host === 'linear.app' || host === 'www.linear.app') {
    // /<workspace>/issue/ENG-4[/slug]
    const root = linearSiteRoot(raw);
    const key = segs.length >= 3 && segs[1]!.toLowerCase() === 'issue' ? segs[2]!.toUpperCase() : '';
    return root != null && PREFIX_KEY_RE.test(key)
      ? { kind: 'url', provider: 'linear', root, key, loose: false }
      : { kind: 'invalid' };
  }
  // Anything else is read as a Jira link: `<root>/browse/KEY`, `…/issues/KEY`, or a board's `?selectedIssue=KEY`.
  const at = segs.findIndex((s) => s.toLowerCase() === 'browse');
  if (at >= 0 && segs[at + 1] != null) {
    const key = decodeSafe(segs[at + 1]!).toUpperCase();
    const root = jiraApiRoot(raw);
    if (root != null && PREFIX_KEY_RE.test(key)) return { kind: 'url', provider: 'jira', root, key, loose: false };
    return { kind: 'invalid' };
  }
  // Jira Cloud's own issue view: `/jira/software/projects/PROJ/issues/PROJ-123`, the `/c/` and
  // service-desk / core spellings alike. Like the board link, its root is only the host (loose).
  const iss = segs.findIndex((s) => s.toLowerCase() === 'issues');
  if (iss >= 0 && segs[iss + 1] != null) {
    const key = decodeSafe(segs[iss + 1]!).toUpperCase();
    if (PREFIX_KEY_RE.test(key)) return { kind: 'url', provider: 'jira', root: `${scheme}://${host}`, key, loose: true };
  }
  const sel = /[?&]selectedIssue=([^&]+)/i.exec(u[4] ?? '');
  if (sel) {
    const key = decodeSafe(sel[1]!).toUpperCase();
    if (PREFIX_KEY_RE.test(key)) return { kind: 'url', provider: 'jira', root: `${scheme}://${host}`, key, loose: true };
  }
  return { kind: 'invalid' };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** What happened to one pasted reference. */
export type TicketRefStatus =
  // Read from the tracker (not linked yet — the box's preview).
  | 'found'
  // Linked to the pull request by hand (stored), and readable.
  | 'linked'
  // Already a ticket of this pull request (named in its title or branch, or linked before).
  | 'already'
  | 'not_found'
  | 'no_access'
  // A link or key for another tracker or another site than this workspace's.
  | 'other_tracker'
  | 'invalid'
  // The tracker could not be read just now.
  | 'failed';

export interface TicketRefResult {
  /** The reference as it was sent. */
  ref: string;
  status: TicketRefStatus;
  /** The key as the tracker stores it (`PROJ-123`, `owner/repo#12`); null when none was parsed. */
  key: string | null;
  /** The ticket's ident (`<provider>:<root>#<KEY>`) — what a ticket review starts with. */
  ident: string | null;
  title: string | null;
  /** The ticket's link (https only). */
  url: string | null;
  /** One plain sentence for anything but found / linked / already. */
  message: string | null;
}

/** `POST /api/prs/:id/tracker-ticket/resolve`. `link: false` only reads (the chips' preview). */
export interface ResolveTicketRefsBody {
  refs: string[];
  link: boolean;
}

export interface ResolveTicketRefsResponse {
  prId: number;
  provider: TrackerProvider;
  results: TicketRefResult[];
}
