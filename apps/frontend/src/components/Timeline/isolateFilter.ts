import type {
  EventCategory,
  EventType,
  ReviewState,
  TimelineEvent,
  TimelinePr,
} from '@pierre-review/shared';
import { ALL_REVIEW_STATES, categoriesToTypes } from '../../store/filters.js';
import { prGroupId } from './lanes.js';

// The Focus (pr-focus / isolate) tab's filters, applied CLIENT-SIDE.
//
// ⚠ WHY NOT ON THE SERVER. The focus tab fetches `/api/timeline?prIds=<id>` and that query string
// carries NOTHING else — no from/to, no workspace, no filter (buildTimelineSearch's early return,
// pinned by test/workspaceScope.test.ts). Three reasons, each sufficient:
//   • KEY STABILITY. Anything the board's filters touch would re-key the fetch, and a date would
//     churn it every minute, refetching the PR for nothing.
//   • THE WRONG WORKSPACE. The request names no workspace, so the server resolves the account's
//     DEFAULT — a server-side `excludeBots` would apply Default's bot judgements, not those of the
//     PR's own workspace.
//   • ONE FETCH PER TAB. A toggle filters the payload already in hand; nothing is refetched.
// getTimeline's prIds branch therefore bypasses every filter and returns the PR plus ALL of its
// events, and this module narrows them with the SAME semantics the server applies on the board.
//
// Focus shows exactly two controls — Events (categories + review verdicts) and Hide bots — so only
// those rules are here. The member (`userIds`) and Threads (`derivedStates`) filters have no
// control in Focus and are deliberately NOT applied: a filter whose control is not on screen is
// the defect the Timeline-only FilterBar move fixed.

export interface IsolateFilterInput {
  categories: EventCategory[];
  reviewStates: ReviewState[];
  excludeBots: boolean;
  allowedBotIds: number[];
}

/**
 * One event's verdict. Mirrors getTimeline's board predicates exactly:
 *   • categories — the type must be in `categoriesToTypes(categories)` (lifecycle + reviews
 *     always flow; review_submitted is narrowed by the verdict rule instead).
 *   • reviewStates — only when the selection is NOT full (the same test buildTimelineSearch uses
 *     to decide whether to send the param): a `review_submitted` passes only with a non-null
 *     `reviewState` in the selection. The server's EXISTS drops a review with no matching row, so
 *     a null state is dropped too. Every other type is untouched.
 *   • excludeBots — a bot actor (the UNION verdict, for the PR's OWN workspace) is dropped unless
 *     allow-listed. A NULL actor is KEPT (the server's `actor_id is null` arm).
 *   • forcedEventId — the event a magnifier deep-linked to ALWAYS passes, whatever the filters:
 *     a link that lands on nothing is worse than a filter that lets one marker through.
 */
export function makeIsolateEventFilter(
  f: IsolateFilterInput,
  isBot: (userId: number) => boolean,
  forcedEventId: number | null,
): (e: TimelineEvent) => boolean {
  const allowedTypes = new Set<EventType>(categoriesToTypes(f.categories));
  const reviewNarrowed = f.reviewStates.length < ALL_REVIEW_STATES.length;
  const reviewSel = new Set<ReviewState>(f.reviewStates);
  const allowBots = new Set<number>(f.allowedBotIds);
  return (e: TimelineEvent): boolean => {
    if (forcedEventId != null && e.id === forcedEventId) return true;
    if (!allowedTypes.has(e.type)) return false;
    if (
      reviewNarrowed &&
      e.type === 'review_submitted' &&
      (e.reviewState == null || !reviewSel.has(e.reviewState))
    ) {
      return false;
    }
    if (f.excludeBots && e.actorId != null && !allowBots.has(e.actorId) && isBot(e.actorId)) {
      return false;
    }
    return true;
  };
}

/** The subject PR's events that survive the Focus filters (see makeIsolateEventFilter). */
export function filterIsolateEvents(
  events: readonly TimelineEvent[] | null | undefined,
  prId: number,
  f: IsolateFilterInput,
  isBot: (userId: number) => boolean,
  forcedEventId: number | null,
): TimelineEvent[] {
  const passes = makeIsolateEventFilter(f, isBot, forcedEventId);
  return (events ?? []).filter((e) => e.prId === prId && passes(e));
}

/**
 * The rows a Focus tab keeps visible: the subject PR's AUTHOR row (always — its bar lives there)
 * plus one row per actor of the surviving events.
 *
 * ⚠ NEVER EMPTY. applyContext / focusRows read an empty keep-set as "no focus" and would drop the
 * isolation outright. `prGroupId` answers for a null-author PR too (the repo row), so the first
 * entry always exists.
 *
 * Recomputed on EVERY rebuild, not once at boot: a participant who first appears after boot (a
 * sync that adds a reviewer, your own reply posted from the pane) must get a visible row, and a
 * row whose every event a filter hid must go.
 */
export function isolateKeepGroupIds(
  pr: TimelinePr,
  events: readonly TimelineEvent[],
): string[] {
  const out = [prGroupId(pr)];
  const seen = new Set(out);
  for (const e of events) {
    if (e.prId !== pr.id || e.actorId == null) continue;
    const gid = `repo:${pr.repoId}:user:${e.actorId}`;
    if (!seen.has(gid)) {
      seen.add(gid);
      out.push(gid);
    }
  }
  return out;
}

/**
 * Resolve a deep-link target (timelineFocusEvent + timelineFocusAt) to ONE event of the PR.
 * Among the events matching (pr, type, refId), prefer the one at the requested instant —
 * review-comment replies share their thread's refId, so `occurredAt` is what tells a specific
 * reply's marker apart — else the first match. Always resolved against the UNFILTERED payload.
 */
export function matchFocusEvent(
  events: readonly TimelineEvent[] | null | undefined,
  prId: number,
  focusEv: { type: EventType; refId: number | null },
  focusAt: string | null,
): TimelineEvent | undefined {
  const candidates = (events ?? []).filter(
    (e) =>
      e.prId === prId &&
      e.type === focusEv.type &&
      (focusEv.refId == null || e.refId === focusEv.refId),
  );
  return (
    (focusAt != null ? candidates.find((e) => e.occurredAt === focusAt) : undefined) ??
    candidates[0]
  );
}
