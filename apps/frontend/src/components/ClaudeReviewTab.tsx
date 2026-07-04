import { useEffect, useRef, useState } from 'react';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeReview,
  ClaudeReviewModel,
  ClaudeReviewStatusResponse,
  ClaudeReviewVerdict,
  PostReviewPreview,
  PostReviewResult,
  PrDetail,
  RequestedReviewMode,
  ReviewMode,
  User,
} from '@pierre-review/shared';
import type { LearningMatch } from '@pierre-review/shared';
import { CLAUDE_REVIEW_MODELS } from '@pierre-review/shared';
import { formatDate } from '../lib/ui.js';
import { unlockReviewSound } from '../lib/sound.js';
import { useProCapabilities } from '../hooks/useTriage.js';
import { useReviewLearnings } from '../hooks/useReviewLearnings.js';
import { useFilters } from '../store/filters.js';
import {
  useCancelReview,
  useClaudeReview,
  useClaudeReviewById,
  useClaudeReviewStream,
  useGenerateReview,
  usePostFinding,
  usePostReview,
  useSetClaudeKey,
  useUpdateFinding,
  useUpdateReview,
} from '../hooks/useClaudeReview.js';
import { Markdown } from './Markdown.js';
import { MentionTextarea } from './MentionTextarea.js';
import { RegenProgressBar } from './Activity/RegenProgressBar.js';

// A label/body row matching ChecksTab's layout — a fixed-width uppercase caption
// on the left, content on the right.
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

const shortSha = (sha: string | null): string => (sha ? sha.slice(0, 7) : '—');

// The resolved review mode (what actually ran), and the user-facing depth options.
const REVIEW_MODE_LABEL: Record<ReviewMode, string> = {
  skip: 'Skipped',
  diff_only: 'Quick',
  worktree: 'Deep',
};

const REQUESTED_MODE_OPTIONS: { value: RequestedReviewMode; label: string }[] = [
  { value: 'auto', label: 'Auto (router decides)' },
  { value: 'diff_only', label: 'Quick — diff only' },
  { value: 'worktree', label: 'Deep — full worktree' },
];

const plural = (n: number, unit: string): string =>
  `${n} ${unit}${n === 1 ? '' : 's'}`;

// A short, human-readable explanation of why a run got the mode it did — shown as a
// tooltip on the mode badge.
function routeReasonText(review: ClaudeReview): string | undefined {
  const rr = review.routeReason;
  if (!rr) return undefined;
  const size = `${plural(rr.changedFiles, 'file')} · ${plural(rr.linesChanged, 'line')} · ${plural(rr.dirsTouched, 'dir')}`;
  if (rr.decidedBy === 'user') {
    return `You chose ${REVIEW_MODE_LABEL[review.reviewMode ?? 'worktree']} for this run (${size}).`;
  }
  if (rr.trippedBy) {
    return `Auto chose Deep — ${size}; over the ${rr.trippedBy} limit.`;
  }
  return `Auto chose ${REVIEW_MODE_LABEL[review.reviewMode ?? 'diff_only']} — ${size}.`;
}

const VERDICT_LABEL: Record<ClaudeReviewVerdict, string> = {
  COMMENT: 'Comment',
  REQUEST_CHANGES: 'Request changes',
  APPROVE: 'Approve',
};

