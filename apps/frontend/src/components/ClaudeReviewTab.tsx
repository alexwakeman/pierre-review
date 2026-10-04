import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeFindingSide,
  ClaudeReview,
  ClaudeReviewModel,
  ClaudeReviewStatusResponse,
  ClaudeReviewVerdict,
  PostReviewPreview,
  PostReviewResult,
  PrDetail,
  PrFilesResponse,
  ReviewMode,
  User,
} from '@pierre-review/shared';
import {
  CLAUDE_FINDING_LENS_LABELS,
  CLAUDE_REVIEW_MODELS,
  CLAUDE_REVIEW_MODEL_LABELS,
  DEFAULT_CLAUDE_REVIEW_MODEL,
  followUpSentence,
} from '@pierre-review/shared';
import { formatDate, formatUsd, safeExternalUrl } from '../lib/ui.js';
import { unlockReviewSound } from '../lib/sound.js';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { AiCloudNote, AiRunGate } from './AiSetup.js';
import { useFilters } from '../store/filters.js';
import {
  useCancelReview,
  useClaudeReview,
  useClaudeReviewById,
  useClaudeReviewStream,
  useClaudeReviewStarting,
  useGenerateReview,
  isAutoReviewHoldError,
  usePostFinding,
  usePostReview,
  useUpdateFinding,
  useUpdateReview,
} from '../hooks/useClaudeReview.js';
import { highlightBlock, languageForPath } from '../lib/hljsLines.js';
import { hunkLineMarker, useHunkHighlight } from './DiffHunk.js';
import { writeClipboard } from './CopyButton.js';
import { Markdown } from './Markdown.js';
import { MentionTextarea } from './MentionTextarea.js';
import { ReviewChatSection } from './ClaudeReviewChat.js';
import { InfoButton } from './InfoModal.js';
import {
  ArrowIcon,
  CheckIcon,
  ChevronIcon,
  ExternalLinkIcon,
  PencilIcon,
  RefreshIcon,
  WarningIcon,
} from './Icons.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';
import { AUTO_REVIEW_LABEL } from './Activity/pendingLabels.js';
import { ClaudeReviewFollowUpSection } from './ClaudeReviewFollowUp.js';
import { ClaudeReviewThreadsSection } from './ClaudeReviewThreads.js';
import { AUTO_REVIEW_WAITING_LABEL, autoFixOutcomeLine } from '../lib/claudeAutoReview.js';
import { ClaudeReviewCiFailuresSection, ClaudeReviewCiStatus } from './ClaudeReviewCiFailures.js';
import { ReviewSection, SectionCount } from './ReviewSection.js';
import { PrRefText, ReviewPrRefsProvider } from './ReviewPrRefs.js';
import { REVIEW_ITEM_CARD, REVIEW_ITEM_TITLE, REVIEW_META } from '../lib/reviewStyles.js';
import { reviewTexts, type KnownPr } from '../lib/reviewPrRefs.js';
import { TicketCoverageSection, type LegacyStories } from './TicketCoverage.js';
import { useTicketReviews } from '../hooks/useTicketReview.js';
import { useClaudeReviewChat } from '../hooks/useClaudeReviewChat.js';
import { legacyOnlyEntries } from '../lib/ticketStory.js';
import { reviewCurrency, type ReviewCurrency } from '../lib/claudeReviewColumn.js';
import {
  ALREADY_POSTED_CHIP,
  RERAISED_CHIP,
  SEVERITY_CLASS,
  alreadyPostedReraiseIds,
  reraisedStatusByFindingId,
  sortFindingsForDisplay,
  placeStoryFindings,
  storyChipLabel,
  VERDICT_CLASS,
  type ReraisedStatus,
} from '../lib/claudeReviewFollowUp.js';

// "Show this finding in the Changes tab" — supplied by PrDetail, which owns the tab state.
// Optional everywhere below so the tab still renders (link-only, as before) if it is ever
// mounted somewhere that can't switch tabs.
export type OpenInChanges = (
  path: string,
  line: number | null,
  side: ClaudeFindingSide,
) => void;

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

// The resolved review mode (what actually ran). Depth is the router's call, never the reader's.
const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  skip: 'Skipped',
  diff_only: 'Quick',
  worktree: 'Deep',
};

const VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

function VerdictBadge({ verdict }: { verdict: ClaudeReviewVerdict }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${VERDICT_CLASS[verdict]}`}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

// Severity ordering for the flat findings list, plus per-severity pill colours.
const SEVERITY_ORDER: ClaudeFindingSeverity[] = [
  'blocker',
  'warning',
  'nit',
  'question',
  'praise',
];

// The rank + pill palette live in lib/claudeReviewFollowUp.ts, shared with the previous-review
// list so an earlier comment's severity paints the same pill as a current finding's.

// "abc1234 · Claude Opus 5.5 · US$0.42". A retired model id prints raw.
function metaLine(review: ClaudeReview): string {
  const label = (CLAUDE_REVIEW_MODEL_LABELS as Record<string, string>)[review.model] ?? review.model;
  const parts: string[] = [shortSha(review.headSha), label];
  if (review.costUsd != null) parts.push(formatUsd(review.costUsd));
  return parts.join(' · ');
}

// The reviewed commit against the PR's synced head — the ONE helper the Open PRs card reads too.
// The server's `head` reading wins; an older server (no `head`) falls back to the PR's head.
function currencyOf(review: ClaudeReview, prHeadSha: string | null): ReviewCurrency | null {
  return reviewCurrency({
    reviewedHeadSha: review.headSha,
    currentHeadSha: review.head?.currentHeadSha ?? prHeadSha,
    commitsSince: review.head?.commitsSince ?? null,
  });
}

// The header pill: green "On latest commit · abc1234", or amber "2 newer commits" / "Branch changed".
function CurrencyPill({ currency }: { currency: ReviewCurrency }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${currency.className}`}
      title={currency.title}
    >
      {currency.tone === 'current' ? <CheckIcon size={12} /> : <WarningIcon size={12} />}
      {currency.label}
      {currency.tone === 'current' && <span className="font-mono">· {currency.sha}</span>}
    </span>
  );
}

const PHASE_LABEL: Record<string, string> = {
  cloning: 'Cloning the worktree',
  fetching_diff: 'Fetching the diff',
  deciding: 'Deciding scope',
  reviewing: 'Reviewing',
  persisting: 'Saving findings',
};

// Map the live run status to a determinate 0–100 reading for the progress bar. The
// discrete phases are honest checkpoints; 'reviewing' is the long tail, so it eases
// from its base toward 90% as the agent's activity log grows (real motion, not a
// timer guess). Returns null → the bar falls back to its indeterminate easing.
function reviewProgressPct(
  status: ClaudeReviewStatusResponse | null,
): number | null {
  if (status == null) return null;
  if (status.status === 'queued') return 5;
  const phase = status.progress?.phase;
  if (phase == null) return 8; // running, first phase not yet reported
  switch (phase) {
    case 'fetching_diff':
      return 15;
    case 'deciding':
      return 28;
    case 'cloning':
      return 42;
    case 'reviewing': {
      const n = status.progress?.recentActivity?.length ?? 0;
      return Math.min(90, 55 + n * 3);
    }
    case 'persisting':
      return 95;
    default:
      return null;
  }
}

// Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M".
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Token/cost breakdown for a finished run — the SAME shape as the live readout, so
// the running tally visibly settles into the final figures. Surfaces the cache
// split (read vs write), the hidden driver of a multi-turn run's cost. Renders
// nothing for a 'skip' run / older rows with no token data.
function UsageBreakdown({ review }: { review: ClaudeReview }): JSX.Element | null {
  const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } =
    review;
  const total =
    (inputTokens ?? 0) +
    (outputTokens ?? 0) +
    (cacheReadTokens ?? 0) +
    (cacheCreationTokens ?? 0);
  if (total <= 0) return null;

  // The mark and the words are SEPARATE fields. `label` stays a plain string (so any
  // future consumer that concatenates it still can), and the pictograph is an icon that
  // inherits the row's colour instead of an arrow glyph at whatever advance width the
  // platform font picked.
  const items: {
    key: string;
    icon: JSX.Element;
    label: string;
    value: number;
    title: string;
  }[] = [];
  if (outputTokens != null)
    items.push({
      key: 'out',
      icon: <ArrowIcon dir="down" size={11} />,
      label: 'out',
      value: outputTokens,
      title: 'Output tokens generated (billed at the output rate — the priciest per token)',
    });
  if (inputTokens != null)
    items.push({
      key: 'in',
      icon: <ArrowIcon dir="up" size={11} />,
      label: 'in',
      value: inputTokens,
      title: 'New (uncached) input tokens',
    });
  if (cacheReadTokens != null)
    items.push({
      key: 'cr',
      icon: <RefreshIcon size={11} />,
      label: 'cache read',
      value: cacheReadTokens,
      title:
        'Cached input tokens re-read each turn — billed at ~10% of the input rate, but the volume driver of a multi-turn run',
    });
  if (cacheCreationTokens != null)
    items.push({
      key: 'cw',
      icon: <PencilIcon size={11} />,
      label: 'cache write',
      value: cacheCreationTokens,
      title: 'Tokens written to the prompt cache (billed at ~1.25× the input rate)',
    });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
      {items.map((it) => (
        <span
          key={it.key}
          title={it.title}
          className="inline-flex items-center gap-1"
        >
          {it.icon}
          <span>
            {it.label} {fmtTokens(it.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

// Live activity feed shown under the running spinner — the agent's rolling log
// (newest-last). Auto-scrolls to the bottom as new lines stream in. Renders
// nothing when there are no lines.
function ActivityLog({ lines }: { lines: string[] }): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el != null) el.scrollTop = el.scrollHeight;
  }, [lines]);
  if (lines.length === 0) return null;
  return (
    <div
      ref={ref}
      className="mt-2 max-h-32 overflow-y-auto rounded border border-gray-100 bg-gray-50 px-2 py-1.5 font-mono text-[11px] leading-snug text-gray-500 dark:border-gray-800 dark:bg-gray-900/60 dark:text-gray-400"
    >
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">
          {l === '' ? ' ' : l}
        </div>
      ))}
    </div>
  );
}

// Per-line colour for a rendered diff hunk.
// ⚠ `highlighted` DROPS THE ADD/DEL INK. On a syntax-coloured row the green/red text colour and
// the token colours fight over the same characters; the leading +/- still says which side the line
// is on. The `@@` header and context rows keep theirs — neither is an add/del claim.
function hunkLineClass(line: string, highlighted = false): string {
  if (line.startsWith('@@')) return 'font-medium text-gray-600 dark:text-gray-300';
  if (line.startsWith('+')) return highlighted ? '' : 'text-green-700 dark:text-green-400';
  if (line.startsWith('-')) return highlighted ? '' : 'text-red-700 dark:text-red-400';
  return 'text-gray-500 dark:text-gray-400';
}

// Shared action-button styles for the per-finding control bar so Post / Reword /
// Copy / Ignore line up consistently. Primary = blue (Post / Reword / Un-ignore);
// secondary = neutral grey (Copy / Ignore / Show).
const BTN_PRIMARY =
  'whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30';
const BTN_SECONDARY =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

