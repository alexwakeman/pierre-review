// THE VERDICT RULE an automatic post (and a Claude + Codex pair's one review) uses, and THE ONE REASON
// a run was not approved. Pure, and in its own module so the pair's consolidated view (./pair-view.ts)
// can compute the pair's verdict without importing the auto-post I/O. auto-post.ts re-exports
// `autoVerdictFor` under its old name. docs/CLAUDE-REVIEW.md § Auto-posting → AUTO VERDICT.
//
// TWO WORKSPACE RULES (migration 0139), both OVERRIDES ONLY:
//   • `approveLeftovers` — what may stay open on an approve: 'nits_questions' (default), 'nits',
//     'none'. Blockers and warnings ALWAYS prevent it; praise never counts.
//   • `pairStrictness` — how a pair's two model verdicts fold (`pairVerdict`): 'strict' (default) =
//     both approved; 'relaxed' = at least one approved and NEITHER asked for changes.
import {
  AUTO_POST_DEFAULT_APPROVE_LEFTOVERS,
  PAIR_VERDICT_DEFAULT_STRICTNESS,
  clipAtSentence,
  type ApproveLeftovers,
  type AutoVerdictEvent,
  type AutoVerdictHeldReason,
  type ClaudeAutoVerdictRecord,
  type ClaudeFinding,
  type ClaudeFindingSeverity,
  type ClaudeNotApproved,
  type ClaudeReview,
  type ClaudeReviewVerdict,
  type PairVerdictStrictness,
} from '@pierre-review/shared';
import { isReaderIgnoredFinding } from './finding-facts.js';

/** The two workspace rules every verdict reads. */
export interface VerdictRules {
  pairStrictness: PairVerdictStrictness;
  approveLeftovers: ApproveLeftovers;
}
export const DEFAULT_VERDICT_RULES: VerdictRules = {
  pairStrictness: PAIR_VERDICT_DEFAULT_STRICTNESS,
  approveLeftovers: AUTO_POST_DEFAULT_APPROVE_LEFTOVERS,
};

/** The stored column → the rule in force. Anything else reads as the default. */
export function resolvePairStrictness(stored: unknown): PairVerdictStrictness {
  return stored === 'relaxed' ? 'relaxed' : 'strict';
}
export function resolveApproveLeftovers(stored: unknown): ApproveLeftovers {
  return stored === 'none' || stored === 'nits' ? stored : 'nits_questions';
}

/** May a finding of this severity still be open when Limn approves? */
export function leftoverAllowed(sev: ClaudeFindingSeverity, leftovers: ApproveLeftovers): boolean {
  switch (sev) {
    case 'blocker':
    case 'warning':
      return false;
    case 'nit':
      return leftovers !== 'none';
    case 'question':
      return leftovers === 'nits_questions';
    default:
      // Praise never counts.
      return true;
  }
}

type VerdictFinding = Pick<ClaudeFinding, 'severity' | 'included' | 'story'> &
  Partial<Pick<ClaudeFinding, 'postedAt' | 'priorFindingId'>>;

// ⚠ Everything except a READER'S ignore counts — a re-raise the server left out because its comment
// is already on this commit is still an open issue (`isReaderIgnoredFinding`).
const countedOf = <F extends VerdictFinding>(findings: readonly F[]): F[] =>
  findings.filter((f) => f.story == null && !isReaderIgnoredFinding(f));

/**
 * The verdict an auto post wants — the model's, made STRICTER. Counts the run's non-story findings a
 * reader did not ignore (whatever the kind toggles say): any blocker ⇒ REQUEST_CHANGES; APPROVE only
 * when the model approved and every open finding is one `leftovers` allows (never a warning);
 * everything else ⇒ COMMENT.
 */
export function autoVerdictFor(
  modelVerdict: ClaudeReview['verdict'],
  findings: readonly VerdictFinding[],
  leftovers: ApproveLeftovers = AUTO_POST_DEFAULT_APPROVE_LEFTOVERS,
): AutoVerdictEvent {
  const counted = countedOf(findings);
  if (counted.some((f) => f.severity === 'blocker')) return 'REQUEST_CHANGES';
  if (modelVerdict === 'APPROVE' && counted.every((f) => leftoverAllowed(f.severity, leftovers))) return 'APPROVE';
  return 'COMMENT';
}

