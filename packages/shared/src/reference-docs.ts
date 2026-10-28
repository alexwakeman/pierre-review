// THE REFERENCE DOCS LIBRARY (CORE, free, LOCAL ONLY — agentic; docs/REFERENCE-DOCS.md).
//
// A workspace's uploaded reference material (PDF, Word, text, markdown, web pages), turned into a
// THREE-LEVEL markdown tree an agent walks by reasoning instead of by embeddings (the PageIndex idea):
//
//   INDEX.md                         the MASTER contents: one entry per document (its summary, its
//                                    topics, a link to its CONTENTS.md). Written by the SERVER from
//                                    each document's stored metadata after every add / remove.
//   <slug>/CONTENTS.md               one document's contents tree: nested entries, each a link to a
//                                    section file + a one-line summary. Written by the SERVER.
//   <slug>/sections/NN-<name>.md     the text itself, split along the document's own structure into
//                                    sections small enough to read one at a time.
//
// Sonnet 5 does the content building (reads a PDF natively and transcribes it; writes the summaries
// and topics for every kind). The server converts Word and HTML, splits, validates and writes every
// file a link can point at, so a link in the tree always resolves.
import type { AiProviderId } from './types.js';
import type { ReferenceDocWiki } from './reference-docs-wiki.js';

// `wiki`: a page tree from a team wiki (Confluence today; reference-docs-wiki.ts), one document.
export type ReferenceDocSourceKind = 'pdf' | 'docx' | 'text' | 'markdown' | 'html' | 'url' | 'wiki';

// The LATEST build's state. A document that built once stays readable (`available`) while a
// rebuild runs or after a rebuild fails.
export type ReferenceDocStatus = 'queued' | 'converting' | 'sectioning' | 'indexing' | 'ready' | 'failed';

/** The largest file an upload (or a fetched web page) may be. */
export const REFERENCE_DOC_MAX_BYTES = 25 * 1024 * 1024;

/** Section sizes, in words. Sections aim for the target range and never pass the hard cap. */
export const REFERENCE_DOC_SECTION_TARGET_MIN_WORDS = 800;
export const REFERENCE_DOC_SECTION_TARGET_MAX_WORDS = 1500;
export const REFERENCE_DOC_SECTION_HARD_CAP_WORDS = 2000;
/** And in characters, for text whose words are not space-separated. */
export const REFERENCE_DOC_SECTION_HARD_CAP_CHARS = 16_000;

/** The longest question the docs chat accepts. */
export const REFERENCE_DOCS_CHAT_MAX_QUESTION_CHARS = 4_000;

export interface ReferenceDocSectionEntry {
  /** Library-relative: `<slug>/sections/NN-name.md`. */
  path: string;
  title: string;
  /** One line. Empty when Claude gave none. */
  summary: string;
  /** 1 = top level. */
  depth: number;
  /** The headings above it, outermost first. */
  trail: string[];
  /** Headings merged into this section (CONTENTS.md links them by anchor). */
  headings: Array<{ title: string; depth: number; anchor: string }>;
  words: number;
}

export interface ReferenceDoc {
  id: number;
  workspaceId: number;
  slug: string;
  title: string;
  sourceKind: ReferenceDocSourceKind;
  /** The uploaded file's name, or the page's URL. */
  sourceName: string;
  sourceUrl: string | null;
  byteSize: number;
  status: ReferenceDocStatus;
  /** 0–100, for the progress bar. */
  progress: number;
  /** What the build is doing, in a few words ("Writing sections"). Null when idle. */
  stage: string | null;
  /** Why the latest build failed, in a sentence. */
  error: string | null;
  /** True when a built version is on disk and listed in INDEX.md. */
  available: boolean;
  sectionCount: number;
  summary: string | null;
  topics: string[];
  /** PDFs: the page count read from the file, when it could be read. */
  pageCount: number | null;
  /** What the latest build cost (US$), when known. */
  costUsd: number | null;
  /** What the latest build ran on (Phase 4): the model id and its provider. Absent on an older row —
   *  read through `aiRunLabel(provider, model)`. */
  model?: string | null;
  provider?: AiProviderId;
  /** A web page added with "Follow links": the crawl's settings and what the last build read. Null
   *  for a single page or a file. */
  crawl: ReferenceDocCrawl | null;
  /** A wiki page tree (Confluence): where it lives, how many pages, when it was last checked, and
   *  whether the wiki can still be reached. Absent / null for every other source. */
  wiki?: ReferenceDocWiki | null;
  createdAt: string;
  updatedAt: string;
  builtAt: string | null;
}

