import type {
  AiFixCommentKind,
  AiFixCommentTargetRef,
  MlLabel,
  MlSeverity,
  PrDetail,
} from '@pierre-review/shared';
import { anchorLineFromHunk } from './diff.js';

// The pure model behind the AI-Fix comment picker ("fix from comments"): every comment on a PR,
// flattened into one selectable list, split bots/humans, ordered, with thread replies nested
// under the comment they answer.
//
// It lives here rather than inside CommentPicker.tsx because every rule below has a wrong version
// that compiles and renders a plausible list — the same reasoning as lib/botComments.ts:
//   • a summary/praise row ordered as if its severity were a finding severity (the worstSeverity
//     trap), which floats a walkthrough above every real bug;
//   • a reply promoted to a free-standing row, which strips the code anchor and the question it
//     was answering, i.e. the two things that make it legible;
//   • a bot/human split applied per COMMENT, which orphans a human reply from the bot thread it
//     belongs to.
// Each one gets a test in test/aiFixCommentModel.test.ts.

/** `${kind}|${id}` — deliberately the same shape as `mlLabelKey`, so a label lookup is direct. */
export const pickerKey = (kind: AiFixCommentKind, id: number): string => `${kind}|${id}`;

export interface PickerComment {
  key: string;
  kind: AiFixCommentKind;
  id: number;
  authorId: number | null;
  /** The GitHub login when known — `user <id>` / `unknown` otherwise. Display only. */
  authorLogin: string;
  isBot: boolean;
  body: string;
  createdAt: string;
  url: string | null;
  /**
   * File anchor: review comments only, and only via their THREAD — a review comment carries no
   * position of its own (`review_threads.path/line`). PR comments and review bodies have none at
   * all, and the UI must label them as unanchored rather than render a blank anchor.
   *
   * `line` is GitHub's LIVE line and goes NULL the moment the anchor drifts out of the current
   * diff — true of ~90% of outdated threads.
   */
  path: string | null;
  line: number | null;
  /**
   * The thread's line reconstructed from its anchor hunk when `line` is null
   * (`anchorLineFromHunk`, lib/diff.ts). ⚠ APPROXIMATE — it is the line in the commit the comment
   * was WRITTEN against, so any UI showing it must say so. Null when there is no hunk to read,
   * which under lean storage is the common case (`diff_hunk` is not persisted).
   */
  approxLine: number | null;
  /** The review thread this comment belongs to, when it has one. */
  threadId: number | null;
  /** True for every comment in a thread after its first — rendered under its root, never alone. */
  isReply: boolean;
  /** Thread flags, both false for PR comments and review bodies. Muted in the UI, skipped by "Move all". */
  isResolved: boolean;
  isOutdated: boolean;
  /**
   * The ML label as stored, for the badge. The badge is the ONE renderer of this — nothing here
   * derives from `vendorSeverity` (the bot's own claim is displayed, never believed: 0.474 exact
   * against our 0.700 on the adjudicated gold-300).
   */
  label: MlLabel | null;
  /**
   * ⚠ THE FINDING SEVERITY, WHICH IS NOT THE SAME THING AS `label.severity`. Null for a
   * summary/walkthrough or a praise row even though those carry a severity — see `findingSeverity`.
   * This is the ordering key; `label` is the display.
   */
  severity: MlSeverity | null;
  severityOrd: number | null;
}

/** Which of the three kinds may be TRUNCATED, because the fetch sits at GitHub's page size. */
export interface PickerCaps {
  threads: boolean;
  prComments: boolean;
  reviews: boolean;
}

/**
 * GitHub's page size for a PR's discussion, as both the sync walk and PR_DETAIL_QUERY ask for it
 * (`reviewThreads(first:50)` / `comments(first:50)` / `reviews(first:50)`, github/queries.ts).
 *
 * ⚠ So "every comment on this PR" IS A CAPPED VIEW, and nothing on the wire says so. A PR sitting
 * at exactly 50 threads (there are several in this dev DB) may have more that were never fetched,
 * which makes "Move all" a claim the data cannot support — hence `capNotice` below, the same
 * honesty move as the hunk hydration's `commentsSeen`.
 */
const GITHUB_PAGE_CAP = 50;

