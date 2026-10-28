// CHECK A STORY AGAINST THE DOCS (CORE, free, LOCAL ONLY — agentic; docs/REFERENCE-DOCS.md § Check a
// story against the docs).
//
// One story (a tracker ticket: its description and its acceptance criteria) is checked against the
// workspace's reference library on a CLICK — never automatically, never on view. Two steps, one row:
//
//   1. SHORTLIST: when every section of the library fits STORY_DOCS_INLINE_CHARS, ALL of them (no model
//      call). Otherwise Haiku 5.5 (tool-less) picks at most STORY_DOCS_SHORTLIST_MAX section files from
//      the top STORY_DOCS_PREFILTER_MAX candidates a deterministic term score ranks (or from every
//      CONTENTS.md when nothing scores). Every entry is server-checked (strict library grammar, a
//      section of a BUILT document of THIS workspace, on disk). An empty shortlist ends the run as
//      `no_relevant_docs` — no second model call.
//   2. READ (Sonnet 5, at low effort on Claude): the shortlisted sections' TEXT is in the prompt (fenced,
//      ≤ STORY_DOCS_INLINE_CHARS), so it answers in one turn; Read/Glob/Grep stay, confined read-only
//      to ONLY the shortlisted documents' folders, for a section the budget cut. It submits a verdict on
//      the whole story, 2-3 sentences, actionable bullets, an OPTIONAL note per acceptance criterion
//      (only the ones the docs bear on) and up to a few points on other parts of the story.
//
// A click whose fingerprint (story, criteria, built library, version, models, provider) equals the
// newest SUCCEEDED run's is answered with that run (`reused`) — no model call — unless `force`.
//
// ⚠ GROUNDING IS DROP, NOT WARN: every criterion note, story point and action must carry at least one
// reference that survives the library validator (a section link of a shortlisted document + a quote
// found in that section). Anything left with none is discarded server-side and never shown.
//
// ⚠ THE CRITERIA ARE THE ONES THE STORY SECTION SHOWS (lib/ticketStory.ts `storySummaryOf`): the latest
// succeeded ticket review's criteria, else the CURRENT sprint brief's numbered criteria, else Claude
// works them out from the description (stored with the run). Items attach by 1-based number `n`.
//
// Every cap is spelled ONCE here and read by the prompt, the validator and the renderer.

import type { AiProviderId } from './types.js';
import type { ReferenceDocCitation } from './reference-docs.js';

// ---- models + version ----

export const STORY_DOCS_SHORTLIST_MODEL = 'claude-haiku-5-5';
export const STORY_DOCS_ALIGNMENT_MODEL = 'claude-sonnet-5';
/** Bump when the prompts, the validator or the result shape change what a run produces for the same
 *  inputs: every stored run then reads "Out of date" once. Folded into the fingerprint. */
export const STORY_DOCS_ALIGNMENT_VERSION = 2;

// ---- caps ----

/** Section files the shortlist may name. */
export const STORY_DOCS_SHORTLIST_MAX = 8;
/** The section text the read's prompt carries, in characters, across every section. A library whose
 *  sections all fit is sent whole and the shortlist call is skipped. */
export const STORY_DOCS_INLINE_CHARS = 48_000;
/** Candidates the deterministic prefilter hands the shortlist call (a library too big to send whole). */
export const STORY_DOCS_PREFILTER_MAX = 30;
/** One shortlist reason, in characters. */
export const STORY_DOCS_SHORTLIST_REASON_MAX = 160;
/** Actionable bullets on the whole story (the prompt asks for at least STORY_DOCS_ACTIONS_MIN). */
export const STORY_DOCS_ACTIONS_MIN = 2;
export const STORY_DOCS_ACTIONS_MAX = 6;
/** One action, in characters. */
export const STORY_DOCS_ACTION_MAX = 240;
/** Points on parts of the story beyond the acceptance criteria. */
export const STORY_DOCS_STORY_PARTS_MAX = 5;
/** The label naming which part of the story a point is about ("The refund flow"). */
export const STORY_DOCS_PART_LABEL_MAX = 80;
/** A criterion note or a story point's note, in characters. */
export const STORY_DOCS_NOTE_MAX = 400;
/** The whole-story summary, in characters and in sentences. */
export const STORY_DOCS_SUMMARY_MAX = 600;
export const STORY_DOCS_SUMMARY_SENTENCES_MIN = 2;
export const STORY_DOCS_SUMMARY_SENTENCES_MAX = 3;
/** A quote copied from a section (the library validator's own limit). */
export const STORY_DOCS_QUOTE_MAX = 300;
/** References on one item (criterion, story point or action). */
export const STORY_DOCS_REFS_PER_ITEM_MAX = 3;
/** Criteria handed to the run from the ticket review or the brief (past this, the rest are not checked). */
export const STORY_DOCS_CRITERIA_MAX = 40;
/** Criteria Claude may work out from the description when the story section shows none. */
export const STORY_DOCS_DERIVED_CRITERIA_MAX = 12;
/** One criterion's text, in characters (derived criteria are clipped to this). */
export const STORY_DOCS_CRITERION_TEXT_MAX = 300;
/** The ticket identifier, as the routes accept it. */
export const STORY_DOCS_IDENT_MAX = 600;

