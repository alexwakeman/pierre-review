import type { MlCategory, MlLabel, MlSeverity } from '@pierre-review/shared';
import { ML_CATEGORY_LABEL, ML_SEVERITY_META } from '../lib/ui.js';

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
}: {
  label: MlLabel | undefined;
  /** Drop the category chip — for dense rows where only the severity fits. */
  compact?: boolean;
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
  const modelNote = label.backend.includes('modernbert-onnx')
    ? ''
    : '\nHeuristic fallback — the ML model was not loaded on the server.';
  const title =
    `${meta.label}: ${meta.description}\n` +
    `Confidence ${confidence}%. Category: ${
      label.categories.map((c) => ML_CATEGORY_LABEL[c] ?? c).join(', ') || 'none'
    }.` +
    (label.isSummary ? '\nThis is a PR walkthrough/summary, not a specific finding.' : '') +
    modelNote;

  return (
    <span className="inline-flex items-center gap-1" title={title}>
      <span
        className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
        style={{ backgroundColor: `${meta.color}1a`, color: meta.color }}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
        {meta.label}
      </span>
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
 * The WORST severity across a set of labels — a thread's rollup, shown on its collapsed header
 * so a conversation can be triaged without expanding it.
 *
 * Summary comments are excluded from the rollup: a vendor walkthrough scored `major` would
 * otherwise flag every thread it happens to sit in.
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
            style={{ color: meta.color }}
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
