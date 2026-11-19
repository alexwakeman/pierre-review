import type { TicketCriterionOutside, TicketPrCardCriterion } from './types.js';
import { criterionDone, criterionOutsideWords } from './criterion-status.js';
import { criterionTextForMatch } from './prose.js';

// THE CRITERIA MAP — "how the code meets each criterion" (docs/CLAUDE-REVIEW.md § The criteria map,
// docs/FRONTEND.md § The story view → The criteria map). ONE pure fold, NO model call: it joins what
// is already stored —
//   • the latest story check's criteria (ref, text, status — the check's verdict, `criterionDone`), and
//   • each member PR's CURRENT contribution card (`TicketReviewMember.card`: the server sends only the
//     card at the PR's synced head, so a PR pushed since its card arrives with `card: null`).
// A LINK is one (criterion, PR) pair that a card says it moves forward, with the card's "how" and files.
//
// Rules:
//   • UNKNOWN IS NEVER ZERO: a criterion no card claims is a row with no links (`unclaimed`), drawn as
//     such; a PR with no current card is listed with `hasCard: false`, never dropped; a card line that
//     matches no criterion stays on its PR as `unmatched`, never silently lost.
//   • A card names a criterion by its text or its ref (cards.ts: "the criterion's text (short), or its
//     ref"), and the card may come from an earlier run with its own wording. So a card line is matched
//     by (1) the same text, (2) word overlap, clear winner only, (3) a lone leading ref ("AC3"). A tie
//     is no match: a guess would draw a link nobody wrote.
//   • The card is model-written; the status is the story check's. The fold never derives one from the
//     other: a met criterion no card claims stays met AND unclaimed.

/** One story-check criterion, as the fold reads it. */
export interface CriteriaMapCriterionIn {
  ref: string;
  text: string;
  status: string;
  // A met only code OUTSIDE the ticket delivers (`TicketCriterion.outside`).
  outside?: TicketCriterionOutside | null;
}

/** One member, as the fold reads it (a `TicketReviewMember`). */
export interface CriteriaMapMemberIn {
  prId: number;
  repo: string;
  number: number;
  title: string | null;
  state: 'open' | 'merged';
  label?: string | null;
  card?: { criteria: readonly TicketPrCardCriterion[] } | null;
}

/** One (criterion, PR) a card says it moves forward. */
export interface CriteriaMapLink {
  prId: number;
  /** The card's words (two card lines on one criterion are joined). */
  how: string;
  files: string[];
}

export interface CriteriaMapRow {
  ref: string;
  text: string;
  status: string;
  /** `criterionDone(status)` — the story check's verdict, never the cards'. */
  done: boolean;
  /** In member order. Empty = no current card claims it. */
  links: CriteriaMapLink[];
  /** A met only code outside the ticket delivers, in words ("Already in acme/api (no PR on this ticket)");
   *  null otherwise. */
  outside: string | null;
}

export interface CriteriaMapPr {
  prId: number;
  repo: string;
  number: number;
  title: string | null;
  state: 'open' | 'merged';
  label: string | null;
  /** false = no card at its current commit (never written, or pushed since): it can carry no link. */
  hasCard: boolean;
  /** Criteria rows it links to (distinct). */
  linkCount: number;
  /** Card lines that match no criterion of this check. */
  unmatched: TicketPrCardCriterion[];
}

export interface CriteriaMap {
  rows: CriteriaMapRow[];
  /** Members in the check's order. */
  prs: CriteriaMapPr[];
  links: number;
  /** Rows with no link. */
  unclaimed: number;
  /** PRs with no current card. */
  withoutCard: number;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'can', 'its', 'into', 'when', 'then', 'than', 'each',
  'every', 'any', 'all', 'has', 'have', 'not', 'but', 'they', 'their', 'them', 'will', 'must', 'should', 'user', 'users',
]);

/** Lower case, letters and digits only, one space. */
function norm(s: string): string {
  return criterionTextForMatch(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm(s).split(' ')) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
  }
  return out;
}