// ---- verdicts ----

export type StoryDocsOverallVerdict = 'aligned' | 'mixed' | 'diverges';
export const STORY_DOCS_OVERALL_VERDICTS: readonly StoryDocsOverallVerdict[] = ['aligned', 'mixed', 'diverges'];
export const STORY_DOCS_OVERALL_VERDICT_LABEL: Record<StoryDocsOverallVerdict, string> = {
  aligned: 'Matches the docs',
  mixed: 'Partly matches the docs',
  diverges: 'Goes against the docs',
};

export type StoryDocsItemVerdict = 'aligned' | 'partly' | 'diverges';
export const STORY_DOCS_ITEM_VERDICTS: readonly StoryDocsItemVerdict[] = ['aligned', 'partly', 'diverges'];
export const STORY_DOCS_ITEM_VERDICT_LABEL: Record<StoryDocsItemVerdict, string> = {
  aligned: 'Matches',
  partly: 'Partly',
  diverges: 'Differs',
};

// ---- the stored result ----

/** One checked passage: a section of a shortlisted document and a quote found in it. The workspace is
 *  the one whose library the server checked it against, so the link opens THAT library. */
export type StoryDocsRef = ReferenceDocCitation & {
  workspaceId: number;
  /** Copied from the section (server-checked), ≤ STORY_DOCS_QUOTE_MAX. */
  quote: string;
};

/** One acceptance criterion the docs bear on. Criteria the docs say nothing about have no item. */
export interface StoryDocsCriterionItem {
  /** 1-based, the criterion's number in the run's `criteria`. */
  n: number;
  verdict: StoryDocsItemVerdict;
  /** One or two sentences, ≤ STORY_DOCS_NOTE_MAX. */
  note: string;
  /** 1..STORY_DOCS_REFS_PER_ITEM_MAX. */
  refs: StoryDocsRef[];
}

/** A point on a part of the story that is not one acceptance criterion (the description, a flow, a rule). */
export interface StoryDocsStoryPoint {
  /** Which part, in a few words (≤ STORY_DOCS_PART_LABEL_MAX). */
  part: string;
  verdict: StoryDocsItemVerdict;
  note: string;
  refs: StoryDocsRef[];
}

/** One actionable bullet on the whole story. */
export interface StoryDocsAction {
  /** ≤ STORY_DOCS_ACTION_MAX. */
  text: string;
  refs: StoryDocsRef[];
}

export interface StoryDocsOverall {
  verdict: StoryDocsOverallVerdict;
  /** 2-3 sentences on how the story lines up with the docs, ≤ STORY_DOCS_SUMMARY_MAX. */
  summary: string;
  /** 0..STORY_DOCS_ACTIONS_MAX (what survived grounding). */
  actions: StoryDocsAction[];
}

/** A section the shortlist chose (server-checked), with Claude Haiku's reason. */
export interface StoryDocsShortlistEntry extends ReferenceDocCitation {
  workspaceId: number;
  /** ≤ STORY_DOCS_SHORTLIST_REASON_MAX. */
  reason: string;
}

/**
 *   checked           the read ran and at least one grounded point survived (`overall` set)
 *   no_relevant_docs  the shortlist named no section: nothing in the library bears on this story
 *   nothing_grounded  the read ran but no point kept a checked reference (`overall` null)
 */
export type StoryDocsOutcome = 'checked' | 'no_relevant_docs' | 'nothing_grounded';

export interface StoryDocsAlignmentResult {
  outcome: StoryDocsOutcome;
  overall: StoryDocsOverall | null;
  /** Sorted by `n`; at most one per criterion. */
  criteria: StoryDocsCriterionItem[];
  /** 0..STORY_DOCS_STORY_PARTS_MAX. */
  storyParts: StoryDocsStoryPoint[];
  /** What the read started from (empty for `no_relevant_docs`). */
  shortlist: StoryDocsShortlistEntry[];
  /** Points and references the server threw away (no checked reference). Diagnostic; not rendered. */
  dropped: number;
}

// ---- the run ----

