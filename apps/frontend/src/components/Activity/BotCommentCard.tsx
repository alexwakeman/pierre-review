import { Fragment, memo, useEffect, useRef, useState } from 'react';
import type {
  AutomatedReviewerKind,
  BotFlaggingCluster,
  BotFlaggingClusterMember,
  BotFlaggingComment,
  MlLabel,
  MlLabelTargetKind,
  MlSeverity,
  User,
} from '@pierre-review/shared';
import { disagreeDirection } from '../../lib/severityAgreement.js';
import type { StateMeta } from '../../lib/ui.js';
import {
  CONFIDENCE_META,
  dateTime,
  DERIVED_STATE_META,
  ML_SEVERITY_META,
  relativeTime,
  safeExternalUrl,
} from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { ArrowIcon, BotIcon, ExternalLinkIcon } from '../Icons.js';
import { Markdown } from '../Markdown.js';
import { MlSeverityBadge } from '../MlSeverityBadge.js';

// The two row types of the "what the bots are flagging" drill-down: one bot comment, and one
// same-line cluster (several bots on the same few lines of one file).
//
// ⚠ THESE CARDS ISSUE NO QUERIES. NOT ONE. Everything they render — the ML label, the author's
// label and vendor kind, the thread's derived state, the PR's repo/number/title/url — arrives
// INLINE on the row, in the single request that fetched the page. A page of 20 cards is one
// request, total.
//
// That is not a performance preference, it is a regression this codebase has already paid for:
// `ThreadAssessment` used to render its bordered panel unconditionally behind a hook keyed PER
// THREAD at ~5 DB queries a call, so a 60-thread PR fired 60 requests to draw 60 empty boxes.
// The specific temptations here, all of which look natural and are all wrong:
//   • `useMlLabelIndex(prId)` — keyed PER PR, and this list deliberately spans many PRs, so it
//     could not serve this surface even if the per-row cost were acceptable. `mlLabel` ships on
//     the row instead.
//   • `useThread` / `InlineThread` / `ThreadCard` — a conversation per card, N requests.
//   • `useAnnotationIndex` / `CommentAnnotations` / `ReactionBar` — per-target fetches, and the
//     drill-down is a read-only survey, not a place to act on one comment. "Open thread" hands
//     the reader to the PR tab, which already owns all of that.
//   • `useBotColors()` — one query, but it belongs to the SCREEN, not to a row: the parent calls
//     it once and passes the resolver down (`botColor`).
// If a card ever needs something it does not have, the fix is a field on the wire row, never a
// hook in this file.
//
// Both cards are `memo`'d with an explicit comparator (the `FeedRow` precedent at the end of
// FeedView.tsx) because their bodies are full markdown + syntax highlighting: a scroll-driven or
// filter-driven parent re-render must not re-parse every visible body.

/** The per-bot colour resolver for the ACTIVE WORKSPACE — `useBotColors(workspaceId)`'s return
 *  value, called ONCE by the screen and threaded down, so a bot is the same colour here as on the
 *  Bots rail and in the feed. Same shape as FeedView's and DetectedReviewersTable's local copies. */
