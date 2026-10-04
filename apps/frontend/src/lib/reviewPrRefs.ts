// PR REFERENCES IN THE REVIEW TAB → THAT PR IN LIMN. The pure half: finding refs in text,
// resolving them against data already on screen, and naming the few that need ONE batched lookup
// (`POST /api/prs/resolve`). The React half (provider, link, plain-text splitter) is
// components/ReviewPrRefs.tsx; the markdown half is the `rehypeReviewPrRefs` plugin below.
//
//   "acme/api#12"        a full name: resolves only by that exact repository.
//   "bng-library#66"     a bare name: resolves when the name is unambiguous among the repositories
//                        on screen (the ticket's PRs, the PR being viewed), else the server tries
//                        it against the account's repos (null when two share the name).
//   "#352"               the PR being viewed's own repository.
//
// A ref that resolves to nothing stays plain text. Nothing here guesses: a qualified ref never
// falls back to a bare-number match in another repository.
import {
  PR_REF_RESOLVE_MAX,
  type ClaudeReview,
  type PrRefQuery,
  type ResolvedPrRef,
  type TicketReview,
} from '@pierre-review/shared';

export interface KnownPr {
  prId: number;
  // "owner/name"
  repoFullName: string;
  number: number;
  title: string | null;
}

export interface PrRefMatch {
  // Offsets into the scanned text: [start, end) covers exactly the ref ("api#12", "#3").
  start: number;
  end: number;
  // As written: "owner/name", "name", or null for a bare "#N".
  repo: string | null;
  number: number;
}

