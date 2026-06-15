import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PrDetail as PrDetailT, ReviewState, User } from '@pierre-review/shared';
import {
  CHECK_STATE_META,
  CI_META,
  dateTime,
  formatDate,
  mergeWarning,
  relativeTime,
} from '../lib/ui.js';
import { Avatar } from './CommentCard.js';
import { UserName } from './UserName.js';
import { Markdown } from './Markdown.js';
import { ApproveControl } from './ApproveControl.js';

// Per-state styling for the "Reviewers" row badges (everyone who submitted a
// review, not just approvers): the badge hue + leading glyph hint at each
// reviewer's LATEST review state, so the row reads at a glance — green check for an
// approval, red cross for changes-requested, neutral for a plain comment / dismissed
// review. Mirrors the Approvers badge style (bg-…/10 + soft text) so the two rows
// sit together visually.
const REVIEWER_STATE_META: Record<
  ReviewState,
  { icon: string; cls: string; title: string }
> = {
  approved: {
    icon: '✓',
    cls: 'bg-green-500/10 text-green-700 dark:text-green-400',
    title: 'Approved',
  },
  changes_requested: {
    icon: '✗',
    cls: 'bg-red-500/10 text-red-700 dark:text-red-400',
    title: 'Requested changes',
  },
  commented: {
    icon: '',
    cls: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
    title: 'Reviewed (commented)',
  },
  dismissed: {
    icon: '',
    cls: 'bg-gray-500/10 text-gray-400',
    title: 'Review dismissed',
  },
  pending: {
    icon: '',
    cls: 'bg-gray-500/10 text-gray-400',
    title: 'Review pending',
  },
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-1.5 text-sm">
      <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-gray-400">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// The PR description (markdown), shown in the Overview between "Merged by" and
// "Checks". Collapsed to the first three lines by default with a Show more/less
// toggle — surfaced only when the body actually overflows. No own top border: it
// sits inside the divide-y section list, which separates it from its neighbours.
function PrSummary({ body }: { body: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [hasHiddenImage, setHasHiddenImage] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Classify "tall" images (screenshots) so the collapsed 3-line preview can hide
  // them instead of letting -webkit-line-clamp squash them — they reappear once
  // expanded. We measure from NATURAL dimensions: the clamp constrains rendered
  // height, so offsetHeight would read the (wrong) squashed value. The class lands
  // on the img itself; CSS only acts on it while the container is collapsed.
  //
  // Two robustness traps drive this shape: (1) react-markdown re-renders (and
  // StrictMode's mount/remount) REPLACE the <img> DOM node, so we must re-query
  // the live nodes each pass and re-apply via a MutationObserver — a `load`
  // listener captured on one node fires on a now-detached element. (2) the big
  // image loads async, so we poll (bounded) until it reports natural dimensions.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only HIDE genuinely tall screenshots; allow moderately tall images to ride
    // along in the collapsed preview (they're cropped by the 3-line clamp like any
    // overflow, no longer squashed — see .md-body img width/height:auto). 160px ≈
    // 2-3× the preview height; e.g. PR #77's ~384px render stays hidden, a ~100px
    // inline image does not.
    const TALL_PX = 160;
    const MAX_PX = 384; // mirrors .md-body img max-height: 24rem

    // Re-query live nodes, tag the tall ones, and report whether we're settled
    // (width known + every image classifiable) so polling can stop. We only need
    // an image's natural dimensions, not a full decode — once it's hidden mid-load
    // `complete` may never flip, so settling on dimensions avoids spinning.
    const apply = (): boolean => {
      const width = el.clientWidth;
      const imgs = Array.from(el.querySelectorAll('img'));
      let anyTall = false;
      let settled = width > 0;
      for (const img of imgs) {
        const measurable = img.naturalWidth > 0 && img.naturalHeight > 0;
        if (!measurable) {
          if (!img.complete) settled = false; // still loading — keep polling
          continue; // not yet measurable, or broken (complete with no dimensions)
        }
        const renderW = width ? Math.min(img.naturalWidth, width) : img.naturalWidth;
        const renderH = Math.min((img.naturalHeight * renderW) / img.naturalWidth, MAX_PX);
        const tall = width > 0 && renderH > TALL_PX;
        img.classList.toggle('pr-summary-tall-img', tall);
        if (tall) anyTall = true;
      }
      setHasHiddenImage(anyTall);
      return settled;
    };

    // Re-tag whenever react-markdown swaps img nodes, so the class follows the
    // live node (we only watch childList — toggling the class is an attribute
    // change we deliberately don't observe, so there's no feedback loop).
    const mo = new MutationObserver(() => apply());
    mo.observe(el, { childList: true, subtree: true });

    let frames = 0;
    let raf = 0;
    const tick = (): void => {
      if (!apply() && frames++ < 240) raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [body]);

  // Measure overflow while clamped (skip when expanded — the clamp is off then, so
  // scrollHeight === clientHeight and the test would always read false).
  useLayoutEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 1);
  }, [body, expanded]);

  // Images in the body load async, so the initial measurement above runs before
  // they have intrinsic size — leaving the Show-more state wrong. Re-measure on
  // any size change of the clamped element (covers image loads + reflow). Only
  // meaningful while clamped, so we skip wiring it when expanded.
  useEffect(() => {
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setOverflowing(el.scrollHeight - el.clientHeight > 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [body, expanded]);

  return (
    <div>
      <div className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        Summary
      </div>
      <div className="px-4 pb-3 text-sm">
        <div
          ref={ref}
          className={`overflow-hidden${expanded ? '' : ' pr-summary-collapsed'}`}
          style={
            expanded
              ? undefined
              : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }
          }
        >
          <Markdown>{body}</Markdown>
        </div>
        {(overflowing || hasHiddenImage || expanded) && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-xs font-medium text-blue-500 hover:underline"
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
}

export function ChecksTab({
  pr,
  usersById,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
}): JSX.Element {
  const ci = CI_META[pr.ciStatus];
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  const checks = pr.checkRuns;
  const counts = checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});

  // A reviewer's standing decision is their LATEST decisive review: an approval
  // is superseded once they later request changes or it gets dismissed.
  // 'commented'/'pending' reviews don't change a standing decision, so we skip
  // them. pr.reviews is chronological (submittedAt asc), so a later decisive
  // review overwrites — approvers are authors whose latest decision is 'approved'.
  const latestDecision = new Map<number, ReviewState>();
  for (const r of pr.reviews) {
    if (
      r.authorId == null ||
      (r.state !== 'approved' && r.state !== 'changes_requested' && r.state !== 'dismissed')
    ) {
      continue;
    }
    latestDecision.set(r.authorId, r.state);
  }
  const approverIds = [...latestDecision]
    .filter(([, state]) => state === 'approved')
    .map(([id]) => id);

  // Everyone who has SUBMITTED a review (any decisive OR commented state), with
  // their latest review state — the fuller picture above the Approvers row, which
  // is just the subset whose standing decision is 'approved'. pr.reviews is
  // chronological (submittedAt asc), so the last entry per author wins. 'pending'
  // reviews (an in-progress draft, never submitted) aren't a real review, so skip
  // them; insertion order is preserved by the Map so reviewers stay first-seen.
  const latestReviewState = new Map<number, ReviewState>();
  for (const r of pr.reviews) {
    if (r.authorId == null || r.state === 'pending') continue;
    latestReviewState.set(r.authorId, r.state);
  }
  const reviewerIds = [...latestReviewState.keys()];

  return (
    <div className="divide-y divide-gray-100 py-1 dark:divide-gray-800">
      <Row label="CI">
        {ci ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: ci.color }}
            />
            {ci.label}
            {checks.length > 0 && (
              <span className="text-xs text-gray-400">
                ·{' '}
                {[
                  counts.success ? `${counts.success} passed` : null,
                  counts.failure ? `${counts.failure} failed` : null,
                  counts.pending ? `${counts.pending} running` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">no checks reported</span>
        )}
      </Row>

      <Row label="Mergeable">
        {warn ? (
          <span className="font-medium text-orange-500">⚠ {warn}</span>
        ) : pr.mergeable === 'mergeable' ? (
          <span className="text-green-500">clean</span>
        ) : (
          <span className="text-gray-400">{pr.mergeStateStatus}</span>
        )}
      </Row>

      {reviewerIds.length > 0 && (
        <Row label="Reviewers">
          <div className="flex flex-wrap gap-2 text-xs">
            {reviewerIds.map((uid) => {
              const u = usersById.get(uid);
              const meta = REVIEWER_STATE_META[latestReviewState.get(uid)!];
              return (
                <span
                  key={uid}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${meta.cls}`}
                  title={meta.title}
                >
                  {meta.icon && <span aria-hidden>{meta.icon}</span>}
                  <Avatar user={u} size={14} />
                  <UserName user={u} fallbackId={uid} repoId={pr.repoId} />
                </span>
              );
            })}
          </div>
        </Row>
      )}

      {approverIds.length > 0 && (
        <Row label="Approvers">
          <div className="flex flex-wrap gap-2 text-xs">
            {approverIds.map((uid) => {
              const u = usersById.get(uid);
              return (
                <span
                  key={uid}
                  className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-green-700 dark:text-green-400"
                  title="Approved this PR"
                >
                  <span className="text-green-600 dark:text-green-500">✓</span>
                  <Avatar user={u} size={14} />
                  <UserName user={u} fallbackId={uid} repoId={pr.repoId} />
                </span>
              );
            })}
          </div>
        </Row>
      )}

      {pr.viewerCanApprove && (
        <Row label="Review">
          <ApproveControl prId={pr.id} />
        </Row>
      )}

      {pr.mergedById != null && (
        <Row label="Merged by">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <Avatar user={usersById.get(pr.mergedById)} size={14} />
            <UserName
              user={usersById.get(pr.mergedById)}
              fallbackId={pr.mergedById}
              repoId={pr.repoId}
            />
            {pr.mergedAt != null && (
              <span className="text-gray-400" title={dateTime(pr.mergedAt)}>
                · {formatDate(pr.mergedAt)}
              </span>
            )}
          </span>
        </Row>
      )}

      {pr.body != null && pr.body.trim() !== '' && <PrSummary body={pr.body} />}

      {checks.length > 0 && (
        <Row label="Checks">
          <ul className="space-y-1">
            {checks.map((c, i) => {
              const m = CHECK_STATE_META[c.state];
              const inner = (
                <span className="flex items-center gap-2">
                  <span
                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: m.color }}
                    title={m.label}
                  >
                    {m.icon}
                  </span>
                  <span className="min-w-0 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-gray-400">
                    {m.label}
                  </span>
                </span>
              );
              return (
                <li key={`${c.name}-${i}`} className="text-xs">
                  {c.url ? (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block rounded px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800"
                    >
                      {inner}
                    </a>
                  ) : (
                    <div className="px-1 py-0.5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Row>
      )}

      {pr.labels.length > 0 && (
        <Row label="Labels">
          <div className="flex flex-wrap gap-1">
            {pr.labels.map((l) => (
              <span
                key={l.name}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                style={{ borderColor: `#${l.color}` }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: `#${l.color}` }}
                />
                {l.name}
              </span>
            ))}
          </div>
        </Row>
      )}

      {pr.requestedReviewers.length > 0 && (
        <Row label="Requested">
          <div className="flex flex-wrap gap-2 text-xs">
            {pr.requestedReviewers.map((r, i) => (
              <span key={i} className="rounded bg-gray-500/10 px-1.5 py-0.5">
                {r.teamName ? (
                  `@${r.teamName}`
                ) : (
                  <UserName
                    user={r.userId != null ? usersById.get(r.userId) : undefined}
                    fallbackId={r.userId}
                    repoId={pr.repoId}
                  />
                )}
              </span>
            ))}
          </div>
        </Row>
      )}

      <Row label="Meta">
        <div className="space-y-0.5 text-xs text-gray-500">
          <div>{pr.repoFullName}</div>
          <div>opened {relativeTime(pr.openedAt)}</div>
          <div>updated {relativeTime(pr.updatedAt)}</div>
        </div>
      </Row>
    </div>
  );
}