export interface PickerModel {
  bots: PickerComment[];
  humans: PickerComment[];
  /**
   * How many replies EXIST on this PR, regardless of `includeReplies` — it is the number the
   * "Show N replies" toggle promises, so it must not go to 0 the moment they are hidden.
   */
  replyCount: number;
  /**
   * Whether `bots` is genuinely ordered by severity, or fell back to newest-first because there
   * was nothing to sort by. The UI must SAY which: ML labels exist only for bot-authored text and
   * only when `SEVERITY_API_URL` is set, so an `npx` install, an unenriched PR and a PR whose bots
   * only wrote praise all arrive here looking identical, and presenting an arbitrary order as a
   * severity ranking is the lie worth avoiding.
   */
  botsSortedBySeverity: boolean;
  /** See GITHUB_PAGE_CAP — the list may not be everything. */
  atPageCap: PickerCaps;
  /**
   * EVERY comment on the PR — roots AND replies — indexed by key, independent of `includeReplies`.
   *
   * The basket renders from this rather than from `bots`/`humans`: a reply the user deliberately
   * dragged in must keep rendering after they collapse the reply rows again, and a selection that
   * silently stops displaying is a selection they cannot remove.
   */
  byKey: Map<string, PickerComment>;
}

export interface PickerModelOptions {
  /** The per-PR ML label index (`useMlLabelIndex`). `undefined` = scoring off or not loaded. */
  labels: Map<string, MlLabel> | undefined;
  /**
   * The UNION bot verdict for an actor, passed in so this module stays pure: it needs the
   * workspace's `workspace_reviewers` rows, which only a hook can fetch.
   */
  isBot: (userId: number | null) => boolean;
  includeReplies: boolean;
}

/**
 * The severity a comment may be ORDERED by — `null` for anything that is not a finding.
 *
 * Mirrors `pillOf()` in lib/botComments.ts and exists for the same reason: a walkthrough/summary
 * comment carries a severity that is NOT a finding severity, so a summary scored `major` would
 * outrank every real finding in the basket ordering (the `worstSeverity` trap that db/ml-labels.ts
 * spells out). Praise is the v2 non-finding CATEGORY and goes the same way — CLAUDE.md's rule is
 * that praise rows are excluded from severity-weighted views exactly like summaries.
 *
 * Praise is tested before `isSummary` only to keep the two branches in the same order as
 * `pillOf`; here they collapse to the same answer.
 */
function findingSeverity(label: MlLabel | undefined): MlSeverity | null {
  if (!label) return null;
  if (label.categories.includes('praise')) return null;
  if (label.isSummary) return null;
  return label.severity;
}

/** A thread root plus its replies, kept together so no ordering step can separate them. */
interface Unit {
  root: PickerComment;
  replies: PickerComment[];
}

