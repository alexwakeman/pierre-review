// CREATING A RELEASE — the shared, PURE half (docs/RELEASES.md § Releases tab 5–7, § Release notes).
//
//   • The SNAPSHOT: what the "Create release…" dialog showed (each ticked repo's candidate tag + sha,
//     each ticket the release ships). Confirm sends it back; the server re-reads the tickets, re-runs
//     the check and `releaseSnapshotChanges` lists every difference — any difference stops Confirm and
//     NOTHING is written.
//   • The NOTES: code-built markdown, one section per repo (each section is also that repo's GitHub
//     pre-release body). Version names and counts come from code; a story's summary is the ONLY model
//     text, and `cleanStorySummary` refuses one that carries a numeral (the D4 digit gate) or the
//     product's name.
//   • The TRACKER COMMENT, exactly the spec's three lines.
//
// ⚠ No product wording ("Ensemble") in anything written to GitHub or the tracker: tag messages, notes,
// pre-release bodies, comments. Pinned by the tests.
import type { ReleaseCheckResult, ReleaseTicketCheck } from './release-check.js';
import { releaseBlockerText } from './release-check.js';

// ── The snapshot ────────────────────────────────────────────────────────────────────────────────

export interface ReleaseSnapshot {
  repos: Array<{ repoId: number; tagName: string; sha: string }>;
  tickets: Array<{ ident: string; key: string }>;
}

/** The tickets in the scope of an included repo's candidate: Complete, or not given by the tracker
 *  (listed for the reader to check). Each repository is judged on its own. Pure. */
export function releaseScopeTickets(
  result: Pick<ReleaseCheckResult, 'tickets'>,
  includedRepoIds: readonly number[],
): ReleaseTicketCheck[] {
  const inc = new Set(includedRepoIds);
  return result.tickets.filter((t) => t.inRelease && t.repos.some((r) => r.state === 'in_candidate' && inc.has(r.repoId)));
}

/** The tickets a release of these repos ships and comments on: in a candidate's scope and READY
 *  (Complete, no open pull request). Pure. */
export function releaseShippedTickets(
  result: Pick<ReleaseCheckResult, 'tickets'>,
  includedRepoIds: readonly number[],
): ReleaseTicketCheck[] {
  return releaseScopeTickets(result, includedRepoIds).filter((t) => t.ready);
}