/**
 * A PAIR's two model verdicts as one model verdict for `autoVerdictFor`. Either asked for changes ⇒
 * REQUEST_CHANGES. 'strict': APPROVE only when BOTH approved. 'relaxed': APPROVE when one approved
 * and the other gave a verdict that asks for nothing (APPROVE or COMMENT). Else COMMENT.
 */
export function pairVerdict(
  a: ClaudeReview['verdict'],
  b: ClaudeReview['verdict'],
  strictness: PairVerdictStrictness = PAIR_VERDICT_DEFAULT_STRICTNESS,
): ClaudeReviewVerdict {
  if (a === 'REQUEST_CHANGES' || b === 'REQUEST_CHANGES') return 'REQUEST_CHANGES';
  if (a === 'APPROVE' && b === 'APPROVE') return 'APPROVE';
  if (strictness === 'relaxed' && (a === 'APPROVE' || b === 'APPROVE') && (a === 'COMMENT' || b === 'COMMENT')) return 'APPROVE';
  return 'COMMENT';
}

/** One run as the reason reads it: who ran it, what it said, and its summary. */
export interface VerdictRun {
  by: string;
  verdict: ClaudeReview['verdict'];
  summary: string | null;
}

// The dissenting model's own words: its summary's first plain sentence, clipped at a sentence end.
const REASON_SENTENCE_MAX = 200;

/** A summary's first plain sentence (a list / heading line is skipped), or null. */
export function firstSentence(summary: string | null | undefined, max = REASON_SENTENCE_MAX): string | null {
  for (const raw of (summary ?? '').split('\n')) {
    const line = raw.trim();
    if (line === '' || /^([-*+•]|\d+[.)])\s/.test(line) || line.startsWith('#') || line.startsWith('|') || line.startsWith('```')) {
      continue;
    }
    const m = /^(.+?[.!?])(?=\s|$)/.exec(line);
    const one = (m?.[1] ?? line).replace(/\*\*/g, '').trim();
    if (one === '') continue;
    return clipAtSentence(one, max);
  }
  return null;
}

const plural = (n: number, one: string): string => (n === 1 ? `a ${one}` : `${n} ${one}s`);