// A ref is preceded by the start or a character that cannot be part of a word, a path, a URL
// fragment or an HTML entity ("&#39;"), so "file.ts#L3", "a/b/pull/3#x" and "C#1"-in-a-word
// never match a longer token by accident.
const REF_RE = /(^|[^\w/#.@&-])((?:[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*)?#(\d{1,7})(?![\w#])/g;

/** Every PR reference in `text`, in order. */
export function parsePrRefs(text: string): PrRefMatch[] {
  const out: PrRefMatch[] = [];
  REF_RE.lastIndex = 0;
  for (let m = REF_RE.exec(text); m != null; m = REF_RE.exec(text)) {
    const lead = m[1] ?? '';
    const start = m.index + lead.length;
    const repo = m[2] ?? null;
    // A repo token cannot END in "." or "-" (that was sentence punctuation, "see api.#3").
    if (repo != null && /[.-]$/.test(repo)) continue;
    const number = Number(m[3]);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    out.push({ start, end: start + (repo?.length ?? 0) + 1 + (m[3]?.length ?? 0), repo, number });
  }
  return out;
}

/** Text and refs interleaved, for a plain-text renderer. */
export function splitPrRefs(text: string): Array<string | PrRefMatch> {
  const out: Array<string | PrRefMatch> = [];
  let at = 0;
  for (const m of parsePrRefs(text)) {
    if (m.start > at) out.push(text.slice(at, m.start));
    out.push(m);
    at = m.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// ---- resolution ----

export interface PrRefIndex {
  // The repo a bare "#N" means (the PR being viewed), lower-cased; null ⇒ "#N" never resolves.
  currentRepo: string | null;
  // "owner/name#N" (lower-cased) → the PR.
  byKey: Map<string, KnownPr>;
  // bare name (lower-cased) → every full name on screen carrying it (lower-cased).
  names: Map<string, Set<string>>;
}

const keyOf = (repo: string, n: number): string => `${repo.trim().toLowerCase()}#${n}`;
const bareName = (full: string): string => full.slice(full.lastIndexOf('/') + 1).toLowerCase();

export function buildPrRefIndex(currentRepoFullName: string | null, known: readonly KnownPr[]): PrRefIndex {
  const byKey = new Map<string, KnownPr>();
  const names = new Map<string, Set<string>>();
  const addRepo = (full: string): void => {
    const lower = full.toLowerCase();
    const set = names.get(bareName(full)) ?? new Set<string>();
    set.add(lower);
    names.set(bareName(full), set);
  };
  if (currentRepoFullName != null) addRepo(currentRepoFullName);
  for (const k of known) {
    byKey.set(keyOf(k.repoFullName, k.number), k);
    addRepo(k.repoFullName);
  }
  return { currentRepo: currentRepoFullName?.toLowerCase() ?? null, byKey, names };
}

/**
 * What to ask the server for this ref: a full name when the screen pins one down (so the answer
 * cannot be ambiguous), else the bare name as written. null ⇒ unanswerable ("#N" with no repo).
 */
export function queryFor(ref: Pick<PrRefMatch, 'repo' | 'number'>, index: PrRefIndex): PrRefQuery | null {
  if (ref.repo == null) return index.currentRepo != null ? { repo: index.currentRepo, number: ref.number } : null;
  if (ref.repo.includes('/')) return { repo: ref.repo.toLowerCase(), number: ref.number };
  const fulls = index.names.get(ref.repo.toLowerCase());
  if (fulls != null && fulls.size === 1) return { repo: [...fulls][0]!, number: ref.number };
  // Two repos on screen share the name: still exact when only ONE of them has a PR with this
  // number on screen (a ticket spanning orgA/api#12 and orgB/api#7 names "api#12" unambiguously).
  if (fulls != null && fulls.size > 1) {
    const hits = [...fulls].filter((f) => index.byKey.has(keyOf(f, ref.number)));
    if (hits.length === 1) return { repo: hits[0]!, number: ref.number };
  }
  return { repo: ref.repo.toLowerCase(), number: ref.number };
}

export const queryKeyOf = (q: PrRefQuery): string => keyOf(q.repo, q.number);

/**
 * The PR a ref names: on-screen data first, then the server's answers (keyed by `queryKeyOf`).
 * undefined ⇒ not known yet (still a candidate for the lookup); null ⇒ known to name nothing.
 */
export function resolvePrRef(
  ref: Pick<PrRefMatch, 'repo' | 'number'>,
  index: PrRefIndex,
  server: ReadonlyMap<string, KnownPr | null> | null,
): KnownPr | null | undefined {
  const q = queryFor(ref, index);
  if (q == null) return null;
  const hit = index.byKey.get(queryKeyOf(q));
  if (hit != null) return hit;
  if (server == null) return undefined;
  return server.has(queryKeyOf(q)) ? (server.get(queryKeyOf(q)) ?? null) : undefined;
}

/**
 * The refs in `texts` the screen cannot resolve on its own, deduplicated and in a stable order
 * (the query key), at most PR_REF_RESOLVE_MAX — the ONE batch the pane sends.
 */
export function refsToResolve(texts: readonly (string | null | undefined)[], index: PrRefIndex): PrRefQuery[] {
  const out = new Map<string, PrRefQuery>();
  for (const t of texts) {
    if (t == null || t === '' || !t.includes('#')) continue;
    for (const m of parsePrRefs(t)) {
      const q = queryFor(m, index);
      if (q == null || index.byKey.has(queryKeyOf(q))) continue;
      out.set(queryKeyOf(q), q);
    }
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, PR_REF_RESOLVE_MAX)
    .map(([, q]) => q);
}

/** The server's answers as a lookup keyed like `queryKeyOf`. */
export function serverIndex(answers: readonly ResolvedPrRef[]): Map<string, KnownPr | null> {
  const out = new Map<string, KnownPr | null>();
  for (const a of answers) {
    out.set(
      keyOf(a.repo, a.number),
      a.prId != null && a.repoFullName != null
        ? { prId: a.prId, repoFullName: a.repoFullName, number: a.number, title: a.title }
        : null,
    );
  }
  return out;
}

// ---- what the Review tab writes ----

/** Every model- or reviewer-written text the Review tab links refs in, for the ONE batch. */
export function reviewTexts(review: ClaudeReview | null | undefined, tickets: readonly (TicketReview | null)[]): string[] {
  const out: Array<string | null | undefined> = [];
  if (review != null) {
    out.push(review.summary);
    for (const f of review.findings) out.push(f.title, f.body);
    for (const t of review.threadAssessments ?? []) out.push(t.excerpt, t.explanation);
    for (const c of review.ciFailures ?? []) out.push(c.cause, c.explanation);
    for (const i of review.followUp?.items ?? []) out.push(i.explanation);
    for (const e of review.tickets ?? []) {
      const a = e.assessment;
      if (a == null) continue;
      out.push(a.summary);
      for (const c of a.criteria) out.push(c.explanation);
      for (const g of [...a.missing, ...a.notRequested]) out.push(g.title, g.explanation);
    }
  }
  for (const r of tickets) {
    const a = r?.assessment;
    if (a == null) continue;
    out.push(a.summary);
    for (const c of a.criteria) out.push(c.explanation);
    for (const g of a.missing) out.push(g.title, g.explanation);
    for (const g of a.notRequested) out.push(g.title, g.explanation);
    for (const i of r!.items) out.push(i.title, i.body);
  }
  return out.filter((t): t is string => typeof t === 'string' && t.includes('#'));
}

// ---- markdown ----

// Minimal HAST shapes (the plugin only needs these; no dependency on @types/hast).
interface HText {
  type: 'text';
  value: string;
}
interface HElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HNode[];
}
interface HRoot {
  type: 'root';
  children: HNode[];
}
type HNode = HText | HElement | HRoot | { type: string; children?: HNode[] };

// Never inside a link (it already goes somewhere) or code (a "#12" there is code, not a PR).
const SKIP_TAGS = new Set(['a', 'code', 'pre', 'kbd', 'samp', 'script', 'style']);

/** The HAST element a ref becomes: an `<a>` the Markdown renderer swaps for the in-app link. */
function refElement(text: string, m: PrRefMatch): HElement {
  return {
    type: 'element',
    tagName: 'a',
    properties: { dataPrRepo: m.repo ?? '', dataPrNumber: String(m.number) },
    children: [{ type: 'text', value: text.slice(m.start, m.end) }],
  };
}

function transform(node: HNode): void {
  const children = (node as { children?: HNode[] }).children;
  if (children == null) return;
  const next: HNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === 'text') {
      const value = (child as HText).value;
      const parts = value.includes('#') ? splitPrRefs(value) : [value];
      if (parts.length === 1 && typeof parts[0] === 'string') {
        next.push(child);
        continue;
      }
      changed = true;
      for (const p of parts) next.push(typeof p === 'string' ? { type: 'text', value: p } : refElement(value, p));
      continue;
    }
    if (child.type === 'element' && SKIP_TAGS.has((child as HElement).tagName)) {
      next.push(child);
      continue;
    }
    transform(child);
    next.push(child);
  }
  if (changed) (node as { children: HNode[] }).children = next;
}

/**
 * Rehype plugin: wraps every PR ref in text (outside links and code) in an `<a data-pr-repo
 * data-pr-number>`. It runs AFTER the sanitizer, so nothing it adds is attacker-controlled beyond
 * the ref's own text; the Markdown renderer turns these into in-app links (or plain text).
 */
export function rehypeReviewPrRefs(): (tree: HRoot) => void {
  return (tree) => transform(tree);
}