/** What the dialog shows for these repos (only repos with a candidate count). Pure. */
export function releaseSnapshotOf(result: ReleaseCheckResult, includedRepoIds: readonly number[]): ReleaseSnapshot {
  const inc = new Set(includedRepoIds);
  return {
    repos: result.repos
      .filter((r) => inc.has(r.repoId) && r.candidate != null)
      .map((r) => ({ repoId: r.repoId, tagName: r.candidate!.name, sha: r.candidate!.sha })),
    tickets: releaseShippedTickets(result, includedRepoIds)
      .map((t) => ({ ident: t.ident, key: t.key }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  };
}

/**
 * Every difference between what the dialog showed and the check now, as plain sentences. Empty =
 * Confirm may write. `liveShaChanged` lists version tags whose commit GitHub now reports differently;
 * `unread` the tickets the tracker did not answer for again. Pure.
 */
export function releaseSnapshotChanges(
  before: ReleaseSnapshot,
  after: ReleaseCheckResult,
  extra: {
    liveShaChanged?: Array<{ repoId: number; tagName: string }>;
    unread?: Array<{ ident: string; key: string }>;
  } = {},
): string[] {
  const out: string[] = [];
  const repoById = new Map(after.repos.map((r) => [r.repoId, r]));
  const repoName = (id: number): string => repoById.get(id)?.name ?? 'a repository';
  const included = before.repos.map((r) => r.repoId);

  for (const u of extra.unread ?? []) out.push(`${u.key} could not be read again from the tracker.`);
  for (const b of before.repos) {
    const now = repoById.get(b.repoId);
    const name = repoName(b.repoId);
    if (now == null) out.push(`${name} is no longer in this workspace.`);
    else if (now.candidate == null) out.push(`${name} has no tag that can be released now.`);
    else if (now.candidate.name !== b.tagName) out.push(`${name}: the tag to release is now ${now.candidate.name}, not ${b.tagName}.`);
    else if (now.candidate.sha !== b.sha) out.push(`${b.tagName} in ${name} now points at another commit.`);
  }
  for (const c of extra.liveShaChanged ?? []) {
    const line = `${c.tagName} in ${repoName(c.repoId)} now points at another commit.`;
    if (!out.includes(line)) out.push(line);
  }
  const ticketByIdent = new Map(after.tickets.map((t) => [t.ident, t]));
  const nowShipped = new Set(releaseShippedTickets(after, included).map((t) => t.ident));
  for (const t of before.tickets) {
    if (nowShipped.has(t.ident)) continue;
    const now = ticketByIdent.get(t.ident);
    if (now?.blocker != null) out.push(releaseBlockerText(now.blocker));
    else out.push(`${t.key} is no longer in the release.`);
  }
  const had = new Set(before.tickets.map((t) => t.ident));
  for (const ident of nowShipped) {
    if (!had.has(ident)) out.push(`${ticketByIdent.get(ident)?.key ?? ident} is now in the release.`);
  }
  return out;
}

// ── Release notes ───────────────────────────────────────────────────────────────────────────────

export interface ReleaseNotesPr {
  id: number;
  repoName: string;
  number: number;
  title: string;
  url: string;
}

export interface ReleaseNotesStory {
  ident: string;
  key: string;
  title: string | null;
  url: string | null;
  /** The model's one paragraph, already cleaned (`cleanStorySummary`); null = none. */
  summary: string | null;
  /** The story's PRs in this release, every included repo. */
  prs: ReleaseNotesPr[];
}

export interface ReleaseNotesRepo {
  repoId: number;
  repoName: string;
  versionTag: string;
  releaseTagName: string;
  stories: ReleaseNotesStory[];
  /** since_release: everything since the last release; since_start: no release yet, so everything up to
   *  the candidate tag (the whole history the check read). */
  scope: 'since_release' | 'since_start';
  untracked: ReleaseNotesPr[];
  bot: ReleaseNotesPr[];
}

/** The PR ids in a repo's candidate scope. Pure. */
export function candidatePrIds(repo: ReleaseCheckResult['repos'][number]): Set<number> {
  return repo.candidate == null ? new Set() : new Set(repo.candidatePrIds);
}

/** The notes' facts for a release of these repos, from the check's result. Pure. */
export function releaseNotesInputOf(
  result: ReleaseCheckResult,
  includedRepoIds: readonly number[],
  summaries: ReadonlyMap<string, string | null> = new Map(),
): ReleaseNotesRepo[] {
  const inc = new Set(includedRepoIds);
  const prById = new Map(result.prs.map((p) => [p.id, p]));
  const repos = result.repos.filter((r) => inc.has(r.repoId) && r.candidate != null);
  const nameOf = new Map(result.repos.map((r) => [r.repoId, r.name]));
  const inRange = new Map(repos.map((r) => [r.repoId, candidatePrIds(r)]));
  const prRef = (id: number): ReleaseNotesPr | null => {
    const p = prById.get(id);
    if (p == null) return null;
    return { id: p.id, repoName: nameOf.get(p.repoId) ?? '', number: p.number, title: p.title, url: p.url };
  };
  const inScope = releaseScopeTickets(result, includedRepoIds);
  const ticketByIdent = new Map(inScope.map((t) => [t.ident, t]));
  const storyPrs = (t: ReleaseTicketCheck): ReleaseNotesPr[] => {
    const out: ReleaseNotesPr[] = [];
    for (const r of [...t.repos].sort((a, b) => (nameOf.get(a.repoId) ?? '').localeCompare(nameOf.get(b.repoId) ?? ''))) {
      const range = inRange.get(r.repoId);
      if (range == null) continue;
      for (const id of [...r.prIds].sort((a, b) => (prById.get(a)?.number ?? 0) - (prById.get(b)?.number ?? 0))) {
        const ref = range.has(id) ? prRef(id) : null;
        if (ref != null) out.push(ref);
      }
    }
    return out;
  };
  return repos.map((r) => ({
    repoId: r.repoId,
    repoName: r.name,
    versionTag: r.candidate!.name,
    releaseTagName: r.candidate!.releaseTagName,
    stories: r.ticketIdents
      .map((ident) => ticketByIdent.get(ident))
      .filter((t): t is ReleaseTicketCheck => t != null)
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((t) => ({ ident: t.ident, key: t.key, title: t.title, url: t.url, summary: summaries.get(t.ident) ?? null, prs: storyPrs(t) })),
    scope: r.scope,
    untracked: r.untrackedPrIds.map(prRef).filter((p): p is ReleaseNotesPr => p != null),
    bot: r.botPrIds.map(prRef).filter((p): p is ReleaseNotesPr => p != null),
  }));
}

/** Text safe inside markdown: no link, emphasis or HTML, and an `@name` cannot notify anyone. Pure. */
export function notesText(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]<>|#~])/g, '\\$1')
    .replace(/(^|[^\w`])@([A-Za-z0-9][\w-]*(?:\/[\w.-]+)?)/g, '$1`@$2`')
    .trim();
}

/** A link only for an https URL; otherwise the plain label. Pure. */
function mdLink(label: string, url: string | null): string {
  return url != null && /^https:\/\/[^\s()<>]+$/.test(url) ? `[${label}](${url})` : label;
}

function prLine(p: ReleaseNotesPr): string {
  return `- ${mdLink(`${notesText(p.repoName)} #${p.number}`, p.url)} ${notesText(p.title)}`;
}

/** ONE repo's section — also its GitHub pre-release body. Pure. */
export function releaseNotesSection(repo: ReleaseNotesRepo): string {
  const lines: string[] = [`## ${notesText(repo.repoName)} ${notesText(repo.releaseTagName)}`, '', `Built from ${notesText(repo.versionTag)}.`];
  // No release yet: everything up to the candidate tag ships, so everything is listed.
  if (repo.scope === 'since_start') lines.push('', 'First release: everything up to this tag.');
  if (repo.stories.length > 0) {
    lines.push('', '### Stories');
    for (const s of repo.stories) {
      const head = s.title != null && s.title !== '' ? `${mdLink(notesText(s.key), s.url)} ${notesText(s.title)}` : mdLink(notesText(s.key), s.url);
      lines.push('', `#### ${head}`);
      if (s.summary != null && s.summary !== '') lines.push('', notesText(s.summary));
      if (s.prs.length > 0) lines.push('', ...s.prs.map(prLine));
    }
  }
  if (repo.untracked.length > 0) lines.push('', '### Untracked changes', '', ...repo.untracked.map(prLine));
  if (repo.bot.length > 0) lines.push('', '### Dependency and bot changes', '', ...repo.bot.map(prLine));
  if (repo.stories.length === 0 && repo.untracked.length === 0 && repo.bot.length === 0) lines.push('', 'No pull requests in this release.');
  return lines.join('\n');
}

/** The whole document: the sections in order. Pure. */
export function releaseNotesDocument(sections: readonly string[]): string {
  return sections.map((s) => s.trim()).join('\n\n');
}

/** The longest notes section Ensemble writes (GitHub's release body allows 125 000 characters). */
export const RELEASE_NOTES_SECTION_MAX = 60_000;

// ── The story summary (the only model text) ─────────────────────────────────────────────────────

const NUMERAL = /[\p{Nd}\p{No}\p{Nl}]/u;
/** The product name, and the old one (Limn → Ensemble, 2026-11): never in model text we publish. */
const PRODUCT = /\b(?:ensemble|limn)\b/i;

/**
 * The model's summary, made safe: one paragraph, ≤ 600 characters, cut at a sentence. REFUSED (null)
 * when it carries any numeral — version numbers and counts are code's (the D4 digit gate) — or the
 * product's name. Pure.
 */
export function cleanStorySummary(text: string | null | undefined): string | null {
  if (text == null) return null;
  let t = text.replace(/\s+/g, ' ').trim().replace(/^["'“]+|["'”]+$/g, '').trim();
  if (t === '' || NUMERAL.test(t) || PRODUCT.test(t)) return null;
  if (t.length > 600) {
    const cut = t.slice(0, 600);
    const end = cut.lastIndexOf('. ');
    t = end > 120 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return t;
}

// ── The tracker comment ─────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Nov 2026" in the machine's local time. Pure. */
export function releaseDateWords(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export interface ReleaseCommentFacts {
  approverName: string;
  at: Date;
  /** The ticket's repos in this release, in order. */
  tags: Array<{ repoName: string; releaseTagName: string }>;
  /** The GitHub pre-release link (the ticket's first repo with one); null = none. */
  notesUrl: string | null;
}

/** The comment, EXACTLY the spec's lines (plain text). Pure. */
export function releaseCommentLines(f: ReleaseCommentFacts): string[] {
  const lines = [
    `Approved for release by ${f.approverName} on ${releaseDateWords(f.at)}.`,
    f.tags.map((t) => `${t.repoName} ${t.releaseTagName}`).join(' · '),
  ];
  if (f.notesUrl != null) lines.push(`Release notes: ${f.notesUrl}`);
  return lines;
}

/** Jira wiki text: every character that could start a mention, a macro or a style is escaped. Pure. */
export function jiraWikiPlain(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([[\]|{}*_^~+?\\-])/g, '\\$1');
}

/** The comment as Jira wiki markup (the link stays a bare https link). Pure. */
export function releaseCommentWiki(f: ReleaseCommentFacts): string {
  const [first, second] = releaseCommentLines({ ...f, notesUrl: null });
  const lines = [jiraWikiPlain(first!), jiraWikiPlain(second!)];
  if (f.notesUrl != null && /^https:\/\/[^\s[\]|{}]+$/.test(f.notesUrl)) lines.push(`Release notes: ${f.notesUrl}`);
  return lines.join('\n');
}

/** The annotated tag's message. No product wording. Pure. */
export function releaseTagMessage(repoName: string, releaseTag: string, versionTag: string): string {
  return `${repoName} ${releaseTag}\n\nRelease of ${versionTag}.`;
}

// ── The wire ────────────────────────────────────────────────────────────────────────────────────

/** POST /api/releases/preview?workspace= */
export interface ReleasePreviewBody {
  repoIds: number[];
}

export interface ReleasePreviewResponse {
  workspaceId: number;
  /** What Confirm sends back. */
  snapshot: ReleaseSnapshot;
  /** Per repo: the notes section (editable in the dialog). */
  sections: Array<{ repoId: number; repoName: string; releaseTagName: string; markdown: string }>;
  /** The whole document (the sections joined). */
  notesMarkdown: string;
  /** The tracker comment one ticket would get (plain text; the link is filled in after the writes). */
  commentPreview: string | null;
  /** Stories with a model summary / without one. */
  summaries: { written: number; missing: number; ai: boolean };
}

/** POST /api/releases?workspace= */
export interface CreateReleaseBody {
  repoIds: number[];
  snapshot: ReleaseSnapshot;
  /** The (edited) notes per repo; a repo left out gets the code-built section. */
  sections?: Array<{ repoId: number; markdown: string }>;
}

export type ReleaseItemTagState = 'pending' | 'claimed' | 'done' | 'failed' | 'refused';
export type ReleaseItemPrereleaseState = 'pending' | 'claimed' | 'done' | 'failed' | 'skipped';
export type ReleaseCommentState = 'pending' | 'claimed' | 'posted' | 'failed' | 'skipped';
export type ReleaseState = 'writing' | 'done' | 'partial' | 'failed' | 'stopped';

export interface ReleaseDetailItem {
  repoId: number;
  repoName: string;
  versionTag: string;
  sha: string;
  releaseTagName: string;
  tagState: ReleaseItemTagState;
  prereleaseState: ReleaseItemPrereleaseState;
  releaseUrl: string | null;
  error: string | null;
}

export interface ReleaseDetailComment {
  ticketKey: string;
  state: ReleaseCommentState;
  error: string | null;
}

export interface ReleaseDetail {
  id: number;
  workspaceId: number;
  createdAt: string;
  createdBy: string | null;
  state: ReleaseState;
  releaseSuffix: string;
  notesMarkdown: string;
  items: ReleaseDetailItem[];
  comments: ReleaseDetailComment[];
  /** The per-step result list, in order, plain sentences. */
  steps: Array<{ ok: boolean; text: string }>;
}

export type CreateReleaseResponse =
  | { workspaceId: number; outcome: 'stopped'; changes: string[]; release: null }
  | { workspaceId: number; outcome: 'written'; changes: []; release: ReleaseDetail };

/** The per-step result list from the stored rows. Pure. */
export function releaseStepLines(d: Pick<ReleaseDetail, 'items' | 'comments'>): Array<{ ok: boolean; text: string }> {
  const out: Array<{ ok: boolean; text: string }> = [];
  for (const i of d.items) {
    const tag = `${i.repoName} ${i.releaseTagName}`;
    if (i.tagState === 'done') out.push({ ok: true, text: `Tagged ${tag}.` });
    else if (i.tagState === 'refused') out.push({ ok: false, text: `${tag} already exists. It was not moved.` });
    else if (i.tagState === 'failed') out.push({ ok: false, text: `Tagging ${tag} failed${i.error ? `: ${i.error}` : '.'}` });
    else out.push({ ok: false, text: `Tagging ${tag} did not finish.` });
  }
  for (const i of d.items) {
    const tag = `${i.repoName} ${i.releaseTagName}`;
    if (i.prereleaseState === 'done') out.push({ ok: true, text: `Published the pre-release ${tag}.` });
    else if (i.prereleaseState === 'failed') out.push({ ok: false, text: `The pre-release ${tag} failed.` });
    else if (i.prereleaseState === 'skipped') out.push({ ok: false, text: `No pre-release for ${tag}, because it was not tagged.` });
    else if (i.tagState === 'done') out.push({ ok: false, text: `The pre-release ${tag} did not finish.` });
  }
  for (const c of d.comments) {
    if (c.state === 'posted') out.push({ ok: true, text: `Commented on ${c.ticketKey}.` });
    else if (c.state === 'skipped') out.push({ ok: false, text: `No comment on ${c.ticketKey}: ${c.error ?? 'skipped'}.` });
    else if (c.state === 'failed') out.push({ ok: false, text: `The comment on ${c.ticketKey} failed${c.error ? `: ${c.error}` : '.'}` });
    else out.push({ ok: false, text: `The comment on ${c.ticketKey} did not finish.` });
  }
  return out;
}

/** done = every step worked; failed = no tag landed; partial otherwise. Another tracker's "not
 *  supported yet" is not a failure. Pure. */
export function releaseFinalState(d: Pick<ReleaseDetail, 'items' | 'comments'>): ReleaseState {
  if (!d.items.some((i) => i.tagState === 'done')) return 'failed';
  const allTags = d.items.every((i) => i.tagState === 'done' && i.prereleaseState === 'done');
  const comments = d.comments.every((c) => c.state === 'posted' || (c.state === 'skipped' && c.error?.includes('not supported yet') === true));
  return allTags && comments ? 'done' : 'partial';
}