export interface ReferenceDocsResponse {
  workspaceId: number;
  docs: ReferenceDoc[];
  /** Settings → use the library in Claude Review (off by default). */
  docsInReview: boolean;
  maxBytes: number;
}

/** POST /api/docs/upload, /api/docs/url, /api/docs/:id/rebuild, /api/docs/:id/cancel. */
export interface ReferenceDocMutationResponse {
  doc: ReferenceDoc;
}

export interface AddReferenceDocUrlBody {
  /** Absent ⇒ the default workspace. */
  workspaceId?: number;
  url: string;
  /** Absent ⇒ this page only. `depth` = link hops followed from the start page (1 to
   *  REFERENCE_DOC_CRAWL_MAX_DEPTH), same site only (docs/REFERENCE-DOCS.md § Following links). */
  crawl?: { depth: number };
}

// ---- following links from a web page (docs/REFERENCE-DOCS.md § Following links) ----

/** The most link hops a crawl follows from its start page. */
export const REFERENCE_DOC_CRAWL_MAX_DEPTH = 3;
/** The most pages one crawl reads, the start page included. */
export const REFERENCE_DOC_CRAWL_MAX_PAGES = 25;
/** The model that scores each page's links for relevance to the start page. */
export const REFERENCE_DOC_CRAWL_RANK_MODEL = 'claude-haiku-5-5';
/** A link is followed only when Claude scores it at least this (0 = unrelated … 3 = core to the topic). */
export const REFERENCE_DOC_CRAWL_MIN_SCORE = 2;

/** Links seen but not followed, by reason. */
export interface ReferenceDocCrawlSkipped {
  /** Another host than the start page's. */
  offSite: number;
  /** Not a web page (a PDF, an image, a feed, a download…), by its address or by what it served. */
  notHtml: number;
  /** robots.txt asks robots not to read it. */
  robots: number;
  /** Claude scored it below REFERENCE_DOC_CRAWL_MIN_SCORE. */
  lowValue: number;
  /** Past the depth, the page cap or the crawl's time limit. */
  overCap: number;
  /** An address seen before (a circular link, a redirect to a page already read, the same text twice). */
  duplicate: number;
  /** An address shaped like a crawler trap (endless calendars, repeating paths, deep pagination). */
  trap: number;
  /** The page could not be read (an error, a timeout, too large). */
  failed: number;
}

export interface ReferenceDocCrawl {
  /** Link hops followed from the start page (1 to REFERENCE_DOC_CRAWL_MAX_DEPTH). */
  depth: number;
  maxPages: number;
  /** Pages read on the LAST successful build, in reading order (null before the first). */
  pages: Array<{ url: string; title: string | null; depth: number }> | null;
  skipped: ReferenceDocCrawlSkipped | null;
}

/** GET /api/docs/tree — the master contents, and one document's contents when `doc=` names one. */
export interface ReferenceDocTreeResponse {
  workspaceId: number;
  /** INDEX.md, verbatim. */
  index: string;
  doc: ReferenceDoc | null;
  /** That document's CONTENTS.md, verbatim; null when it has not built. */
  contents: string | null;
  sections: ReferenceDocSectionEntry[];
}

/** GET /api/docs/section?path= — one library file (INDEX.md, a CONTENTS.md or a section). */
export interface ReferenceDocSectionResponse {
  workspaceId: number;
  path: string;
  docId: number | null;
  docSlug: string | null;
  docTitle: string | null;
  /** The section's title (or the document's, for a CONTENTS.md; "Reference library" for INDEX.md). */
  title: string;
  markdown: string;
  /** Library-relative paths of the neighbouring sections, when this is a section. */
  prev: string | null;
  next: string | null;
}

