// The user-story pieces that need MARKDOWN or an HREF, kept out of ClaudeReviewFollowUp.tsx
// (whose source guard keeps every model- or reader-typed string there as plain text):
//
//   JiraStoryView — a story Limn READ from Jira, shown read-only. Its text is the plugin's
//                   markdown conversion of the ticket, through the sanitising <Markdown>.
//   JiraKeyLink   — a Jira key linked to its ticket.
//
// A story's results reach GitHub as FINDINGS (each with the finding card's own Post / Reword /
// Ignore); the per-ticket "Post as comment" is retired. Every href here goes through
// `safeExternalUrl` (a Jira browse URL is customer-typed).
import type { ReactNode } from 'react';
import { safeExternalUrl } from '../lib/ui.js';
import type { TicketDraft } from '../lib/claudeReviewFollowUp.js';
import { Markdown } from './Markdown.js';
import { ExternalLinkIcon } from './Icons.js';

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
