import { ML_CATEGORIES, ML_SEVERITIES, ML_SEVERITY_ORD } from '@pierre-review/shared';
import type {
  BotFlaggingRefine,
  BotFlaggingSelector,
  MlCategory,
  MlLabel,
  MlSeverity,
  SeverityAgreementCellRef,
  SeverityAgreementMatrix,
  VendorSeverityAxis,
} from '@pierre-review/shared';
import { ML_CATEGORY_LABEL, ML_SEVERITY_META } from './ui.js';

// The pure layer behind the "what the bots are flagging" drill-down — reading the ours-vs-vendor
// confusion matrix, naming the tile a selector came from, and turning a selector/refine pair into
// a cache key.
//
// It lives here rather than inline in BotFlaggingDetail.tsx for the same reason `botComments.ts`
// does: every rule below has a wrong version that compiles and renders a plausible screen —
//   • "the bot disagrees" evaluated against a null vendor claim, which is most rows
//   • a direction read off `severityProb` or the vendor's confidence rather than the two ordinals
//   • an absent dense cell rendering `undefined` instead of the zero it means
//   • a query key built from the severities array in click order, so `['major','critical']` and
//     `['critical','major']` become two cache entries for one population
// Each one gets a test in test/severityAgreement.test.ts.
//
// ⚠ NOTHING HERE MAY DERIVE OUR SEVERITY FROM THE VENDOR'S. `MlLabel.vendorSeverity` is the bot's
// own claim and the LESS accurate of the two numbers on the object (0.474 exact vs our 0.700 on the
// adjudicated gold-300); it is displayed, and here it is COMPARED against ours, but it never
// corrects, overrides or seeds `severity`. The comparison is the product — the reconciliation
// would be a bug.
//
// ⚠ AND NOTHING HERE COUNTS. The drill-down's `total`/`filteredTotal`/`matrix` are the SERVER's,
// folded from the same scan the tiles are (see docs/ML-SEVERITY.md); a client-side re-derivation
// would disagree with the tile it was opened from — `pillOf` in botComments.ts already buckets a
// praise-flavoured walkthrough the opposite way from the backend, deliberately.

/**
 * Which column of the confusion matrix a row sits in. `'none'` is a real axis value, not a
 * placeholder: the bot declaring nothing is the common case (and equally what an older
 * severity-api reports for every row), so those rows get their own column rather than being
 * dropped from the matrix and quietly shrinking its denominator.
 */
export function vendorAxisOf(l: MlLabel): VendorSeverityAxis {
  return l.vendorSeverity ?? 'none';
}

/**
 * Which way the bot's own badge contradicts ours, or `null` for no contradiction.
 *
 * `null` covers TWO different situations on purpose — the bot agreed, and the bot said nothing —
 * because neither is a disagreement and the caller's question ("does this row survive the
 * Disagreements filter?") has the same answer for both. The matrix reports them apart, via
 * `agree` and `undeclared`.
 *
 * ⚠ ONLY SEVERITY, and only through `ML_SEVERITY_ORD` on BOTH sides. Not `severityProb` (our
 * confidence in our own class), not `vendorSeverityConfidence` (the marker reader's confidence
 * that it read a real badge) — a low-confidence read of a `critical` badge against our `nit` is
 * still the bot calling it worse than we did. Category never enters into it: vendors declare no
 * machine-readable category, so there is nothing there to disagree with.
 */
export function disagreeDirection(l: MlLabel): 'over' | 'under' | null {
  const vendor = l.vendorSeverity;
  if (vendor == null || vendor === l.severity) return null;
  return ML_SEVERITY_ORD[vendor] > ML_SEVERITY_ORD[l.severity] ? 'over' : 'under';
}

/**
 * Whether a row belongs to one clicked matrix cell. Goes through `vendorAxisOf` so a null claim
 * matches the `'none'` cell — a cell filter that tested `l.vendorSeverity === cell.vendor`
 * directly would render an empty list for the matrix's biggest column.
 */
export function matchesCell(l: MlLabel, cell: SeverityAgreementCellRef): boolean {
  return vendorAxisOf(l) === cell.vendor && l.severity === cell.ours;
}

/**
 * One cell's count. The wire grid is DENSE (5 vendor rows × our 4, zeros present), so a lookup
 * miss means the shape changed — answer `0` rather than letting `undefined` reach a
 * `.toLocaleString()` or a width calculation. A linear scan of 20 cells is cheaper than building
 * an index per render.
 */
