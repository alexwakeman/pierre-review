import { useState } from 'react';
import type {
  AnnotationKind,
  AnnotationRunTarget,
  AnnotationTargetKind,
  AddressedVerdict,
  CommentAnnotation,
} from '@pierre-review/shared';
import { ADDRESSED_VERDICTS } from '@pierre-review/shared';
import { ADDRESSED_VERDICT_META } from '../lib/ui.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import {
  annotationKey,
  useAnnotationIndex,
  usePrAnnotations,
  useRunAnnotations,
} from '../hooks/useAnnotations.js';
import { Markdown } from './Markdown.js';

// The comment-ANNOTATIONS surface (Pro; the prSummary capability). ONE component renders every
// stored AI judgement about a comment or thread, whatever its kind:
//
//   simplify  — a faithful short rewrite of a long/bot-generated comment. Rendered as an
//               ADDITIONAL collapsible view: the original body is always still on screen right
//               below it. Never a destructive replacement — a rewrite you can't check against
//               the original is worse than the wall of text.
//   validity  — is the comment's point well-founded?
//   addressed — was the concern actually dealt with, and (the new part) WHAT is still open?
//
// STALENESS IS PASSIVE. A row whose target has changed since it was written gets a "may be out
// of date" chip and nothing else happens: there is no regenerate-on-open path, because that
// would bill on every open of a bot-flooded PR. The re-check is a button a human presses
// (ReviewCheckBar's "Re-check N stale").
//
// All of this reads ONE per-PR query (useAnnotationIndex) that every call site shares, so the
// number of chips on screen doesn't change the number of requests.

const VALIDITY_META: Record<string, { label: string; color: string }> = {
  valid: { label: 'Holds up', color: '#059669' },
  partly: { label: 'Partly valid', color: '#d97706' },
  weak: { label: 'Shaky', color: '#e11d48' },
  unclear: { label: 'Unclear', color: '#94a3b8' },
};

const KIND_META: Record<AnnotationKind, { label: string; title: string }> = {
  simplify: {
    label: 'Simplified',
    title: 'A shorter, faithful rewrite of this comment — the original is below, unchanged.',
  },
  validity: {
    label: 'Comment check',
    title: 'A critical second opinion on whether this comment’s point holds up.',
  },
  addressed: {
    label: 'Addressed check',
    title: 'Whether later changes actually dealt with this concern, and what is still open.',
  },
};

function verdictChip(a: CommentAnnotation): { label: string; color: string } | null {
  if (a.verdict == null) return null;
  if (a.kind === 'validity') return VALIDITY_META[a.verdict] ?? null;
  if (a.kind === 'addressed') {
    const meta = ADDRESSED_VERDICT_META[a.verdict as AddressedVerdict] as
      | { label: string; color: string }
      | undefined;
    if (meta == null) return null;
    return {
      label: a.confidence != null ? `${meta.label} · ${a.confidence}%` : meta.label,
      color: meta.color,
    };
  }
  return null;
}

function StaleChip(): JSX.Element {
  return (
    <span
      className="rounded-full border border-amber-300 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-amber-700 dark:text-amber-300"
      title="This comment (or the code around it) changed after the check ran, so the result may no longer hold. Use “Re-check stale” to refresh it."
    >
      may be out of date
    </span>
  );
}