/** GET /api/docs/:id/stream — server-sent events while a build runs. */
export type ReferenceDocStreamEvent =
  | {
      type: 'snapshot' | 'progress';
      docId: number;
      status: ReferenceDocStatus;
      progress: number;
      stage: string | null;
    }
  | { type: 'done'; docId: number; status: ReferenceDocStatus; error: string | null };

// ---- the docs chat ----

export interface ReferenceDocCitation {
  /** Library-relative, as GET /api/docs/section takes it. */
  path: string;
  /**
   * The workspace whose library a REVIEW checked this against (stamped by the server's validator), so
   * a link opens THAT library — not whichever workspace the reader has selected. Absent on a chat
   * citation (the chat lives in its own library) and on a review stored before the field existed.
   */
  workspaceId?: number;
  anchor: string | null;
  docSlug: string;
  docTitle: string;
  sectionTitle: string | null;
  /**
   * The words the link rests on, CHECKED against the section by the server, so the viewer can
   * highlight them. A chat citation carries one when the answer quoted the passage beside the link
   * (docs/REFERENCE-DOCS.md § The chat); a finding's citation never stores one. Absent = anchor only.
   */
  quote?: string;
}

export interface ReferenceDocsChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  citations: ReferenceDocCitation[];
  createdAt: string;
  costUsd: number | null;
  // What ran it (docs/CODEX-PLAN.md Phase 4): the model id and its provider. Optional: an older
  // server or row omits them — read through `aiRunLabel(provider, model)`.
  model?: string | null;
  provider?: AiProviderId;
}

export interface ReferenceDocsChatBody {
  workspaceId?: number;
  /** Absent ⇒ a new conversation. */
  conversationId?: string | null;
  question: string;
}

export interface ReferenceDocsChatResponse {
  workspaceId: number;
  conversationId: string;
  question: ReferenceDocsChatMessage;
  answer: ReferenceDocsChatMessage;
}

export interface ReferenceDocsConversationResponse {
  workspaceId: number;
  conversationId: string;
  messages: ReferenceDocsChatMessage[];
}

export interface ReferenceDocsConversationSummary {
  conversationId: string;
  /** The first question, clipped. */
  title: string;
  messageCount: number;
  updatedAt: string;
}

export interface ReferenceDocsConversationsResponse {
  workspaceId: number;
  conversations: ReferenceDocsConversationSummary[];
}

// ---- the per-workspace setting ----

export interface ReferenceDocsSettings {
  workspaceId: number;
  /** Claude Review reads the library to check stories against it. Off by default. */
  docsInReview: boolean;
}

export interface SetReferenceDocsSettingsBody {
  docsInReview: boolean;
}

// ---- the library in reviews (docs/REFERENCE-DOCS.md § Use in reviews) ----
//
// When a workspace's `docsInReview` switch is on and its library has a built document, Claude Review,
// the ticket review and This Sprint's "Check against code" may READ the library (read-only, behind the
// path guard) and report the passages they used. Every reference is SERVER-CHECKED before it is
// stored: its link must name a section file of a built document of THAT workspace, and its quote must
// appear in that section. A reference that fails either is dropped, never shown.

export type ReviewDocVerdict = 'supports' | 'contradicts' | 'context';

export const REVIEW_DOC_VERDICT_LABEL: Record<ReviewDocVerdict, string> = {
  supports: 'Supports',
  contradicts: 'Contradicts',
  context: 'Context',
};

/** A quote is copied from the section, at most this long. */
export const REVIEW_DOC_QUOTE_MAX_CHARS = 300;
/** …and at least this long (letters and digits), so "the" cannot match every section. */
export const REVIEW_DOC_QUOTE_MIN_CHARS = 12;
export const REVIEW_DOC_NOTE_MAX_CHARS = 400;
export const REVIEW_DOC_ABOUT_MAX_CHARS = 120;
/** At most this many references are kept per run. */
export const REVIEW_DOC_REFERENCES_MAX = 20;
/** At most this many library citations per finding. */
export const REVIEW_DOC_FINDING_CITATIONS_MAX = 3;