// The diff hunk a finding covers, COLLAPSED by default. Clicking the collapsed
// preview expands it (a convenience); the expanded hunk collapses via the dedicated
// "Hide" control or its @@ header line — never via a code line, so clicking the code
// to read/select it doesn't fold it away. State is local + transient — it never
// persists across reloads.
function FindingHunk({ hunk, path }: { hunk: string; path?: string | null }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // The whole hunk in one two-pass run, index-aligned with `lines` — never the preview line on
  // its own, which is the forbidden mid-file lexer start (`hljsLines.ts`'s header).
  const html = useHunkHighlight(hunk, path);
  const lines = hunk.replace(/\n$/, '').split('\n');
  // Prefer the @@ header for the collapsed preview; else the anchor (last) line. Tracked by INDEX
  // as well, so the preview can take its own highlighted entry rather than a second lexer pass.
  const headerIdx = lines.findIndex((l) => l.startsWith('@@'));
  const previewIdx = headerIdx >= 0 ? headerIdx : lines.length - 1;
  const preview = lines[previewIdx] ?? '';
  const previewHtml = html?.[previewIdx] ?? null;
  // The header only doubles as a collapse target when it really IS the first line;
  // a truncated hunk opens on real code, which stays plain, selectable text.
  const headerCollapses = lines[0]?.startsWith('@@') === true;

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-expanded={false}
        title="Show the code hunk"
        className="mt-1 flex w-full items-center gap-2 overflow-hidden rounded bg-gray-50 px-2 py-1.5 text-left font-mono text-xs dark:bg-gray-900/60"
      >
        <ChevronIcon dir="right" className="shrink-0 text-gray-400" />
        <span className={`min-w-0 flex-1 truncate ${hunkLineClass(preview, previewHtml != null)}`}>
          {previewHtml != null ? (
            <>
              {/* The marker is diff notation, not code, so it prints plain.
                  ⚠ ONLY highlight.js OUTPUT REACHES `dangerouslySetInnerHTML`. */}
              {hunkLineMarker(preview)}
              <span className="code-hl" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </>
          ) : preview === '' ? (
            ' '
          ) : (
            preview
          )}
        </span>
        {lines.length > 1 && (
          <span className="shrink-0 font-sans text-[11px] text-gray-500 dark:text-gray-400">
            {lines.length} lines
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="mt-1 rounded bg-gray-50 dark:bg-gray-900/60">
      <pre className="overflow-x-auto px-2 py-1.5 font-mono text-xs leading-snug">
        {lines.map((l, i) =>
          i === 0 && headerCollapses ? (
            <button
              key={i}
              type="button"
              onClick={() => {
                // A click that ENDED a drag-select is the reader copying the
                // header, not asking to fold the hunk away.
                if (window.getSelection()?.isCollapsed === false) return;
                setExpanded(false);
              }}
              aria-expanded={true}
              aria-label="Hide code"
              title="Hide code"
              className={`block w-full whitespace-pre text-left hover:bg-gray-200/70 dark:hover:bg-gray-800/70 ${hunkLineClass(l)}`}
            >
              {l === '' ? ' ' : l}
            </button>
          ) : (
            <div key={i} className={hunkLineClass(l, html?.[i] != null)}>
              {html?.[i] != null ? (
                <>
                  {hunkLineMarker(l)}
                  <span
                    className="code-hl"
                    dangerouslySetInnerHTML={{ __html: html[i]! }}
                  />
                </>
              ) : l === '' ? (
                ' '
              ) : (
                l
              )}
            </div>
          ),
        )}
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        aria-expanded={true}
        className="inline-flex items-center gap-1 px-2 pb-1.5 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      >
        <ChevronIcon dir="up" size={11} />
        Hide code
      </button>
    </div>
  );
}

// Claude's replacement code for the finding's line(s) — a whole blob, not a diff, so it goes
// through `highlightBlock` rather than the per-row path. ⚠ ONLY highlight.js OUTPUT REACHES
// `dangerouslySetInnerHTML`; a null (unlisted extension, past the line gate, lexer threw) renders
// the suggestion as plain text, which is what it was before.
function SuggestionBlock({
  suggestion,
  path,
}: {
  suggestion: string;
  path?: string | null;
}): JSX.Element {
  const html = useMemo(
    () => (path == null || path === '' ? null : highlightBlock(suggestion, languageForPath(path))),
    [suggestion, path],
  );
  return (
    <pre className="mt-1 overflow-x-auto rounded bg-gray-100 px-2 py-1.5 font-mono text-xs dark:bg-gray-800">
      {html != null ? (
        <code className="code-hl" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <code>{suggestion}</code>
      )}
    </pre>
  );
}

// One finding row: severity pill, title, a code anchor that links to the line on
// GitHub, the (collapsible) diff hunk it covers, Claude's body, an optional
// suggestion, and a single control bar — Post as comment / Reword / Copy / Ignore.
// Findings are INCLUDED by default; "Ignore" sets one aside (collapsed + faded,
// excluded from a submitted review) and it can be re-expanded and un-ignored.
function FindingRow({
  prId,
  finding,
  editable,
  prUrl,
  repoFullName,
  headSha,
  posting,
  postError,
  inChangeset,
  priorStatus,
  alreadyPosted = false,
  storyLabel = null,
  onOpenInChanges,
  onToggle,
  onReword,
  onPostComment,
}: {
  prId: number;
  finding: ClaudeFinding;
  editable: boolean;
  prUrl: string;
  // "owner/name" — for building a blob permalink to the finding's line.
  repoFullName: string;
  // The reviewed head SHA (run's headSha, falling back to the PR head). Pins the
  // blob link so the line number stays correct. null ⇒ no blob link.
  headSha: string | null;
  posting: boolean;
  postError: string | null;
  // This finding's file is part of the PR's changeset, so the Changes tab has something to
  // show. false ⇒ nothing local to reveal, keep the GitHub link (a deep review reads files
  // the PR never touched).
  inChangeset: boolean;
  // Set when this finding raises a comment from the previous review again: what became of that
  // comment (only the two still-open statuses get a chip).
  priorStatus?: ReraisedStatus;
  // It repeats an earlier comment already posted on this same commit (the server saved it
  // ignored, so Post review does not put it on GitHub twice). The chip says why.
  alreadyPosted?: boolean;
  // A STORY FINDING (made by the server from the user-story check): the chip naming its story item,
  // e.g. "BMD-1040 · AC2" (`storyChipLabel`). null ⇒ an ordinary finding. Nothing else about the
  // card differs: it posts, rewords and ignores like any finding.
  storyLabel?: string | null;
  onOpenInChanges?: OpenInChanges;
  onToggle: (included: boolean) => void;
  onReword: (editedBody: string) => Promise<unknown>;
  onPostComment: () => Promise<unknown>;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current != null) clearTimeout(copyTimer.current);
    },
    [],
  );

  // Reword editor — an empty (or seeded) markdown textarea the user can open.
  const [rewording, setRewording] = useState(false);
  const [draft, setDraft] = useState(finding.editedBody ?? '');
  useEffect(() => {
    if (!rewording) setDraft(finding.editedBody ?? '');
  }, [finding.editedBody, rewording]);

  const hasReword =
    finding.editedBody != null && finding.editedBody.trim() !== '';
  // A reword the user has typed but not yet saved (editor still open) takes
  // priority — posting uses it (Copy never does: it copies Claude's original).
  const pendingReword =
    rewording && draft.trim() !== '' && draft !== (finding.editedBody ?? '')
      ? draft
      : null;

  const anchorLabel =
    finding.line != null ? `${finding.path}:${finding.line}` : finding.path;
  // No file at all (a story finding about the whole change): it posts as a PR comment and has no
  // code anchor to show.
  const noFile = finding.path === '';
  // Posted singly, or inside a submitted review. ⚠ A POSTED FINDING IS DONE: no Post again, no
  // Reword, no Ignore — only its link (and Copy).
  const isPosted = finding.postedAt != null;
  // Permalink depends on HOW it was posted: a PR-level issue comment anchors as
  // #issuecomment-<id>, an inline review comment as #discussion_r<id>.
  const commentUrl =
    finding.githubCommentId != null
      ? finding.postedCommentKind === 'pr_comment'
        ? `${prUrl}#issuecomment-${finding.githubCommentId}`
        : `${prUrl}#discussion_r${finding.githubCommentId}`
      : null;

  // The PR "Files changed" diff anchor — lands ON the finding's line, in review
  // context (the +/- diff, with the comment affordance). GitHub anchors a diff
  // line by `diff-<sha256(path)>` + side (`R` new / `L` old) + line number; this
  // is the same scheme GitHub itself emits and (empirically) it scrolls to and
  // highlights the right line. For a deep file GitHub lazily hydrates the diff and
  // late-scrolls, so the page briefly sits at the top then jumps to the line — a
  // cosmetic GitHub-side delay we can't control, but it resolves correctly. When
  // the finding has no line we fall back to the file-level anchor (file header).
  const diffLineHref =
    finding.line != null
      ? `${prUrl}/files#diff-${finding.diffAnchorId}${finding.side === 'LEFT' ? 'L' : 'R'}${finding.line}`
      : `${prUrl}/files#diff-${finding.diffAnchorId}`;

  // A blob permalink at the reviewed head SHA: non-virtualized, so #L<line> is
  // honoured instantly with no jump — but it shows the file, not the diff. We keep
  // it only as a SECONDARY "view file" escape hatch for the cases the PR diff
  // can't serve: a file collapsed under "Large diffs are not rendered", or an
  // outdated finding. RIGHT-side only (the left/base side isn't in the head blob).
  const blobHref =
    headSha != null && finding.line != null && finding.side === 'RIGHT'
      ? `https://github.com/${repoFullName}/blob/${headSha}/${finding.path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}#L${finding.line}`
      : null;

  // THE CODE ANCHOR IS AN IN-APP JUMP whenever the finding's file is in this PR's
  // changeset: the path reveals the file (and, when it has one, the line) in the Changes
  // tab, where the diff, the inline threads and the comment affordances already are.
  // GitHub is still one click away — see `diffLineHref` below, kept as a small secondary
  // link — but it is no longer the only way to look at the code a finding is about.
  const canJumpInApp = inChangeset && onOpenInChanges != null;
  // Fallback primary link, in reliability + usefulness order, unchanged from before:
  //   1. posted comment permalink (most reliable, already in PR context)
  //   2. the PR diff line anchor (in-review context — the useful default)
  const primaryHref = commentUrl ?? diffLineHref;
  // Secondary "view file" escape hatch (blob at head) — only when we didn't link a
  // posted comment and a RIGHT-side blob link is available.
  const secondaryBlobHref = commentUrl == null ? blobHref : null;
  // Posting is offered for every finding on the editable run. Unanchored findings
  // (their own line isn't in the diff) still post inline — the server re-anchors
  // them onto the file's first change. Only a finding whose file isn't in the diff
  // can't post, and that surfaces as an error on the attempt.
  const canPostComment = editable && !isPosted;

  // Copy is CLAUDE'S ORIGINAL COMMENT, as its markdown SOURCE — never the reader's reword
  // (that is theirs, already in their own editor), and never the rendered DOM, so fences,
  // lists and links paste intact. The title goes in bold so the whole paste stays markdown.
  const copy = (): void => {
    let text = finding.body.trim() !== '' ? `**${finding.title}**\n\n${finding.body}` : `**${finding.title}**`;
    if (finding.suggestion != null && finding.suggestion.trim() !== '') {
      text += `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
    }
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copyTimer.current != null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  const saveReword = (): void => {
    void onReword(draft).catch(() => {});
    setRewording(false);
  };
  const clearReword = (): void => {
    void onReword('').catch(() => {});
    setDraft('');
    setRewording(false);
  };

  // Post this finding as a single comment. The server auto-routes the destination
  // (inline on the line / first change, or a PR-level comment when the file is
  // outside the diff). If the user typed a reword that isn't saved yet, persist it
  // FIRST — the server reads editedBody from the DB, so without this it would post
  // Claude's text instead of the user's words.
  const [working, setWorking] = useState(false);
  const handlePost = async (): Promise<void> => {
    setWorking(true);
    try {
      if (pendingReword != null) {
        await onReword(pendingReword);
        setRewording(false);
      }
      await onPostComment();
    } catch {
      /* surfaced via the postError prop */
    } finally {
      setWorking(false);
    }
  };
  const busy = posting || working;
  // Where this finding will post: a PR-level comment when its file is outside the PR
  // diff (can't anchor inline), otherwise an inline review comment (on its own line,
  // or — when unanchored but the file IS in the diff — the file's first change).
  const postsAsPrComment = !finding.anchored && !finding.fileInDiff;

  // Ignore = exclude from the submitted review. Offered for every finding on the
  // editable run — including unanchored ones, which now post inline on the file's
  // first change, so the user needs a way to opt them out. An ignored finding
  // collapses + fades but can be re-expanded for a look, then un-ignored
  // (re-included). `included` defaults true, so a finding is normal until ignored.
  const canIgnore = editable && !isPosted;
  const ignored = canIgnore && !finding.included;
  const [ignoredExpanded, setIgnoredExpanded] = useState(false);
  const detailsHidden = ignored && !ignoredExpanded;

  return (
    <li
      // The previous-review list's "Raised again below" scrolls to this id.
      id={`claude-finding-${finding.id}`}
      className={`${REVIEW_ITEM_CARD} ${ignored ? 'opacity-50' : ''}`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-semibold capitalize ${SEVERITY_CLASS[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={REVIEW_ITEM_TITLE}>
              <PrRefText text={finding.title} />
            </span>
            {finding.lens != null && (
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                {CLAUDE_FINDING_LENS_LABELS[finding.lens]}
              </span>
            )}
            {storyLabel != null && (
              <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[11px] text-sky-700 dark:text-sky-300">
                {storyLabel}
              </span>
            )}
            {priorStatus != null && (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${RERAISED_CHIP[priorStatus].cls}`}
                title="Raised in the previous review"
              >
                {RERAISED_CHIP[priorStatus].label}
              </span>
            )}
            {alreadyPosted && (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${ALREADY_POSTED_CHIP.cls}`}
                title={ALREADY_POSTED_CHIP.title}
              >
                {ALREADY_POSTED_CHIP.label}
              </span>
            )}
            {isPosted &&
              (commentUrl != null ? (
                <a
                  href={safeExternalUrl(commentUrl)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[11px] text-green-700 hover:underline dark:text-green-400"
                  title="View this comment on GitHub"
                >
                  Posted
                  <CheckIcon size={11} />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[11px] text-green-700 dark:text-green-400">
                  Posted
                  <CheckIcon size={11} />
                </span>
              ))}
            {hasReword && !isPosted && (
              <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[11px] text-blue-600 dark:text-blue-400">
                Your wording
              </span>
            )}
            {!finding.anchored && !isPosted &&
              (noFile ? (
                <span
                  className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300"
                  title="Posts as a PR comment"
                >
                  PR comment
                </span>
              ) : finding.fileInDiff ? (
                <span
                  className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300"
                  title="Posts on the file's first change"
                >
                  Line not in diff
                </span>
              ) : (
                <span
                  className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                  title="Posts as a PR comment"
                >
                  File not in diff
                </span>
              ))}
            {ignored && (
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[11px] text-gray-600 dark:text-gray-300">
                Ignored
              </span>
            )}
          </div>

          {/* Detail (anchor / hunk / body / suggestion / reword). Hidden while an
              ignored finding is collapsed; the action bar can re-expand it. */}
          {!detailsHidden && (
          <>
          {/* Code anchor → reveals this finding's file/line in the Changes tab when the
              file is in the PR's changeset, else (as before) opens it on GitHub. The small
              ↗ beside it always exits to the PR diff line on GitHub — today's behaviour,
              kept as an explicit, visually secondary escape. A third "view file" link goes
              to the blob at the reviewed commit for collapsed/outdated diffs. */}
          {!noFile && (
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs">
            {canJumpInApp ? (
              <>
                {/* A BUTTON, not an <a href="#…">: a hash navigation would write to the URL
                    that useUrlState owns and serializes. */}
                <button
                  type="button"
                  onClick={() =>
                    onOpenInChanges(finding.path, finding.line, finding.side)
                  }
                  className="text-left text-blue-600 hover:underline dark:text-blue-400"
                  title={
                    finding.line != null
                      ? 'Show this line in the Changes tab'
                      : 'Show this file in the Changes tab'
                  }
                >
                  {anchorLabel}
                </button>
                <a
                  href={diffLineHref}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={
                    finding.line != null
                      ? `Open ${finding.path} line ${finding.line} in the PR diff on GitHub`
                      : `Open ${finding.path} in the PR diff on GitHub`
                  }
                  title="Open this line in the PR diff on GitHub"
                  className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  <ExternalLinkIcon size={11} />
                </a>
              </>
            ) : (
              <a
                href={primaryHref}
                target="_blank"
                rel="noreferrer noopener"
                className="text-blue-600 hover:underline dark:text-blue-400"
                title={
                  commentUrl != null
                    ? 'Open this posted comment on GitHub'
                    : finding.line != null
                      ? 'Open this line in the PR diff on GitHub'
                      : 'Open this file in the PR diff on GitHub'
                }
              >
                {anchorLabel}
              </a>
            )}
            {secondaryBlobHref != null && (
              <a
                href={secondaryBlobHref}
                target="_blank"
                rel="noreferrer noopener"
                className="font-sans text-[11px] text-gray-500 hover:text-gray-700 hover:underline dark:text-gray-400 dark:hover:text-gray-200"
                title="Open the file at the reviewed commit"
              >
                view file
              </a>
            )}
          </div>
          )}

          {/* The (collapsible) diff hunk this finding covers. */}
          {finding.diffHunk != null && finding.diffHunk !== '' && (
            <FindingHunk hunk={finding.diffHunk} path={finding.path} />
          )}

          {/* Claude's body (read-only). A story finding with no explanation has none: its
              title is the criterion. */}
          {finding.body.trim() !== '' && (
            <div className="mt-1">
              <Markdown prRefs>{finding.body}</Markdown>
            </div>
          )}
          {finding.suggestion != null && finding.suggestion !== '' && (
            <SuggestionBlock suggestion={finding.suggestion} path={finding.path} />
          )}

          {/* Your reword — shown when set, editable on the latest run. */}
          {hasReword && !rewording && (
            <div className="mt-1.5 rounded border border-blue-200 bg-blue-50/50 px-2 py-1 dark:border-blue-900/50 dark:bg-blue-900/10">
              <div className="text-[11px] font-medium text-blue-700 dark:text-blue-400">
                Your wording
              </div>
              <Markdown>{finding.editedBody as string}</Markdown>
            </div>
          )}

          {/* Reword editor (inline). The OPEN trigger lives in the action bar. */}
          {editable && !isPosted && rewording && (
            <div className="mt-2 space-y-1">
              <MentionTextarea
                prId={prId}
                value={draft}
                onChange={setDraft}
                rows={4}
                placeholder="Your wording (markdown)"
                className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={saveReword} className={BTN_PRIMARY}>
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRewording(false);
                    setDraft(finding.editedBody ?? '');
                  }}
                  className={BTN_SECONDARY}
                >
                  Cancel
                </button>
                {hasReword && (
                  <button
                    type="button"
                    onClick={clearReword}
                    className={`${BTN_SECONDARY} text-gray-500 dark:text-gray-400`}
                  >
                    Use Claude&apos;s text
                  </button>
                )}
              </div>
            </div>
          )}
          </>
          )}
        </div>
      </div>

      {/* One control bar for every per-finding action: Post / Reword / Copy /
          Ignore, plus posted/error status. Ignored findings show only the
          re-expand + un-ignore controls. */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
        {ignored ? (
          <>
            <button
              type="button"
              onClick={() => setIgnoredExpanded((v) => !v)}
              className={BTN_SECONDARY}
            >
              {ignoredExpanded ? 'Collapse' : 'Show'}
            </button>
            <button
              type="button"
              onClick={() => onToggle(true)}
              title="Re-include this finding in the review"
              className={BTN_PRIMARY}
            >
              Un-ignore
            </button>
            {ignoredExpanded && (
              <button type="button" onClick={copy} className={BTN_SECONDARY}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </>
        ) : (
          <>
            {canPostComment && (
              <button
                type="button"
                onClick={handlePost}
                disabled={busy}
                className={BTN_PRIMARY}
              >
                {busy ? 'Posting…' : postsAsPrComment ? 'Post as PR comment' : 'Post as comment'}
              </button>
            )}
            {editable && !isPosted && !rewording && (
              <button
                type="button"
                onClick={() => {
                  setDraft(finding.editedBody ?? '');
                  setRewording(true);
                }}
                className={BTN_PRIMARY}
              >
                {hasReword ? 'Edit wording' : 'Reword'}
              </button>
            )}
            <button type="button" onClick={copy} className={BTN_SECONDARY}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            {canIgnore && (
              <button
                type="button"
                onClick={() => onToggle(false)}
                title="Set aside — exclude this finding from the submitted review"
                className={BTN_SECONDARY}
              >
                Ignore
              </button>
            )}
            {postError != null && (
              <span className="ml-auto text-xs text-red-500">{postError}</span>
            )}
          </>
        )}
      </div>
    </li>
  );
}

// Section A: Claude's read-only output (verdict, meta, summary, findings). Used
// for both the latest run and a selected past run; `editable` gates the per-finding
// actions — Reword / Ignore / post (only the latest run can be edited).
function ClaudesReview({
  review,
  editable,
  prUrl,
  repoFullName,
  prHeadSha,
  postingFindingId,
  postErrorFindingId,
  postErrorMessage,
  changedPaths,
  onOpenInChanges,
  onOpenThread,
  onToggleFinding,
  onRewordFinding,
  onPostFinding,
  storyCheck,
}: {
  review: ClaudeReview;
  editable: boolean;
  prUrl: string;
  // "owner/name" + the PR's current head SHA (the per-finding blob link prefers
  // the run's own headSha, falling back to this).
  repoFullName: string;
  prHeadSha: string | null;
  postingFindingId: number | null;
  postErrorFindingId: number | null;
  postErrorMessage: string | null;
  // Every path the PR touches, as far as we can tell WITHOUT spending a GitHub call.
  // Empty ⇒ we know nothing, fall back to the finding's own `fileInDiff`.
  changedPaths: ReadonlySet<string>;
  onOpenInChanges?: OpenInChanges;
  onOpenThread?: (threadId: number) => void;
  onToggleFinding: (findingId: number, included: boolean) => void;
  onRewordFinding: (findingId: number, editedBody: string) => Promise<unknown>;
  onPostFinding: (findingId: number) => Promise<unknown>;
  // The Story check section, handed this run's stories that no ticket review covers.
  storyCheck: (legacy: LegacyStories) => ReactNode;
}): JSX.Element {
  // ONE STORY SECTION. This run's stories (an older PR review judged them against this PR alone)
  // show in Story check only where NO ticket review covers the ticket; a covered ticket shows its
  // ticket review instead. Until the ticket reviews load, every story shows (as before).
  const ai = useAiCapabilities();
  const { data: ticketReviews } = useTicketReviews(review.prId, ai.enabled);
  const legacyEntries = useMemo(
    () =>
      !ai.enabled
        ? []
        : legacyOnlyEntries(review.tickets ?? [], ticketReviews?.tickets ?? []),
    [ai.enabled, review.tickets, ticketReviews],
  );
  // EACH FINDING IS ON SCREEN ONCE: a shown story's finding renders as its card INSIDE that story
  // (Story check), and the Findings list leaves it out (`placeStoryFindings`). A story NOT shown
  // places nothing, so its findings stay in the Findings list with their chip.
  const placement = useMemo(
    () => placeStoryFindings(review.findings, legacyEntries),
    [review.findings, legacyEntries],
  );
  // Severity first; within a severity, the findings that raise an earlier comment again lead.
  const findings = sortFindingsForDisplay(review.findings.filter((f) => !placement.placed.has(f.id)));
  const priorStatusById = reraisedStatusByFindingId(review);
  const alreadyPostedIds = alreadyPostedReraiseIds(review);
  // TEMPLATED from the server-validated statuses (a code-derived figure) — Claude's own
  // explanations are shown per comment in the Previous review section.
  const followUpLine = followUpSentence(review.followUp);
  // Pin blob links to the reviewed commit so line numbers stay correct; fall back
  // to the PR's current head when the run didn't record a SHA.
  const headSha = review.headSha ?? prHeadSha;
  // Only a finished review that actually read code can be asked about.
  const chatReviewId =
    review.status === 'succeeded' && review.reviewMode !== 'skip' ? review.id : null;
  const currency = currencyOf(review, prHeadSha);
  const storyIds = placement.ids;

  // THE ONE FINDING CARD, for the Findings list and the Story check's older stories alike. `storyLabel`
  // is the chip naming the story item (null for an ordinary finding).
  const findingCard = (f: ClaudeFinding, storyLabel: string | null): JSX.Element => (
    <FindingRow
      key={f.id}
      prId={review.prId}
      finding={f}
      editable={editable}
      prUrl={prUrl}
      repoFullName={repoFullName}
      headSha={headSha}
      posting={postingFindingId === f.id}
      postError={postErrorFindingId === f.id ? postErrorMessage : null}
      // The changed-file list is authoritative when we have one (it is also what
      // the Changes tab renders); `fileInDiff` is the review-time answer and the
      // only signal available when the list is empty or capped away.
      inChangeset={changedPaths.size > 0 ? changedPaths.has(f.path) : f.fileInDiff}
      priorStatus={priorStatusById.get(f.id)}
      alreadyPosted={alreadyPostedIds.has(f.id)}
      storyLabel={storyLabel}
      onOpenInChanges={onOpenInChanges}
      onToggle={(included) => onToggleFinding(f.id, included)}
      onReword={(editedBody) => onRewordFinding(f.id, editedBody)}
      onPostComment={() => onPostFinding(f.id)}
    />
  );
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

  return (
    <>
      <ReviewSection
        title="Claude's review"
        pills={
          <>
            {currency != null && <CurrencyPill currency={currency} />}
            {review.verdict != null && <VerdictBadge verdict={review.verdict} />}
            {review.trigger === 'auto' && (
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                {AUTO_REVIEW_LABEL}
              </span>
            )}
            {review.reviewMode != null && (
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                {REVIEW_MODE_LABEL[review.reviewMode]} review
              </span>
            )}
            <ClaudeReviewCiStatus review={review} />
          </>
        }
        info={
          <InfoButton title="This run">
            <div className="space-y-2">
              <UsageBreakdown review={review} />
              {review.numTurns != null && <p>{review.numTurns} turns.</p>}
              {review.diffCapped && (
                <p>The diff was too large to send whole, so it was cut to fit.</p>
              )}
              {review.excludedFiles.length > 0 && (
                <p>
                  Left out as noise: {review.excludedFiles.length} file
                  {review.excludedFiles.length === 1 ? '' : 's'} (lockfiles, generated code).
                </p>
              )}
            </div>
          </InfoButton>
        }
      >
        <div className="text-xs text-gray-500 dark:text-gray-400">{metaLine(review)}</div>
        {followUpLine != null && <div className="font-medium">{followUpLine}</div>}
        {review.summary != null && review.summary !== '' && <Markdown prRefs>{review.summary}</Markdown>}
      </ReviewSection>
      <ClaudeReviewCiFailuresSection
        review={review}
        changedPaths={changedPaths}
        onOpenInChanges={onOpenInChanges}
      />
      {review.followUp != null && (
        <ClaudeReviewFollowUpSection
          followUp={review.followUp}
          findings={review.findings}
          changedPaths={changedPaths}
          onOpenInChanges={onOpenInChanges}
        />
      )}
      <ClaudeReviewThreadsSection
        items={review.threadAssessments}
        counts={review.threadAssessmentCounts}
        onOpenThread={onOpenThread}
      />
      <ReviewSection
        title="Findings"
        pills={
          <>
            <SectionCount>{plural(findings.length, 'finding', 'findings')}</SectionCount>
            {placement.placed.size > 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {placement.placed.size} more under Story check
              </span>
            )}
          </>
        }
      >
        {findings.length > 0 ? (
          <ul className="space-y-2">
            {findings.map((f) =>
              findingCard(f, f.story != null ? storyChipLabel(f.story, review.tickets) : null),
            )}
          </ul>
        ) : (
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {placement.placed.size > 0 ? 'None outside Story check.' : 'No line-level findings.'}
          </div>
        )}
      </ReviewSection>
      {storyCheck({
        entries: legacyEntries,
        findingIds: storyIds,
        findingsById: placement.byId,
        renderFinding: findingCard,
      })}
      {/* The chat sits UNDER Story check and opens expanded, so a question about the review or
          the story is one click from both. */}
      {chatReviewId != null && <ReviewChatSection reviewId={chatReviewId} />}
    </>
  );
}

// PR REFERENCES across the whole tab ("bng-library#66", "#352") link to that PR in Limn. Known PRs
// come from what is on screen (the ticket reviews' members — the same cached query Story check
// reads — and this PR); the rest go in ONE batched lookup (ReviewPrRefsProvider).
function ReviewTabPrRefs({
  pr,
  review,
  children,
}: {
  pr: PrDetail;
  review: ClaudeReview | null;
  children: ReactNode;
}): JSX.Element {
  const ai = useAiCapabilities();
  const tickets = useTicketReviews(pr.id, ai.enabled);
  const ticketReviews = tickets.data;
  // The review chat's answers are linked too. This OBSERVES the thread the chat section reads
  // (same key, `enabled: false`), so it adds no request; the section itself fetches it on mount.
  const chatId = review?.status === 'succeeded' && review.reviewMode !== 'skip' ? review.id : null;
  const chat = useClaudeReviewChat(chatId ?? -1, null, false);
  const chatMessages = chatId != null ? chat.data?.messages : undefined;
  const known = useMemo<KnownPr[]>(() => {
    const out: KnownPr[] = [{ prId: pr.id, repoFullName: pr.repoFullName, number: pr.number, title: pr.title }];
    for (const t of ticketReviews?.tickets ?? []) {
      for (const m of t.review?.members ?? []) {
        out.push({ prId: m.prId, repoFullName: m.repo, number: m.number, title: m.title });
      }
    }
    return out;
  }, [pr.id, pr.repoFullName, pr.number, pr.title, ticketReviews]);
  const texts = useMemo(
    () => [
      ...reviewTexts(review, (ticketReviews?.tickets ?? []).map((t) => t.review)),
      ...(chatMessages ?? []).filter((m) => m.role === 'assistant' && m.content.includes('#')).map((m) => m.content),
    ],
    [review, ticketReviews, chatMessages],
  );
  // ONE batch: wait for the ticket reviews (their members are resolved on screen, so the batch
  // must not ask for them) and for the chat thread, when either is coming.
  const ready =
    (!ai.enabled || tickets.data !== undefined || tickets.isError) &&
    (chatId == null || chat.data !== undefined || chat.isError);
  return (
    <ReviewPrRefsProvider
      currentPrId={pr.id}
      currentRepoFullName={pr.repoFullName}
      known={known}
      texts={texts}
      ready={ready}
    >
      {children}
    </ReviewPrRefsProvider>
  );
}

// Surface: hand a completed review to the agentic fixer. Opens the AI Fix tab with this review
// picked; the server builds the seed from the stored run (every item except praise). Free,
// local-only (`me.ai`); renders nothing in the cloud or until a review has succeeded.
function GenerateFixFromReview({
  prId,
  review,
}: {
  prId: number;
  review: ClaudeReview | null;
}): JSX.Element | null {
  const aiFix = useAiCapabilities().enabled;
  const openAiFixFromReview = useFilters((s) => s.openAiFixFromReview);
  if (!aiFix || review?.status !== 'succeeded') return null;
  return (
    <ReviewSection
      title="Generate a fix"
      info={
        <InfoButton title="Generate a fix">
          <p>
            Opens AI Fix with this review picked. Claude edits the code to address the findings and
            threads still to fix. Nothing is pushed until you press the button there.
          </p>
        </InfoButton>
      }
      actions={
        <button
          type="button"
          onClick={() => openAiFixFromReview(prId, review.id)}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-ai-border px-2.5 py-1 text-xs text-ai-signal hover:border-ai-signal/60 hover:bg-ai-surface-2"
        >
          Generate fix from this review
          <ArrowIcon dir="right" size={11} />
        </button>
      }
    />
  );
}

export function ClaudeReviewTab({
  pr,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  usersById,
  onOpenInChanges,
  onOpenThread,
}: {
  pr: PrDetail;
  usersById: Map<number, User>;
  // Provided by PrDetail (which owns the tab state). Absent ⇒ every code anchor keeps its
  // pre-existing GitHub link.
  onOpenInChanges?: OpenInChanges;
  // Opens a review thread in the Threads tab (PrDetail's `openThreadInThreads`).
  onOpenThread?: (threadId: number) => void;
}): JSX.Element {
  const ai = useAiCapabilities();
  const { data, isLoading } = useClaudeReview(pr.id);
  const review = data?.review ?? null;

  // WHICH FILES THIS PR TOUCHES — assembled WITHOUT issuing a request. `pr.files` is the
  // lean metadata list already on the PrDetail payload, and `['pr-files', prId]` is the
  // Changes tab's own query (staleTime: Infinity, IndexedDB-persisted), read
  // opportunistically: populated whenever the user has opened Changes, absent otherwise.
  // Deliberately NOT `usePrFiles(pr.id)` — that is a LIVE GitHub round trip, and firing it
  // from a tab that renders no diffs would spend quota just to pick a link style.
  const qc = useQueryClient();
  const changedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of pr.files) set.add(f.path);
    const cached = qc.getQueryData<PrFilesResponse>(['pr-files', pr.id]);
    for (const f of cached?.files ?? []) {
      set.add(f.path);
      if (f.previousPath) set.add(f.previousPath);
    }
    return set;
  }, [pr.files, pr.id, qc]);

  // Model picker. ALWAYS opens on the default (Claude Opus 5.5) — never seeded from the stored
  // run, or every already-reviewed PR would keep reopening on its old model, and a run stored
  // under a retired id (the old Opus 4.8) would become a select value with no option. A pick
  // stays until remount.
  const [model, setModel] = useState<ClaudeReviewModel>(DEFAULT_CLAUDE_REVIEW_MODEL);

  // Same-SHA re-run confirmation (warn-but-allow).
  const [confirmRerun, setConfirmRerun] = useState(false);

  // Authored draft (Section B) — seeded from the latest review, local until saved.
  const [userBody, setUserBody] = useState('');
  const [userVerdict, setUserVerdict] = useState<ClaudeReviewVerdict>('COMMENT');

  // History selector — defaults to the latest run.
  const [selectedReviewId, setSelectedReviewId] = useState<number | null>(null);

  // Post actions: dry-run preview + confirm-then-post + result/skip surfacing.
  const [preview, setPreview] = useState<PostReviewPreview | null>(null);
  const [postResult, setPostResult] = useState<PostReviewResult | null>(null);
  const [confirmPost, setConfirmPost] = useState(false);

  const generate = useGenerateReview(pr.id);
  // A start in flight from ANY surface (this tab or the Open PRs table) — one shared mutation key.
  const starting = useClaudeReviewStarting(pr.id);
  const cancel = useCancelReview(pr.id);
  const updateReview = useUpdateReview(pr.id);
  const updateFinding = useUpdateFinding(pr.id);
  const postReview = usePostReview(pr.id);
  const postFinding = usePostFinding(pr.id);

  // Per-finding single-comment posting state (one shared mutation; disambiguate
  // by the variables of the in-flight/last call).
  const postingFindingId = postFinding.isPending
    ? (postFinding.variables?.findingId ?? null)
    : null;
  const postErrorFindingId = postFinding.isError
    ? (postFinding.variables?.findingId ?? null)
    : null;
  const postErrorMessage = postFinding.isError
    ? ((postFinding.error as Error)?.message ?? 'Failed to post comment')
    : null;

  // Re-seed local state whenever the latest review changes (new run, refetch).
  const seededReviewId = useRef<number | null>(null);
  useEffect(() => {
    if (review == null) {
      seededReviewId.current = null;
      return;
    }
    if (seededReviewId.current === review.id) return;
    seededReviewId.current = review.id;
    setUserBody(review.userBody ?? '');
    setUserVerdict(review.userVerdict ?? 'COMMENT');
    setSelectedReviewId(review.id);
    setPreview(null);
    setPostResult(null);
    setConfirmPost(false);
  }, [review]);

  const isRunning = review?.status === 'running' || review?.status === 'queued';
  // An AUTO review holds this PR (waiting in its lane, or running): the manual start is locked
  // until it ends — the server answers 409 AutoReviewInProgress otherwise.
  const autoHold: 'queued' | 'running' | null =
    data?.autoReview ?? (isRunning && review?.trigger === 'auto' ? 'running' : null);
  // Live progress over SSE — pushes each phase/activity/usage change in real time
  // and self-invalidates the full review on the terminal `done` (so the finished
  // result loads without a poll).
  const { status } = useClaudeReviewStream(pr.id, isRunning);

  // Which run is shown in Section A: the latest unless the user picked an older
  // one from history. Both are hooks, so they MUST run unconditionally — before
  // any early return below (React's Rules of Hooks).
  const viewingLatest =
    selectedReviewId == null || selectedReviewId === review?.id;
  const { data: historicReview } = useClaudeReviewById(
    viewingLatest ? null : selectedReviewId,
  );

  if (isLoading) {
    return <div className="px-4 py-3 text-sm text-gray-400">Loading…</div>;
  }

  // Off here: the hosted app (one line saying where it runs) or a local kill switch (nothing to
  // run, nothing to say — the tab is not even listed then; this covers a stale deep link).
  if (!ai.enabled || data?.enabled === false) {
    return (
      <div className="px-4 py-3">
        <AiCloudNote />
      </div>
    );
  }

  const alreadyReviewed =
    review?.status === 'succeeded' && review.headSha === pr.headSha;
  // The latest run against the PR's head: shown beside the Re-review button, in amber when newer
  // commits (or a rewritten history) have landed since.
  const latestCurrency = review?.status === 'succeeded' ? currencyOf(review, pr.headSha) : null;
  const latestOutdated = latestCurrency?.tone === 'behind' ? latestCurrency.label : null;

  const runGenerate = (): void => {
    // Create/resume the AudioContext now, during this user gesture, so the
    // completion chime can play later without one (browsers gate WebAudio behind
    // a gesture). No-op / swallowed if WebAudio is unavailable.
    unlockReviewSound();
    setConfirmRerun(false);
    setPreview(null);
    setPostResult(null);
    // No story: the PR review looks at the code. Stories are the Story check section below.
    generate.mutate({ model });
  };

  const onRunClick = (): void => {
    if (alreadyReviewed) {
      setConfirmRerun(true);
    } else {
      runGenerate();
    }
  };

  const shownReview: ClaudeReview | null = viewingLatest
    ? review
    : historicReview ?? null;

  // Editing + posting are only enabled for the latest run.
  const canEdit = viewingLatest && review != null;

  const phase = status?.progress?.phase ?? null;
  const phaseLabel = phase != null ? (PHASE_LABEL[phase] ?? phase) : 'Starting…';

  const runPreview = (): void => {
    if (review == null) return;
    setPostResult(null);
    postReview.mutate(
      { reviewId: review.id, userVerdict, dryRun: true },
      { onSuccess: (res) => setPreview(res as PostReviewPreview) },
    );
  };

  const runPost = (): void => {
    if (review == null) return;
    setConfirmPost(false);
    postReview.mutate(
      { reviewId: review.id, userVerdict },
      { onSuccess: (res) => setPostResult(res as PostReviewResult) },
    );
  };

  return (
    <ReviewTabPrRefs pr={pr} review={shownReview}>
    <div className="space-y-3 px-4 py-3">
      {/* The run controls are ALWAYS shown; a missing AI runtime or Claude credential replaces
          only the Run button (AiRunGate), so past reviews and the stories stay usable.
          ⚠ THERE IS NOWHERE IN THE APP TO ENTER A KEY, AND THE LINE MUST NOT PRETEND OTHERWISE:
          both credential rungs (an ambient Claude Code session, then ANTHROPIC_API_KEY) live
          outside the SPA. */}
      <ReviewSection title="Run a review">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ClaudeReviewModel)}
              disabled={isRunning || starting}
              aria-label="Model"
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {CLAUDE_REVIEW_MODELS.map((m) => (
                <option key={m} value={m}>
                  {CLAUDE_REVIEW_MODEL_LABELS[m]}
                </option>
              ))}
            </select>
            <AiRunGate auth={data?.auth}>
            <button
              type="button"
              onClick={onRunClick}
              disabled={isRunning || starting || autoHold != null}
              className={
                latestOutdated != null
                  ? 'rounded border border-blue-400 px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30'
                  : 'rounded border border-gray-300 px-2 py-1 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500'
              }
            >
              {review == null ? 'Run review' : 'Re-review'}
            </button>
            </AiRunGate>
            {autoHold != null && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {autoHold === 'running' ? 'Auto review running' : 'Auto review queued'}
              </span>
            )}
            {autoHold == null && data?.autoReviewWaiting != null && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {AUTO_REVIEW_WAITING_LABEL[data.autoReviewWaiting]}
              </span>
            )}
          </div>

          {/* Same-SHA warn-but-allow confirmation. */}
          {confirmRerun && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300">
              <span>This commit is already reviewed.</span>
              <button
                type="button"
                onClick={runGenerate}
                disabled={autoHold != null}
                className="rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100 disabled:opacity-50 dark:border-amber-600 dark:hover:bg-amber-900/40"
              >
                Run anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirmRerun(false)}
                className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
              >
                Cancel
              </button>
            </div>
          )}

          {/* After an auto review of the reader's own PR: the auto fix started, or why not. */}
          {viewingLatest && autoFixOutcomeLine(data?.autoFix) != null && (
            <div className="mt-2 text-xs text-gray-600 dark:text-gray-400">
              {autoFixOutcomeLine(data?.autoFix)}
            </div>
          )}

          {/* An auto-review refusal is shown by the "Auto review queued/running" note instead,
              and is history once the hold ends. */}
          {generate.isError && !isAutoReviewHoldError(generate.error) && (
            <div className="mt-2 text-xs text-red-600 dark:text-red-400">
              {(generate.error as Error)?.message ?? 'Failed to start review.'}
            </div>
          )}
        </div>

      {/* Running progress. The bar is mounted OUTSIDE the isRunning gate so it observes
          the running→done transition and plays its 100%→fade-out completion (it renders
          null when idle, so this adds no chrome otherwise). */}
      <div className="empty:hidden">
        <RegenProgressBar
          active={isRunning}
          label="Running Claude review"
          value={reviewProgressPct(status)}
          timeConstantSec={30}
        />
      </div>
      {isRunning && (
        <div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            <span>{phaseLabel}…</span>
            {review?.trigger === 'auto' && (
              <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-500 dark:text-gray-400">
                {AUTO_REVIEW_LABEL}
              </span>
            )}
            {status?.progress?.reviewMode != null && (
              <span
                className="rounded bg-blue-500/10 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-400"
                title="The review depth chosen for this run"
              >
                {REVIEW_MODE_LABEL[status.progress.reviewMode]} review
              </span>
            )}
            {status?.progress?.message != null && (
              <span className="text-xs text-gray-400">
                {status.progress.message}
              </span>
            )}
            <button
              type="button"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
              className="ml-auto rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              {cancel.isPending ? 'Stopping…' : 'Stop'}
            </button>
          </div>
          {/* Live token usage + running cost estimate (once the agent has a turn). */}
          {status?.progress?.usage && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
              <span
                className="inline-flex items-center gap-1"
                title="Output tokens generated so far"
              >
                <ArrowIcon dir="down" size={11} />
                {fmtTokens(status.progress.usage.outputTokens)} out
              </span>
              <span
                className="inline-flex items-center gap-1"
                title="New (uncached) input tokens billed so far"
              >
                <ArrowIcon dir="up" size={11} />
                {fmtTokens(status.progress.usage.inputTokens)} in
              </span>
              <span
                className="inline-flex items-center gap-1"
                title="Cached input tokens read so far (billed at ~10% of input)"
              >
                <RefreshIcon size={11} />
                {fmtTokens(status.progress.usage.cacheReadTokens)} cache
              </span>
              <span
                className="font-semibold text-gray-600 dark:text-gray-300"
                title="Estimated cost so far, on your own Claude Code or Anthropic API key. Limn charges nothing. The figure recorded when the run finishes is authoritative."
              >
                ~{formatUsd(status.progress.usage.estCostUsd)}
              </span>
            </div>
          )}
          {/* Live activity feed from the agent run (newest-last). */}
          <ActivityLog lines={status?.progress?.recentActivity ?? []} />
        </div>
      )}

      {/* Failed / cancelled. */}
      {!isRunning && review?.status === 'failed' && (
        <div>
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700/60 dark:bg-red-900/20 dark:text-red-400">
            {review.error ?? 'The review failed.'}
          </div>
        </div>
      )}
      {!isRunning && review?.status === 'cancelled' && (
        <div className="text-sm text-gray-500 dark:text-gray-400">Review cancelled.</div>
      )}

      {/* History selector. */}
      {data != null && data.history.length > 1 && (
        <label className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          Showing
          <select
            value={selectedReviewId ?? review?.id ?? ''}
            onChange={(e) => {
              setSelectedReviewId(Number(e.target.value));
              setPreview(null);
              setPostResult(null);
            }}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
          >
            {data.history.map((h) => (
              <option key={h.id} value={h.id}>
                {shortSha(h.headSha)} ·{' '}
                {(CLAUDE_REVIEW_MODEL_LABELS as Record<string, string>)[h.model] ?? h.model} ·{' '}
                {h.status} ·{' '}
                {formatDate(h.createdAt)}
                {h.trigger === 'auto' ? ` · ${AUTO_REVIEW_LABEL}` : ''}
                {h.id === review?.id ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      </ReviewSection>

      {/* Section A — Claude's read-only review for the shown run. */}
      {shownReview != null && shownReview.status === 'succeeded' && (
        <ClaudesReview
          review={shownReview}
          editable={canEdit}
          prUrl={pr.githubUrl}
          repoFullName={pr.repoFullName}
          prHeadSha={pr.headSha}
          postingFindingId={postingFindingId}
          postErrorFindingId={postErrorFindingId}
          postErrorMessage={postErrorMessage}
          changedPaths={changedPaths}
          onOpenInChanges={onOpenInChanges}
          onOpenThread={onOpenThread}
          onToggleFinding={(findingId, included) =>
            updateFinding.mutate({ findingId, included })
          }
          onRewordFinding={(findingId, editedBody) =>
            updateFinding.mutateAsync({ findingId, editedBody })
          }
          onPostFinding={(findingId) => postFinding.mutateAsync({ findingId })}
          // The ticket review: one check per TICKET across every PR on it — a separate run from
          // the PR review above, with its own Check button. It also carries this run's stories
          // that no ticket review covers, so there is ONE story section.
          storyCheck={(legacy) => (
            <TicketCoverageSection
              pr={pr}
              changedPaths={changedPaths}
              onOpenInChanges={onOpenInChanges}
              legacy={legacy}
            />
          )}
        />
      )}
      {!(shownReview != null && shownReview.status === 'succeeded') && (
        <TicketCoverageSection pr={pr} changedPaths={changedPaths} onOpenInChanges={onOpenInChanges} />
      )}

      {/* Section B — the authored review that gets posted (latest run only). */}
      {canEdit && review != null && review.status === 'succeeded' && review.reviewMode !== 'skip' && (
        <ReviewSection
          title="Post to GitHub"
          pills={
            review.postedAt != null ? (
              <span className="text-xs text-gray-500 dark:text-gray-400">Posted {formatDate(review.postedAt)}</span>
            ) : null
          }
          info={
            <InfoButton title="Post to GitHub">
              <p>
                Posts one review: your summary as its top-level comment, with your verdict. Every
                finding above that you have not ignored or already posted goes with it, including a
                story marked “Checked on this PR only”. Other Story check items are posted on their
                own.
              </p>
            </InfoButton>
          }
        >
          <div className="text-xs font-medium text-gray-700 dark:text-gray-300">Summary</div>
          <MentionTextarea
            prId={pr.id}
            value={userBody}
            onChange={setUserBody}
            onBlur={() => updateReview.mutate({ reviewId: review.id, userBody })}
            rows={6}
            placeholder="Summary (markdown, @ to mention). Optional."
            className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                updateReview.mutate({ reviewId: review.id, userBody })
              }
              disabled={updateReview.isPending}
              title="Saves the draft. Nothing is posted yet."
              className="rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              Save draft
            </button>
            <select
              aria-label="Verdict"
              value={userVerdict}
              onChange={(e) => {
                const v = e.target.value as ClaudeReviewVerdict;
                setUserVerdict(v);
                updateReview.mutate({ reviewId: review.id, userVerdict: v });
              }}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              <option value="COMMENT">Comment</option>
              <option value="REQUEST_CHANGES">Request changes</option>
              <option value="APPROVE">Approve</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runPreview}
              disabled={postReview.isPending}
              className="rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              Preview
            </button>
            {!confirmPost ? (
              <button
                type="button"
                onClick={() => setConfirmPost(true)}
                disabled={postReview.isPending}
                className="rounded border border-blue-400 px-2 py-0.5 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
              >
                Post to GitHub
              </button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Post as <strong>{VERDICT_LABEL[userVerdict]}</strong>?
                </span>
                <button
                  type="button"
                  onClick={runPost}
                  disabled={postReview.isPending}
                  className="rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
                >
                  Confirm post
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmPost(false)}
                  className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
                >
                  Cancel
                </button>
              </span>
            )}
            {postReview.isPending && (
              <span className="text-xs text-gray-500 dark:text-gray-400">Posting…</span>
            )}
          </div>

          {/* Dry-run preview summary. */}
          {preview != null && (
            <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800/50">
              <div>
                Will post <strong>{preview.comments.length}</strong> inline
                comment{preview.comments.length === 1 ? '' : 's'} as{' '}
                <strong>{VERDICT_LABEL[preview.event]}</strong>.
              </div>
              {preview.prComments.length > 0 && (
                <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Plus <strong>{preview.prComments.length}</strong> PR comment
                  {preview.prComments.length === 1 ? '' : 's'}:{' '}
                  {preview.prComments.map((c) => (c.path !== '' ? c.path : 'the whole change')).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Post result. */}
          {postResult != null && (
            <div className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-700 dark:border-green-700/60 dark:bg-green-900/20 dark:text-green-400">
              <div>
                Posted review #{postResult.postedReviewId ?? '?'} ·{' '}
                {postResult.postedCommentCount} inline comment
                {postResult.postedCommentCount === 1 ? '' : 's'}
              </div>
              {postResult.prCommentCount > 0 && (
                <div className="mt-1 text-xs">
                  Plus {postResult.prCommentCount} PR comment
                  {postResult.prCommentCount === 1 ? '' : 's'}.
                </div>
              )}
            </div>
          )}

          {postReview.isError && (
            <div className="text-xs text-red-600 dark:text-red-400">
              {(postReview.error as Error)?.message ??
                'Failed to post review to GitHub.'}
            </div>
          )}
        </ReviewSection>
      )}

      {/* Hand the latest succeeded review to the agentic fixer — last, once the reader has
          decided what in it is worth fixing. */}
      {canEdit && <GenerateFixFromReview prId={pr.id} review={review} />}
    </div>
    </ReviewTabPrRefs>
  );
}
