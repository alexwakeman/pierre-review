import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ClaudeFinding,
  ClaudeFindingSeverity,
  ClaudeReview,
  ClaudeReviewModel,
  ClaudeReviewVerdict,
  PostReviewPreview,
  PostReviewResult,
  PrDetail,
  User,
} from '@pierre-review/shared';
import { CLAUDE_REVIEW_MODELS } from '@pierre-review/shared';
import { formatDate } from '../lib/ui.js';
import { unlockReviewSound } from '../lib/sound.js';
import {
  useCancelReview,
  useClaudeReview,
  useClaudeReviewById,
  useClaudeReviewStatus,
  useGenerateReview,
  usePostFinding,
  usePostReview,
  useSetClaudeKey,
  useUpdateFinding,
  useUpdateReview,
} from '../hooks/useClaudeReview.js';
import { Markdown } from './Markdown.js';

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
  const tokens =
    (review.inputTokens ?? 0) + (review.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${tokens.toLocaleString()} tokens`);
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

// One finding row: severity pill, title, a code anchor that links to the line on
// GitHub, the diff hunk it covers, Claude's body, an optional suggestion, a Copy
// button, a "Reword" editor (your own markdown that posts instead of Claude's),
// and an include checkbox.
function FindingRow({
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
  const commentUrl =
    finding.githubCommentId != null
      ? `${prUrl}#discussion_r${finding.githubCommentId}`
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
  const canPostComment = editable && finding.anchored && finding.line != null;

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

  // Post this finding as a single inline comment. If the user typed a reword that
  // isn't saved yet, persist it FIRST — the server reads editedBody from the DB,
  // so without this it would post Claude's text instead of the user's words.
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

  return (
    <li className="rounded border border-gray-100 px-3 py-2 text-sm dark:border-gray-800">
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
            {!finding.anchored && (
              <span
                className="rounded bg-gray-500/10 px-1.5 py-0.5 text-[10px] text-gray-500"
                title="Couldn't map onto an addable diff line — won't post inline"
              >
                unanchored — won't post inline
              </span>
            )}
          </div>

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

          {/* The diff hunk this finding covers. */}
          {finding.diffHunk != null && finding.diffHunk !== '' && (
            <pre className="mt-1 overflow-x-auto rounded bg-gray-50 px-2 py-1.5 font-mono text-xs leading-snug dark:bg-gray-900/60">
              {finding.diffHunk.split('\n').map((l, i) => (
                <div key={i} className={hunkLineClass(l)}>
                  {l === '' ? ' ' : l}
                </div>
              ))}
            </pre>
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

          {editable &&
            (rewording ? (
              <div className="mt-2 space-y-1">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={4}
                  placeholder="Reword this finding in your own words (markdown). This is what gets posted as the inline comment."
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={saveReword}
                    className="rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
                  >
                    Save reword
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRewording(false);
                      setDraft(finding.editedBody ?? '');
                    }}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
                  >
                    Cancel
                  </button>
                  {hasReword && (
                    <button
                      type="button"
                      onClick={clearReword}
                      className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-500 hover:border-gray-400 dark:border-gray-700"
                    >
                      Clear reword
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(finding.editedBody ?? '');
                  setRewording(true);
                }}
                className="mt-1.5 text-xs text-blue-600 hover:underline dark:text-blue-400"
              >
                {hasReword ? 'Edit reword' : 'Reword in my words'}
              </button>
            ))}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <button
            type="button"
            onClick={copy}
            className="rounded border border-gray-300 px-1.5 py-0.5 text-xs hover:border-gray-400 dark:border-gray-700 dark:hover:border-gray-500"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <label
            className="flex items-center gap-1 text-xs text-gray-500"
            title="Include this finding as an inline comment in the full review"
          >
            <input
              type="checkbox"
              checked={finding.included}
              disabled={!editable || !finding.anchored}
              onChange={(e) => onToggle(e.target.checked)}
            />
            include
          </label>
        </div>
      </div>

      {/* Bottom action bar — post this single finding as its own comment. */}
      {(canPostComment || isPosted || postError != null) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 dark:border-gray-800">
          {canPostComment && (
            <button
              type="button"
              onClick={handlePost}
              disabled={busy}
              title="Post just this finding as a single inline comment on the PR (no review submitted)"
              className="whitespace-nowrap rounded border border-blue-400 px-2 py-0.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-600 dark:text-blue-400 dark:hover:bg-blue-900/30"
            >
              {busy
                ? 'Posting…'
                : isPosted
                  ? 'Post again as comment'
                  : 'Post as comment'}
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
        </div>
      )}
    </li>
  );
}

// Section A: Claude's read-only output (verdict, meta, summary, findings). Used
// for both the latest run and a selected past run; `editable` gates the include
// checkboxes (only the latest run can be edited).
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
      <div className="flex items-center gap-2 text-sm font-semibold">
        Claude&apos;s review
        {review.verdict != null && <VerdictBadge verdict={review.verdict} />}
        {review.scope != null && (
          <span className="rounded bg-gray-500/10 px-1.5 py-0.5 text-xs text-gray-500">
            {review.scope}
          </span>
        )}
      </div>
      <div className="text-xs text-gray-500">{metaLine(review)}</div>
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

export function ClaudeReviewTab({
  pr,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  usersById,
}: {
  pr: PrDetail;
  usersById: Map<number, User>;
}): JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading } = useClaudeReview(pr.id);
  const review = data?.review ?? null;

  // Model picker (defaults to the last run's model, else sonnet).
  const [model, setModel] = useState<ClaudeReviewModel>(
    review?.model ?? 'claude-sonnet-4-6',
  );

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
  const { data: status } = useClaudeReviewStatus(pr.id, isRunning);

  // When polling sees the run reach a terminal state, invalidate the full review
  // so the finished result loads. Guard on the transition to avoid a loop.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!isRunning) {
      settledRef.current = false;
      return;
    }
    const s = status?.status;
    const terminal =
      s === 'succeeded' || s === 'failed' || s === 'cancelled' || s === 'idle';
    if (terminal && !settledRef.current) {
      settledRef.current = true;
      void qc.invalidateQueries({ queryKey: ['claude-review', pr.id] });
    }
  }, [isRunning, status?.status, qc, pr.id]);

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
    generate.mutate(model);
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
        {/* Compact key management when auth is already satisfied. */}
        {data != null && (
          <ApiKeyPanel
            prId={pr.id}
            hasUserKey={data.hasUserKey}
            prominent={false}
          />
        )}
        </>
      )}

      {/* Running progress. */}
      {isRunning && (
        <div className="px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
            <span>{phaseLabel}…</span>
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
              Cancel
            </button>
          </div>
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
      {canEdit && review != null && review.status === 'succeeded' && (
        <div className="space-y-2 px-4 py-3">
          <div className="text-sm font-semibold">
            Overall review · the PR-level summary comment
          </div>
          <p className="text-xs text-gray-400">
            This is the single <strong>top-level review comment</strong> posted on
            the PR (GitHub&apos;s review summary), together with your verdict
            below. It is <strong>not</strong> a line comment — the inline comments
            come from the findings you tick <em>include</em> above. Leave it short
            or empty if the inline comments say it all.
          </p>
          <textarea
            value={userBody}
            onChange={(e) => setUserBody(e.target.value)}
            onBlur={() =>
              updateReview.mutate({ reviewId: review.id, userBody })
            }
            rows={6}
            placeholder="Overall summary for the PR (markdown). Posted as the review's top-level comment…"
            className="w-full rounded border border-gray-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                updateReview.mutate({ reviewId: review.id, userBody })
              }
              disabled={updateReview.isPending}
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
      {canEdit && review != null && review.status === 'succeeded' && (
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
              {preview.skippedUnanchored.length > 0 && (
                <div className="mt-1 text-xs text-gray-500">
                  Skipped (unanchored):{' '}
                  {preview.skippedUnanchored.map((s) => s.title).join(', ')}
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
              {postResult.skippedUnanchored.length > 0 && (
                <div className="mt-1 text-xs text-green-700/80 dark:text-green-400/80">
                  Skipped (unanchored):{' '}
                  {postResult.skippedUnanchored.map((s) => s.title).join(', ')}
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