function AnnotationPanel({
  annotation,
  defaultOpen,
}: {
  annotation: CommentAnnotation;
  defaultOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const meta = KIND_META[annotation.kind];
  const chip = verdictChip(annotation);

  return (
    <div className="mt-2 rounded-md border border-violet-200/70 bg-violet-50/40 px-2.5 py-1.5 dark:border-violet-900/50 dark:bg-violet-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          className="flex items-center gap-1 text-[11px] font-semibold text-violet-700 hover:underline dark:text-violet-300"
          title={meta.title}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span aria-hidden="true">✨</span>
          {meta.label}
        </button>
        {chip != null && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ backgroundColor: `${chip.color}1a`, color: chip.color }}
          >
            {chip.label}
          </span>
        )}
        {annotation.stale && <StaleChip />}
      </div>
      {open && (
        <div className="prose-thread mt-1.5 text-[12px] text-gray-700 dark:text-gray-200">
          <Markdown>{annotation.body}</Markdown>
          <div className="mt-1 text-[10px] text-gray-400">
            {annotation.kind === 'simplify'
              ? 'AI rewrite — the original comment is shown below, unchanged.'
              : 'AI judgement — a critical read, your call.'}{' '}
            {new Date(annotation.createdAt).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every stored annotation for ONE target (a thread, a review comment, or a PR-level comment).
 * Renders nothing without the capability, and nothing when the target has no annotations —
 * so it can be dropped at any comment site without adding empty chrome.
 */
export function CommentAnnotations({
  prId,
  targetKind,
  targetId,
  kinds,
}: {
  prId: number | null;
  targetKind: AnnotationTargetKind;
  targetId: number;
  /** Narrow to certain kinds (e.g. only `simplify` next to a comment body). Default: all. */
  kinds?: readonly AnnotationKind[];
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const index = useAnnotationIndex(prId, enabled);
  if (!enabled || index == null) return null;

  const want: readonly AnnotationKind[] = kinds ?? ['simplify', 'validity', 'addressed'];
  const found = want
    .map((k) => index.get(annotationKey(k, targetKind, targetId)))
    .filter((a): a is CommentAnnotation => a != null);
  if (found.length === 0) return null;

  return (
    <>
      {found.map((a) => (
        <AnnotationPanel
          key={a.kind}
          annotation={a}
          // OPEN BY DEFAULT, every kind. A verdict chip with the reasoning behind a ▸ is the same
          // failure as putting it in a `title` tooltip: the reader has to already suspect there is
          // something worth reading. "Likely addressed" is not actionable — "the rename is covered,
          // the null guard is not" is, and that sentence is the whole reason the run was paid for.
          // Volume is self-limiting: a panel only exists where a judgement was actually generated.
          defaultOpen
        />
      ))}
    </>
  );
}

// ---- "Check review" (the ONE run surface) ----------------------------------------------------
//
// There used to be three buttons ("Simplify all" / "Check validity" / "Check addressed") in two
// places — the Threads tab's sticky header and, misleadingly, under the "PR comments" heading, even
// though a run there covered threads too. Now there is ONE button, in ONE place, that produces all
// three judgements in a single model call per target (see the plugin's 'review' run kind) and a
// compact twin on each thread card and PR comment so the same check can be spent on just that one.
//
// The three judgements are still stored separately, so this bar's breakdown is computed CLIENT-side
// from the annotations already in the shared per-PR query — no new wire field, no extra request.

const VERDICT_ORDER: readonly string[] = ['valid', 'partly', 'weak', 'unclear'];

interface BreakdownLine {
  label: string;
  title: string;
  parts: Array<{ label: string; color: string; n: number }>;
  total: number;
}

/** Group the stored judgements into one line per kind, with each kind's verdict tally. */
function breakdownOf(annotations: readonly CommentAnnotation[]): BreakdownLine[] {
  const tally = (kind: AnnotationKind): Map<string, number> => {
    const m = new Map<string, number>();
    for (const a of annotations) {
      if (a.kind !== kind || a.verdict == null) continue;
      m.set(a.verdict, (m.get(a.verdict) ?? 0) + 1);
    }
    return m;
  };
  const count = (kind: AnnotationKind): number =>
    annotations.filter((a) => a.kind === kind).length;

  const lines: BreakdownLine[] = [];

  const simplified = count('simplify');
  if (simplified > 0) {
    lines.push({
      label: KIND_META.simplify.label,
      title: KIND_META.simplify.title,
      parts: [{ label: 'rewritten', color: '#7c3aed', n: simplified }],
      total: simplified,
    });
  }

  const validity = tally('validity');
  if (validity.size > 0) {
    lines.push({
      label: KIND_META.validity.label,
      title: KIND_META.validity.title,
      parts: VERDICT_ORDER.flatMap((v) => {
        const n = validity.get(v) ?? 0;
        const meta = VALIDITY_META[v];
        return n > 0 && meta != null
          ? [{ label: meta.label.toLowerCase(), color: meta.color, n }]
          : [];
      }),
      total: count('validity'),
    });
  }

  const addressed = tally('addressed');
  if (addressed.size > 0) {
    lines.push({
      label: KIND_META.addressed.label,
      title: KIND_META.addressed.title,
      parts: ADDRESSED_VERDICTS.flatMap((v) => {
        const n = addressed.get(v) ?? 0;
        const meta = ADDRESSED_VERDICT_META[v];
        return n > 0 ? [{ label: meta.label.toLowerCase(), color: meta.color, n }] : [];
      }),
      total: count('addressed'),
    });
  }

  return lines;
}

const RUN_BUTTON_CLASS =
  'rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:text-violet-200 dark:hover:bg-violet-900/30';
const STOP_BUTTON_CLASS =
  'rounded border border-amber-400 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-300 dark:hover:bg-amber-900/30';

const CHECK_REVIEW_TITLE =
  'One AI pass over this PR’s review threads and comments: rewrite the walls of bot text, ' +
  'sanity-check each point, and judge what has actually been addressed (Pro)';

/**
 * The PR-wide "Check review" bar. Costs are bounded server-side (one combined call per ~6 targets,
 * a resumable 50-target cap, $0 on unchanged content, a per-account in-flight guard and a credit
 * gate); this only has to make the state legible — live progress, what the run produced, and a
 * standing breakdown of every judgement the PR already holds.
 */
export function ReviewCheckBar({
  prId,
  className = '',
}: {
  prId: number;
  className?: string;
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const { data } = usePrAnnotations(prId, enabled);
  const { state, run, stop } = useRunAnnotations(prId);
  if (!enabled) return null;

  const staleCount = data?.staleCount ?? 0;
  const result = state.result;
  const lines = breakdownOf(data?.annotations ?? []);
  const judgements = lines.reduce((n, l) => n + l.total, 0);

  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${className}`}>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-500 dark:text-violet-300">
        <span aria-hidden="true">✨</span> AI
      </span>

      {state.running ? (
        <>
          <span className="tabular-nums text-gray-500">
            Checking review… {state.done}/{state.total}
          </span>
          <button type="button" onClick={stop} className={STOP_BUTTON_CLASS}>
            Stop
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => run('review')}
            title={CHECK_REVIEW_TITLE}
            className={RUN_BUTTON_CLASS}
          >
            ✨ Check review
          </button>
          {staleCount > 0 && (
            <button
              type="button"
              // Refresh only what has actually moved on — the cheap path. `onlyStale` never
              // generates a judgement that didn't exist before.
              onClick={() => run('review', { onlyStale: true })}
              title="Re-run only the checks whose comment or code changed after they were written"
              className={STOP_BUTTON_CLASS}
            >
              Re-check {staleCount} stale
            </button>
          )}
        </>
      )}

      {!state.running && result != null && (
        <span className="text-gray-500">
          {result.generated > 0 ? `${result.generated} checked` : 'nothing to check'}
          {result.cached > 0 && ` · ${result.cached} up to date`}
          {result.failed > 0 && ` · ${result.failed} failed`}
          {result.creditsExhausted && ' · out of credits'}
        </span>
      )}
      {!state.running && state.remaining > 0 && (
        <button
          type="button"
          onClick={() => run('review')}
          title="This run stopped at the per-run cap — run it again to take the next batch"
          className={RUN_BUTTON_CLASS}
        >
          Check the next {state.remaining > 50 ? 50 : state.remaining}
        </button>
      )}
      {state.error != null && (
        <span className="text-amber-600 dark:text-amber-400">{state.error}</span>
      )}

      {lines.length > 0 && (
        // The breakdown the one button replaced three of: what this PR's review actually looks
        // like once checked, per axis. Each judgement's reasoning is inline on its own comment.
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-gray-400" title="Total AI judgements stored for this PR">
            {judgements} judgement{judgements === 1 ? '' : 's'}
          </span>
          {lines.map((l) => (
            <span key={l.label} className="flex flex-wrap items-center gap-1" title={l.title}>
              <span className="text-gray-500 dark:text-gray-400">{l.label}</span>
              {l.parts.map((p) => (
                <span
                  key={p.label}
                  className="rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums"
                  style={{ backgroundColor: `${p.color}1a`, color: p.color }}
                >
                  {p.n} {p.label}
                </span>
              ))}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The same check, spent on ONE anchor — a thread card, or a single PR comment.
 *
 * `target` is the entity the user clicked; the server expands a thread anchor to that thread's own
 * judgements AND its comments' rewrites, so this button produces the same rows the PR-wide run
 * would produce for that thread (see AnnotationRunTarget). Costs one combined call.
 */
export function ReviewCheckButton({
  prId,
  target,
  className = '',
}: {
  prId: number;
  target: AnnotationRunTarget;
  className?: string;
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const { state, run } = useRunAnnotations(prId);
  if (!enabled) return null;

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <button
        type="button"
        onClick={(e) => {
          // Thread-card headers and PR-comment rows are themselves clickable regions.
          e.stopPropagation();
          run('review', { targets: [target] });
        }}
        disabled={state.running}
        className="rounded px-1 py-0.5 text-[10px] font-medium text-violet-600 hover:bg-violet-100 disabled:opacity-50 dark:text-violet-300 dark:hover:bg-violet-900/30"
        title={CHECK_REVIEW_TITLE}
      >
        {state.running ? 'Checking…' : '✨ Check review'}
      </button>
      {/* The server allows one run per account at a time, so a second button pressed mid-run gets
          'Another annotation run is already in progress.' — it MUST be visible, or that click
          looks like it did nothing. */}
      {state.error != null && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">{state.error}</span>
      )}
    </span>
  );
}
