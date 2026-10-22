import type { DigestPrRef } from '@pierre-review/shared';
import { escapeSlack, slackLinkText } from './links.js';

// ── MODEL MARKDOWN → SLACK mrkdwn, WITH EVERY PR REFERENCE A LIMN LINK ──────────────────────
//
// The Haiku summaries (the sprint report and the per-repo digests) are GitHub-flavoured markdown.
// Slack mrkdwn has no headings or tables, uses *bold*, • bullets and `<url|text>` links, and has
// exactly three special characters (& < >). This module is PURE — no ctx, no I/O — and the caller
// hands it the link builders, so it never decides where a link points.
//
// ⚠ EVERY LINK POINTS INTO LIMN. A PR reference becomes `opts.prUrl(ref)` (slack/links.ts
// `prLink`, built from the ref's LOCAL prId); with no URL it is plain text — never a github.com
// fallback. A github.com URL the model wrote is rewritten to text BEFORE anything else runs
// (`neutraliseLinks`): a PR/issue URL becomes its `owner/name#N` token, which the next step links
// when it resolves, and anything else becomes plain text.
//
// ⚠ A PR NUMBER RESOLVES TO A LOCAL ID ONLY WITHIN (accountId, repoId). A qualified
// `owner/name#N` resolves by its exact key. A bare `#N` resolves ONLY against the section's own
// repo (`opts.repoFullName`, a per-repo digest) or the `**owner/name**` heading it sits under;
// anywhere else it stays plain text, so the cross-repo sprint summary never guesses between two
// repositories' #12. The old formatter took the first ref with that number across ALL repos.
//
// ⚠ UNTRUSTED TEXT. Model output and PR titles are attacker-influenced, so every character that
// is not link markup this module built goes through `escapeSlack` — nothing can forge a link or
// write `<!channel>`. The caller also marks every mrkdwn object `verbatim: true` (slack/report.ts).
//
// Each PR's FIRST mention in a line reads `#123 Title by @login` — the prompts tell the model not
// to write titles or authors (HEADLINES_SYSTEM promises the app renders them), and this is the
// render that keeps that promise in Slack. A repeat mention in the same line is a bare link.
//
// ⚠ A LINE NAMING MANY PRs LISTS THEM, ONE PER SUB-LINE. HEADLINES_SYSTEM tells the model to put
// every PR of a shared theme on ONE bullet ("awaiting review #1 #2 #3", no upper bound — a real
// digest carries 16 on one line). Inline, each titled reference is ~150 characters, so twenty of
// them made one line longer than a Slack section: `fitSections` cut it mid-list and the cut line
// filled the repo's section cap, so later PRs AND the next bullet were lost with only a `…` to show
// for it. From LIST_MIN_REFS titled PRs up, the sentence keeps its numbers as plain text and each PR
// gets its own `◦ <url|#N Title> by @login` line beneath it — the same shape the SPA gives a
// multi-PR bullet (its tokens beside the text) — so a section split falls BETWEEN references.

/** A title longer than this is cut to TITLE_MAX - 1 characters plus `…`. */
const TITLE_MAX = 80;
/** A title at least this long that the line already contains is not printed a second time. */
const TITLE_DEDUPE_MIN = 12;
/** A line naming at least this many PRs that carry a title or author lists them one per sub-line. */
const LIST_MIN_REFS = 4;
/** The sub-line marker, indented under the line it belongs to. */
const SUB_BULLET = '    ◦ ';

const REPO_SRC = '[A-Za-z0-9][\\w.-]*\\/[A-Za-z0-9][\\w.-]*';
// Qualified `owner/name#N` first (group 1 = repo, 2 = number), else a bare `#N` (group 3). The
// bare form refuses a preceding word char, `/` (a path) or `&` (an HTML entity like `&#39;`).
// Built fresh per line: a shared global regex carries `lastIndex` between calls.
const TOKEN_SRC = `(?<![\\w/.-])(${REPO_SRC})#(\\d+)\\b|(?<![\\w/&#])#(\\d+)\\b`;
// Another PR token follows after whitespace only — the comma rule (`#1 #2 #3` → `#1 …, #2 …`).
const NEXT_TOKEN_RE = new RegExp(`^[ \\t]+(?:${REPO_SRC})?#\\d`);
// A line that is only a repo name — bold (after the bold conversion) or plain, optionally with a
// colon: `*acme/api*`, `*acme/api:*`, `acme/api:`. It is linked, and opens that repo's scope.
const REPO_HEADING_RE = new RegExp(`^(\\*?)(${REPO_SRC}):?\\1:?$`);
// A line that OPENS with a bold repo name ("*acme/web* — 3 items") also switches the scope, so a
// bare #N under it is never credited to the PREVIOUS heading's repo.
const REPO_LEAD_RE = new RegExp(`^\\*(${REPO_SRC}):?\\*`);
// Any other line opening in bold ("*Action items*", the headline) ends a repo heading's scope.
const BOLD_LEAD_RE = /^\*[^*\s][^*]*\*/;
const MD_AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/gi;
const MD_LINK_RE = /!?\[([^\]]+)\]\(([^)\s]+)\)/g;
const GITHUB_URL_RE =
  /(?<![\w.-])(?:https?:\/\/)?((?:[\w-]+\.)*github\.com)(?![\w-]|\.[\w-])(\/[^\s)\]<>|"'`*]*)?/gi;
