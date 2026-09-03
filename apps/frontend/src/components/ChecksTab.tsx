import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  AutomatedReviewerKind,
  PrDetail as PrDetailT,
  RequestReviewersBody,
  ReviewBotKind,
  ReviewerSuggestion,
  ReviewProvenance,
  ReviewState,
  User,
} from '@pierre-review/shared';
import {
  automatedReviewerMeta,
  BOT_VENDOR_META,
  botVendorMeta,
  checksRowVisible,
  CI_META,
  dateTime,
  MERGE_TONE_CLASS,
  mergeVerdict,
  relativeTime,
  safeExternalUrl,
} from '../lib/ui.js';
import { useFilters } from '../store/filters.js';
import { Avatar } from './CommentCard.js';
import { UserName } from './UserName.js';
import { Markdown } from './Markdown.js';
import { ApproveControl } from './ApproveControl.js';
import { MergeControl } from './MergeControl.js';
import { MergeWhenReadyControl } from './MergeWhenReadyControl.js';
import { ClosePrControl } from './ClosePrControl.js';
import { ChecksList, CiRerunControl } from './CheckList.js';
import { AiSummary } from './AiSummary.js';
import { CiAnalysisCard } from './CiAnalysisCard.js';
import { useRequestReviewers } from '../hooks/usePrWrites.js';
import { usePrArmedIntent } from '../hooks/useAutoMerge.js';
import { useSuggestedReviewers } from '../hooks/usePr.js';
import { usePrBotBehaviour } from '../hooks/useBotTriage.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { BotIcon, CheckIcon, CloseIcon, ExternalLinkIcon, WarningIcon } from './Icons.js';

// Per-state styling for the "Reviewers" row badges (everyone who submitted a
// review, not just approvers): the badge hue + leading mark hint at each
// reviewer's LATEST review state, so the row reads at a glance — green check for an
// approval, red cross for changes-requested, neutral for a plain comment / dismissed
// review. Mirrors the Approvers badge style (bg-…/10 + soft text) so the two rows
// sit together visually.
//
// `icon` is an ELEMENT, not a character: the badge tints itself (text-green-700 /
// text-red-700), and only an icon inheriting `currentColor` follows that tint. The
// states with nothing to say carry null and render no mark at all.
const REVIEWER_STATE_META: Record<
  ReviewState,
  { icon: JSX.Element | null; cls: string; title: string }
