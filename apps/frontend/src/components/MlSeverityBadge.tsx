import type { MlCategory, MlLabel, MlSeverity, MlSeverityCounts } from '@pierre-review/shared';
import { ML_CATEGORY_LABEL, ML_SEVERITY_META, vendorInk } from '../lib/ui.js';
import { disagreeDirection } from '../lib/severityAgreement.js';
import { ArrowIcon } from './Icons.js';

// `severityProb` is the RAW probability of the CHOSEN class, and the argmax of a FOUR-class
// softmax can never be below 1/4. So a stored label under 0.25 is one the MODEL DID NOT PICK —
// the serving-side calibration prior overrode its own argmax. That is an IDENTITY, not a
// threshold anyone tuned, and it is true of ~15% of the CodeRabbit corpus
// (docs/ML-SEVERITY.md § Accuracy). It is a different statement from "we are not very sure",
// which is why it gets its own mark and its own sentence rather than being folded into the
// low-confidence case below.
const ARGMAX_FLOOR = 0.25;

// Ordinary low confidence — a WEAKER version of the same statement, not a different one. The
// number carries real signal: agreement with an independent rater rises monotonically with it
// (39% below 0.40 → 70% at ≥0.75), so below roughly half the pill should stop asserting itself.
const LOW_CONFIDENCE = 0.5;

