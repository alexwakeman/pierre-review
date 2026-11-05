// THE PROSE GUARD (docs/CLAUDE-REVIEW.md § Still-open points → The prose guard, 2026-11-05).
//
// A review summary must never name an open point the reader cannot find. PR DEFRA/bng-metric-frontend
// #454: a teammate's Limn posted "The change is sound and close to ready to merge, with one open point
// from the previous review." with no finding and every earlier comment judged addressed — the author
// could not find the point anywhere.
//
// The prompt forbids it (prompts.ts, the summary rule). This is the deterministic check after the
// model returns: when the run has NO open point on record — no finding (praise aside), no follow-up
// item still open, no thread judgement still open — a sentence that claims one is cut at the clause
// that says so ("…, with one open point from the previous review." → "The change is sound and close
// to ready to merge."), or dropped when the whole sentence is the claim (a bullet line too). When the
// run does record an open point, the text is left as the model wrote it. Pure.
import {
  isStillOpenFollowUp,
  isStillOpenThread,
  type ClaudeFollowUpItemRecord,
  type ClaudeThreadAssessment,
} from '@pierre-review/shared';

const NOUN = '(?:points?|issues?|items?|concerns?|questions?|comments?|findings?|threads?|problems?|matters?|blockers?|nits?|things?)';
const OPEN_WORD = '(?:open|outstanding|unresolved|unaddressed|remaining|pending)';
const STILL_WORD = '(?:open|outstanding|unresolved|unaddressed|not (?:yet )?(?:been )?addressed|to (?:be )?(?:addressed|fixed|resolved))';

// A claim that something is open: "one open point", "an outstanding issue", "a point remains open",
// "still unresolved", "left to address".
const OPEN_CLAIM_RE = new RegExp(
  [
    `\\b${OPEN_WORD}\\s+(?:[a-z-]+\\s+)?${NOUN}\\b`,
    `\\b${NOUN}\\s+(?:still\\s+)?(?:remains?|is|are|stays?)\\s+(?:still\\s+)?${STILL_WORD}`,
    `\\bstill\\s+${STILL_WORD}`,
    `\\b(?:remains?|left)\\s+${STILL_WORD}`,
    `\\b(?:one|two|three|\\d+|a few|some)\\s+(?:more\\s+)?${NOUN}\\s+(?:left|remain(?:s|ing)?)\\b`,
  ].join('|'),
  'i',
);

/** Does this text claim an open point? */
export function claimsOpenPoint(text: string): boolean {
  return OPEN_CLAIM_RE.test(text);
}

// Where a sentence may be cut: the start of the clause that holds the claim.
const CLAUSE_SEP_RE = /(?:,\s+|;\s+|\s+[—–]\s+|\s+-\s+|\s+but\s+|\s+though\s+|\s+although\s+|\s+except\s+)/gi;

/** One sentence without its open-point clause, or null when the sentence is the claim. */
function cutSentence(sentence: string): string | null {
  const m = OPEN_CLAIM_RE.exec(sentence);
  if (!m) return sentence;
  const before = sentence.slice(0, m.index);
  let cut = -1;
  for (const sep of before.matchAll(CLAUSE_SEP_RE)) cut = sep.index ?? -1;
  if (cut <= 0) return null;
  const kept = before.slice(0, cut).trim().replace(/[,;:—–-]+$/, '').trim();
  // Too little left to stand as a sentence ("Sound, with…" is not worth keeping).
  if (kept.split(/\s+/).length < 3 || claimsOpenPoint(kept)) return null;
  const end = /[.!?]$/.test(sentence.trim()) ? sentence.trim().slice(-1) : '.';
  return `${kept}${end}`;
}

// Sentences of one line: split after . ! ? followed by a space (a decimal or "e.g." mostly survives).
function sentencesOf(line: string): string[] {
  return line.split(/(?<=[.!?])\s+(?=[A-Z`*_[(])/);
}

/**
 * The summary with every claim of an open point removed — only when `hasOpenPoints` is false. Returns
 * the text unchanged otherwise, or when nothing claims one. Pure.
 */
export function withoutUnbackedOpenPoints(summary: string | null, hasOpenPoints: boolean): string | null {
  if (summary == null || hasOpenPoints || !claimsOpenPoint(summary)) return summary;
  const out: string[] = [];
  for (const raw of summary.split('\n')) {
    if (!claimsOpenPoint(raw)) {
      out.push(raw);
      continue;
    }
    const bullet = /^(\s*(?:[-*+•]|\d+[.)])\s+)(.*)$/.exec(raw);
    if (bullet) {
      // A bullet line IS one point: never keep a bullet that claims one is open.
      continue;
    }
    const kept = sentencesOf(raw)
      .map((s) => cutSentence(s))
      .filter((s): s is string => s != null && s.trim() !== '');
    if (kept.length > 0) out.push(kept.join(' '));
  }
  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

/** Does a run record any open point: a finding (praise aside), or a still-open judgement? Pure. */
export function runHasOpenPoints(r: {
  findings: ReadonlyArray<{ severity: string }>;
  followUpItems?: ReadonlyArray<Pick<ClaudeFollowUpItemRecord, 'status'>> | null;
  threadAssessments?: ReadonlyArray<Pick<ClaudeThreadAssessment, 'validity' | 'addressed'>> | null;
}): boolean {
  if (r.findings.some((f) => f.severity !== 'praise')) return true;
  if ((r.followUpItems ?? []).some((it) => isStillOpenFollowUp(it.status))) return true;
  return (r.threadAssessments ?? []).some((a) => a != null && isStillOpenThread(a));
}

/**
 * How many earlier points the run(s) hold open: follow-up items and thread judgements still open,
 * one per thread (a follow-up item without a thread counts once by its finding). A pair: both halves,
 * the later half's word on a thread wins. For the "Not approved" line. Pure.
 */
export function stillOpenCountOf(
  runs: ReadonlyArray<{
    followUpItems?: ReadonlyArray<Pick<ClaudeFollowUpItemRecord, 'status' | 'priorFindingId' | 'threadId'>> | null;
    threadAssessments?: ReadonlyArray<Pick<ClaudeThreadAssessment, 'validity' | 'addressed' | 'threadId'>> | null;
  }>,
): number {
  const open = new Map<string, boolean>();
  for (const r of runs) {
    for (const a of r.threadAssessments ?? []) {
      if (a == null || typeof a.threadId !== 'number') continue;
      if (a.validity === 'not_checked' && a.addressed === 'not_checked') continue;
      open.set(`t${a.threadId}`, isStillOpenThread(a));
    }
    for (const it of r.followUpItems ?? []) {
      if (it == null || it.status === 'not_checked') continue;
      open.set(typeof it.threadId === 'number' ? `t${it.threadId}` : `f${it.priorFindingId}`, isStillOpenFollowUp(it.status));
    }
  }
  return [...open.values()].filter(Boolean).length;
}