export function matrixCell(
  m: SeverityAgreementMatrix,
  vendor: VendorSeverityAxis,
  ours: MlSeverity,
): number {
  return m.cells.find((c) => c.vendor === vendor && c.ours === ours)?.count ?? 0;
}

/**
 * The human name of the population a selector drills into — the tab chip's label and the
 * drill-down's own heading, so the two always agree with each other and with the tile that was
 * clicked (`BotRoiPanel`'s strip).
 *
 * The `severity` arm is spelled by SET rather than by member because the strip only ever emits two
 * of them and they have names on the tile: `['major','critical']` is "High severity" and `['nit']`
 * is "Nits". Any other combination is reachable only from a URL or a future caller, so it falls
 * back to listing the classes rather than inventing a name for them.
 */
/**
 * The bot narrowing a flagging drill-down was opened with: the EXACT `users.id` set the number
 * that was clicked was summed over, plus the name to call it by.
 *
 * ⚠ A SET, not one id, and the label is nullable BECAUSE OF THAT. A per-bar click narrows to one
 * bot and has its name; the card-level "View all N →" narrows to every bot the chart summed and
 * has no single name — so it passes `label: null` and the display falls back to a count. The set
 * is what makes the button's number and the list it opens agree by construction: the panel's bots
 * are role `'review'` while the drill-down resolves role `'all'`, both deliberately.
 */
export interface BotFlaggingBotNarrowing {
  userIds: number[];
  /** The single bot's display name when the set has exactly one member; null for a set. */
  label: string | null;
}

/**
 * How a narrowing names itself: the bot, or how many there are.
 *
 * Never `label ?? String(n)` — an unnamed single bot must not read "1", and a set must not read
 * as a bot's name. Both the chip and the on-page pill go through this one function, so the tab
 * and the heading can never describe the same narrowing differently.
 */
export function botNarrowLabel(n: BotFlaggingBotNarrowing): string {
  if (n.label) return n.label;
  return n.userIds.length === 1 ? '1 bot' : `${n.userIds.length} bots`;
}

export function selectorLabel(
  s: BotFlaggingSelector,
  // The bot narrowing, when the drill-down was opened from the Behaviour tab's inflation index
  // (one bot's bar, or the card-level "view all" over the bots the chart summed). It belongs IN
  // the name rather than only in a pill: the pinned tab's chip is `selectorLabel(seed).title`, and
  // two opens for two different bots would otherwise read "Flagged · Findings" both times — the
  // chip's whole job is to tell them apart. Absent for every tile-opened drill-down, which is why
  // it is optional rather than a widened parameter.
  bots?: BotFlaggingBotNarrowing | null,
): { title: string; subtitle: string } {
  const base = baseSelectorLabel(s);
  if (!bots) return base;
  // Possessive by arity: one named bot owns its comments; a set has no name to possess, and
  // "3 bots’s own comments" is how a single hard-coded sentence gives itself away.
  const owned = bots.label
    ? `${bots.label}’s own comments`
    : bots.userIds.length === 1
      ? 'this bot’s comments'
      : `these ${bots.userIds.length} bots’ comments`;
  return {
    title: `${base.title} — ${botNarrowLabel(bots)}`,
    // The narrowing goes in the SUBTITLE too, because that sentence is what the reader checks the
    // list against. The grid above it is deliberately NOT narrowed (the matrix describes the
    // selector population pre-refine), so the copy must not claim the whole screen is theirs.
    subtitle: `${base.subtitle} Narrowed to ${owned} — the grid above still describes every bot.`,
  };
}

