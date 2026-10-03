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
import { criteriaHasOwnHeading } from '../lib/storyTabs.js';
import { Markdown } from './Markdown.js';
import { ExternalLinkIcon } from './Icons.js';

const MUTED = 'text-gray-500 dark:text-gray-400';

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

/**
 * A Jira-read story's tab body: key (linked) and title, the field its criteria came from, then the
 * description and acceptance criteria as markdown. Read-only: the tab's × removes it.
 */
export function JiraStoryView({
  draft,
  actions,
  fieldControl,
}: {
  draft: TicketDraft;
  // Refresh, when this session can read the ticket.
  actions?: ReactNode;
  // "Criteria from: <field> · Change", and the picker when open.
  fieldControl?: ReactNode;
}): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        {draft.key != null && (
          <span className="pt-0.5">
            <JiraKeyLink ticketKey={draft.key} url={draft.url} />
          </span>
        )}
        <span className="min-w-0 flex-1 break-words text-sm font-medium">{draft.title}</span>
        {actions}
      </div>
      {fieldControl}
      {draft.description.trim() !== '' && (
        <div className="max-h-56 overflow-y-auto text-xs">
          <Markdown>{draft.description}</Markdown>
        </div>
      )}
      <div>
        {!criteriaHasOwnHeading(draft.acceptanceCriteria) && (
          <div className={`text-xs font-medium ${MUTED}`}>Acceptance criteria</div>
        )}
        {draft.acceptanceCriteria.trim() !== '' ? (
          <div className="max-h-56 overflow-y-auto text-xs">
            <Markdown>{draft.acceptanceCriteria}</Markdown>
          </div>
        ) : (
          <p className="text-xs text-gray-700 dark:text-gray-300">None taken from this ticket.</p>
        )}
      </div>
    </div>
  );
}