export type StoryDocsAlignmentStatus = 'queued' | 'shortlisting' | 'reading' | 'succeeded' | 'failed';
export const STORY_DOCS_IN_FLIGHT: readonly StoryDocsAlignmentStatus[] = ['queued', 'shortlisting', 'reading'];
export const isStoryDocsInFlight = (s: StoryDocsAlignmentStatus): boolean => STORY_DOCS_IN_FLIGHT.includes(s);

/** Where the run's criteria came from — the same order the Story section uses. */
export type StoryDocsCriteriaSource = 'ticket_review' | 'brief' | 'derived';

export interface StoryDocsCriterion {
  /** 1-based. */
  n: number;
  text: string;
}

/** What moved since the run (any ⇒ `current: false`). */
export type StoryDocsStaleReason = 'story' | 'criteria' | 'library' | 'version';

export interface StoryDocsAlignmentRun {
  id: number;
  workspaceId: number;
  ident: string;
  ticketKey: string | null;
  status: StoryDocsAlignmentStatus;
  /** A plain sentence when `failed`; null otherwise. */
  error: string | null;
  /** The run's fingerprint equals the live one (story text, criteria list, built library, version). */
  current: boolean;
  /** [] when current. */
  staleBecause: StoryDocsStaleReason[];
  criteriaSource: StoryDocsCriteriaSource;
  /** The criteria this run checked: as given (ticket review / brief), or Claude's when 'derived'
   *  ([] for a derived run until it has read). */
  criteria: StoryDocsCriterion[];
  /** Set only when `succeeded`. */
  result: StoryDocsAlignmentResult | null;
  /** Both model calls, US$; null until known. */
  costUsd: number | null;
  // What ran it (docs/CODEX-PLAN.md Phase 4): the model id and its provider. Optional: an older
  // server or row omits them — read through `aiRunLabel(provider, model)`.
  model?: string | null;
  provider?: AiProviderId;
  createdAt: string; // ISO-8601
  finishedAt: string | null; // ISO-8601
}

// ---- the wire ----

/** GET /api/docs/story-alignment?workspace=<id>&ident=<trackerTicketIdent> */
export interface StoryDocsAlignmentResponse {
  workspaceId: number;
  ident: string;
  /** The workspace has at least one built document: the button is offered. (The Settings switch for
   *  using the library in reviews is NOT consulted — the click is the consent.) */
  available: boolean;
  docCount: number;
  /** The newest run, any status; null when never run. */
  run: StoryDocsAlignmentRun | null;
  /** The newest SUCCEEDED run when `run` is not that one (in flight or failed), so a re-run never
   *  hides the last good result; null otherwise. */
  lastSucceeded: StoryDocsAlignmentRun | null;
}

/** POST /api/docs/story-alignment */
export interface StartStoryDocsAlignmentBody {
  /** Absent ⇒ the default workspace (resolveWorkspaceScope). */
  workspaceId?: number;
  ident: string;
  /** Run even when nothing changed since the newest succeeded run (else that run is `reused`). */
  force?: boolean;
}

export type StoryDocsAlignmentRefusal =
  /** No built document in this workspace's library. */
  | 'no_docs'
  /** No story text and no criteria to check. */
  | 'no_story'
  /** STORY_DOCS_ALIGNMENT_DAILY_CAP runs already started today (UTC). */
  | 'daily_cap';

/**
 *   queued           a new run was queued
 *   already_running  a run of this story is queued or running (its id once inserted)
 *   reused           nothing changed since the newest succeeded run (same fingerprint): that run IS the
 *                    answer, no model call, no new row
 */
export type StartStoryDocsAlignmentResponse =
  | { outcome: 'queued' | 'already_running'; runId: number | null }
  | { outcome: 'reused'; runId: number }
  | { outcome: 'refused'; runId: null; refusal: StoryDocsAlignmentRefusal };

export const STORY_DOCS_REFUSAL_TEXT: Record<StoryDocsAlignmentRefusal, string> = {
  no_docs: 'This workspace has no reference docs yet.',
  no_story: 'This ticket has no text to check.',
  daily_cap: "Today's limit for docs checks is reached. Try again tomorrow.",
};

// ---- defensive re-read of a stored result ----

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function refsFromStored(raw: unknown): StoryDocsRef[] {
  if (!Array.isArray(raw)) return [];
  const out: StoryDocsRef[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    const path = str(r.path);
    const docSlug = str(r.docSlug);
    const docTitle = str(r.docTitle);
    const quote = str(r.quote);
    const workspaceId = posInt(r.workspaceId);
    if (path == null || docSlug == null || docTitle == null || quote == null || workspaceId == null) continue;
    out.push({
      path,
      workspaceId,
      anchor: str(r.anchor),
      docSlug,
      docTitle,
      sectionTitle: str(r.sectionTitle),
      quote,
    });
    if (out.length >= STORY_DOCS_REFS_PER_ITEM_MAX) break;
  }
  return out;
}