const VERDICT_CLASS: Record<ClaudeReviewVerdict, string> = {
  APPROVE: 'bg-green-500/10 text-green-700 dark:text-green-400',
  REQUEST_CHANGES: 'bg-red-500/10 text-red-700 dark:text-red-400',
  COMMENT: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
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

const SEVERITY_RANK: Record<ClaudeFindingSeverity, number> = {
  blocker: 0,
  warning: 1,
  nit: 2,
  question: 3,
  praise: 4,
};

const SEVERITY_CLASS: Record<ClaudeFindingSeverity, string> = {
  blocker: 'bg-red-500/10 text-red-700 dark:text-red-400',
  warning: 'bg-orange-500/10 text-orange-700 dark:text-orange-400',
  nit: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-500',
  question: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  praise: 'bg-green-500/10 text-green-700 dark:text-green-400',
};

function metaLine(review: ClaudeReview): string {
  const parts: string[] = [review.model];
  if (review.costUsd != null) parts.push(`$${review.costUsd.toFixed(4)}`);
  if (review.numTurns != null) parts.push(`${review.numTurns} turns`);
  if (review.excludedFiles.length > 0) {
    parts.push(`${review.excludedFiles.length} noise files excluded`);
  }
  return parts.join(' · ');
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

  const items: { key: string; label: string; value: number; title: string }[] =
    [];
  if (outputTokens != null)
    items.push({
      key: 'out',
      label: '↓ out',
      value: outputTokens,
      title: 'Output tokens generated (billed at the output rate — the priciest per token)',
    });
  if (inputTokens != null)
    items.push({
      key: 'in',
      label: '↑ in',
      value: inputTokens,
      title: 'New (uncached) input tokens',
    });
  if (cacheReadTokens != null)
    items.push({
      key: 'cr',
      label: '⟳ cache read',
      value: cacheReadTokens,
      title:
        'Cached input tokens re-read each turn — billed at ~10% of the input rate, but the volume driver of a multi-turn run',
    });
  if (cacheCreationTokens != null)
    items.push({
      key: 'cw',
      label: '✎ cache write',
      value: cacheCreationTokens,
      title: 'Tokens written to the prompt cache (billed at ~1.25× the input rate)',
    });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
      {items.map((it) => (
        <span key={it.key} title={it.title}>
          {it.label} {fmtTokens(it.value)}
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
function hunkLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-violet-500';
  if (line.startsWith('+')) return 'text-green-700 dark:text-green-400';
  if (line.startsWith('-')) return 'text-red-700 dark:text-red-400';
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
// preview expands it (a convenience); the expanded hunk only collapses via the
// dedicated "Hide" control (so clicking the code to read/select it never folds it
// away). State is local + transient — it never persists across reloads.
function FindingHunk({ hunk }: { hunk: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lines = hunk.replace(/\n$/, '').split('\n');
  // Prefer the @@ header for the collapsed preview; else the anchor (last) line.
  const preview = lines.find((l) => l.startsWith('@@')) ?? lines.at(-1) ?? '';

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="Show the code hunk"
        className="mt-1 flex w-full items-center gap-2 overflow-hidden rounded bg-gray-50 px-2 py-1.5 text-left font-mono text-xs dark:bg-gray-900/60"
      >
        <span className="shrink-0 text-gray-400">▸</span>
        <span className={`min-w-0 flex-1 truncate ${hunkLineClass(preview)}`}>
          {preview === '' ? ' ' : preview}
        </span>
        {lines.length > 1 && (
          <span className="shrink-0 font-sans text-[10px] text-gray-400">
            {lines.length} lines
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="mt-1 rounded bg-gray-50 dark:bg-gray-900/60">
      <pre className="overflow-x-auto px-2 py-1.5 font-mono text-xs leading-snug">
        {lines.map((l, i) => (
          <div key={i} className={hunkLineClass(l)}>
            {l === '' ? ' ' : l}
          </div>
        ))}
      </pre>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="px-2 pb-1.5 text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      >
        ⌃ Hide code
      </button>
    </div>
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
  // priority — posting and Copy use it.
  const pendingReword =
    rewording && draft.trim() !== '' && draft !== (finding.editedBody ?? '')
      ? draft
      : null;
  const willPostReword = pendingReword != null || hasReword;
  const effectiveBody =
    pendingReword ?? (hasReword ? (finding.editedBody as string) : finding.body);

  const anchorLabel =
    finding.line != null ? `${finding.path}:${finding.line}` : finding.path;
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

  // Primary code-anchor link, in reliability + usefulness order:
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
  const canPostComment = editable;

  const copy = (): void => {
    let text = `${finding.title}\n\n${effectiveBody}`;
    if (finding.suggestion != null && finding.suggestion !== '') {
      text += `\n\n\`\`\`suggestion\n${finding.suggestion}\n\`\`\``;
    }
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (copyTimer.current != null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
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
  const canIgnore = editable;
  const ignored = canIgnore && !finding.included;
  const [ignoredExpanded, setIgnoredExpanded] = useState(false);
  const detailsHidden = ignored && !ignoredExpanded;

  return (
    <li
      className={`rounded border border-gray-100 px-3 py-2 text-sm dark:border-gray-800 ${
        ignored ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <span
          className={`mt-0.5 inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_CLASS[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{finding.title}</span>
            {isPosted &&
              (commentUrl != null ? (
                <a
                  href={commentUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-700 hover:underline dark:text-green-400"
                  title="View this comment on GitHub"
                >
                  posted ✓
                </a>
              ) : (
                <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] text-green-700 dark:text-green-400">
                  posted ✓
                </span>
              ))}
            {hasReword && (
              <span
                className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400"
                title="You reworded this — your text posts instead of Claude's"
              >
                reworded
              </span>
            )}
            {!finding.anchored &&
              (finding.fileInDiff ? (
                <span
                  className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] text-gray-500"
                  title="This line isn't in the PR diff — it posts inline on the file's first change (added preferred)"
                >
                  off-diff line — posts on first change
                </span>
              ) : (
                <span
                  className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400"
                  title="This finding's file isn't part of the PR's diff — it posts as a standalone PR-level comment, marked as outside the diff"
                >
                  outside the PR diff — posts as a PR comment
                </span>
              ))}
            {ignored && (
              <span
                className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500"
                title="Set aside — excluded from the submitted review"
              >
                ignored
              </span>
            )}
          </div>

          {/* Detail (anchor / hunk / body / suggestion / reword). Hidden while an
              ignored finding is collapsed; the action bar can re-expand it. */}
          {!detailsHidden && (
          <>
          {/* Code anchor → opens this finding's line in the PR diff (review
              context). A secondary "view file" links the blob at the reviewed
              commit as an escape hatch for collapsed/outdated diffs. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs">
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
            {secondaryBlobHref != null && (
              <a
                href={secondaryBlobHref}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[10px] font-sans text-gray-400 hover:text-gray-600 hover:underline dark:hover:text-gray-200"
                title="Open the file at the reviewed commit (no diff, but no jump — use if the PR diff doesn't land right)"
              >
                view file
              </a>
            )}
          </div>

          {/* The (collapsible) diff hunk this finding covers. */}
          {finding.diffHunk != null && finding.diffHunk !== '' && (
            <FindingHunk hunk={finding.diffHunk} />
          )}

          {/* Claude's body (read-only). */}
          <div className="mt-1">
            <Markdown>{finding.body}</Markdown>
          </div>
          {finding.suggestion != null && finding.suggestion !== '' && (
            <pre className="mt-1 overflow-x-auto rounded bg-gray-100 px-2 py-1.5 font-mono text-xs dark:bg-gray-800">
              <code>{finding.suggestion}</code>
            </pre>
          )}

          {/* Your reword — shown when set, editable on the latest run. */}
          {hasReword && !rewording && (
            <div className="mt-1.5 rounded border border-blue-200 bg-blue-50/50 px-2 py-1 dark:border-blue-900/50 dark:bg-blue-900/10">
              <div className="text-[10px] uppercase tracking-wide text-blue-500">
                Your reword (posts instead of Claude&apos;s)
              </div>
              <Markdown>{finding.editedBody as string}</Markdown>
            </div>
          )}

          {/* Reword editor (inline). The OPEN trigger lives in the action bar. */}
          {editable && rewording && (
            <div className="mt-2 space-y-1">
              <MentionTextarea
                prId={prId}
                value={draft}
                onChange={setDraft}
                rows={4}
                placeholder="Reword this finding in your own words (markdown). This is what gets posted as the inline comment."
                className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={saveReword} className={BTN_PRIMARY}>
                  Save reword
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
                    className={`${BTN_SECONDARY} text-gray-500`}
                  >
                    Clear reword
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
                title={
                  postsAsPrComment
                    ? "This finding's file isn't in the PR diff — posts as a standalone PR-level comment (no review submitted)"
                    : 'Post just this finding as a single inline comment on the PR (no review submitted)'
                }
                className={BTN_PRIMARY}
              >
                {busy
                  ? 'Posting…'
                  : postsAsPrComment
                    ? isPosted
                      ? 'Post again as PR comment'
                      : 'Post as PR comment'
                    : isPosted
                      ? 'Post again as comment'
                      : 'Post as comment'}
              </button>
            )}
            {editable && !rewording && (
              <button
                type="button"
                onClick={() => {
                  setDraft(finding.editedBody ?? '');
                  setRewording(true);
                }}
                title="Rewrite this finding in your own words — your text posts instead of Claude's"
                className={BTN_PRIMARY}
              >
                {hasReword ? 'Edit reword' : 'Reword in my words'}
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
            {canPostComment && (
              <span className="text-[11px] text-gray-400">
                {willPostReword ? 'posts your reworded text' : "posts Claude's text"}
              </span>
            )}
            {isPosted &&
              (commentUrl != null ? (
                <a
                  href={commentUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-green-700 hover:underline dark:text-green-400"
                >
                  view comment ↗
                </a>
              ) : (
                <span className="text-xs text-green-700 dark:text-green-400">
                  posted ✓
                </span>
              ))}
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
  onToggleFinding,
  onRewordFinding,
  onPostFinding,
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
  onToggleFinding: (findingId: number, included: boolean) => void;
  onRewordFinding: (findingId: number, editedBody: string) => Promise<unknown>;
  onPostFinding: (findingId: number) => Promise<unknown>;
}): JSX.Element {
  const findings = [...review.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  // Pin blob links to the reviewed commit so line numbers stay correct; fall back
  // to the PR's current head when the run didn't record a SHA.
  const headSha = review.headSha ?? prHeadSha;

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        Claude&apos;s review
        {review.verdict != null && <VerdictBadge verdict={review.verdict} />}
        {review.reviewMode != null && (
          <span
            className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs font-normal text-gray-500"
            title={routeReasonText(review)}
          >
            {REVIEW_MODE_LABEL[review.reviewMode]} review
          </span>
        )}
        {/* Self-escalation: a diff-only run where Claude judged a deeper review was
            warranted (scopeUsed = worktree). Prompt the user to re-review as Deep. */}
        {review.reviewMode === 'diff_only' && review.scope === 'worktree' && (
          <span
            className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400"
            title="Reviewed from the diff only, but Claude flagged that this change warrants a deeper, cross-file review. Re-review with depth set to Deep."
          >
            ⚠ suggests a deeper review
          </span>
        )}
        {review.diffCapped && (
          <span
            className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs font-normal text-gray-500"
            title="The diff shown to Claude was truncated to a size budget to control cost. Routing and line-anchoring still used the full diff, and any omitted files were listed for the worktree to read."
          >
            diff capped
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500">{metaLine(review)}</div>
      <UsageBreakdown review={review} />
      {review.summary != null && review.summary !== '' && (
        <div className="text-sm">
          <Markdown>{review.summary}</Markdown>
        </div>
      )}
      {findings.length > 0 ? (
        <ul className="space-y-2">
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              prId={review.prId}
              finding={f}
              editable={editable}
              prUrl={prUrl}
              repoFullName={repoFullName}
              headSha={headSha}
              posting={postingFindingId === f.id}
              postError={
                postErrorFindingId === f.id ? postErrorMessage : null
              }
              onToggle={(included) => onToggleFinding(f.id, included)}
              onReword={(editedBody) => onRewordFinding(f.id, editedBody)}
              onPostComment={() => onPostFinding(f.id)}
            />
          ))}
        </ul>
      ) : (
        <div className="text-xs text-gray-400">No line-level findings.</div>
      )}
    </div>
  );
}

// Anthropic API-key management — store (or clear) a user-supplied key so reviews
// bill to the user's own Anthropic account. The key is write-only: the backend
// never returns it, so the input always renders empty and we never echo it.
//
// Rendered in two flavours: `prominent` when Claude auth is missing (it's the fix
// for the amber gate), and a compact "Manage API key" disclosure when auth is ok.
function ApiKeyPanel({
  prId,
  hasUserKey,
  prominent,
}: {
  prId: number;
  hasUserKey: boolean;
  prominent: boolean;
}): JSX.Element {
  const setKey = useSetClaudeKey(prId);
  const [keyInput, setKeyInput] = useState('');
  // The compact (auth-ok) variant starts collapsed behind a disclosure.
  const [open, setOpen] = useState(prominent);

  const save = (value: string): void => {
    setKey.mutate(value, { onSuccess: () => setKeyInput('') });
  };

  const body = (
    <div className="space-y-1.5">
      <div className="text-sm font-semibold">Anthropic API key (optional)</div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Paste a key to use your own Anthropic billing for reviews. Stored locally
        only — never sent to any server but Anthropic.
      </p>
      {hasUserKey && (
        <div className="text-xs text-green-700 dark:text-green-400">
          ✓ Using your stored Anthropic key
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={hasUserKey ? 'Replace stored key…' : 'sk-ant-…'}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <button
          type="button"
          onClick={() => save(keyInput)}
          disabled={setKey.isPending || keyInput.trim() === ''}
          className="rounded border border-blue-400 px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
        >
          {setKey.isPending ? 'Saving…' : 'Save'}
        </button>
        {hasUserKey && (
          <button
            type="button"
            onClick={() => save('')}
            disabled={setKey.isPending}
            className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-500 hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
          >
            Clear
          </button>
        )}
      </div>
      {setKey.isError && (
        <div className="text-xs text-red-500">
          {(setKey.error as Error)?.message ?? 'Failed to save the key.'}
        </div>
      )}
    </div>
  );

  if (prominent) {
    return (
      <div className="mt-3 rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
        {body}
      </div>
    );
  }

  // Compact disclosure for the auth-ok case.
  return (
    <div className="px-4 py-2">
      {open ? (
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/50">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-gray-400">
              Manage API key
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            >
              Hide
            </button>
          </div>
          {body}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
        >
          Manage API key
          {hasUserKey && (
            <span className="ml-1 text-green-700 dark:text-green-400">
              ✓ stored key in use
            </span>
          )}
        </button>
      )}
    </div>
  );
}

// Subtle confidence label (right-aligned on a match row) — never a hard claim,
// mirroring the app's heuristic-honesty ethos.
const CONFIDENCE_CLASS: Record<LearningMatch['confidence'], string> = {
  high: 'text-green-600 dark:text-green-400',
  medium: 'text-amber-600 dark:text-amber-400',
  low: 'text-gray-400',
};

function LearningMatchRow({ match }: { match: LearningMatch }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasExample =
    match.example != null && (match.example.claude != null || match.example.you != null);
  return (
    <li className="px-2 py-1.5">
      <div className="flex items-baseline gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
            <span className="truncate font-mono">{match.glob}</span>
            {match.category != null && (
              <>
                <span className="text-gray-300 dark:text-gray-600">·</span>
                <span>{match.category}</span>
              </>
            )}
          </div>
          <div className="text-xs text-gray-700 dark:text-gray-200">{match.summary}</div>
        </div>
        <span className={`shrink-0 text-[10px] ${CONFIDENCE_CLASS[match.confidence]}`}>
          {match.confidence}
        </span>
      </div>
      {hasExample && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 text-[10px] text-gray-400 hover:underline"
        >
          {open ? 'hide example' : 'show example ▸'}
        </button>
      )}
      {open && hasExample && (
        <div className="mt-1 space-y-0.5 rounded bg-gray-50 px-2 py-1 text-[11px] dark:bg-gray-800/60">
          {match.example?.claude != null && (
            <div>
              <span className="font-medium text-gray-400">Claude: </span>
              <span className="text-gray-600 dark:text-gray-300">
                “{match.example.claude}”
              </span>
            </div>
          )}
          {match.example?.you != null && (
            <div>
              <span className="font-medium text-gray-400">You: </span>
              <span className="text-gray-600 dark:text-gray-300">
                “{match.example.you}”
              </span>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Surface 1 (Pro): a collapsible panel of aggregated signals from the reviewer's
// past reviews in this repo, shown ABOVE the Run/Re-review controls. The same
// signals are injected into the run as context. Gated on pro.reviewMemory; renders
// nothing in OSS mode or when there are no matches.
function ReviewLearningsPanel({ prId }: { prId: number }): JSX.Element | null {
  const { reviewMemory } = useProCapabilities();
  const { data } = useReviewLearnings(prId, reviewMemory);
  const [open, setOpen] = useState(false);
  const matches = data?.matches ?? [];
  if (!reviewMemory || matches.length === 0) return null;
  return (
    <div className="mb-2 rounded border border-violet-200 bg-violet-50/50 dark:border-violet-900/50 dark:bg-violet-950/20">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs font-medium text-violet-700 dark:text-violet-300"
        aria-expanded={open}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        From your past reviews in this repo ({matches.length} signal
        {matches.length === 1 ? '' : 's'})
        <span className="ml-auto text-[10px] font-normal text-violet-500/70">
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        <div className="border-t border-violet-200 px-1 pb-1 dark:border-violet-900/50">
          <div className="px-2 py-1 text-[10px] text-gray-500 dark:text-gray-400">
            ⓘ These are given to Claude as context for this run.
          </div>
          <ul className="divide-y divide-violet-100 dark:divide-violet-900/40">
            {matches.map((m, i) => (
              <LearningMatchRow key={i} match={m} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Build the seed prompt for the AI fixer from a completed review: the reviewer's own
// draft body when present, else Claude's summary, plus each ACTIONABLE finding. We
// only hand the fixer real issues — findings the user IGNORED (included === false) are
// skipped, and non-actionable severities (praise and open questions) are dropped so
// the agent doesn't try to "fix" a compliment or a question. blocker/warning/nit stay.
function buildReviewSeed(review: ClaudeReview): string {
  const parts: string[] = [];
  const head = review.userBody?.trim() || review.summary?.trim();
  if (head) parts.push(head);
  const findings = (review.findings ?? []).filter(
    (f) =>
      f.included !== false &&
      f.severity !== 'praise' &&
      f.severity !== 'question',
  );
  for (const f of findings) {
    const loc = f.line != null ? `${f.path}:${f.line}` : f.path;
    const body = (f.editedBody ?? f.body ?? '').trim();
    parts.push(`- [${f.severity}] ${loc} — ${f.title}${body ? `\n  ${body}` : ''}`);
  }
  return parts.join('\n\n');
}

// Surface (Pro, aiFix): hand a completed review to the agentic fixer. Opens the AI
// Fix tab seeded with the review text. Gated on the aiFix capability; renders nothing
// otherwise or until a review has succeeded.
function GenerateFixFromReview({
  prId,
  review,
}: {
  prId: number;
  review: ClaudeReview | null;
}): JSX.Element | null {
  const { aiFix } = useProCapabilities();
  const openAiFixFromReview = useFilters((s) => s.openAiFixFromReview);
  if (!aiFix || review?.status !== 'succeeded') return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => openAiFixFromReview(prId, buildReviewSeed(review))}
        className="whitespace-nowrap rounded border border-violet-400 px-2.5 py-1 text-xs text-violet-700 hover:bg-violet-50 dark:border-violet-600 dark:text-violet-300 dark:hover:bg-violet-900/30"
        title="Launch an agent to apply this review as a fix"
      >
        Generate fix from this review →
      </button>
    </div>
  );
}

export function ClaudeReviewTab({
  pr,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  usersById,
}: {
  pr: PrDetail;
  usersById: Map<number, User>;
}): JSX.Element {
  const { data, isLoading } = useClaudeReview(pr.id);
  const review = data?.review ?? null;

  // Model picker (defaults to the last run's model, else sonnet).
  const [model, setModel] = useState<ClaudeReviewModel>(
    review?.model ?? 'claude-sonnet-4-6',
  );

  // Review depth. 'auto' lets the deterministic router decide from the diff; the
  // user can override to force a Quick (diff-only) or Deep (worktree) review.
  const [reviewModeChoice, setReviewModeChoice] =
    useState<RequestedReviewMode>('auto');

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
    setModel(review.model);
    setPreview(null);
    setPostResult(null);
    setConfirmPost(false);
  }, [review]);

  const isRunning = review?.status === 'running' || review?.status === 'queued';
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

  if (data?.enabled === false) {
    return (
      <div className="px-4 py-3">
        <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
          Claude Review is disabled. Set{' '}
          <code className="font-mono text-xs">ENABLE_CLAUDE_REVIEW=true</code> to
          turn it on.
        </div>
      </div>
    );
  }

  const alreadyReviewed =
    review?.status === 'succeeded' && review.headSha === pr.headSha;

  const runGenerate = (): void => {
    // Create/resume the AudioContext now, during this user gesture, so the
    // completion chime can play later without one (browsers gate WebAudio behind
    // a gesture). No-op / swallowed if WebAudio is unavailable.
    unlockReviewSound();
    setConfirmRerun(false);
    setPreview(null);
    setPostResult(null);
    generate.mutate({ model, mode: reviewModeChoice });
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
    <div className="divide-y divide-gray-100 py-1 dark:divide-gray-800">
      {/* Auth gate — replaces the run controls until Claude auth is set. */}
      {data?.auth === 'none' ? (
        <div className="px-4 py-3">
          <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300">
            <div className="font-semibold">Claude authentication needed</div>
            <div className="mt-1">
              {data.authMessage ??
                'Claude is not authenticated. Set up Claude credentials to run a review.'}
            </div>
          </div>
          {/* The fix: paste an Anthropic key (prominent in the no-auth state). */}
          <ApiKeyPanel
            prId={pr.id}
            hasUserKey={data.hasUserKey}
            prominent
          />
        </div>
      ) : (
        <>
        <div className="px-4 py-3">
          {/* Surface 1 (Pro): matches from past reviews, injected into this run. */}
          <ReviewLearningsPanel prId={pr.id} />
          {/* Pro (aiFix): hand this completed review to the agentic fixer. */}
          <GenerateFixFromReview prId={pr.id} review={review} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs uppercase tracking-wide text-gray-400">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ClaudeReviewModel)}
              disabled={isRunning || generate.isPending}
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {CLAUDE_REVIEW_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label className="text-xs uppercase tracking-wide text-gray-400">
              Depth
            </label>
            <select
              value={reviewModeChoice}
              onChange={(e) =>
                setReviewModeChoice(e.target.value as RequestedReviewMode)
              }
              disabled={isRunning || generate.isPending}
              title="How deep to review: Auto decides from the diff; Quick reviews the diff only (fast, no repository access); Deep clones the repo and explores callers/dependents."
              className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
            >
              {REQUESTED_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onRunClick}
              disabled={isRunning || generate.isPending}
              className="rounded border border-gray-300 px-2 py-1 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              {review == null ? 'Run review' : 'Re-review'}
            </button>
            <span
              className="font-mono text-xs text-gray-400"
              title={pr.headSha ?? undefined}
            >
              {shortSha(pr.headSha)}
            </span>
          </div>

          {/* Depth hint — the PR's size + what the chosen depth will do. */}
          <div className="mt-1 text-xs text-gray-400">
            {plural(pr.changedFilesCount, 'file')} ·{' '}
            {plural(pr.additions + pr.deletions, 'line')} changed.{' '}
            {reviewModeChoice === 'auto'
              ? 'Auto picks Quick (diff-only) for small, localized changes and Deep (worktree) for large or contract-changing ones.'
              : reviewModeChoice === 'diff_only'
                ? 'Quick: reviewed from the diff alone — fast, no repository exploration.'
                : 'Deep: clones the repo and explores callers/dependents — slower, thorough.'}
          </div>

          {/* Same-SHA warn-but-allow confirmation. */}
          {confirmRerun && (
            <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-300">
              <div>
                You already reviewed this exact commit (
                <span className="font-mono">{shortSha(pr.headSha)}</span>).
                Re-running will incur additional cost.
              </div>
              <div className="mt-1.5 flex gap-2">
                <button
                  type="button"
                  onClick={runGenerate}
                  className="rounded border border-amber-400 px-2 py-0.5 text-xs hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900/40"
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
            </div>
          )}

          {generate.isError && (
            <div className="mt-2 text-xs text-red-500">
              {(generate.error as Error)?.message ?? 'Failed to start review.'}
            </div>
          )}
        </div>
        {/* Compact key management — only when the user has their OWN stored key to
            manage. If ambient auth (an env ANTHROPIC_API_KEY / OAuth token / logged-in
            session) already satisfies Claude, there's nothing to add, so we hide it. */}
        {data != null && data.hasUserKey && (
          <ApiKeyPanel
            prId={pr.id}
            hasUserKey={data.hasUserKey}
            prominent={false}
          />
        )}
        </>
      )}

      {/* Running progress. The bar is mounted OUTSIDE the isRunning gate so it observes
          the running→done transition and plays its 100%→fade-out completion (it renders
          null when idle, so this adds no chrome otherwise). */}
      <div className="px-4">
        <RegenProgressBar
          active={isRunning}
          label="Running Claude review"
          value={reviewProgressPct(status)}
          timeConstantSec={30}
        />
      </div>
      {isRunning && (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            <span>{phaseLabel}…</span>
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
              <span title="Output tokens generated so far">
                ↓ {fmtTokens(status.progress.usage.outputTokens)} out
              </span>
              <span title="New (uncached) input tokens billed so far">
                ↑ {fmtTokens(status.progress.usage.inputTokens)} in
              </span>
              <span title="Cached input tokens read so far (billed at ~10% of input)">
                ⟳ {fmtTokens(status.progress.usage.cacheReadTokens)} cache
              </span>
              <span
                className="font-semibold text-gray-600 dark:text-gray-300"
                title="Estimated cost so far. The cost recorded when the run finishes is the authoritative figure."
              >
                ~${status.progress.usage.estCostUsd.toFixed(2)}
              </span>
            </div>
          )}
          {/* Live activity feed from the agent run (newest-last). */}
          <ActivityLog lines={status?.progress?.recentActivity ?? []} />
        </div>
      )}

      {/* Failed / cancelled. */}
      {!isRunning && review?.status === 'failed' && (
        <div className="px-4 py-3">
          <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700/60 dark:bg-red-900/20 dark:text-red-400">
            {review.error ?? 'The review failed.'}
          </div>
        </div>
      )}
      {!isRunning && review?.status === 'cancelled' && (
        <div className="px-4 py-3 text-sm text-gray-400">Review cancelled.</div>
      )}

      {/* History selector. */}
      {data != null && data.history.length > 1 && (
        <Row label="History">
          <select
            value={selectedReviewId ?? review?.id ?? ''}
            onChange={(e) => {
              setSelectedReviewId(Number(e.target.value));
              setPreview(null);
              setPostResult(null);
            }}
            className="rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
          >
            {data.history.map((h) => (
              <option key={h.id} value={h.id}>
                {shortSha(h.headSha)} · {h.model} · {h.status} ·{' '}
                {formatDate(h.createdAt)}
                {h.id === review?.id ? ' (latest)' : ''}
              </option>
            ))}
          </select>
        </Row>
      )}

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
          onToggleFinding={(findingId, included) =>
            updateFinding.mutate({ findingId, included })
          }
          onRewordFinding={(findingId, editedBody) =>
            updateFinding.mutateAsync({ findingId, editedBody })
          }
          onPostFinding={(findingId) => postFinding.mutateAsync({ findingId })}
        />
      )}

      {/* Section B — the authored review that gets posted (latest run only). */}
      {canEdit && review != null && review.status === 'succeeded' && review.reviewMode !== 'skip' && (
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm font-semibold">
            Overall review · the PR-level summary comment
          </div>
          <p className="text-xs text-gray-400">
            This is the single <strong>top-level review comment</strong> posted on
            the PR (GitHub&apos;s review summary), together with your verdict
            below. It is <strong>not</strong> a line comment — the inline comments
            come from the findings above that you haven&apos;t{' '}
            <em>ignored</em>. Leave it short or empty if the inline comments say it
            all.
          </p>
          <MentionTextarea
            prId={pr.id}
            value={userBody}
            onChange={setUserBody}
            onBlur={() => updateReview.mutate({ reviewId: review.id, userBody })}
            rows={6}
            placeholder="Overall summary for the PR (markdown, @ to mention). Posted as the review's top-level comment…"
            className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                updateReview.mutate({ reviewId: review.id, userBody })
              }
              disabled={updateReview.isPending}
              title="Save this overall review draft. It's kept until you post to GitHub — it does NOT post anything yet (use “Post to GitHub” below for that)."
              className="rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              Save
            </button>
            <label className="text-xs uppercase tracking-wide text-gray-400">
              Verdict
            </label>
            <select
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
          <p className="text-xs text-gray-400">
            Claude&apos;s text above is reference only — use a finding&apos;s
            Reword box to post your own wording inline, or Copy to pull lines in
            here.
          </p>
        </div>
      )}

      {/* Post actions — latest succeeded run only. */}
      {canEdit && review != null && review.status === 'succeeded' && review.reviewMode !== 'skip' && (
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm font-semibold">Post to GitHub</div>
          {review.postedAt != null && (
            <div className="text-xs text-gray-400">
              Already posted — re-posting is still allowed.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={runPreview}
              disabled={postReview.isPending}
              className="rounded border border-gray-300 px-2 py-0.5 text-sm hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500"
            >
              Preview payload
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
                <span className="text-xs text-gray-500">
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
              <span className="text-xs text-gray-400">working…</span>
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
                <div className="mt-1 text-xs text-gray-500">
                  Plus <strong>{preview.prComments.length}</strong> PR-level comment
                  {preview.prComments.length === 1 ? '' : 's'} for findings outside
                  the PR diff:{' '}
                  {preview.prComments.map((c) => c.path).join(', ')}
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
                <div className="mt-1 text-xs text-green-700/80 dark:text-green-400/80">
                  Plus {postResult.prCommentCount} PR-level comment
                  {postResult.prCommentCount === 1 ? '' : 's'} (findings outside the
                  PR diff).
                </div>
              )}
            </div>
          )}

          {postReview.isError && (
            <div className="text-xs text-red-500">
              {(postReview.error as Error)?.message ??
                'Failed to post review to GitHub.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