// The ML severity/category pill on a BOT comment (CORE, free tier — a local ONNX classifier,
// not an LLM, nothing billed).
//
// RENDERS NOTHING WITHOUT A LABEL. Every call site passes a label it already found in the ONE
// per-PR index (useMlLabelIndex); this component never fetches. That is the load-bearing rule
// on this surface: a bordered box drawn per target behind a per-target query is how a 60-thread
// PR once became 60 requests painting 60 empty panels.
export function MlSeverityBadge({
  label,
  compact,
  vendorClaim,
}: {
  label: MlLabel | undefined;
  /**
   * Drop the category chip AND the vendor's own claim — for dense rows where only the severity
   * fits. The second half is not just about space: the one compact caller (ThreadCard) passes a
   * ROLLUP (`worstSeverity` across a conversation), and one comment's vendor badge must never be
   * shown against a number that summarises several of our verdicts.
   */
  compact?: boolean;
  /**
   * SAY SOMETHING IN ALL FOUR VENDOR STATES, not just the contradiction.
   *
   * The default is silence on agreement and on a bot that declared nothing — correct everywhere a
   * severity pill is incidental, because two pills saying the same thing is noise. It is WRONG on
   * the bot-flagging drill-down, whose facets are exactly `agree` / `overCall` / `underCall` /
   * `undeclared`: there, silence leaves three of the four looking identical. So this mode adds the
   * two muted markers, and marks the contradiction with its DIRECTION.
   *
   * ⚠ Direction is the two SEVERITY ORDINALS and nothing else (`disagreeDirection`) — never
   * `severityProb` (our confidence in our own class), never `vendorSeverityConfidence` (the marker
   * reader's confidence that it read a real badge). And this is a display of two claims, never a
   * reconciliation: our severity is the more accurate rater (0.700 exact on the adjudicated
   * gold-300 against the vendor badge's 0.474), so nothing here invites the reader to resolve the
   * disagreement, and nothing anywhere derives our label from theirs.
   *
   * Ignored under `compact`, which is a rollup and has no single vendor claim to report.
   *
   * (This absorbed `BotCommentCard`'s `VendorClaim`, which rendered BESIDE this badge on the
   * identical condition and produced rows reading "[Major] bot said Minor ↑ bot called it worse".)
   */
  vendorClaim?: boolean;
}): JSX.Element | null {
  if (!label) return null;
  const meta = ML_SEVERITY_META[label.severity];
  const categories = label.categories.slice(0, 2);
  // The category list is the model's, so an unrecognised value would render as a raw
  // snake_case key; ML_CATEGORY_LABEL covers all eight, and anything else is dropped upstream.
  const categoryText = categories.map((c) => ML_CATEGORY_LABEL[c] ?? c).join(' · ');
  const confidence = Math.round(label.severityProb * 100);
  // The `backend` string is the only signal that a deployment fell back to the marker heuristic;
  // saying so in the tooltip is cheaper than a user wondering why the labels look odd.
  const fromModel = label.backend.includes('modernbert-onnx');
  const modelNote = fromModel
    ? ''
    : '\nHeuristic fallback — the ML model was not loaded on the server.';

  // "the model did not pick this" is a claim about a four-class softmax, so it may only be made
  // about a label the MODEL produced — on a marker-fallback deployment `severityProb` is not a
  // softmax at all and the floor identity does not hold.
  const overridden = fromModel && label.severityProb < ARGMAX_FLOOR;
  const dim = label.severityProb < LOW_CONFIDENCE;

  // ── The bot's OWN badge — shown only when it CONTRADICTS ours ────────────────────────────
  // Agreement stays silent (two pills saying the same thing is noise) UNLESS `vendorClaim` asks
  // for all four states — see that prop. This is a display of what
  // the vendor claimed, never a correction of our label and never a second opinion of equal
  // weight: on a held-out adjudicated sample our severities score 0.700 exact / 0.303 ordinal MAE
  // against the vendor badge's 0.474 / 0.697 — we are the more accurate rater, and the
  // contradiction is the product (docs/ML-SEVERITY.md § Accuracy). Nothing here invites the user
  // to resolve the disagreement, because there is nothing to resolve.
  const vendorMeta =
    !compact && label.vendorSeverity && label.vendorSeverity !== label.severity
      ? ML_SEVERITY_META[label.vendorSeverity]
      : null;
  // Which way it contradicts — ordinals only. Non-null exactly when `vendorMeta` is, but computed
  // through the shared fold so the direction can never be re-derived a second, different way here.
  const dir = vendorMeta ? disagreeDirection(label) : null;
  // The other two states, said out loud only in `vendorClaim` mode (see the prop's note).
  const quietVendorState =
    vendorClaim && !compact && !vendorMeta
      ? label.vendorSeverity == null
        ? {
            text: 'bot declared nothing',
            title:
              'This bot posted no severity badge of its own, so there is nothing here to agree or disagree with — the matrix’s ‘none’ column. Silence is not agreement, which is why the two are counted apart.',
          }
        : {
            text: 'bot agreed',
            title: `The bot badged this ${meta.label} itself — the matrix’s diagonal. Said out loud here because on this screen agreement is a finding of its own; on an ordinary comment the badge stays quiet about it.`,
          }
      : null;
  // How sure the marker parser is that it READ a real declared badge — metadata about the
  // vendor's claim, never about ours. Only worth saying when it is not 'high', so we don't
  // misquote a bot on a shaky parse.
  const vendorReadNote =
    label.vendorSeverityConfidence && label.vendorSeverityConfidence !== 'high'
      ? ` (a ${label.vendorSeverityConfidence}-confidence read of its own markup)`
      : '';

  const title =
    `${meta.label}: ${meta.description}\n` +
    `Confidence ${confidence}%. Category: ${
      label.categories.map((c) => ML_CATEGORY_LABEL[c] ?? c).join(', ') || 'none'
    }.` +
    (overridden
      ? `\nThe model did not pick this label — a four-class score is never under 25%, so ${confidence}% means the serving-side calibration overrode the model's own choice.`
      : dim
        ? '\nDimmed: under 50% confidence, where this label is materially less reliable.'
        : '') +
    (vendorMeta
      ? `\nThe bot badged this ${vendorMeta.label} itself${vendorReadNote}. Ours is the more accurate rating — 70% agreement with human adjudication on a held-out sample, against the bot's 47%.`
      : '') +
    (label.isSummary ? '\nThis is a PR walkthrough/summary, not a specific finding.' : '') +
    modelNote;

  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold${
          dim ? ' opacity-70' : ''
        }`}
        style={{ backgroundColor: `${meta.color}1a`, ...vendorInk(meta.color) }}
      >
        {/* The dot goes HOLLOW when calibration overrode the model's own pick — a different mark
            rather than a fainter one, because it is a different kind of statement. Drawn with an
            inset box-shadow, not a border, so the pill's geometry is byte-identical to the
            ordinary case and nothing on a dense row reflows. */}
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={
            overridden
              ? { boxShadow: `inset 0 0 0 1px ${meta.color}` }
              : { backgroundColor: meta.color }
          }
        />
        {meta.label}
      </span>
      {/* Bare tinted text against our filled pill — the form difference is what carries the
          hierarchy, while the severity hue keeps the contradiction scannable. ONE element for the
          whole contradiction: the vendor's own severity IS the claim, so the direction rides it as
          an arrow + a muted word rather than as a second chip repeating the same fact. */}
      {vendorMeta && (
        <span
          className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-400 dark:text-gray-500"
          title={
            vendorClaim && dir != null
              ? `The bot badged this ${vendorMeta.label}; our model rated it ${meta.label}. The direction is the two severity ordinals — not anyone's confidence. Ours is the more accurate rating (70% agreement with human adjudication against the bot's 47%), so this is a disagreement to look at, not one to resolve.`
              : undefined
          }
        >
          {vendorClaim && dir != null && (
            <ArrowIcon dir={dir === 'over' ? 'up' : 'down'} size={10} />
          )}
          <span>bot said</span>
          <span className="font-semibold" style={vendorInk(vendorMeta.color)}>
            {vendorMeta.label}
          </span>
          {vendorClaim && dir != null && (
            <span className="opacity-80">· {dir === 'over' ? 'worse' : 'milder'}</span>
          )}
        </span>
      )}
      {quietVendorState && (
        <span
          className="text-[10px] text-gray-400 dark:text-gray-500"
          title={quietVendorState.title}
        >
          {quietVendorState.text}
        </span>
      )}
      {!compact && categoryText && (
        <span className="rounded bg-gray-100 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {categoryText}
        </span>
      )}
      {!compact && label.isSummary && (
        <span
          className="text-[10px] font-medium text-gray-400 dark:text-gray-500"
          title="A PR walkthrough/summary comment rather than a specific finding."
        >
          summary
        </span>
      )}
    </span>
  );
}

/**
 * The WORST severity across a set of labels — a thread's rollup, shown on its header so a long
 * conversation can be triaged without reading every reply's own badge.
 *
 * Summary comments are excluded from the rollup: a vendor walkthrough scored `major` would
 * otherwise flag every thread it happens to sit in.
 *
 * ⚠ The returned label is one comment's row, standing in for a whole conversation, so its
 * `vendorSeverity` is NOT a rollup and must not be rendered as one — which is why the caller
 * passes `compact` (see the prop's note above).
 *
 * ⚠ AND ON A ONE-COMMENT THREAD IT IS NOT A ROLLUP AT ALL — it returns that comment's own row,
 * which the comment renders for itself a few pixels lower. `ThreadCard` therefore does not call
 * this below two comments; read the note there before changing the call site.
 */
export function worstSeverity(labels: MlLabel[]): MlLabel | undefined {
  let worst: MlLabel | undefined;
  for (const l of labels) {
    if (l.isSummary) continue;
    if (!worst || l.severityOrd > worst.severityOrd) worst = l;
  }
  return worst;
}

/** Compact coloured dot+count chips per severity — the counts shape used in list headers. */
export function MlSeverityDots({
  counts,
}: {
  counts: Record<MlSeverity, number>;
}): JSX.Element | null {
  const order: MlSeverity[] = ['critical', 'major', 'minor', 'nit'];
  const shown = order.filter((s) => counts[s] > 0);
  if (shown.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      {shown.map((s) => {
        const meta = ML_SEVERITY_META[s];
        return (
          <span
            key={s}
            className="inline-flex items-center gap-0.5 text-[10px] font-semibold"
            style={vendorInk(meta.color)}
            title={`${meta.label}: ${counts[s]}`}
          >
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: meta.color }}
            />
            {counts[s]}
          </span>
        );
      })}
    </span>
  );
}

export function categoryLabel(c: MlCategory): string {
  return ML_CATEGORY_LABEL[c] ?? c;
}

/**
 * One horizontal severity-mix bar over a set of FINDINGS-only counts. ⚠ `total` must be the
 * FINDINGS count (the four counts' own sum), never the all-in labelled count — `bySeverity`
 * excludes summaries and praise, so dividing by `labelled` leaves a phantom gap at the end of
 * every bar. Lived in the retired standalone BotSeverityPanel; the merged Bots ROI table is
 * now the main consumer.
 */
const BAR_ORDER: MlSeverity[] = ['critical', 'major', 'minor', 'nit'];

export function SeverityBar({
  counts,
  total,
}: {
  counts: MlSeverityCounts;
  total: number;
}): JSX.Element {
  if (total === 0) {
    return <div className="h-2 w-full rounded-full bg-gray-100 dark:bg-gray-800" />;
  }
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
      {BAR_ORDER.map((s) => {
        const n = counts[s];
        if (n === 0) return null;
        const meta = ML_SEVERITY_META[s];
        return (
          <div
            key={s}
            style={{ width: `${(n / total) * 100}%`, backgroundColor: meta.color }}
            title={`${meta.label}: ${n}`}
          />
        );
      })}
    </div>
  );
}
