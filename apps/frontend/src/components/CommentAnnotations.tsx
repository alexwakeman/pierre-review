import { useState } from 'react';
import type {
  AnnotationKind,
  AnnotationRunTarget,
  AnnotationTargetKind,
  AddressedVerdict,
  CommentAnnotation,
  ThreadDetail,
  User,
} from '@pierre-review/shared';
import { ADDRESSED_VERDICT_META, userLabel } from '../lib/ui.js';
import { annotationRunMessage } from '../lib/annotationRun.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import {
  annotationKey,
  useAnnotationIndex,
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
// would bill on every open of a bot-flooded PR. The re-check is the SAME per-item "Check review"
// button that produced the row — there is no bulk "re-check the stale ones" control any more,
// because there is no PR-wide sweep to hang it off.
//
// All of this reads ONE per-PR query (useAnnotationIndex) that every call site shares, so the
// number of chips on screen doesn't change the number of requests. A target with no stored
// judgements renders NOTHING and issues NO request of its own — load-bearing, because ThreadCard
// is mounted in eight places (the Threads tab, the feed, search results, the diff view), so an
// unconditional placeholder box was ALSO an unconditional per-thread request storm.

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
      title="This comment (or the code around it) changed after the check ran, so the result may no longer hold. Press “Check review” on this thread or comment again to refresh it."
    >
      may be out of date
    </span>
  );
}

function AnnotationPanel({
  annotation,
  defaultOpen,
  sublabel,
}: {
  annotation: CommentAnnotation;
  defaultOpen: boolean;
  /**
   * Which comment this panel is ABOUT, when the panel is no longer adjacent to it. Required for
   * the per-thread block: a thread's rewrites all sit under the conversation, so without a name
   * ("@coderabbitai's opening comment", "reply 2") the reader cannot pair a rewrite with the wall
   * of text it rewrites — which is the whole point of keeping the original on screen.
   */
  sublabel?: string;
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
        {sublabel != null && (
          <span className="text-[10px] text-violet-500/80 dark:text-violet-400/80">
            {sublabel}
          </span>
        )}
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

// ---- the per-THREAD output block ---------------------------------------------------------------
//
// A thread's three judgements are keyed on THREE DIFFERENT ids — `simplify` on each comment
// ('review_comment', c.id), `validity` on the ROOT comment only, `addressed` on the thread itself
// — so a single <CommentAnnotations> cannot express a thread. Hence this component: ONE
// useAnnotationIndex call (the SAME shared per-PR query every other surface uses, so this adds no
// request) assembling all three into the single block that sits under the conversation.
//
// The order matches the model's own combinedItemBody order (simplify, validity, addressed), so a
// run and its output read the same way round.

/**
 * The whole "Check review" output for ONE thread, as one block.
 *
 * Renders NOTHING when the thread has no stored judgements — no placeholder, no empty bordered
 * box. That is the whole fix: the box this replaces rendered unconditionally whenever the Pro
 * capability was on, and its per-thread query meant a 60-thread PR issued 60 requests to draw 60
 * empty boxes, in the Threads tab AND in every other place ThreadCard is mounted.
 */
export function ThreadCheckOutput({
  thread,
  usersById,
}: {
  thread: ThreadDetail;
  /** Only used to NAME whose comment a rewrite belongs to; absent → a positional label. */
  usersById?: Map<number, User>;
}): JSX.Element | null {
  const enabled = useProCapabilities().prSummary;
  const index = useAnnotationIndex(thread.prId, enabled);
  if (!enabled || index == null) return null;

  const root = thread.comments[0];

  // simplify: one per comment that actually got a rewrite (the root + any reply the server judged
  // long enough). Showing only the root would hide rows the user just paid for.
  const rewrites = thread.comments.flatMap((c, i) => {
    const a = index.get(annotationKey('simplify', 'review_comment', c.id));
    if (a == null) return [];
    // Only NAME the author when we actually resolved one \u2014 `userLabel`'s "user 123" / "unknown"
    // fallbacks read as noise in a sublabel, and the position alone already pairs the panel with
    // its comment.
    const user = c.authorId != null ? usersById?.get(c.authorId) : undefined;
    const where = i === 0 ? 'opening comment' : `reply ${i}`;
    const sublabel = user != null ? `${userLabel(user, c.authorId)}\u2019s ${where}` : where;
    return [{ annotation: a, sublabel }];
  });

  const validity =
    root != null ? index.get(annotationKey('validity', 'review_comment', root.id)) ?? null : null;
  const addressed = index.get(annotationKey('addressed', 'thread', thread.id)) ?? null;

  if (rewrites.length === 0 && validity == null && addressed == null) return null;

  return (
    <>
      {rewrites.map((r) => (
        <AnnotationPanel
          key={`simplify:${r.annotation.targetId}`}
          annotation={r.annotation}
          sublabel={r.sublabel}
          defaultOpen
        />
      ))}
      {validity != null && <AnnotationPanel annotation={validity} defaultOpen />}
      {/* The two-section "**Addressed:** / **Still open:**" summary — the thing you actually need
          before resolving the thread, and the reason it is inline rather than in a chip tooltip. */}
      {addressed != null && <AnnotationPanel annotation={addressed} defaultOpen />}
    </>
  );
}

// ---- "Check review" (the ONE run surface) ----------------------------------------------------
//
// There used to be three buttons ("Simplify all" / "Check validity" / "Check addressed"), then one
// PR-WIDE bar above the tab content plus a per-item twin. The bar is GONE: a whole-PR sweep on a
// bot-flooded PR is many billed calls and tens of seconds, and the answer a reader wants is almost
// always about the one thread they are looking at. What remains is the per-item button below —
// one anchor, one combined call, all three judgements.

const CHECK_REVIEW_TITLE =
  'One AI pass over this thread or comment: rewrite the wall of bot text, sanity-check the point, ' +
  'and judge what has actually been addressed (Pro)';

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

  // A non-2xx (the 429 gate) wins over the outcome of a previous run; otherwise report what the
  // run actually did — including the outcomes the 200 body only implies (see annotationRunMessage).
  const outcome = state.error ?? annotationRunMessage(state.result);

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
      {/* `disabled` only covers THIS button — every thread card and PR comment has its own hook,
          and the server allows one run per ACCOUNT at a time. So a second button pressed mid-run
          gets the route's 429 message ('Another check is already running…'), and it MUST be
          visible, or that click looks like it did nothing.

          The SAME argument applies to a 200 that produced nothing: no AI credential on the
          server and exhausted AI credits both answer 200 with an all-zero result, so without
          `annotationRunMessage` the button flips back to its idle label and the click looks
          like it did nothing. Those two used to be surfaced by the (now deleted) SSE error
          events and the sweep bar's out-of-credits suffix. */}
      {outcome != null && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">{outcome}</span>
      )}
    </span>
  );
}