const millis = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Newest first, with the key as a deterministic tiebreak so the order never depends on input order. */
function newestFirst(a: PickerComment, b: PickerComment): number {
  const d = millis(b.createdAt) - millis(a.createdAt);
  if (d !== 0) return d;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Worst finding first, UNLABELLED LAST, ties newest-first.
 *
 * "Unlabelled" is one bucket holding three different situations — not scored yet, no scoring
 * service on this deployment, and the summary/praise rows above. All three mean the same thing to
 * a reader picking work: there is no severity to rank this by.
 */
function bySeverityThenNewest(a: PickerComment, b: PickerComment): number {
  const ao = a.severityOrd;
  const bo = b.severityOrd;
  if (ao !== bo) {
    if (ao == null) return 1;
    if (bo == null) return -1;
    return bo - ao;
  }
  return newestFirst(a, b);
}

export function buildPickerModel(pr: PrDetail, opts: PickerModelOptions): PickerModel {
  const usersById = new Map(pr.users.map((u) => [u.id, u]));
  const loginOf = (id: number | null): string => {
    if (id == null) return 'unknown';
    return usersById.get(id)?.githubLogin ?? `user ${id}`;
  };
  const labelOf = (kind: AiFixCommentKind, id: number): MlLabel | undefined =>
    opts.labels?.get(pickerKey(kind, id));

  const make = (
    kind: AiFixCommentKind,
    c: {
      id: number;
      authorId: number | null;
      body: string;
      createdAt: string;
      url: string | null;
    },
    anchor: {
      path: string | null;
      line: number | null;
      approxLine: number | null;
      threadId: number | null;
      isReply: boolean;
      isResolved: boolean;
      isOutdated: boolean;
    },
  ): PickerComment => {
    const label = labelOf(kind, c.id) ?? null;
    const severity = findingSeverity(label ?? undefined);
    return {
      key: pickerKey(kind, c.id),
      kind,
      id: c.id,
      authorId: c.authorId,
      authorLogin: loginOf(c.authorId),
      isBot: opts.isBot(c.authorId),
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
      ...anchor,
      label,
      severity,
      // The service's own 0..3 ordinal, read off the label rather than recomputed from the union.
      severityOrd: severity == null ? null : (label?.severityOrd ?? null),
    };
  };

  const units: Unit[] = [];
  const byKey = new Map<string, PickerComment>();
  let replyCount = 0;
  const register = (c: PickerComment): PickerComment => {
    byKey.set(c.key, c);
    return c;
  };

  /**
   * A comment with no text is NOT A TARGET, whatever its kind.
   *
   * ⚠ This has to hold for all three kinds, not just review bodies, because the SERVER drops a
   * body-less target and then re-assigns the C1..Cn labels over the survivors. Offering one here
   * meant the launch button promised "Fix 5 comments" while 4 were worked, every basket label
   * after the dropped row disagreed with the report card for the same comment, and a basket made
   * only of such rows 400'd with "none of the selected comments could be found on this pull
   * request" — a false diagnosis: they are on the PR, they just have no synced body.
   *
   * Empty bodies are real: `getPrDetail` returns `body ?? ''` for PR comments and
   * `body ?? excerpt ?? ''` for review comments, and hydration normally repairs the legacy NULLs —
   * but not under `PERSIST_BODIES=true` (hydration returns immediately) and not when the fetch is
   * blocked (the SAML-SSO cloud path, which already renders an authNotice).
   */
  const hasText = (body: string | null | undefined): boolean => (body ?? '').trim() !== '';

  // ── inline review threads ──────────────────────────────────────────────────────────────────
  // `comments[0]` IS the root: that is the anchor the server matches on and the same convention
  // ThreadList/resolvable.ts reads (`t.comments[0]?.authorId`). A thread with no comments left
  // (lean pruning) has no root and contributes nothing.
  for (const t of pr.threads) {
    const root = t.comments[0];
    if (root == null) continue;
    // A thread whose OPENING comment has no text is dropped whole: its replies are a discussion of
    // something the reader (and the agent) cannot see, and promoting a reply to root would break
    // the positional root convention the server and the annotations platform both key on.
    if (!hasText(root.body)) continue;
    const anchor = {
      path: t.path,
      line: t.line,
      // Read ONCE from the root's hunk and shared by the replies — they all discuss the same line
      // — and consulted only when GitHub's live line is gone. `anchorLineFromHunk` returns null on
      // anything it cannot parse rather than throwing: this app has no error boundary, so a
      // render-time throw in one card blanks the whole SPA.
      approxLine: t.line == null ? (anchorLineFromHunk(root.diffHunk)?.line ?? null) : null,
      threadId: t.id,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
    };
    const unit: Unit = {
      root: register(make('review_comment', root, { ...anchor, isReply: false })),
      replies: [],
    };
    // ⚠ Replies are BUILT even while hidden, because they go into `byKey` and the basket renders
    // from there — a reply the user dragged in must not vanish when they collapse the reply rows.
    // `includeReplies` gates only which of them reach the rendered lists.
    for (const c of t.comments.slice(1)) {
      if (!hasText(c.body)) continue;
      replyCount += 1;
      unit.replies.push(register(make('review_comment', c, { ...anchor, isReply: true })));
    }
    units.push(unit);
  }

  // ── top-level PR comments ─────────────────────────────────────────────────────────────────
  // No file anchor and no thread: GitHub issue comments are flat, so each one is its own root.
  const bare = {
    path: null,
    line: null,
    approxLine: null,
    threadId: null,
    isReply: false,
    isResolved: false,
    isOutdated: false,
  };
  for (const c of pr.comments) {
    if (!hasText(c.body)) continue;
    units.push({ root: register(make('pr_comment', c, bare)), replies: [] });
  }

  // ── review bodies ─────────────────────────────────────────────────────────────────────────
  // The review's own summary text. An APPROVE/COMMENT event with no body says nothing an agent
  // could act on — the same `hasText` rule the other two kinds now take.
  for (const r of pr.reviews) {
    const body = r.body ?? '';
    if (!hasText(body)) continue;
    units.push({
      root: register(
        make(
          'review',
          { id: r.id, authorId: r.authorId, body, createdAt: r.submittedAt, url: r.url },
          bare,
        ),
      ),
      replies: [],
    });
  }

  // The split is by the ROOT's author, so a thread never straddles the two groups: a human reply
  // on a bot's thread stays attached to the comment it answers (each reply still carries its own
  // `isBot` so a card can say who wrote it). Grouping per comment instead would leave the reply
  // stranded in the other column with no anchor and no question.
  const botUnits: Unit[] = [];
  const humanUnits: Unit[] = [];
  for (const u of units) (u.root.isBot ? botUnits : humanUnits).push(u);

  botUnits.sort((a, b) => bySeverityThenNewest(a.root, b.root));
  humanUnits.sort((a, b) => newestFirst(a.root, b.root));

  // Replies stay CHRONOLOGICAL under their root (oldest first) — a conversation only reads in
  // one direction, and the newest-first rule is about which conversation to look at, not which
  // half of one to read first.
  const flatten = (list: Unit[]): PickerComment[] => {
    const out: PickerComment[] = [];
    for (const u of list) {
      out.push(u.root);
      if (!opts.includeReplies) continue;
      for (const r of [...u.replies].sort((a, b) => millis(a.createdAt) - millis(b.createdAt))) {
        out.push(r);
      }
    }
    return out;
  };

  return {
    bots: flatten(botUnits),
    humans: flatten(humanUnits),
    replyCount,
    // Keyed on whether any bot root ACTUALLY carries a finding severity, not on `labels != null`:
    // a PR whose bots wrote nothing but walkthroughs and praise has a full label index and still
    // nothing to rank, and the comparator falls through to newest-first there too.
    botsSortedBySeverity: botUnits.some((u) => u.root.severityOrd != null),
    atPageCap: {
      threads: pr.threads.length >= GITHUB_PAGE_CAP,
      prComments: pr.comments.length >= GITHUB_PAGE_CAP,
      reviews: pr.reviews.length >= GITHUB_PAGE_CAP,
    },
    byKey,
  };
}

/**
 * One muted line disclosing that a kind may be truncated, or null when nothing is at the cap.
 *
 * Pure + exported so the wording is pinned by a test and the component holds no logic. It exists
 * because "Move all" and a scrollable list of everything both imply completeness the fetch cannot
 * promise — see GITHUB_PAGE_CAP.
 */
export function capNotice(caps: PickerCaps): string | null {
  const parts: string[] = [];
  if (caps.threads) parts.push('review threads');
  if (caps.prComments) parts.push('PR comments');
  if (caps.reviews) parts.push('reviews');
  if (parts.length === 0) return null;
  return `Showing the first ${GITHUB_PAGE_CAP} ${parts.join(' / ')} GitHub returned — there may be more.`;
}

/**
 * Everything "Move all" moves: every comment the model is CURRENTLY carrying, minus the
 * resolved/outdated ones.
 *
 * Resolved and outdated are skipped because a bulk action must not quietly spend prompt budget
 * (and an agent's attention) on conversations someone already closed — but they are listed, and a
 * deliberate drag or `+` still includes them, because "resolved" is a click and not evidence.
 *
 * It reads the model it is given, so with replies hidden it moves only the roots on screen. That
 * is the intended reading of "all": what the user can see.
 */
export function movableAll(model: PickerModel): AiFixCommentTargetRef[] {
  const out: AiFixCommentTargetRef[] = [];
  for (const c of [...model.bots, ...model.humans]) {
    if (c.isResolved || c.isOutdated) continue;
    out.push({ kind: c.kind, id: c.id });
  }
  return out;
}