function baseSelectorLabel(s: BotFlaggingSelector): { title: string; subtitle: string } {
  switch (s.kind) {
    case 'findings':
      return {
        title: 'Findings',
        subtitle: 'Scored bot comments that raise something — walkthroughs and praise excluded.',
      };
    case 'summaries':
      return {
        title: 'Walkthroughs & summaries',
        subtitle:
          'The PR-level summaries bots post. Scored, but never counted as findings — a walkthrough rated major must not outrank real ones.',
      };
    case 'severity': {
      const set = new Set(s.severities);
      const high = set.size === 2 && set.has('major') && set.has('critical');
      const nits = set.size === 1 && set.has('nit');
      // Worst-first for the reader (`ML_SEVERITIES`), NOT the key's lexicographic order — the two
      // orderings answer different questions and this codebase already carries both.
      const names = ML_SEVERITIES.filter((sev) => set.has(sev))
        .map((sev) => ML_SEVERITY_META[sev].label)
        .join(' or ');
      if (high) {
        return {
          title: 'High severity',
          subtitle:
            'Findings the model rated major or critical. The two are read together — CRITICAL alone is the class it under-recalls.',
        };
      }
      if (nits) {
        return { title: 'Nits', subtitle: 'Findings the model rated trivial or optional.' };
      }
      return {
        title: names || 'Severity',
        subtitle: names ? `Findings the model rated ${names}.` : 'Findings by severity.',
      };
    }
    case 'category':
      return {
        title: ML_CATEGORY_LABEL[s.category] ?? s.category,
        subtitle: `Findings the model tagged ${ML_CATEGORY_LABEL[s.category] ?? s.category}. Categories are multi-label, so a finding can appear under more than one.`,
      };
    case 'overlap':
      return {
        title: 'Same-line overlap',
        subtitle:
          'Line areas two or more review bots both flagged (within ±3 lines of each other in the same file). Measured from the threads themselves — not model-scored.',
      };
  }
}

/**
 * Canonical form of a `severity` selector's classes: deduplicated and sorted.
 *
 * ⚠ THIS IS THE CACHE-KEY RULE, not cosmetics. `['major','critical']` and `['critical','major']`
 * name the same population, and an unsorted key makes them two React Query entries — two requests,
 * two scroll positions, and a "Load more" that pages one of them while the other is on screen.
 * Lexicographic because the key only has to be canonical; the DISPLAY order is `ML_SEVERITIES`.
 */
function canonicalSeverities(severities: readonly MlSeverity[]): MlSeverity[] {
  return [...new Set(severities)].sort();
}

/**
 * A stable, collision-free string for the selector slot of the `['bot-flagging', …]` query key.
 * Every arm is prefixed by its `kind`, so a category named `findings` could never occupy the
 * Findings tile's entry.
 */
export function selectorQueryKey(s: BotFlaggingSelector): string {
  switch (s.kind) {
    case 'findings':
      return 'findings';
    case 'summaries':
      return 'summaries';
    case 'severity':
      return `severity:${canonicalSeverities(s.severities).join(',')}`;
    case 'category':
      return `category:${s.category}`;
    case 'overlap':
      return 'overlap';
  }
}

/**
 * The refine slot of the same key. The refinement is applied SERVER-side (paging is), so a change
 * to either half is a different response and must be a different entry — while an empty refine
 * has to produce one fixed string, or every mount would miss the cache.
 *
 * `'-'` is the no-narrowing marker in all three parts; it cannot collide with a
 * `VendorDisagreeDirection`, a `vendor>ours` cell or a `users.id`.
 *
 * ⚠ ALL THREE PARTS, and the third is the one that bites. `authorUserIds` narrows the list
 * SERVER-side exactly as the other two do, so a key that ignores it serves one bot's comments
 * from another bot's cache entry — two inflation bars clicked in a row would show the same list
 * under two different captions, with nothing on screen saying why.
 *
 * ⚠ THE BOT SLOT IS A SET, SO IT IS SORTED — the `canonicalSeverities` rule one function up.
 * `[7,3]` and `[3,7]` name one population; unsorted they are two React Query entries, two
 * `search`-tier requests and a "Load more" that pages the copy that is not on screen. And `[]`
 * ("no bots") must never key the same as `null` ("every bot"), which is why the empty set spells
 * itself `[]` rather than collapsing to the `'-'` marker.
 */
export function refineQueryKey(r: BotFlaggingRefine): string {
  const cell = r.cell ? `${r.cell.vendor}>${r.cell.ours}` : '-';
  const bots = r.authorUserIds
    ? `[${[...r.authorUserIds].sort((a, b) => a - b).join(',')}]`
    : '-';
  return `cell:${cell}|dis:${r.disagree ?? '-'}|bot:${bots}`;
}

// ── The on-page pickers ─────────────────────────────────────────────────────────────────────
// The drill-down opens on whatever tile was clicked, but the reader's next question is almost
// never "show me that same tile again" — it is "…and what about the criticals?" or "…and what
// about security?". These two mappings are what lets the page CHANGE its own selector without
// going back to the strip, and they are pure so the round-trip below can be pinned by a test:
// a picker whose value cannot be read back OUT of the selector renders a dropdown that forgets
// what it is showing on every re-render of the tab.

