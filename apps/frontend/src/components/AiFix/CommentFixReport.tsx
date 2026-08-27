import { useState, useSyncExternalStore } from 'react';
import type {
  AiFix,
  AiFixCommentDisposition,
  AiFixCommentKind,
  AiFixCommentTarget,
  AiFixCommentVerdict,
  PrDetail,
} from '@pierre-review/shared';
import {
  ADDRESSED_VERDICT_META,
  CONFIDENCE_META,
  DERIVED_STATE_META,
  safeExternalUrl,
} from '../../lib/ui.js';
import { useCreatePrComment, useReplyToThread } from '../../hooks/usePrWrites.js';
import { errText } from '../CiAnalysisCard.js';
import { CheckIcon, ExternalLinkIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { MentionTextarea } from '../MentionTextarea.js';

// The per-comment report for a `seed: 'comments'` fix run: what the agent did about each
// comment the user dragged into the basket, whether it thought the comment was RIGHT, and —
// where it disagrees — an argued rebuttal the user can send as a reply with one click.
//
// ⚠ EVERY FIELD HERE IS MODEL OUTPUT that the server parsed out of a tool call, and this app
// has NO React error boundary (docs/PRO-PLUGIN-AND-ACTIVITY.md) — a render-time throw blanks
// the whole SPA, not this panel. So nothing below indexes a record without a fallback, iterates
// a value without an Array.isArray, or renders a string without checking it is a non-empty one,
// even where the wire type says it cannot be missing.

// ---- disposition vocabulary ----

// Disagreement is PURPLE (#8957e5 — the hue EVENT_META.pr_merged and the ML `security` category
// already carry), deliberately NOT red: the agent arguing back is a legitimate outcome of the
// run, not an error, and red would read as "the fix failed".
const DISAGREE_COLOR = '#8957e5';

interface DispositionMeta {
  // Tag on the card ("Disagrees").
  chip: string;
  // Part of the roll-up SENTENCE ("2 pushed back"), which is why it is a separate string:
  // a tag and a counted phrase don't share wording.
  phrase: string;
  // Only where the plural phrase misreads at one ("1 needs a human").
  phraseOne?: string;
  color: string;
  title: string;
}

// Colours come from the app's existing state hues rather than a new palette, so a verdict chip
// tints like every other state pill: fixed → the "addressed" green, partially fixed → the
// "likely" blue, already addressed → the neutral slate, needs-a-human → the "replied" amber
// (attention wanted). No red anywhere — see DISAGREE_COLOR.
const DISPOSITION_META: Record<AiFixCommentDisposition, DispositionMeta> = {
  fixed: {
    chip: 'Fixed',
    phrase: 'fixed',
    color: ADDRESSED_VERDICT_META.addressed.color,
    title: 'The agent changed the code in response to this comment.',
  },
  partially_fixed: {
    chip: 'Partially fixed',
    phrase: 'partially fixed',
    color: ADDRESSED_VERDICT_META.likely.color,
    title: 'The agent addressed part of what this comment asked for.',
  },
  already_addressed: {
    chip: 'Already addressed',
    phrase: 'already addressed',
    color: CONFIDENCE_META.low.color,
    title: 'The code already satisfied this comment — nothing to change.',
  },
  invalid: {
    chip: 'Disagrees',
    phrase: 'pushed back',
    color: DISAGREE_COLOR,
    title:
      'The agent judged this comment wrong and left the code alone. A disagreement, not a failure — read its argument below.',
  },
  out_of_scope: {
    chip: 'Out of scope',
    phrase: 'out of scope',
    color: DISAGREE_COLOR,
    title:
      'The agent judged this outside the scope of the PR, whether or not the comment itself is right.',
  },
  needs_human: {
    chip: 'Needs a human',
    phrase: 'need a human',
    phraseOne: 'needs a human',
    color: DERIVED_STATE_META.replied_unresolved.color,
    title: 'The agent could not decide, or could not change this safely on its own.',
  },
};

// Roll-up order. Explicit rather than Object.keys, so the sentence's order is a decision and
// not an artefact of the record literal.
const DISPOSITION_ORDER: AiFixCommentDisposition[] = [
  'fixed',
  'partially_fixed',
  'already_addressed',
  'invalid',
  'out_of_scope',
  'needs_human',
];

// Fallback for a disposition string outside the union — possible because the value originates
// in a model's tool call. Neutral on purpose: an unrecognised verdict is not a failure claim.
const UNKNOWN_DISPOSITION: DispositionMeta = {
  chip: 'Reported',
  phrase: 'reported',
  color: CONFIDENCE_META.none.color,
  title: 'The agent reported an outcome this build does not recognise.',
};

function metaFor(disposition: AiFixCommentDisposition): DispositionMeta {
  return DISPOSITION_META[disposition] ?? UNKNOWN_DISPOSITION;
}

const KIND_LABEL: Record<AiFixCommentKind, string> = {
  review_comment: 'Inline comment',
  pr_comment: 'PR-level comment',
  review: 'Review body',
};

// ---- pure helpers (exported for test/aiFixCommentVerdicts.test.ts) ----

export interface CommentVerdictSummary {
  // Verdicts the agent reported, matched or not.
  total: number;
  counts: Record<AiFixCommentDisposition, number>;
  // Verdicts carrying a rebuttal the user could send.
  pushbacks: number;
  // Verdicts citing a ref that was not in the seed set.
  unmatched: number;
  // Seeded comments the agent never mentioned. Counted from the run's stored targets, so it
  // stays honest about what the run was GIVEN versus what it answered for.
  unreported: number;
}

function emptyCounts(): Record<AiFixCommentDisposition, number> {
  return {
    fixed: 0,
    partially_fixed: 0,
    already_addressed: 0,
    invalid: 0,
    out_of_scope: 0,
    needs_human: 0,
  };
}

/**
 * Fold the run's verdicts into the numbers the roll-up line reads from.
 *
 * A disposition outside the union is deliberately counted in NOTHING but `total`: the roll-up
 * lists only non-zero known groups, so an unrecognised value shows up as the gap between
 * `total` and the sum of the groups rather than as a corrupted (NaN) count.
 */
export function summariseCommentVerdicts(
  verdicts: AiFixCommentVerdict[],
  targets: AiFixCommentTarget[] | null,
): CommentVerdictSummary {
  const counts = emptyCounts();
  let pushbacks = 0;
  let unmatched = 0;
  const cited = new Set<string>();
  for (const v of verdicts) {
    if (v.verdict in counts) counts[v.verdict] += 1;
    if (typeof v.pushback === 'string' && v.pushback.trim() !== '') pushbacks += 1;
    if (v.target == null) unmatched += 1;
    // ⚠ KEY ON THE TARGET, NOT `v.ref`. `v.ref` is the AGENT's spelling, stored verbatim — the
    // server matches it to a target through a normaliser precisely because a model writes "c3",
    // " C3 " and "C3." for the same comment. Keying this set on the raw string made the
    // "not reported on" line fire for comments that WERE reported on, and (since every genuinely
    // unreported target gets a synthesized verdict carrying the canonical ref) that was the ONLY
    // way it could ever fire. A test with exactly-matching refs cannot catch it.
    cited.add(v.target?.ref ?? v.ref);
  }
  const seeded = Array.isArray(targets) ? targets : [];
  return {
    total: verdicts.length,
    counts,
    pushbacks,
    unmatched,
    unreported: seeded.filter((t) => !cited.has(t.ref)).length,
  };
}

/**
 * The one-line roll-up: "7 comments: 4 fixed · 1 pushed back · 2 needs a human".
 *
 * Zero groups are omitted (a list of six mostly-zero counts is noise). `unmatched` and
 * `unreported` are NOT groups here — they aren't peers of a disposition and folding them into
 * the same "·" list would read as double counting against the head. They get their own line.
 */
export function commentVerdictRollup(summary: CommentVerdictSummary): string {
  const head = `${summary.total} comment${summary.total === 1 ? '' : 's'}`;
  const parts: string[] = [];
  for (const d of DISPOSITION_ORDER) {
    const n = summary.counts[d];
    if (n === 0) continue;
    const meta = metaFor(d);
    parts.push(`${n} ${n === 1 ? (meta.phraseOne ?? meta.phrase) : meta.phrase}`);
  }
  return parts.length === 0 ? head : `${head}: ${parts.join(' · ')}`;
}

export type PushbackReplyTarget =
  | { kind: 'thread'; threadId: number }
  | { kind: 'pr_comment' };

/**
 * Where a pushback reply would POST. Null means "nowhere" — the card must then offer no reply
 * action at all, which is the case for a verdict whose ref matched no seeded comment.
 *
 * A thread is the precise address and always wins. Everything else falls back to a flat
 * PR-level comment: a top-level comment and a review body have no reply address of their own
 * on GitHub, and a review comment whose thread we never synced has lost its. The fallback is
 * disclosed in the composer — the ClaudeReviewTab precedent for "this posts somewhere other
 * than inline".
 */
export function pushbackReplyTarget(
  target: AiFixCommentTarget | null,
): PushbackReplyTarget | null {
  if (target == null) return null;
  if (typeof target.threadId === 'number') {
    return { kind: 'thread', threadId: target.threadId };
  }
  return { kind: 'pr_comment' };
}

/**
 * The editable prefill for a pushback reply: the agent's rebuttal, verbatim.
 *
 * A PR-level reply additionally @mentions the comment's author, because a flat issue comment
 * has no threading to carry the addressee (the same reasoning as `buildQuotedReply`). The
 * mention is visible in the composer and the user is the one who presses Send, so mentioning
 * a BOT — which some vendors treat as a command — stays a deliberate, editable choice.
 */
export function prefillPushbackReply(
  target: AiFixCommentTarget | null,
  pushback: string | null,
): string {
  const body = (pushback ?? '').trim();
  const to = pushbackReplyTarget(target);
  if (to == null || to.kind === 'thread') return body;
  const login = target?.authorLogin;
  return login ? `@${login} ${body}` : body;
}

/** Where the comment sits: `path:line` when it has a file anchor, else what kind it is. */
export function commentAnchorLabel(target: AiFixCommentTarget): string {
  if (typeof target.path === 'string' && target.path !== '') {
    return typeof target.line === 'number' ? `${target.path}:${target.line}` : target.path;
  }
  return KIND_LABEL[target.kind] ?? 'Comment';
}

// ---- one send per pushback, across mounts ----

// AiFixTab is React.lazy'd inside PrDetail, which mounts ONE tab body at a time — so switching
// tab mid-request UNMOUNTS this card while the POST completes, and React Query then skips the
// per-call onSuccess. A fresh mount that read only its own `isPending` would show an armed Send
// for a reply GitHub already has: the same double-post class the paid CI analysis hit, whose fix
// was a shared mutation key. The write hooks in usePrWrites declare no `mutationKey` to read
// with `useIsMutating`, so the claim lives here instead, keyed `${fixId}|${ref}`:
//   click   → CLAIMED (before the request resolves — this is the guard)
//   success → SENT (the action is replaced by a sent state, never re-offered)
//   failure → released, so a genuine error can still be retried
// Session-scoped on purpose: a reload forgets it, and by then the reply is in the thread itself.
// Two verdicts sharing one ref both read as sent — malformed input, resolved in the safe
// direction (never a second post).
const CLAIMED = new Set<string>();
const SENT = new Set<string>();
const LISTENERS = new Set<() => void>();

function subscribeReplyState(onChange: () => void): () => void {
  LISTENERS.add(onChange);
  return () => {
    LISTENERS.delete(onChange);
  };
}

function notifyReplyState(): void {
  for (const l of LISTENERS) l();
}

type ReplyState = 'idle' | 'sending' | 'sent';

function useReplyState(key: string): ReplyState {
  // Returns a primitive, so a fresh getSnapshot closure per render is fine.
  return useSyncExternalStore(subscribeReplyState, () =>
    SENT.has(key) ? 'sent' : CLAIMED.has(key) ? 'sending' : 'idle',
  );
}

// ---- the report ----

/**
 * The per-comment report, or null when there is nothing to report.
 *
 * NO HOOKS IN THIS COMPONENT, deliberately: `seed` and `commentVerdicts` are both fields of the
 * fix ROW, so a re-run replacing it flips the early returns between renders of the same
 * instance — a hook above them (a useMemo over the fold, say) would change the hook count
 * mid-life and throw. The fold is over at most AI_FIX_MAX_COMMENT_TARGETS items, which is cheap
 * enough that memoising it buys nothing.
 *
 * Rendering nothing here is load-bearing, not an optimisation: a per-target panel that draws
 * itself unconditionally is what made 60 threads issue 60 requests to paint 60 empty boxes
 * (docs/FRONTEND.md). This component issues no request at all — everything it shows was stored
 * on the run.
 */
export function CommentFixReport({
  pr,
  fix,
}: {
  pr: PrDetail;
  fix: AiFix;
}): JSX.Element | null {
  if (fix.seed !== 'comments') return null;
  const verdicts = Array.isArray(fix.commentVerdicts) ? fix.commentVerdicts : [];
  if (verdicts.length === 0) return null;

  const summary = summariseCommentVerdicts(
    verdicts,
    Array.isArray(fix.commentTargets) ? fix.commentTargets : null,
  );

  return (
    <div className="mt-3 rounded border border-gray-200 p-2 dark:border-gray-800">
      <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">
        Per-comment report
      </div>
      <div className="mt-0.5 text-[11px] text-gray-500">
        {commentVerdictRollup(summary)}
      </div>
      {summary.unmatched > 0 && (
        <div className="mt-0.5 text-[11px] text-gray-400">
          {summary.unmatched === 1
            ? '1 verdict cites a reference that was not in the selection.'
            : `${summary.unmatched} verdicts cite references that were not in the selection.`}
        </div>
      )}
      {summary.unreported > 0 && (
        <div className="mt-0.5 text-[11px] text-gray-400">
          {summary.unreported === 1
            ? '1 selected comment was not reported on.'
            : `${summary.unreported} selected comments were not reported on.`}
        </div>
      )}
      {/* The run's own order — never re-sorted by verdict, so the report reads in the order the
          prompt listed the comments and a re-read finds each card where it was. */}
      <ul className="mt-2 space-y-1.5">
        {verdicts.map((v, i) => (
          <VerdictCard
            key={`${v.ref}|${i}`}
            prId={pr.id}
            fixId={fix.id}
            verdict={v}
          />
        ))}
      </ul>
    </div>
  );
}

function Chip({
  color,
  title,
  children,
}: {
  color: string;
  title: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <span
      className="mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ backgroundColor: `${color}22`, color }}
      title={title}
    >
      {children}
    </span>
  );
}

function VerdictCard({
  prId,
  fixId,
  verdict,
}: {
  prId: number;
  fixId: number;
  verdict: AiFixCommentVerdict;
}): JSX.Element {
  const meta = metaFor(verdict.verdict);
  const target = verdict.target ?? null;
  const reasoning = typeof verdict.reasoning === 'string' ? verdict.reasoning.trim() : '';
  const learning = typeof verdict.learning === 'string' ? verdict.learning.trim() : '';
  const pushback = typeof verdict.pushback === 'string' ? verdict.pushback.trim() : '';
  const files = Array.isArray(verdict.filesTouched) ? verdict.filesTouched : [];

  // A ref the agent invented (or one whose comment the run never carried) is information about
  // the RUN, not about a comment: no anchor, no excerpt and — above all — no reply action,
  // since there is nothing to reply to.
  if (target == null) {
    return (
      <li className="rounded border border-dashed border-gray-200 px-3 py-2 opacity-70 dark:border-gray-800">
        <div className="flex items-start gap-2">
          <Chip color={meta.color} title={meta.title}>
            {meta.chip}
          </Chip>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] text-gray-500">
              <span className="font-mono text-gray-400">{verdict.ref}</span> — reported
              against an unknown reference; no matching comment in the selection.
            </div>
            {reasoning !== '' && (
              <div className="mt-1 text-xs text-gray-500">
                <Markdown>{reasoning}</Markdown>
              </div>
            )}
          </div>
        </div>
      </li>
    );
  }

  const url = safeExternalUrl(target.url);
  const excerpt = typeof target.excerpt === 'string' ? target.excerpt.trim() : '';

  return (
    <li className="rounded border border-gray-100 px-3 py-2 dark:border-gray-800">
      <div className="flex items-start gap-2">
        <Chip color={meta.color} title={meta.title}>
          {meta.chip}
        </Chip>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="font-mono text-gray-400">{verdict.ref}</span>
            <span className="text-gray-600 dark:text-gray-300">
              {target.authorLogin ? `@${target.authorLogin}` : 'unknown author'}
            </span>
            {/* The stored flag, never re-derived from the login: bot-ness is not on the wire
                for a comment author, which is exactly why the server stamps it onto the
                target. */}
            {target.isBot && (
              <span className="rounded bg-gray-500/10 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                bot
              </span>
            )}
            <span className="truncate font-mono text-gray-500" title={commentAnchorLabel(target)}>
              {commentAnchorLabel(target)}
            </span>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center text-blue-600 hover:underline dark:text-blue-400"
                title="Open this comment on GitHub"
              >
                <ExternalLinkIcon size={11} />
              </a>
            )}
            {/* Separate from the disposition ON PURPOSE: a valid comment can still be out of
                scope, and an invalid one can still have been fixed defensively. Collapsing the
                two would misreport the run.

                ⚠ THREE states, not two. `null` = NOT ASSESSED (the row was synthesized for a
                comment the agent never reported on, or one that never fit the prompt). Rendering
                that as "not valid" published a verdict on a reviewer's comment that nobody had
                reached — right above prose saying nothing is known about it. */}
            <span
              className="rounded bg-gray-500/10 px-1 py-0.5 text-[10px] text-gray-500"
              title={
                verdict.valid == null
                  ? 'Nobody assessed this comment on this run — this is not a judgement about it.'
                  : 'Whether the agent judged the comment itself technically correct — independent of what it did about it.'
              }
            >
              {verdict.valid == null
                ? 'comment: not assessed'
                : verdict.valid
                  ? 'comment: valid'
                  : 'comment: not valid'}
            </span>
          </div>

          {excerpt !== '' && (
            <div className="mt-1 border-l-2 border-gray-200 pl-2 text-[11px] text-gray-500 dark:border-gray-700">
              <span className="whitespace-pre-wrap">{excerpt}</span>
            </div>
          )}

          {reasoning !== '' && (
            <div className="mt-1 text-xs text-gray-700 dark:text-gray-200">
              <Markdown>{reasoning}</Markdown>
            </div>
          )}

          {files.length > 0 && (
            <div
              className="mt-1 text-[11px] text-gray-400"
              title="The agent's own account of what it edited for this comment. The diff above is the authoritative changeset."
            >
              <span className="uppercase tracking-wide">Agent says it edited</span>{' '}
              <span className="font-mono text-gray-500">{files.join(', ')}</span>
            </div>
          )}

          {learning !== '' && (
            <div className="mt-1.5 rounded bg-gray-50 px-2 py-1 dark:bg-gray-900">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Learning
              </div>
              <div className="text-xs text-gray-600 dark:text-gray-300">
                <Markdown>{learning}</Markdown>
              </div>
            </div>
          )}

          {pushback !== '' && (
            <div
              className="mt-1.5 border-l-2 pl-2"
              style={{ borderColor: DISAGREE_COLOR }}
            >
              <div
                className="text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: DISAGREE_COLOR }}
              >
                Pushback
              </div>
              <div className="text-xs text-gray-700 dark:text-gray-200">
                <Markdown>{pushback}</Markdown>
              </div>
              <PushbackReply
                prId={prId}
                fixId={fixId}
                ref_={verdict.ref}
                target={target}
                pushback={pushback}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

// The one-click reply. Nothing posts without an explicit Send click, one post per click, and the
// action is gone once a post has landed (see the CLAIMED/SENT note above).
function PushbackReply({
  prId,
  fixId,
  ref_,
  target,
  pushback,
}: {
  prId: number;
  fixId: number;
  // `ref` is reserved on a component's props, so the seed label rides in as ref_.
  ref_: string;
  target: AiFixCommentTarget;
  pushback: string;
}): JSX.Element | null {
  const key = `${fixId}|${ref_}`;
  const state = useReplyState(key);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(() => prefillPushbackReply(target, pushback));
  const [error, setError] = useState<string | null>(null);
  const reply = useReplyToThread();
  const prComment = useCreatePrComment(prId);

  const to = pushbackReplyTarget(target);
  if (to == null) return null;

  if (state === 'sent') {
    return (
      <div className="mt-1 text-[11px] text-green-600 dark:text-green-400">
        Reply posted{to.kind === 'thread' ? ' in the thread' : ' as a PR comment'}{' '}
        <CheckIcon size={11} className="inline-block align-[-0.1em]" />
      </div>
    );
  }

  const sending = state === 'sending';

  const send = (): void => {
    const trimmed = body.trim();
    if (trimmed === '' || sending) return;
    setError(null);
    // Claim BEFORE the request resolves — the whole point is that a second Send cannot be
    // armed, from this mount or a later one, while the first is in flight.
    CLAIMED.add(key);
    notifyReplyState();
    const posted =
      to.kind === 'thread'
        ? reply.mutateAsync({ prId, threadId: to.threadId, body: trimmed })
        : prComment.mutateAsync(trimmed);
    // Settled on the PROMISE, not in a mutate() callback: those are skipped when the component
    // unmounts mid-request, which is precisely the case this guard exists for. The rejection is
    // handled here, so mutateAsync can never surface as an unhandled rejection.
    void posted.then(
      () => {
        SENT.add(key);
        CLAIMED.delete(key);
        notifyReplyState();
      },
      (err: unknown) => {
        CLAIMED.delete(key);
        notifyReplyState();
        setError(errText(err));
      },
    );
  };

  if (!open) {
    return (
      <div className="mt-1">
        <button
          type="button"
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
          onClick={() => setOpen(true)}
          disabled={sending}
        >
          {sending ? 'Sending…' : 'Reply on GitHub'}
        </button>
        {error != null && (
          <span className="ml-2 text-[11px] text-red-500">{error}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 space-y-1">
      <MentionTextarea
        prId={prId}
        value={body}
        onChange={setBody}
        rows={4}
        ariaLabel="Reply with this pushback"
        disabled={sending}
        className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-gray-900"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
          onClick={send}
          disabled={sending || body.trim() === ''}
        >
          {sending ? 'Sending…' : 'Send reply'}
        </button>
        <button
          type="button"
          className="whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-[11px] hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
          onClick={() => {
            setError(null);
            setOpen(false);
          }}
          disabled={sending}
        >
          Cancel
        </button>
        <span className="text-[11px] text-gray-400">
          {to.kind === 'thread'
            ? "Posts as a reply in this comment's thread."
            : target.kind === 'review_comment'
              ? "This comment's thread isn't available here — posts as a PR-level comment."
              : 'Posts as a PR-level comment.'}
        </span>
      </div>
      {error != null && <div className="text-[11px] text-red-500">{error}</div>}
    </div>
  );
}