const GITHUB_ITEM_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/(?:pull|pulls|issues)\/(\d+)/i;
const GH_NAME_RE = /^[A-Za-z0-9][\w.-]*$/;

export interface SlackFormatOptions {
  /** The Limn deep link for a resolved ref; null → the reference is plain text. */
  prUrl: (ref: DigestPrRef) => string | null;
  /** Links a `**owner/name**` heading line into Limn. Omitted → headings stay text. */
  repoUrl?: (repoId: number) => string | null;
  /** The ONE repo a per-repo digest section is about: every bare `#N` in it belongs to it. */
  repoFullName?: string;
}

const refKey = (repoFullName: string, prNumber: number): string =>
  `${repoFullName.toLowerCase()}#${prNumber}`;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── github.com URLs → text ─────────────────────────────────────────────────────────────────

function ghRepo(owner: string, name: string): string | null {
  const n = name.replace(/\.+$/, '');
  return GH_NAME_RE.test(owner) && GH_NAME_RE.test(n) ? `${owner}/${n}` : null;
}

// A PR or issue URL keeps its `owner/name#N` token (GitHub numbers issues and PRs from one
// sequence per repo, so an issue number never resolves to a PR and stays plain). A repo URL keeps
// `owner/name`; anything else is the word "GitHub".
function githubUrlToText(host: string, path: string): string {
  const h = host.toLowerCase();
  if (h !== 'github.com' && h !== 'www.github.com') return 'GitHub';
  const segs = path
    .replace(/[?#].*$/, '')
    .split('/')
    .filter((s) => s !== '');
  if (segs.length === 0) return 'GitHub';
  if (segs.length === 1) return GH_NAME_RE.test(segs[0] ?? '') ? (segs[0] ?? '') : 'GitHub';
  const repo = ghRepo(segs[0] ?? '', segs[1] ?? '');
  if (repo == null) return 'GitHub';
  const kind = segs[2]?.toLowerCase();
  if ((kind === 'pull' || kind === 'pulls' || kind === 'issues') && /^\d+$/.test(segs[3] ?? '')) {
    return `${repo}#${segs[3]}`;
  }
  return repo;
}

function neutraliseBareGithub(s: string): string {
  return s.replace(GITHUB_URL_RE, (_m, host: string, path: string | undefined) => {
    const p = path ?? '';
    const trail = /[.,;:!?]+$/.exec(p)?.[0] ?? '';
    return githubUrlToText(host, trail ? p.slice(0, -trail.length) : p) + trail;
  });
}

// Runs on the RAW model text, before escaping, so no github.com URL survives as a URL. Defensive:
// SPRINT_SYSTEM forbids markdown links and neither grounding payload carries a URL.
function neutraliseLinks(md: string): string {
  const unlinked = md
    .replace(MD_AUTOLINK_RE, '$1')
    .replace(MD_LINK_RE, (_m, text: string, url: string) => {
      const item = GITHUB_ITEM_URL_RE.exec(url);
      if (item) {
        const repo = ghRepo(item[1] ?? '', item[2] ?? '');
        if (repo != null) return `${repo}#${item[3] ?? ''}`;
      }
      return text;
    });
  return neutraliseBareGithub(unlinked);
}

// ── markdown → mrkdwn, one line at a time (raw text; escaping happens at render) ─────────────

function convertLine(line: string): string {
  let l = line.replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/__([^_]+)__/g, '*$1*');
  const heading = /^#{1,6}\s+(.*)$/.exec(l);
  if (heading) {
    const inner = (heading[1] ?? '').trim().replace(/^\*(.*)\*$/, '$1');
    l = inner === '' ? '' : `*${inner}*`;
  }
  return l.replace(/^(\s*)[-*]\s+/, '$1• ');
}

// ── PR token rendering ──────────────────────────────────────────────────────────────────────

function capTitle(t: string): string {
  if (t.length <= TITLE_MAX) return t;
  let cut = t.slice(0, TITLE_MAX - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

// The title to print beside a first mention, or null. `line` is the RAW line, so a title the
// summary already printed is found before it would be printed twice.
function titleFor(ref: DigestPrRef, line: string): string | null {
  if (ref.title == null) return null;
  const t = neutraliseBareGithub(ref.title.replace(/\s+/g, ' ').trim());
  if (t === '') return null;
  if (t.length >= TITLE_DEDUPE_MIN && line.toLowerCase().includes(t.toLowerCase())) return null;
  return capTitle(t);
}

function authorFor(ref: DigestPrRef, line: string): string | null {
  const login = ref.authorLogin?.trim();
  if (!login) return null;
  if (new RegExp(`by @?${escapeRe(login)}(?![\\w-])`, 'i').test(line)) return null;
  return login;
}

interface Mention {
  start: number;
  end: number;
  text: string;
  ref: DigestPrRef | null;
  bare: boolean;
}

// Every PR token in the line, resolved. Built fresh per line: a shared global regex carries
// `lastIndex` between calls.
function mentionsIn(line: string, ctxRepo: string | null, byKey: Map<string, DigestPrRef>): Mention[] {
  const out: Mention[] = [];
  for (const mm of line.matchAll(new RegExp(TOKEN_SRC, 'g'))) {
    const start = mm.index ?? 0;
    const qRepo = mm[1];
    const qNum = mm[2];
    const bNum = mm[3];
    const ref =
      qRepo != null && qNum != null
        ? byKey.get(refKey(qRepo, Number(qNum)))
        : ctxRepo != null && bNum != null
          ? byKey.get(refKey(ctxRepo, Number(bNum)))
          : undefined;
    out.push({ start, end: start + mm[0].length, text: mm[0], ref: ref ?? null, bare: qRepo == null });
  }
  return out;
}

// One reference: `<url|#N Title> by @login`, or the same as plain text when there is no URL.
function renderRef(
  ref: DigestPrRef,
  num: string,
  title: string | null,
  author: string | null,
  opts: SlackFormatOptions,
): string {
  const label = title != null ? `${num} ${title}` : num;
  const suffix = author != null ? ` by @${escapeSlack(author)}` : '';
  const url = ref.prId == null ? null : opts.prUrl(ref);
  return url != null ? `<${url}|${slackLinkText(label)}>${suffix}` : `${escapeSlack(label)}${suffix}`;
}

interface Extra {
  title: string | null;
  author: string | null;
}
const hasExtra = (e: Extra): boolean => e.title != null || e.author != null;

function renderLine(
  line: string,
  ctxRepo: string | null,
  byKey: Map<string, DigestPrRef>,
  opts: SlackFormatOptions,
): string {
  const mentions = mentionsIn(line, ctxRepo, byKey);
  // What each PR adds beside its first mention, decided once per line (against the RAW line).
  const extras = new Map<string, Extra>();
  for (const m of mentions) {
    if (m.ref == null) continue;
    const key = refKey(m.ref.repoFullName, m.ref.prNumber);
    if (!extras.has(key)) extras.set(key, { title: titleFor(m.ref, line), author: authorFor(m.ref, line) });
  }
  const listed = [...extras.values()].filter(hasExtra).length >= LIST_MIN_REFS;
  const indent = /^\s*/.exec(line)?.[0] ?? '';

  const seen = new Set<string>(); // refs already titled on THIS line
  const subLines: string[] = [];
  let out = '';
  let cursor = 0;
  for (const m of mentions) {
    out += escapeSlack(line.slice(cursor, m.start));
    cursor = m.end;
    const ref = m.ref;
    if (ref == null) {
      // Unresolved, or a bare number with no repo to own it: exactly as written.
      out += escapeSlack(m.text);
      continue;
    }

    const ownRepo = m.bare || (ctxRepo != null && ref.repoFullName.toLowerCase() === ctxRepo);
    const num = ownRepo ? `#${ref.prNumber}` : `${ref.repoFullName}#${ref.prNumber}`;
    const key = refKey(ref.repoFullName, ref.prNumber);
    const first = !seen.has(key);
    seen.add(key);
    const extra = extras.get(key) ?? { title: null, author: null };

    if (listed && hasExtra(extra)) {
      // The sentence keeps the number; the linked, titled reference is its own sub-line.
      out += escapeSlack(num);
      if (first) subLines.push(`${indent}${SUB_BULLET}${renderRef(ref, num, extra.title, extra.author, opts)}`);
      continue;
    }

    const title = first ? extra.title : null;
    const author = first ? extra.author : null;
    let rendered = renderRef(ref, num, title, author, opts);
    // `#1 #2 #3` would read as one blur once each carries a title: separate them.
    if ((title != null || author != null) && NEXT_TOKEN_RE.test(line.slice(m.end))) rendered += ',';
    out += rendered;
  }
  out += escapeSlack(line.slice(cursor));
  return subLines.length === 0 ? out : `${out}\n${subLines.join('\n')}`;
}

/**
 * Convert one model summary to Slack mrkdwn, linking every resolvable PR reference into Limn.
 * `refs` are the account-scoped resolved refs for this text; `opts.prUrl` is required so a caller
 * cannot forget where links point.
 */
export function toSlackMrkdwn(md: string, refs: DigestPrRef[], opts: SlackFormatOptions): string {
  const byKey = new Map<string, DigestPrRef>();
  for (const r of refs) {
    const k = refKey(r.repoFullName, r.prNumber);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const fixedRepo = opts.repoFullName?.toLowerCase() ?? null;
  let headingRepo: string | null = null;
  const out: string[] = [];
  for (const rawLine of neutraliseLinks(md).split('\n')) {
    const line = convertLine(rawLine);
    const t = line.trim();
    const heading = REPO_HEADING_RE.exec(t);
    if (heading) {
      headingRepo = (heading[2] ?? '').toLowerCase();
      const ref = refs.find((r) => r.repoFullName.toLowerCase() === headingRepo);
      const url = ref != null && opts.repoUrl ? opts.repoUrl(ref.repoId) : null;
      const bold = heading[1] === '*' ? '*' : '';
      out.push(
        ref != null && url != null
          ? `${bold}<${url}|${slackLinkText(ref.repoFullName)}>${bold}`
          : escapeSlack(line),
      );
      continue;
    }
    const lead = REPO_LEAD_RE.exec(t);
    if (lead) headingRepo = (lead[1] ?? '').toLowerCase();
    // The headline or "*Action items*": the previous repo heading's scope ends here (its tokens
    // are still linked when qualified).
    else if (BOLD_LEAD_RE.test(t)) headingRepo = null;
    out.push(renderLine(line, fixedRepo ?? headingRepo, byKey, opts));
  }
  return out.join('\n').trim();
}

// ── splitting into Slack sections ──────────────────────────────────────────────────────────

// Cut one over-long line to at most `max` characters ending in `…`, never inside `<url|text>`
// markup and never through an `&amp;`-style entity.
function cutLine(line: string, max: number): string {
  let cut = Math.max(0, max - 1);
  const head = line.slice(0, cut);
  const lt = head.lastIndexOf('<');
  if (lt !== -1 && head.indexOf('>', lt) === -1) cut = lt;
  const amp = line.slice(0, cut).lastIndexOf('&');
  if (amp !== -1 && cut - amp <= 5 && !line.slice(amp, cut).includes(';')) cut = amp;
  if (cut > 0 && /[\uD800-\uDBFF]/.test(line[cut - 1] ?? '')) cut -= 1;
  return `${line.slice(0, cut).trimEnd()}…`;
}

/**
 * Split mrkdwn into section texts of at most `max` characters, at LINE boundaries, so a cut never
 * lands inside a link (the old hard `slice(0, 2899)` could cut through `<url|text>`). At most
 * `limit` chunks; when more were needed the last ends with `\n…`. Every chunk loses its leading
 * blank lines and trailing whitespace — but not the indent of its first line, which may be a
 * `◦` sub-line continuing a list — and an empty one is dropped: Slack rejects a section with empty
 * text and fails the whole message.
 */
export function fitSections(text: string, max: number, limit: number): string[] {
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  const flush = (): void => {
    const c = cur.join('\n').replace(/^\s*\n/, '').trimEnd();
    if (c.trim() !== '') chunks.push(c);
    cur = [];
    curLen = 0;
  };
  for (const raw of text.split('\n')) {
    const line = raw.length > max ? cutLine(raw, max) : raw;
    if (cur.length > 0 && curLen + 1 + line.length > max) flush();
    curLen = cur.length === 0 ? line.length : curLen + 1 + line.length;
    cur.push(line);
  }
  flush();

  const keep = Math.max(1, limit);
  if (chunks.length <= keep) return chunks;
  const kept = chunks.slice(0, keep);
  const last = kept[keep - 1] ?? '';
  let ended = `${last}\n…`;
  if (ended.length > max) {
    const lines = last.split('\n');
    while (lines.length > 1 && `${lines.join('\n').trimEnd()}\n…`.length > max) lines.pop();
    const body = lines.join('\n').trimEnd();
    ended = body !== '' && `${body}\n…`.length <= max ? `${body}\n…` : cutLine(lines[0] ?? '', max);
  }
  kept[keep - 1] = ended;
  return kept;
}