const itemVerdict = (v: unknown): StoryDocsItemVerdict | null =>
  typeof v === 'string' && (STORY_DOCS_ITEM_VERDICTS as readonly string[]).includes(v) ? (v as StoryDocsItemVerdict) : null;

/** A stored `result_json`, re-read defensively; null when unusable. Items left with no reference are
 *  dropped here too, so a hand-edited row can never show an ungrounded point. */
export function storyDocsResultFromStored(raw: unknown): StoryDocsAlignmentResult | null {
  if (!isObj(raw)) return null;
  const outcome = raw.outcome;
  if (outcome !== 'checked' && outcome !== 'no_relevant_docs' && outcome !== 'nothing_grounded') return null;
  const criteria: StoryDocsCriterionItem[] = [];
  const seenN = new Set<number>();
  for (const c of Array.isArray(raw.criteria) ? raw.criteria : []) {
    if (!isObj(c)) continue;
    const n = posInt(c.n);
    const verdict = itemVerdict(c.verdict);
    const refs = refsFromStored(c.refs);
    if (n == null || verdict == null || refs.length === 0 || seenN.has(n)) continue;
    seenN.add(n);
    criteria.push({ n, verdict, note: str(c.note) ?? '', refs });
  }
  criteria.sort((a, b) => a.n - b.n);
  const storyParts: StoryDocsStoryPoint[] = [];
  for (const p of Array.isArray(raw.storyParts) ? raw.storyParts : []) {
    if (!isObj(p)) continue;
    const part = str(p.part);
    const verdict = itemVerdict(p.verdict);
    const refs = refsFromStored(p.refs);
    if (part == null || verdict == null || refs.length === 0) continue;
    storyParts.push({ part, verdict, note: str(p.note) ?? '', refs });
    if (storyParts.length >= STORY_DOCS_STORY_PARTS_MAX) break;
  }
  let overall: StoryDocsOverall | null = null;
  if (isObj(raw.overall)) {
    const o = raw.overall;
    const verdict =
      typeof o.verdict === 'string' && (STORY_DOCS_OVERALL_VERDICTS as readonly string[]).includes(o.verdict)
        ? (o.verdict as StoryDocsOverallVerdict)
        : null;
    const summary = str(o.summary);
    if (verdict != null && summary != null) {
      const actions: StoryDocsAction[] = [];
      for (const a of Array.isArray(o.actions) ? o.actions : []) {
        if (!isObj(a)) continue;
        const text = str(a.text);
        const refs = refsFromStored(a.refs);
        if (text == null || refs.length === 0) continue;
        actions.push({ text, refs });
        if (actions.length >= STORY_DOCS_ACTIONS_MAX) break;
      }
      overall = { verdict, summary, actions };
    }
  }
  const shortlist: StoryDocsShortlistEntry[] = [];
  for (const s of Array.isArray(raw.shortlist) ? raw.shortlist : []) {
    if (!isObj(s)) continue;
    const path = str(s.path);
    const docSlug = str(s.docSlug);
    const docTitle = str(s.docTitle);
    const workspaceId = posInt(s.workspaceId);
    if (path == null || docSlug == null || docTitle == null || workspaceId == null) continue;
    shortlist.push({
      path,
      workspaceId,
      anchor: str(s.anchor),
      docSlug,
      docTitle,
      sectionTitle: str(s.sectionTitle),
      reason: str(s.reason) ?? '',
    });
    if (shortlist.length >= STORY_DOCS_SHORTLIST_MAX) break;
  }
  return {
    outcome: outcome === 'checked' && overall == null ? 'nothing_grounded' : outcome,
    overall: outcome === 'checked' ? overall : null,
    criteria: outcome === 'checked' ? criteria : [],
    storyParts: outcome === 'checked' ? storyParts : [],
    shortlist,
    dropped: typeof raw.dropped === 'number' && Number.isFinite(raw.dropped) && raw.dropped >= 0 ? raw.dropped : 0,
  };
}

/** The per-criterion items keyed by number, for the two criteria lists of the Story section. */
export function storyDocsItemsByN(result: StoryDocsAlignmentResult | null | undefined): Map<number, StoryDocsCriterionItem> {
  const out = new Map<number, StoryDocsCriterionItem>();
  for (const c of result?.criteria ?? []) out.set(c.n, c);
  return out;
}
