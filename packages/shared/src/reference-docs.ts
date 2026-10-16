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

export type ReferenceDocSourceKind = 'pdf' | 'docx' | 'text' | 'markdown' | 'html' | 'url';

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
  anchor: string | null;
  docSlug: string;
  docTitle: string;
  sectionTitle: string | null;
}

export interface ReferenceDocsChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  citations: ReferenceDocCitation[];
  createdAt: string;
  costUsd: number | null;
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