> = {
  approved: {
    icon: <CheckIcon size={12} />,
    cls: 'bg-green-500/10 text-green-700 dark:text-green-400',
    title: 'Approved',
  },
  changes_requested: {
    icon: <CloseIcon size={12} />,
    cls: 'bg-red-500/10 text-red-700 dark:text-red-400',
    title: 'Requested changes',
  },
  commented: {
    icon: null,
    cls: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
    title: 'Reviewed (commented)',
  },
  dismissed: {
    icon: null,
    cls: 'bg-gray-500/10 text-gray-400',
    title: 'Review dismissed',
  },
  pending: {
    icon: null,
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

// WS2 provenance badge — a small "🤖 {label}" tag next to a reviewer/approver whose review is
// classified automated (compute-on-read via ReviewDetail.automatedKind on the PR-detail payload).
// For the Pierre kind we additionally surface how the posted review was authored:
// "Pierre · Claude · verbatim" (ai_verbatim, Claude's summary posted as-is) vs "· curated" (a
// human materially edited it). The kind is in hand, so we look it up via automatedReviewerMeta
// (which covers vendors + in_house + pierre — botVendorMeta only maps a login→ReviewBotKind).
function AutomatedReviewerBadge({
  kind,
  provenance,
}: {
  kind: AutomatedReviewerKind;
  provenance: ReviewProvenance | null;
}): JSX.Element {
  const meta = automatedReviewerMeta(kind);
  const prov =
    kind === 'pierre' && provenance
      ? provenance === 'ai_verbatim'
        ? ' · verbatim'
        : ' · curated'
      : '';
  return (
    <span
      data-testid="reviewer-provenance"
      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium"
      style={{ color: meta.color, background: `${meta.color}1a` }}
      title={`Automated reviewer — ${meta.label}${prov}`}
    >
      <BotIcon size={10} />
      {meta.label}
      {prov}
    </span>
  );
}

// Suggested reviewers (CORE) for a PR that has none assigned — each with its rationale and,
// for someone with push access, a one-click "Assign" that requests them on GitHub. Shown
// only when the server returned suggestions (it gates on open + non-draft + no reviewers/
// reviews). Combines CODEOWNERS ownership (users + @org/team) with history-based picks.
function SuggestedReviewersRow({
  pr,
  suggestions,
  usersById,
}: {
  pr: PrDetailT;
  suggestions: ReviewerSuggestion[];
  usersById: Map<number, User>;
}): JSX.Element {
  const request = useRequestReviewers(pr.id);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const keyOf = (s: ReviewerSuggestion): string =>
    s.kind === 'team' ? `team:${s.teamSlug}` : `user:${s.login}`;

  const assign = (s: ReviewerSuggestion): void => {
    const body: RequestReviewersBody =
      s.kind === 'team'
        ? { teamSlugs: s.teamSlug ? [s.teamSlug] : [] }
        : s.userId != null
          ? { userIds: [s.userId] }
          : { logins: s.login ? [s.login] : [] };
    const k = keyOf(s);
    setPendingKey(k);
    request.mutate(body, {
      onSuccess: () => setRequested((prev) => new Set(prev).add(k)),
      onSettled: () => setPendingKey(null),
    });
  };

  return (
    <Row label="Suggested">
      <div className="flex flex-col gap-1.5 text-xs">
        {suggestions.map((s) => {
          const k = keyOf(s);
          const done = requested.has(k);
          const u = s.userId != null ? usersById.get(s.userId) : undefined;
          return (
            <div key={k} className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded bg-gray-500/10 px-1.5 py-0.5">
                {s.kind === 'team' ? (
                  <span className="font-medium">@{s.teamName}</span>
                ) : u ? (
                  <>
                    <Avatar user={u} size={14} />
                    <UserName user={u} fallbackId={s.userId} repoId={pr.repoId} />
                  </>
                ) : (
                  <span>@{s.login}</span>
                )}
              </span>
              <span className="text-gray-400">{s.reason}</span>
              {pr.viewerCanPush && (
                <button
                  type="button"
                  onClick={() => assign(s)}
                  disabled={pendingKey !== null || done}
                  className="rounded border border-violet-300 px-1.5 py-0.5 font-medium text-violet-700 hover:bg-violet-50 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/20"
                  title="Request this reviewer on GitHub"
                >
                  {done ? (
                    <>
                      <CheckIcon size={11} className="inline-block align-[-0.1em]" /> Requested
                    </>
                  ) : pendingKey === k ? (
                    'Assigning…'
                  ) : (
                    'Assign'
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {request.isError && (
        <div className="mt-1 text-[11px] text-red-500">
          {(request.error as Error)?.message ?? 'Couldn’t request the reviewer.'}
        </div>
      )}
    </Row>
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
        // The DECLARED width caps the render too (`.md-body img` turns a tag's width/height
        // into max-* bounds), so an image that declares one is drawn smaller than its asset.
        // Measuring natural-only would over-estimate its height and could hide a badge as if
        // it were a screenshot — this stays a natural-DIMENSION measurement, it just applies
        // the same cap the CSS does. `img.width` is 0 before layout, so read the attribute.
        const declaredW = Number(img.getAttribute('width'));
        const capW = Number.isFinite(declaredW) && declaredW > 0
          ? Math.min(img.naturalWidth, declaredW)
          : img.naturalWidth;
        const renderW = width ? Math.min(capW, width) : capW;
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
  onShowBotActivity,
}: {
  pr: PrDetailT;
  usersById: Map<number, User>;
  // Set (by PrDetail) only when this PR has automated-reviewer activity — enables the per-PR
  // bot-behaviour fetch + the "slower than typical" Overview badge that opens the Bot activity tab.
  onShowBotActivity?: () => void;
}): JSX.Element {
  // Suggested reviewers are a LIVE query (not part of the cached detail), so they stay fresh —
  // they empty the instant a reviewer is requested. Merge any CODEOWNERS-resolved users the
  // detail didn't carry into the lookup map so their avatars/links render.
  const { data: sugg } = useSuggestedReviewers(pr.id);
  // The Checks row's fallback branch (red ciStatus, no hydrated checkRuns) has no content
  // without the Pro CI-failure card — see checksRowVisible.
  const prSummary = useProCapabilities().prSummary;
  // Per-PR bot behaviour — only fetched for bot PRs (onShowBotActivity set). Powers the
  // "slower than typical" caution that opens the Bot activity tab.
  const { data: prBots } = usePrBotBehaviour(pr.id, onShowBotActivity != null);
  const slowBots = (prBots?.bots ?? []).filter((b) => b.ttfrAnomaly != null);
  // This account's live auto-merge intent on this PR — a selector over the armed list the app
  // already polls (no new request). While armed the Close button hides: "close without merging"
  // and "merge when ready" are opposite promises, and the armed control's Cancel is the honest
  // first step. Cross-tab the hide can lag the 45s poll; own-tab arms react instantly.
  const armedIntent = usePrArmedIntent(pr.id);
  const suggestions = sugg?.suggestedReviewers ?? [];
  const suggestUsersById =
    (sugg?.users?.length ?? 0) > 0
      ? new Map([...usersById, ...sugg!.users.map((u): [number, User] => [u.id, u])])
      : usersById;

  const ci = CI_META[pr.ciStatus];
  // ITEM 9 — the bug this replaced: this row read `pr.mergeable === 'mergeable'` and rendered
  // a green "mergeable" for any PR without CONFLICTS, including the ~444 open PRs whose
  // required checks were failing (`mergeStateStatus: 'blocked'`). `mergeVerdict` leads with
  // mergeStateStatus, and `reviewDecision` lets a blocked PR say WHICH half of protection is
  // unmet. Only meaningful while the PR is open — a merged/closed PR has no merge verdict.
  const verdict = mergeVerdict({
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
  });
  const showVerdict = pr.state === 'open';
  const checks = pr.checkRuns;
  const counts = checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.state] = (acc[c.state] ?? 0) + 1;
    return acc;
  }, {});

  // Everyone who has SUBMITTED a review (any decisive OR commented state), with
  // their latest review state — the Reviews row. An approval reads as a green ✓
  // badge (REVIEWER_STATE_META.approved), so a separate Approvers row is redundant.
  // pr.reviews is chronological (submittedAt asc), so the last entry per author
  // wins. 'pending' reviews (an in-progress draft, never submitted) aren't a real
  // review, so skip them; insertion order is preserved by the Map so reviewers stay
  // first-seen.
  const latestReviewState = new Map<number, ReviewState>();
  for (const r of pr.reviews) {
    if (r.authorId == null || r.state === 'pending') continue;
    latestReviewState.set(r.authorId, r.state);
  }
  const reviewerIds = [...latestReviewState.keys()];

  // WS2 automated-reviewer provenance, folded per author. A ReviewDetail carries an
  // `automatedKind` when its author is classified automated (vendor / in_house), and 'pierre'
  // (with `provenance`) on a review POSTED via Pierre — note that Pierre review is authored by a
  // human token, so the SAME author can have both a plain human review and a Pierre-stamped one.
  // We therefore track, per author: their automated marker (latest wins) AND whether they ALSO
  // filed a genuine human review. "Only bots reviewed" then means every reviewer is
  // automated-only (has an automated review, no human one).
  const automatedByAuthor = new Map<
    number,
    { kind: AutomatedReviewerKind; provenance: ReviewProvenance | null }
  >();
  const humanReviewAuthors = new Set<number>();
  for (const r of pr.reviews) {
    if (r.authorId == null || r.state === 'pending') continue;
    if (r.automatedKind != null) {
      automatedByAuthor.set(r.authorId, {
        kind: r.automatedKind,
        provenance: r.provenance ?? null,
      });
    } else {
      humanReviewAuthors.add(r.authorId);
    }
  }
  const onlyBotsReviewed =
    reviewerIds.length > 0 &&
    reviewerIds.every((uid) => automatedByAuthor.has(uid) && !humanReviewAuthors.has(uid));

  // Review-BOT thread rollup — "the calm layer above your review bot." Group this PR's
  // threads by the vendor that opened them (originalCommenter → reviewBotKind), counting
  // total + still-unresolved (untouched | replied_unresolved). Drives the "CodeRabbit · 12 ·
  // 3 unresolved" chips; clicking one filters the Threads tab to that vendor's threads.
  //
  // ⚠ KNOWN GAP, recorded rather than closed here: this classifies CLIENT-SIDE BY LOGIN
  // (`botVendorMeta`), so the stored per-WORKSPACE judgement never reaches these chips — a login
  // marked "not a bot" or `quality_check` in this workspace still gets one, and a workspace-local
  // vendor `label` is not shown. ThreadList's bulk-resolve OFFER on the same screen DOES consult
  // the workspace listing (it has to match what the server re-derives), so the two can disagree by
  // design. Closing it means threading the PR's own workspace listing in here — see
  // ThreadList/index.tsx for the shape, and note the workspace must come from the PR's repo
  // (`Repo.workspaceId`), never from the selector.
  const setThreadBotFilter = useFilters((s) => s.setThreadBotFilter);
  const botGroups = (() => {
    const byKind = new Map<ReviewBotKind, { threads: number; unresolved: number }>();
    for (const t of pr.threads) {
      const authorId = t.originalCommenterId ?? t.comments[0]?.authorId ?? null;
      if (authorId == null) continue;
      const meta = botVendorMeta(usersById.get(authorId));
      if (!meta) continue;
      const g = byKind.get(meta.kind) ?? { threads: 0, unresolved: 0 };
      g.threads += 1;
      if (t.derivedState === 'untouched' || t.derivedState === 'replied_unresolved') {
        g.unresolved += 1;
      }
      byKind.set(meta.kind, g);
    }
    return [...byKind.entries()]
      .map(([kind, g]) => ({ kind, ...BOT_VENDOR_META[kind], ...g }))
      .sort((a, b) => b.threads - a.threads);
  })();

  return (
    <>
      {pr.authNotice?.kind === 'saml_sso' && (
        <div className="mx-4 mt-2 rounded-md border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
          <strong className="font-semibold">
            Some data from {pr.authNotice.org} is hidden.
          </strong>{' '}
          Your GitHub sign-in isn&rsquo;t authorized for {pr.authNotice.org}&rsquo;s SAML
          SSO, so the description, CI jobs and comment bodies couldn&rsquo;t be loaded. Fix:{' '}
          <a
            className="underline underline-offset-2"
            href={`https://github.com/orgs/${pr.authNotice.org}/sso`}
            target="_blank"
            rel="noreferrer"
          >
            start an SSO session for {pr.authNotice.org}
          </a>
          , then revoke the app at{' '}
          <a
            className="underline underline-offset-2"
            href="https://github.com/settings/applications"
            target="_blank"
            rel="noreferrer"
          >
            Authorized OAuth Apps
          </a>{' '}
          and sign in again. (If GitHub only offers &ldquo;Request&rdquo;, an org owner must
          approve the app.)
        </div>
      )}
      <div className="divide-y divide-gray-100 py-1 dark:divide-gray-800">
        {/* Status = CI + mergeability on one row (the two are one "can this ship?" fact). */}
        <Row label="Status">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {ci ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: ci.color }}
                />
                {/* The rollup label opens the PR's OWN Checks tab — ALWAYS that page, never a
                    derived Actions run id. A PR that triggers several workflows has several
                    simultaneously-latest runs, so deep-linking one presents an arbitrary pick as
                    "the" answer; the Checks tab always exists, always shows this exact set, and
                    works for third-party CI that has no Actions run at all. (Per-check deep links
                    still live one row down, in CheckList's `checkHref`.)
                    ⚠ Deliberately INSIDE the `{ci ? …}` branch: `CI_META['unknown']` is null, and
                    "GitHub told us nothing" is not evidence a run exists — the "no checks" branch
                    below must stay unlinked. Wrapping the label rather than the row also keeps the
                    merge verdict and its `|` separator out of the anchor.
                    `pr.githubUrl` is OUR value (built server-side from owner/name/number), not
                    vendor-supplied, so it needs no safeExternalUrl — same as `${pr.githubUrl}/files`
                    in ChangesTab. Styled like CheckList's in-row name anchor: inherited colour +
                    hover underline, with the external-link mark carrying the affordance. */}
                <a
                  href={`${pr.githubUrl}/checks`}
                  target="_blank"
                  rel="noreferrer noopener"
                  title="Open this pull request's Checks tab on GitHub"
                  className="inline-flex items-center gap-1 hover:underline"
                >
                  {ci.label}
                  <ExternalLinkIcon
                    size={11}
                    className="inline-block align-[-0.1em] text-gray-400"
                  />
                </a>
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
              <span className="text-gray-400">no checks</span>
            )}
            {showVerdict && (
              <>
                <span className="text-gray-300 dark:text-gray-600" aria-hidden>
                  |
                </span>
                <span
                  className={`font-medium ${MERGE_TONE_CLASS[verdict.tone]}`}
                  title={verdict.detail ?? undefined}
                >
                  {(verdict.tone === 'bad' || verdict.tone === 'warn') && (
                    <WarningIcon size={12} className="mr-1 inline-block align-[-0.1em]" />
                  )}
                  {verdict.label}
                </span>
                {verdict.detail && (
                  <span className="text-xs text-gray-400">· {verdict.detail}</span>
                )}
              </>
            )}
          </div>
        </Row>

        {/* Reviews = everyone who reviewed, with their latest-state badge (approvals already
            read as a green ✓), plus the "only bots reviewed" coverage chip. */}
      {reviewerIds.length > 0 && (
        <Row label="Reviews">
          <div className="flex flex-wrap gap-2 text-xs">
            {reviewerIds.map((uid) => {
              const u = usersById.get(uid);
              const meta = REVIEWER_STATE_META[latestReviewState.get(uid)!];
              const auto = automatedByAuthor.get(uid);
              return (
                <span
                  key={uid}
                  className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${meta.cls}`}
                  title={meta.title}
                >
                  {meta.icon}
                  <Avatar user={u} size={14} />
                  <UserName user={u} fallbackId={uid} repoId={pr.repoId} />
                  {auto && (
                    <AutomatedReviewerBadge kind={auto.kind} provenance={auto.provenance} />
                  )}
                </span>
              );
            })}
            {onlyBotsReviewed && (
              <span
                data-testid="only-bots-reviewed"
                className="inline-flex items-center gap-1 rounded bg-amber-400/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300"
                title="Every review on this PR came from an automated reviewer — no human has reviewed it yet."
              >
                <BotIcon size={12} />
                only bots reviewed
              </span>
            )}
          </div>
        </Row>
      )}

      {botGroups.length > 0 && (
        <Row label="Bots">
          <div className="flex flex-wrap gap-2 text-xs">
            {botGroups.map((g) => (
              <button
                key={g.kind}
                type="button"
                onClick={() => setThreadBotFilter(g.kind)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium transition-opacity hover:opacity-80"
                style={{ color: g.color, background: `${g.color}1a` }}
                title={`${g.label} opened ${g.threads} review thread${
                  g.threads === 1 ? '' : 's'
                } on this PR${
                  g.unresolved > 0 ? ` · ${g.unresolved} still need a look` : ' · all acted on'
                } — click to filter the Threads tab`}
              >
                <BotIcon size={12} />
                {g.label}
                <span className="tabular-nums opacity-70">· {g.threads}</span>
                {g.unresolved > 0 && (
                  <span className="tabular-nums font-semibold">· {g.unresolved} unresolved</span>
                )}
              </button>
            ))}
          </div>
        </Row>
      )}

      {/* "Slower than typical" caution — a bot took anomalously longer to first-review THIS PR
          than its own baseline. Opens the Bot activity tab for the evidence + timeline. */}
      {slowBots.length > 0 && onShowBotActivity && (
        <Row label="Bot activity">
          <button
            type="button"
            onClick={onShowBotActivity}
            className="inline-flex items-center gap-1 rounded bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600 transition-opacity hover:opacity-80 dark:text-red-400"
            title={slowBots
              .map((b) => `${b.label}: slower than its typical on this PR`)
              .join(' · ')}
          >
            <WarningIcon size={12} />
            {slowBots.length === 1
              ? `${slowBots[0]!.label} slower than typical`
              : `${slowBots.length} bots slower than typical`}
            <span className="opacity-70">— view</span>
          </button>
        </Row>
      )}

      {/* Actions = every viewer write action on the PR in one row: approve, merge (push + open +
          non-draft), arm "merge when ready" (same gate; its own eligibility inside) and
          close-without-merging (push OR author + open, HIDDEN while an auto-merge is armed).
          Each control expands in place; the approvers themselves read from the green ✓ badges
          in the Reviews row above. The Pro "check addressed" run used to sit here too — it is
          now folded into the single "Check review" bar above the tabs, which covers the same
          threads and comments in one combined call per target, so leaving both would let a
          user pay twice for one judgement. */}
      {(pr.viewerCanApprove ||
        (pr.viewerCanPush && pr.state === 'open' && !pr.isDraft) ||
        (pr.viewerCanClose && pr.state === 'open' && armedIntent == null)) && (
        <Row label="Actions">
          <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
            {pr.viewerCanApprove && (
              <ApproveControl prId={pr.id} alreadyApproved={pr.viewerHasApprovedStanding} />
            )}
            {pr.viewerCanPush && pr.state === 'open' && !pr.isDraft && (
              <>
                <MergeControl prId={pr.id} githubUrl={pr.githubUrl} />
                <MergeWhenReadyControl prId={pr.id} />
              </>
            )}
            {pr.viewerCanClose && pr.state === 'open' && armedIntent == null && (
              <ClosePrControl prId={pr.id} />
            )}
          </div>
        </Row>
      )}

      {pr.mergedById != null && (
        <Row label="Merged by">
          <div className="text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Avatar user={usersById.get(pr.mergedById)} size={14} />
              <UserName
                user={usersById.get(pr.mergedById)}
                fallbackId={pr.mergedById}
                repoId={pr.repoId}
              />
            </span>
            {pr.mergedAt != null && (
              // The exact merge moment — date AND time of day — on its own line under the
              // merger (`dateTime` carries the time; the title repeats it for hover parity).
              <div className="mt-0.5 text-gray-400" title={dateTime(pr.mergedAt)}>
                {dateTime(pr.mergedAt)}
              </div>
            )}
          </div>
        </Row>
      )}

      {/* Jira/Linear ticket links (Pro, compute-on-read). tri-state: null → hidden; [] → a muted
          "No ticket found"; non-empty → one link chip per detected ticket. */}
      {pr.tickets != null && (
        <Row label="Ticket">
          {pr.tickets.length === 0 ? (
            <span className="text-xs text-gray-400">No ticket found</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {pr.tickets.map((t) => (
                <a
                  key={t.key}
                  href={safeExternalUrl(t.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-700 hover:bg-sky-100 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-300"
                  title={`Open ${t.key} in ${t.provider === 'jira' ? 'Jira' : 'Linear'}`}
                >
                  {t.key}
                </a>
              ))}
            </div>
          )}
        </Row>
      )}

      {pr.body != null && pr.body.trim() !== '' && <PrSummary body={pr.body} />}

      <AiSummary pr={pr} />

      {/* The Checks row also carries the CI-failure diagnosis ("Why did CI fail?"), directly
          under the checks list + re-run control — the same ordering the AI Fix tab's CI-status
          section uses. The card self-gates (prSummary capability) and presence-gates (renders
          NOTHING unless something is red or an analysis is already stored), so a green PR is
          unchanged. `showFix={false}`: the agentic fixer's progress UI lives on the AI Fix tab.

          The row gate is widened past `checks.length > 0` so a PR whose ciStatus is red but
          whose checkRuns did not hydrate (the lean-storage / SAML-SSO case handled at the
          authNotice above) can still reach a STORED diagnosis; the list + re-run control stay
          inner-gated on there actually being checks to render. The widened branch is ALSO gated
          on the capability (see checksRowVisible) — the card is its only possible content, and
          without prSummary it renders null, leaving an empty labelled row. */}
      {checksRowVisible(checks.length, pr.ciStatus, prSummary) && (
        <Row label="Checks">
          {checks.length > 0 && (
            <>
              <ChecksList prId={pr.id} prGithubUrl={pr.githubUrl} checks={checks} />
              <CiRerunControl
                prId={pr.id}
                checks={checks}
                viewerCanPush={pr.viewerCanPush}
              />
            </>
          )}
          <CiAnalysisCard pr={pr} showFix={false} />
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

      {suggestions.length > 0 && (
        <SuggestedReviewersRow pr={pr} suggestions={suggestions} usersById={suggestUsersById} />
      )}

      <Row label="Meta">
        <div className="space-y-0.5 text-xs text-gray-500">
          <div>{pr.repoFullName}</div>
          <div>opened {relativeTime(pr.openedAt)}</div>
          <div>updated {relativeTime(pr.updatedAt)}</div>
        </div>
      </Row>
      </div>
    </>
  );
}