/** One passage a review used, as stored (`references` on the run). */
export interface ReviewDocReference {
  /** Library-relative section path: `<slug>/sections/NN-name.md`. */
  path: string;
  /** The workspace whose library the server checked it against (see ReferenceDocCitation). */
  workspaceId?: number;
  /** A heading anchor inside it, when the run named one that exists. */
  anchor: string | null;
  docSlug: string;
  docTitle: string;
  sectionTitle: string | null;
  /** Copied from the section (server-checked). */
  quote: string;
  verdict: ReviewDocVerdict;
  /** One sentence: what it means for the change or the story. */
  note: string;
  /** What it bears on, when the run said: a criterion ('AC2'), a finding title, a file. */
  about: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const VERDICTS: readonly string[] = ['supports', 'contradicts', 'context'];
// The stored workspace id, only when it is a real one; the key is left off otherwise.
const workspaceIdOf = (v: unknown): { workspaceId?: number } =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? { workspaceId: v } : {};

/** A stored run's references, re-read defensively; null when the run stored none. */
export function reviewDocReferencesFromStored(raw: unknown): ReviewDocReference[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ReviewDocReference[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    if (typeof r.path !== 'string' || typeof r.docSlug !== 'string' || typeof r.docTitle !== 'string') continue;
    if (typeof r.quote !== 'string' || typeof r.verdict !== 'string' || !VERDICTS.includes(r.verdict)) continue;
    out.push({
      path: r.path,
      ...workspaceIdOf(r.workspaceId),
      anchor: typeof r.anchor === 'string' && r.anchor !== '' ? r.anchor : null,
      docSlug: r.docSlug,
      docTitle: r.docTitle,
      sectionTitle: typeof r.sectionTitle === 'string' && r.sectionTitle !== '' ? r.sectionTitle : null,
      quote: r.quote,
      verdict: r.verdict as ReviewDocVerdict,
      note: typeof r.note === 'string' ? r.note : '',
      about: typeof r.about === 'string' && r.about !== '' ? r.about : null,
    });
    if (out.length >= REVIEW_DOC_REFERENCES_MAX) break;
  }
  return out;
}

/** A finding's stored library citations, re-read defensively ([] when none). */
export function referenceDocCitationsFromStored(raw: unknown): ReferenceDocCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferenceDocCitation[] = [];
  for (const c of raw) {
    if (!isObj(c) || typeof c.path !== 'string' || typeof c.docSlug !== 'string' || typeof c.docTitle !== 'string') continue;
    out.push({
      path: c.path,
      ...workspaceIdOf(c.workspaceId),
      anchor: typeof c.anchor === 'string' && c.anchor !== '' ? c.anchor : null,
      docSlug: c.docSlug,
      docTitle: c.docTitle,
      sectionTitle: typeof c.sectionTitle === 'string' && c.sectionTitle !== '' ? c.sectionTitle : null,
    });
    if (out.length >= REVIEW_DOC_FINDING_CITATIONS_MAX) break;
  }
  return out;
}

/** A chat answer's stored citations, re-read defensively ([] when none); a quote is kept only as a short string. */
export function chatCitationsFromStored(raw: unknown): ReferenceDocCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: ReferenceDocCitation[] = [];
  for (const c of raw) {
    if (!isObj(c) || typeof c.path !== 'string' || typeof c.docSlug !== 'string' || typeof c.docTitle !== 'string') continue;
    const quote = typeof c.quote === 'string' ? c.quote.trim() : '';
    out.push({
      path: c.path,
      anchor: typeof c.anchor === 'string' && c.anchor !== '' ? c.anchor : null,
      docSlug: c.docSlug,
      docTitle: c.docTitle,
      sectionTitle: typeof c.sectionTitle === 'string' && c.sectionTitle !== '' ? c.sectionTitle : null,
      ...(quote !== '' && quote.length <= REVIEW_DOC_QUOTE_MAX_CHARS ? { quote } : {}),
    });
  }
  return out;
}