export type BotColorFn = (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;

/**
 * The minimum a caller needs to open a PR tab from either card. Deliberately structural rather
 * than `BotFlaggingComment`: the cluster header opens the SAME PR from cluster-level fields (a
 * cluster's PR metadata is on the cluster, not on any one member's comment), and both shapes
 * satisfy this, so the screen wires up ONE handler instead of two that could drift.
 */
export interface BotFlaggedPrRef {
  prId: number;
  prNumber: number;
  prTitle: string;
  prAuthorId: number | null;
  repoId: number;
  repoFullName: string;
}

/**
 * The list key for a comment row. ⚠ `targetId` lives in THREE id spaces (`review_comments`,
 * `pr_comments`, `reviews`) — the same discriminator `ml_comment_labels` keys on — so a bare
 * `targetId` collides across kinds and React silently reuses one row's DOM (and its expanded
 * body) for another's. Exported so the list and the cards cannot spell it differently.
 */
export function flaggedCommentKey(c: BotFlaggingComment): string {
  return `${c.targetKind}:${c.targetId}`;
}

// Copied from BotPrsDetail's Comments view so the two bot-comment lists name the same three
// things the same way.
const TARGET_KIND_LABEL: Record<MlLabelTargetKind, string> = {
  review_comment: 'inline comment',
  pr_comment: 'PR comment',
  review: 'review summary',
};

// Collapsed body height. Deliberately taller than the feed's 160 (FeedView.tsx): the feed is a
// stream you skim, this list is a survey you read — and the `summaries` selector lists vendor
// walkthroughs, which are the longest bodies in the corpus.
const BODY_COLLAPSED_MAX = 220;

/**
 * A comment body, clamped with a "Show more" toggle once it actually overflows.
 *
 * The ResizeObserver watches the UNCLAMPED inner content, copied from the feed's row for the same
 * reason it exists there: bot bodies are full of images and rendered tables that contribute 0
 * height at first paint, so a one-shot measurement decides "no toggle needed" and then the clamp
 * silently truncates. `expanded` is LOCAL here (the feed lifts it to its parent) — `memo` does not
 * block a component's own state updates, and nothing outside this card needs to know.
 */
function CardBody({ body }: { body: string }): JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = (): void => {
      if (expanded) return; // expanded shows everything — nothing to clamp or measure
      setOverflows(outer.scrollHeight > outer.clientHeight + 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [body, expanded]);

  return (
    <div className="mt-1.5 rounded bg-gray-50 px-2 py-1.5 text-sm dark:bg-gray-900/50">
      <div
        ref={outerRef}
        className={expanded ? '' : 'overflow-hidden'}
        style={expanded ? undefined : { maxHeight: BODY_COLLAPSED_MAX }}
      >
        <div ref={innerRef}>
          <Markdown>{body}</Markdown>
        </div>
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

/**
 * What the BOT claimed about its own comment, next to what our model rated it — the one thing
 * this screen exists to show, said per row.
 *
 * It carries only what `MlSeverityBadge` does not. That badge already prints "bot said <X>" when
 * the two contradict, and stays silent otherwise — correct everywhere else, but on a screen whose
 * facets are `agree` / `overCall` / `underCall` / `undeclared`, silence would leave three of the
 * four states looking identical. So: the DIRECTION word on a contradiction, and an explicit (muted)
 * marker for the other two.
 *
 * ⚠ Direction is the two SEVERITY ORDINALS and nothing else (`disagreeDirection`) — never
 * `severityProb`, never `vendorSeverityConfidence`. And this is a display of two claims, never a
 * reconciliation: our severity is the more accurate rater (0.700 exact on the adjudicated gold-300
 * against the vendor badge's 0.474), so nothing here invites the reader to resolve the
 * disagreement, and nothing anywhere derives our label from theirs.
 */
function VendorClaim({ label }: { label: MlLabel }): JSX.Element {
  const vendor = label.vendorSeverity;
  const ours = ML_SEVERITY_META[label.severity];

  if (vendor == null) {
    return (
      <span
        className="text-[10px] text-gray-400 dark:text-gray-500"
        title="This bot posted no severity badge of its own, so there is nothing here to agree or disagree with — the matrix's 'none' column. Silence is not agreement, which is why the two are counted apart."
      >
        bot declared nothing
      </span>
    );
  }

  const vendorMeta = ML_SEVERITY_META[vendor];
  const dir = disagreeDirection(label);

  if (dir == null) {
    return (
      <span
        className="text-[10px] text-gray-400 dark:text-gray-500"
        title={`The bot badged this ${vendorMeta.label} itself — the matrix's diagonal. Said out loud here because on this screen agreement is a finding of its own; on an ordinary comment the badge stays quiet about it.`}
      >
        bot agreed
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-0.5 text-[10px] font-medium"
      style={{ color: vendorMeta.color }}
      title={`The bot badged this ${vendorMeta.label}; our model rated it ${ours.label}. The direction is the two severity ordinals — not anyone's confidence. Ours is the more accurate rating (70% agreement with human adjudication against the bot's 47%), so this is a disagreement to look at, not one to resolve.`}
    >
      <ArrowIcon dir={dir === 'over' ? 'up' : 'down'} size={10} />
      {dir === 'over' ? 'bot called it worse' : 'bot called it milder'}
    </span>
  );
}

/** Derived-state / confidence chip chrome — the same tinted-at-10%-opacity form used wherever a
 *  `StateMeta` is shown as a pill (DERIVED_STATE_META, CONFIDENCE_META, ML_SEVERITY_META). */
function MetaChip({ meta, prefix }: { meta: StateMeta; prefix?: string }): JSX.Element {
  return (
    <span
      className="shrink-0 rounded px-1 py-px text-[10px] font-medium"
      style={{ color: meta.color, background: `${meta.color}1a` }}
      title={meta.description}
    >
      {prefix}
      {meta.label}
    </span>
  );
}

interface BotCommentCardProps {
  c: BotFlaggingComment;
  /** From the ONE shared `useUsers()` the screen already holds — for the author's avatar. */
  usersById: Map<number, User>;
  botColor: BotColorFn;
  onOpenPr: (ref: BotFlaggedPrRef) => void;
  onOpenThread: (ref: BotFlaggedPrRef, threadId: number) => void;
  /**
   * Set ONLY when this card is one bot's contribution to a same-line cluster. It carries the three
   * facts a member row has and a standalone row does not — how many threads this bot left in the
   * cluster (the ×N pill), the deterministic addressed-confidence, and the fact that the CLUSTER
   * owns the PR/file header, so repeating it on every member would be noise.
   */
  member?: BotFlaggingClusterMember;
}

function BotCommentCardImpl({
  c,
  usersById,
  botColor,
  onOpenPr,
  onOpenThread,
  member,
}: BotCommentCardProps): JSX.Element {
  const user = usersById.get(c.authorUserId);
  // The author's label and vendor kind are RESOLVED SERVER-SIDE on the row (the reviewerLabel
  // precedence: workspace custom label → vendor pretty name → display name/login), so this card
  // never classifies a bot by login the way PrDetail still does.
  const color = botColor({ login: c.authorLogin, kind: c.authorKind });
  // Inside a cluster the MEMBER's state is the authoritative one: it is non-nullable on the wire
  // and it is the state the cluster itself was assembled from, so the two can never disagree on
  // screen. Standalone rows fall back to the comment's own thread join, which is null for PR
  // comments and review bodies (no thread at all).
  const state = member
    ? DERIVED_STATE_META[member.derivedState]
    : c.derivedState
      ? DERIVED_STATE_META[c.derivedState]
      : null;
  const threadCount = member?.threadIds.length ?? 0;
  // 'none' is "no addressed signal" — a chip saying so on every untouched thread is noise.
  const confidence =
    member && member.addressedConfidence !== 'none'
      ? CONFIDENCE_META[member.addressedConfidence]
      : null;
  // A member's own thread id survives even when its opening comment could not be hydrated.
  const threadId = c.threadId ?? member?.threadId ?? null;
  // Data-derived href — React renders `javascript:` URLs, so every one of these goes through
  // safeExternalUrl (undefined ⇒ the link simply isn't rendered).
  const prHref = safeExternalUrl(c.prUrl);
  const showPrRef = member == null;
  const hasContextRow = showPrRef || c.line != null || state != null || confidence != null;

  return (
    <article className="rounded-md border border-gray-200 bg-white p-2.5 text-sm dark:border-gray-800 dark:bg-gray-950">
      {/* header: who said it, in what kind of comment, and when */}
      <div className="flex flex-wrap items-center gap-2">
        <Avatar user={user} size={18} />
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ color, background: `${color}1a` }}
          title={`${c.authorLabel} — an automated reviewer Limn triages`}
        >
          <BotIcon size={10} />
          {c.authorLabel}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-gray-400">
          {TARGET_KIND_LABEL[c.targetKind]}
        </span>
        {threadCount > 1 && (
          <span
            className="shrink-0 rounded bg-gray-100 px-1 py-px text-[10px] font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400"
            title={`This bot left ${threadCount} separate threads in the same line area — collapsed to one row here, exactly as the overlap count treats them.`}
          >
            ×{threadCount}
          </span>
        )}
        <span
          className="ml-auto shrink-0 text-[11px] text-gray-400"
          title={dateTime(c.createdAt)}
        >
          {relativeTime(c.createdAt)}
        </span>
      </div>

      {/* severity row: our rating, then the bot's own claim about the same comment */}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {c.mlLabel ? (
          <>
            <MlSeverityBadge label={c.mlLabel} />
            <VendorClaim label={c.mlLabel} />
          </>
        ) : (
          <span
            className="text-[10px] text-gray-400 dark:text-gray-500"
            title="Not scored yet — the enrichment worker labels bot text on its own pass, which always FOLLOWS the sync that stored it."
          >
            not scored
          </span>
        )}
      </div>

      {/* context row: where it landed, and what happened to it */}
      {hasContextRow && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          {showPrRef && (
            <button
              type="button"
              onClick={() => onOpenPr(c)}
              className="shrink-0 font-medium text-gray-700 hover:text-sky-600 hover:underline dark:text-gray-200"
              title={`${c.repoFullName} #${c.prNumber} — ${c.prTitle}`}
            >
              {c.repoFullName} #{c.prNumber}
            </button>
          )}
          {showPrRef && c.path != null && (
            <span className="min-w-0 truncate font-mono text-gray-400" title={c.path}>
              {c.path}
              {c.line != null ? `:${c.line}` : ''}
            </span>
          )}
          {/* Inside a cluster the file is the cluster's; only this member's own line varies. */}
          {!showPrRef && c.line != null && (
            <span className="shrink-0 font-mono text-gray-400">L{c.line}</span>
          )}
          {state && <MetaChip meta={state} />}
          {confidence && <MetaChip meta={confidence} prefix="addressed: " />}
        </div>
      )}

      {/* Full markdown — comment and review bodies are ALWAYS persisted, so there is nothing to
          hydrate here even under lean storage. */}
      {c.body != null && c.body.trim() !== '' ? (
        <CardBody body={c.body} />
      ) : (
        // A scored row whose text GitHub no longer returns. Bodies are re-upserted on every sync
        // walk while labels are never re-scored, so the label outlives the text it was computed
        // from. The row is SHOWN rather than dropped on purpose: `total` is counted from the
        // labels, so hiding it here would make the list unable to reach the tile it was opened
        // from — the same drift the shared fold exists to prevent. Its severity is still real.
        <div className="mt-1 rounded border border-dashed border-gray-300 px-2 py-1.5 text-[11px] text-gray-400 dark:border-gray-700">
          GitHub no longer returns this comment’s text, so only its scored severity survives. It
          still counts toward the number above.
        </div>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
        {threadId != null && (
          <button
            type="button"
            onClick={() => onOpenThread(c, threadId)}
            className="font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            Open thread
          </button>
        )}
        {prHref != null && (
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-0.5 font-medium text-sky-600 hover:underline dark:text-sky-400"
            title={`${c.repoFullName} #${c.prNumber} on GitHub. There is deliberately no per-comment permalink — the comment's REST id isn't stored, so an anchor would 404.`}
          >
            <ExternalLinkIcon size={11} />
            PR
          </a>
        )}
      </div>
    </article>
  );
}

// All props are stable references from the drill-down (`c`/`member` are query-stable, the maps and
// callbacks are memoised there), so a shallow comparison over exactly the render inputs skips a
// full markdown re-parse for every row whose content did not change.
export const BotCommentCard = memo(
  BotCommentCardImpl,
  (a, b) =>
    a.c === b.c &&
    a.member === b.member &&
    a.usersById === b.usersById &&
    a.botColor === b.botColor &&
    a.onOpenPr === b.onOpenPr &&
    a.onOpenThread === b.onOpenThread,
);

/**
 * A cluster member whose own bot left no stored opening comment.
 *
 * The wire carries no identity for it — `BotFlaggingClusterMember` names its bot only through
 * `comment`, so there is nothing to label or colour. It still renders, because it is a real thread
 * that contributed to the overlap and dropping it would make the member list disagree with the
 * count above it.
 */
function UnbodiedMember({
  member,
  cluster,
  onOpenThread,
}: {
  member: BotFlaggingClusterMember;
  cluster: BotFlaggingCluster;
  onOpenThread: (ref: BotFlaggedPrRef, threadId: number) => void;
}): JSX.Element {
  const state = DERIVED_STATE_META[member.derivedState];
  const confidence =
    member.addressedConfidence !== 'none' ? CONFIDENCE_META[member.addressedConfidence] : null;
  return (
    <div className="rounded-md border border-dashed border-gray-200 p-2 text-[11px] dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="text-gray-400"
          title="This thread has no stored comment by its own bot, so there is no body and no author to name here — it still counts toward the overlap."
        >
          another bot thread here — no stored comment
        </span>
        {member.line != null && (
          <span className="shrink-0 font-mono text-gray-400">L{member.line}</span>
        )}
        {member.threadIds.length > 1 && (
          <span className="shrink-0 rounded bg-gray-100 px-1 py-px font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            ×{member.threadIds.length}
          </span>
        )}
        <MetaChip meta={state} />
        {confidence && <MetaChip meta={confidence} prefix="addressed: " />}
        <button
          type="button"
          onClick={() => onOpenThread(cluster, member.threadId)}
          className="font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Open thread
        </button>
      </div>
    </div>
  );
}

interface BotClusterCardProps {
  cluster: BotFlaggingCluster;
  usersById: Map<number, User>;
  botColor: BotColorFn;
  onOpenPr: (ref: BotFlaggedPrRef) => void;
  onOpenThread: (ref: BotFlaggedPrRef, threadId: number) => void;
}

function BotClusterCardImpl({
  cluster,
  usersById,
  botColor,
  onOpenPr,
  onOpenThread,
}: BotClusterCardProps): JSX.Element {
  const file = cluster.path.split('/').pop() ?? cluster.path;
  // The ±3 anchored window means the span is small; render one number when it is a single line.
  const lineLabel =
    cluster.lineEnd > cluster.lineStart
      ? `L${cluster.lineStart}–${cluster.lineEnd}`
      : `L${cluster.lineStart}`;
  const prHref = safeExternalUrl(cluster.prUrl);

  // The LEDGER: each bot and how OUR model rated what it said, side by side, above the bodies.
  // This is the whole point of the card — "two bots flagged the same lines" is only interesting
  // once you can see whether they agree about how bad it is — so it is read before any prose.
  //
  // ⚠ ONE severity scale on this card, and it is ours. The per-PR dedup panel derives
  // consensus/conflict from `inferSeverity()`, a coarse regex over an excerpt; that vocabulary is
  // deliberately absent from the wire shape and must not be reintroduced here. Each bot's own
  // badge is on its member card below, where it sits next to the rating it contradicts.
  const rated = cluster.members
    .map((m) => m.comment?.mlLabel?.severity ?? null)
    .filter((s): s is MlSeverity => s != null);
  const mixed = new Set(rated).size > 1;

  return (
    <section className="rounded-md border border-sky-200 bg-sky-50/60 p-2.5 text-sm dark:border-sky-800 dark:bg-sky-950/30">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <BotIcon size={12} />
        <span className="font-medium text-sky-800 dark:text-sky-200">
          {cluster.members.length} bots flagged the same lines
        </span>
        <button
          type="button"
          onClick={() => onOpenPr(cluster)}
          className="shrink-0 font-medium text-gray-700 hover:text-sky-600 hover:underline dark:text-gray-200"
          title={`${cluster.repoFullName} #${cluster.prNumber} — ${cluster.prTitle}`}
        >
          {cluster.repoFullName} #{cluster.prNumber}
        </button>
        <span
          className="min-w-0 truncate font-mono text-gray-500 dark:text-gray-400"
          title={cluster.path}
        >
          {file}
        </span>
        <span className="shrink-0 font-mono text-gray-500 dark:text-gray-400">{lineLabel}</span>
        {cluster.threadCount > cluster.members.length && (
          <span
            className="shrink-0 text-gray-400"
            title="Threads in this line area across all its bots — more than one bot left several, and each bot is collapsed to a single row below."
          >
            {cluster.threadCount} threads
          </span>
        )}
        {prHref != null && (
          <a
            href={prHref}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-medium text-sky-600 hover:underline dark:text-sky-400"
          >
            <ExternalLinkIcon size={11} />
            PR
          </a>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        {cluster.members.map((m, i) => {
          const c = m.comment;
          const color = c ? botColor({ login: c.authorLogin, kind: c.authorKind }) : '#94a3b8';
          const sev = c?.mlLabel ? ML_SEVERITY_META[c.mlLabel.severity] : null;
          return (
            <Fragment key={m.threadId}>
              {i > 0 && <span className="text-gray-400">vs</span>}
              <span
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium"
                style={{ color, background: `${color}1a` }}
              >
                {c?.authorLabel ?? 'a bot'}
              </span>
              {sev ? (
                <span
                  className="font-semibold"
                  style={{ color: sev.color }}
                  title={sev.description}
                >
                  {sev.label}
                </span>
              ) : (
                <span className="text-gray-400" title="Not scored yet.">
                  —
                </span>
              )}
            </Fragment>
          );
        })}
        {mixed && (
          <span
            className="rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            title="Our model rated these bots' comments at different severities — the same lines read as trivial to one reviewer and substantive to another. This compares OUR ratings of what each bot said, not the bots' own badges (those are on each card below)."
          >
            rated differently
          </span>
        )}
      </div>

      <div className="mt-2 space-y-2">
        {cluster.members.map((m) =>
          m.comment ? (
            <BotCommentCard
              key={m.threadId}
              c={m.comment}
              member={m}
              usersById={usersById}
              botColor={botColor}
              onOpenPr={onOpenPr}
              onOpenThread={onOpenThread}
            />
          ) : (
            <UnbodiedMember
              key={m.threadId}
              member={m}
              cluster={cluster}
              onOpenThread={onOpenThread}
            />
          ),
        )}
      </div>
    </section>
  );
}

// Same comparator discipline as the comment card — a cluster renders several markdown bodies, so
// it is the more expensive of the two to re-render.
export const BotClusterCard = memo(
  BotClusterCardImpl,
  (a, b) =>
    a.cluster === b.cluster &&
    a.usersById === b.usersById &&
    a.botColor === b.botColor &&
    a.onOpenPr === b.onOpenPr &&
    a.onOpenThread === b.onOpenThread,
);