// A lone leading ref: "AC3", "AC 3", "AC3: …". A combined one ("AC1/AC2") names two and is left to text.
const LONE_REF = /^\s*ac\s?(\d+)(?![\s]*[/,&]\s*ac)\b/i;

/** The words two texts share, over the shorter one's words (0..1), and how many are shared. */
function overlap(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  if (a.size === 0 || b.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return { score: shared / Math.min(a.size, b.size), shared };
}

/** The share of words a match needs, and the fewest shared words. */
export const CRITERIA_MAP_MATCH_MIN = 0.5;
const MATCH_MIN_SHARED = 2;

/**
 * Which criterion (index) a card line names, or null when none clearly does. Pure.
 *   1. the same text (refs and punctuation aside);
 *   2. the best word overlap, when it clears CRITERIA_MAP_MATCH_MIN with ≥ 2 shared words and no other
 *      criterion scores the same;
 *   3. a lone leading ref equal to a criterion's ref.
 */
export function matchCardCriterion(cardText: string, criteria: readonly CriteriaMapCriterionIn[]): number | null {
  const n = norm(cardText);
  if (n !== '') {
    const exact = criteria.findIndex((c) => norm(c.text) === n);
    if (exact >= 0) return exact;
  }
  const mine = tokens(cardText);
  let best = -1;
  let bestScore = 0;
  let tie = false;
  criteria.forEach((c, i) => {
    const o = overlap(mine, tokens(c.text));
    if (o.shared < MATCH_MIN_SHARED || o.score < CRITERIA_MAP_MATCH_MIN) return;
    if (o.score > bestScore + 1e-9) {
      best = i;
      bestScore = o.score;
      tie = false;
    } else if (Math.abs(o.score - bestScore) <= 1e-9) tie = true;
  });
  if (best >= 0 && !tie) return best;
  const ref = LONE_REF.exec(cardText);
  if (ref != null) {
    const want = `ac${Number(ref[1])}`;
    const i = criteria.findIndex((c) => c.ref.replace(/\s+/g, '').toLowerCase() === want);
    if (i >= 0) return i;
  }
  return null;
}

/** Build the map. Pure; the inputs are never mutated. */
export function criteriaMap(criteria: readonly CriteriaMapCriterionIn[], members: readonly CriteriaMapMemberIn[]): CriteriaMap {
  const rows: CriteriaMapRow[] = criteria.map((c) => ({
    ref: c.ref,
    text: c.text,
    status: c.status,
    done: criterionDone(c.status),
    links: [],
    outside: c.status === 'met' && c.outside != null ? criterionOutsideWords(c.outside) : null,
  }));
  const prs: CriteriaMapPr[] = [];
  let links = 0;
  for (const m of members) {
    const card = m.card ?? null;
    const pr: CriteriaMapPr = {
      prId: m.prId,
      repo: m.repo,
      number: m.number,
      title: m.title,
      state: m.state,
      label: m.label ?? null,
      hasCard: card != null,
      linkCount: 0,
      unmatched: [],
    };
    prs.push(pr);
    if (card == null) continue;
    for (const line of card.criteria) {
      const i = matchCardCriterion(line.criterion, criteria);
      if (i == null) {
        pr.unmatched.push({ criterion: line.criterion, how: line.how, files: [...line.files] });
        continue;
      }
      const row = rows[i]!;
      const have = row.links.find((l) => l.prId === m.prId);
      if (have != null) {
        if (line.how !== '' && !have.how.includes(line.how)) have.how = have.how === '' ? line.how : `${have.how} ${line.how}`;
        for (const f of line.files) if (!have.files.includes(f)) have.files.push(f);
        continue;
      }
      row.links.push({ prId: m.prId, how: line.how, files: [...new Set(line.files)] });
      pr.linkCount += 1;
      links += 1;
    }
  }
  return {
    rows,
    prs,
    links,
    unclaimed: rows.filter((r) => r.links.length === 0).length,
    withoutCard: prs.filter((p) => !p.hasCard).length,
  };
}

/** Drawn at all: a check with criteria, judged over at least one PR. */
export function criteriaMapOffered(map: CriteriaMap): boolean {
  return map.rows.length > 0 && map.prs.length > 0;
}