/** "2 warnings are still open." / "a blocker and a question are still open." */
function openText(counts: Array<[number, string]>): string {
  const parts = counts.filter(([n]) => n > 0).map(([n, w]) => plural(n, w));
  const total = counts.reduce((a, [n]) => a + n, 0);
  const list = parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} ${total === 1 ? 'is' : 'are'} still open.`;
}

/**
 * A reason made safe for OUR GitHub comment (it may quote a model's summary, which read untrusted PR
 * text): no @-mention pings, no HTML comment (a forged marker), one line.
 */
export function safeReasonText(t: string): string {
  return t
    .replace(/<!--/g, '&lt;!--')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@​')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Not approved: <text>" — the one shape every reason takes. */
const sentence = (t: string): string => `Not approved: ${t}`;

/** A model that did not approve, in words: "Codex didn’t approve. <its first sentence>" */
export function dissentText(run: VerdictRun): string {
  const lead = run.verdict === 'REQUEST_CHANGES' ? `${run.by} asked for changes.` : `${run.by} didn’t approve.`;
  const why = firstSentence(run.summary);
  return why ? `${lead} ${why}` : lead;
}

/**
 * WHY THE FINDINGS AND THE MODEL(S) DO NOT GIVE AN APPROVAL — null exactly when
 * `autoVerdictFor(pairVerdict(…)|model, findings, leftovers)` is APPROVE. Checked in order: blockers
 * and warnings still open; the model(s) not approving (strict pair: the half that did not; relaxed
 * pair: the half that asked for changes, or both when neither approved); nits / questions the
 * workspace does not allow to remain. Pure.
 */
export function findingsNotApproved(
  runs: readonly VerdictRun[],
  findings: readonly VerdictFinding[],
  rules: VerdictRules = DEFAULT_VERDICT_RULES,
): ClaudeNotApproved | null {
  const counted = countedOf(findings);
  const n = (sev: ClaudeFindingSeverity) => counted.filter((f) => f.severity === sev).length;
  const blockers = n('blocker');
  const warnings = n('warning');
  if (blockers + warnings > 0) {
    return { heldReason: 'open_findings', text: sentence(openText([[blockers, 'blocker'], [warnings, 'warning']])) };
  }
  if (runs.length >= 2) {
    const [a, b] = runs as [VerdictRun, VerdictRun];
    const folded = pairVerdict(a.verdict, b.verdict, rules.pairStrictness);
    if (folded !== 'APPROVE') {
      const askers = runs.filter((r) => r.verdict === 'REQUEST_CHANGES');
      const notApproving = runs.filter((r) => r.verdict !== 'APPROVE');
      const held: AutoVerdictHeldReason = rules.pairStrictness === 'strict' ? 'pair_strict' : 'model_comment';
      // ONE half stands in the way: name it, in its own words.
      const lone = askers.length === 1 ? askers[0] : askers.length === 0 && notApproving.length === 1 ? notApproving[0] : null;
      if (lone != null) return { heldReason: held, text: sentence(dissentText(lone)) };
      const names = runs.map((r) => r.by);
      const text =
        askers.length === 2 ? `${names[0]} and ${names[1]} asked for changes.` : `neither ${names[0]} nor ${names[1]} approved.`;
      return { heldReason: 'model_comment', text: sentence(text) };
    }
  } else {
    const only = runs[0];
    if (only == null || only.verdict !== 'APPROVE') {
      return { heldReason: 'model_comment', text: sentence(dissentText(only ?? { by: 'Claude', verdict: null, summary: null })) };
    }
  }
  const nits = n('nit');
  const questions = n('question');
  const leftNits = leftoverAllowed('nit', rules.approveLeftovers) ? 0 : nits;
  const leftQuestions = leftoverAllowed('question', rules.approveLeftovers) ? 0 : questions;
  if (leftNits + leftQuestions > 0) {
    return { heldReason: 'open_findings', text: sentence(openText([[leftNits, 'nit'], [leftQuestions, 'question']])) };
  }
  return null;
}

/** The reason a gate held a wanted APPROVE (or a refused verdict), in words. */
export function heldReasonText(v: Pick<ClaudeAutoVerdictRecord, 'heldReason' | 'impact'>): string | null {
  switch (v.heldReason) {
    case 'own_pr':
      return sentence('your own pull request.');
    case 'prior_review':
      return sentence('your own review on GitHub still stands.');
    case 'already_requested':
      return sentence('the earlier request for changes still stands.');
    case 'reviews_unreadable':
      return sentence('couldn’t read the earlier reviews on GitHub.');
    case 'impact': {
      const lvl = v.impact;
      return lvl === 'high' || lvl === 'medium' || lvl === 'low'
        ? sentence(`${lvl[0]!.toUpperCase()}${lvl.slice(1)} impact.`)
        : sentence('impact unknown.');
    }
    case 'refused':
      return sentence('GitHub refused it.');
    default:
      return null;
  }
}

/**
 * Gate reasons that stay IN LIMN, never posted to GitHub: an author can never approve their own PR
 * ('own_pr' — it would fire on every head and never be actionable), the reader's own review still
 * standing ('prior_review' — posted under the same account, "not approved" would only confuse), and an internal / transient
 * failure ('reviews_unreadable' — a failed read; 'refused' — GitHub's own answer) is not news for the
 * team. Only a wanted APPROVE's gate text is ever one of these (a REQUEST_CHANGES held by a gate
 * carries the findings reason instead).
 */
const LIMN_ONLY_HELD_REASONS: ReadonlySet<string> = new Set(['own_pr', 'prior_review', 'reviews_unreadable', 'refused']);

/** May this verdict record's reason go to GitHub (body line or reason-only review)? Pure. */
export function reasonMayPost(v: Pick<ClaudeAutoVerdictRecord, 'wanted' | 'heldReason' | 'reasonText'> | null | undefined): boolean {
  if (v == null || v.reasonText == null || v.reasonText === '') return false;
  return !(v.wanted === 'APPROVE' && v.heldReason != null && LIMN_ONLY_HELD_REASONS.has(v.heldReason));
}

/**
 * THE ONE REASON for a verdict record: null when it APPROVED; else the findings / model reason when it
 * never wanted an approval (`findingsReason`), or the gate's when a wanted APPROVE was held.
 */
export function notApprovedOf(
  v: Pick<ClaudeAutoVerdictRecord, 'wanted' | 'submitted' | 'heldReason' | 'impact'>,
  findingsReason: ClaudeNotApproved | null,
): ClaudeNotApproved | null {
  if (v.submitted === 'APPROVE') return null;
  if (v.wanted === 'APPROVE' && v.heldReason != null) {
    const text = heldReasonText(v);
    if (text) return { heldReason: v.heldReason as AutoVerdictHeldReason, text };
  }
  return findingsReason;
}

/** A verdict record with its reason stamped (heldReason kept when a gate set one). */
export function withReason(
  v: ClaudeAutoVerdictRecord,
  findingsReason: ClaudeNotApproved | null,
): ClaudeAutoVerdictRecord {
  const r = notApprovedOf(v, findingsReason);
  if (r == null) return { ...v, reasonText: null };
  // `heldReason` keeps meaning "why `wanted` was not sent": a run that only ever wanted a COMMENT
  // takes the findings / model reason; a REQUEST_CHANGES (sent or held) keeps the gate's own.
  return { ...v, heldReason: v.wanted === 'COMMENT' ? r.heldReason : v.heldReason, reasonText: r.text };
}

/**
 * The open findings as a reason: 'severe' = blockers and warnings (they always prevent an approval);
 * 'leftovers' = the nits / questions `leftovers` does not allow to remain. null when none. Pure.
 */
export function openFindingsReason(
  open: readonly Pick<ClaudeFinding, 'severity'>[],
  which: 'severe' | 'leftovers',
  leftovers: ApproveLeftovers = AUTO_POST_DEFAULT_APPROVE_LEFTOVERS,
): ClaudeNotApproved | null {
  const n = (sev: ClaudeFindingSeverity) => open.filter((f) => f.severity === sev).length;
  const counts: Array<[number, string]> =
    which === 'severe'
      ? [
          [n('blocker'), 'blocker'],
          [n('warning'), 'warning'],
        ]
      : [
          [leftoverAllowed('nit', leftovers) ? 0 : n('nit'), 'nit'],
          [leftoverAllowed('question', leftovers) ? 0 : n('question'), 'question'],
        ];
  return counts.some(([c]) => c > 0) ? { heldReason: 'open_findings', text: sentence(openText(counts)) } : null;
}

/**
 * THE REPLIES OUTCOME'S PAIR RULE: a half of the full review that did not approve AND raised nothing
 * of its own (`raised` = its counted findings) stands in the way of an approval no reply can change —
 * a reply settles findings, not a model's reluctance (e.g. "the binary fixture cannot be checked from
 * the diff"). 'strict': any such half holds the approval; 'relaxed': only one that asked for changes,
 * or every half when none approved. A single run is never read this way (null). Pure.
 */
export function repliesDissent(
  halves: ReadonlyArray<VerdictRun & { raised: number }>,
  strictness: PairVerdictStrictness = PAIR_VERDICT_DEFAULT_STRICTNESS,
): ClaudeNotApproved | null {
  if (halves.length < 2) return null;
  const silent = halves.filter((h) => h.raised === 0 && h.verdict !== 'APPROVE');
  const noneApproved = halves.every((h) => h.verdict !== 'APPROVE');
  const blocking =
    strictness === 'strict' || (noneApproved && silent.length === halves.length)
      ? silent
      : silent.filter((h) => h.verdict === 'REQUEST_CHANGES');
  if (blocking.length === 0) return null;
  const held: AutoVerdictHeldReason = strictness === 'strict' ? 'pair_strict' : 'model_comment';
  if (blocking.length === 1) return { heldReason: held, text: sentence(dissentText(blocking[0]!)) };
  return { heldReason: 'model_comment', text: sentence(`neither ${blocking[0]!.by} nor ${blocking[1]!.by} approved.`) };
}
