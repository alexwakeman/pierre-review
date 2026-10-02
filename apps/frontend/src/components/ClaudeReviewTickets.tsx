// The two user-story pieces that need MARKDOWN or an HREF, kept out of ClaudeReviewFollowUp.tsx
// (whose source guard keeps every model- or reader-typed string there as plain text):
//
//   JiraStoryView     — a story Limn READ from Jira, shown read-only. Its text is the plugin's
//                       markdown conversion of the ticket, through the sanitising <Markdown>.
//   TicketPostControl — "Post as comment" for ONE ticket's analysis, then its posted link.
//
// Every href here goes through `safeExternalUrl` (a Jira browse URL is customer-typed, a comment
// URL is GitHub's).
import type { ReactNode } from 'react';
import type { ClaudeReviewTicketEntry } from '@pierre-review/shared';
import { ApiError } from '../api/client.js';
import { usePostTicketAnalysis, useTicketPostPending } from '../hooks/useClaudeReview.js';
import { safeExternalUrl } from '../lib/ui.js';
import type { TicketDraft } from '../lib/claudeReviewFollowUp.js';
import { Markdown } from './Markdown.js';
import { CheckIcon, ExternalLinkIcon } from './Icons.js';

const MUTED = 'text-gray-500 dark:text-gray-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';

/** A Jira key as a link to the ticket (plain text when the URL is not http/https). */
export function JiraKeyLink({ ticketKey, url }: { ticketKey: string; url?: string | null }): JSX.Element {
  const href = url != null ? safeExternalUrl(url) : undefined;
  if (href == null || href === '') {
    return <span className="font-mono text-xs font-semibold">{ticketKey}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-blue-600 hover:underline dark:text-blue-400"
    >
      {ticketKey}
      <ExternalLinkIcon size={11} />
    </a>
  );
}

/** A Jira-read story: key, title, then description and acceptance criteria as markdown. */
export function JiraStoryView({
  draft,
  onRemove,
  acPicker,
}: {
  draft: TicketDraft;
  onRemove: () => void;
  // The "Acceptance criteria from" dropdown, when this session fetched the ticket.
  acPicker?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded border border-gray-200 px-2 py-1.5 dark:border-gray-800">
      <div className="flex items-start gap-2">
        {draft.key != null && <JiraKeyLink ticketKey={draft.key} url={draft.url} />}
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{draft.title}</span>
        <button type="button" onClick={onRemove} className={BTN}>
          Remove
        </button>
      </div>
      {draft.description.trim() !== '' && (
        <div className="mt-1 max-h-48 overflow-y-auto text-xs">
          <Markdown>{draft.description}</Markdown>
        </div>
      )}
      {acPicker}
      {draft.acceptanceCriteria.trim() !== '' && (
        <div className="mt-1">
          <div className={`text-xs font-medium ${MUTED}`}>Acceptance criteria</div>
          <div className="max-h-48 overflow-y-auto text-xs">
            <Markdown>{draft.acceptanceCriteria}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One ticket's "Post as comment", once. Posted ⇒ only the link. `visible: false` from the route
 * means the comment IS on GitHub: say it will show, and never offer a retry (it would post twice).
 */
export function TicketPostControl({
  prId,
  reviewId,
  entry,
  canPost,
}: {
  prId: number;
  reviewId: number;
  entry: ClaudeReviewTicketEntry;
  // The latest run only, like every other write on this screen.
  canPost: boolean;
}): JSX.Element | null {
  const post = usePostTicketAnalysis(prId, reviewId, entry.index);
  const pending = useTicketPostPending(reviewId, entry.index);
  const posted = entry.posted ?? null;
  const justPosted = post.data ?? null;

  if (posted != null || justPosted != null) {
    const url = posted?.url ?? justPosted?.url ?? null;
    const href = url != null ? safeExternalUrl(url) : undefined;
    const chip =
      'inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-[11px] text-green-700 dark:text-green-400';
    return (
      <span className="inline-flex items-center gap-2">
        {href != null && href !== '' ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className={`${chip} hover:underline`}>
            Posted
            <CheckIcon size={11} />
          </a>
        ) : (
          <span className={chip}>
            Posted
            <CheckIcon size={11} />
          </span>
        )}
        {posted == null && justPosted?.visible === false && (
          <span className={`text-xs ${MUTED}`}>It will show here shortly.</span>
        )}
      </span>
    );
  }
  // A ticket the run did not report on has nothing to post (the route answers NotReady).
  if (!canPost || entry.assessment == null || entry.assessment.alignment === 'not_checked') return null;
  // 409 AlreadyPosted re-reads the review (the hook), which then renders the link above.
  const error =
    post.error != null && !(post.error instanceof ApiError && post.error.code === 'AlreadyPosted')
      ? post.error.message
      : null;
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => post.mutate()} disabled={pending} className={BTN}>
        {pending ? 'Posting…' : 'Post as comment'}
      </button>
      {error != null && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
    </span>
  );
}