/**
 * One option of the severity dropdown.
 *
 * `'high'` is not a class — it is the `major + critical` PAIR the whole product reads together,
 * because the model under-recalls CRITICAL alone (docs/ML-SEVERITY.md § accuracy). It is offered
 * ALONGSIDE its two members rather than instead of them: the tile emits the pair, and someone
 * looking at the pair still needs to be able to ask for one half of it.
 *
 * `'praise'` is not a severity either — it is the v2 non-finding CATEGORY (the bot acknowledging
 * a fix, withdrawing a concern, saying thanks). It sits in the SEVERITY picker on the precedent
 * `botComments.ts`'s `SEVERITY_PILLS` already set for the comments list: from the reader's side
 * "show me only the praise" is the same kind of question as "show me only the criticals" — one
 * row of mutually-exclusive answers to "what KIND of thing was this bot saying". Splitting it out
 * into the topic dropdown would put it next to eight questions of a different shape ("what was
 * this finding ABOUT"), where it is the only option that is not a finding at all.
 */
export type SeverityPick = 'high' | MlSeverity | 'praise';

/** Worst-first, praise last — the order the dropdown renders in (`SEVERITY_PILLS`'s order, with
 *  the `high` pair leading, since it is the widest of the severity answers). */
export const SEVERITY_PICKS: SeverityPick[] = [
  'high',
  'critical',
  'major',
  'minor',
  'nit',
  'praise',
];

/**
 * The selector a severity pick drills into.
 *
 * `'high'` spells the pair the strip's own tile does (`['major','critical']`), so picking it lands
 * on the SAME query key — and therefore the same cached page — as arriving from the High-severity
 * tile. `'praise'` crosses arms into `category`, which is where praise lives on the wire; the
 * picker's job is to hide that from the reader, not to invent a `severities: ['praise']` the
 * server has no class for.
 */
export function severityPickToSelector(p: SeverityPick): BotFlaggingSelector {
  if (p === 'high') return { kind: 'severity', severities: ['major', 'critical'] };
  if (p === 'praise') return { kind: 'category', category: 'praise' };
  return { kind: 'severity', severities: [p] };
}

/**
 * The inverse: which option the dropdown should show as selected, or `null` when the selector is
 * not something the severity picker can express (`findings`, `summaries`, `overlap`, a real topic
 * category, or a severity SET the picker has no option for).
 *
 * By SET, never by index — `['major','critical']` and `['critical','major']` are one population
 * (the same rule `canonicalSeverities` exists for), and a picker that read `severities[0]` would
 * show "Major" for a list the caption calls High severity.
 */
export function severityPickOf(s: BotFlaggingSelector): SeverityPick | null {
  if (s.kind === 'category') return s.category === 'praise' ? 'praise' : null;
  if (s.kind !== 'severity') return null;
  const set = new Set(s.severities);
  if (set.size === 2 && set.has('major') && set.has('critical')) return 'high';
  if (set.size === 1) return [...set][0] ?? null;
  return null;
}

/**
 * Whether the SEVERITY dropdown is the control for this selector — i.e. the severity picker can
 * name it, so it can also re-point it without the page changing shape.
 */
export function isSeverityFamily(s: BotFlaggingSelector): boolean {
  return severityPickOf(s) !== null;
}

/**
 * Whether the TOPIC dropdown is the control for this selector.
 *
 * ⚠ PRAISE IS EXCLUDED, even though it is a `category` arm. It belongs to the SEVERITY family
 * (it is that picker's last option, see `SeverityPick`), and a plain `s.kind === 'category'` test
 * compiles, reads correctly, and makes the page swap its own dropdown the instant the reader picks
 * Praise: the severity select they just used disappears from under the cursor and a topic select
 * showing nothing selected takes its place. The two predicates must be disjoint AND total over the
 * arms the pickers own, which is exactly what excluding praise here buys.
 */
export function isCategoryFamily(s: BotFlaggingSelector): boolean {
  return s.kind === 'category' && s.category !== 'praise';
}

/**
 * The options the TOPIC dropdown offers: every ML category except `praise`.
 *
 * Praise is left out for two independent reasons and either one alone would be enough. It is the
 * severity picker's option (above). And the strip's `byCategory` — the counts the topic dropdown's
 * options are read against — is incremented ONLY inside the FINDING branch of the rollup fold
 * (`db/ml-labels.ts`: a praise row buckets as `praise`, never as a finding, exactly like a
 * walkthrough), so praise never appears there at all. Offering it as a topic would advertise a
 * topic whose count the strip can never display.
 */
export const TOPIC_PICKS: MlCategory[] = ML_CATEGORIES.filter((c) => c !== 'praise');
