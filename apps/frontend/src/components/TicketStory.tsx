// A TICKET'S OWN STORY, read-only, as markdown — two mounts of one body:
//
//   StoryDisclosure  — the collapsible "Story" in each Story check block (TicketCoverage.tsx) and the
//                      "As written in Jira" of the Story section (Activity/TicketStorySection.tsx):
//                      the key linked to Jira, the title, description and acceptance criteria, and
//                      for a Jira ticket the field the criteria come from (chosen in Settings → Integrations), and the
//                      people's comments, collapsed (TicketComments.tsx) — except in the story view, whose
//                      Story section shows them OPEN under the disclosure (`withComments={false}` here).
//   (The Open PRs ticket-key modal is GONE, 2026-10-18: the key opens the story view instead,
//    whose Story section carries this disclosure.)
//
// ⚠ CLICK-GATED. The stored Jira row (`GET /api/prs/:id/tracker-ticket?key=`, written by the
// plugin's worker when the PR was received — no Jira call) is fetched only once the disclosure is
// opened. Nothing here fetches on a list's or a card's mount. Pure half:
// lib/ticketStory.ts. Every href goes through `safeExternalUrl`.
import { useId, useState } from 'react';
import type { ClaudeReviewTicket, TicketRef } from '@pierre-review/shared';
import { hasFixedAcSource, jiraSiteOf } from '../lib/jiraTicket.js';
import { pulledAcField, jiraStoryFromDetails, acFieldText } from '../lib/storyTabs.js';
import { ticketDraftFromStored } from '../lib/claudeReviewFollowUp.js';
import { storySourceOf } from '../lib/ticketStory.js';
import { safeExternalUrl } from '../lib/ui.js';
import { useStoredJiraTicket } from '../hooks/useJiraTicket.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { JiraStoryView, StoryText } from './ClaudeReviewTickets.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { TicketComments } from './TicketComments.js';

const MUTED = 'text-ui-mute';
const ERROR_TEXT = 'text-ui-danger';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
const LINK_BTN = 'text-meta text-ui-ink hover:underline disabled:opacity-50';

/** The stored Jira row, with the criteria-field line and picker. */
function JiraStory({
  prId,
  jiraRef,
  fallback,
  linkKey,
  withComments,
}: {
  prId: number;
  jiraRef: TicketRef;
  fallback: ClaudeReviewTicket | null;
  linkKey: boolean;
  withComments: boolean;
}): JSX.Element {
  const { data, isLoading, isError, error } = useStoredJiraTicket(prId, jiraRef.key, true);
  const openSettings = useSettingsModal((st) => st.openSettings);
  // GitHub Issues: the criteria come from a fixed place (sub-issues, a task list, a section), so
  // there is no field to change.
  const fixedSource = hasFixedAcSource(jiraRef);
  if (isLoading) return <p className={`text-meta ${MUTED}`}>Reading {jiraRef.key}…</p>;
  if (isError || data == null) {
    return (
      <div className="space-y-2">
        <p className={`text-meta ${ERROR_TEXT}`}>
          {fixedSource && error instanceof Error && error.message !== '' ? error.message : `Could not read ${jiraRef.key}.`}
        </p>
        {fallback != null && <StoredStory ticket={fallback} url={jiraRef.url} linkKey={linkKey} />}
      </div>
    );
  }
  const chosen = pulledAcField(data);
  const draft = jiraStoryFromDetails(jiraRef, data, chosen);
  return (
    <div className="space-y-2">
      <JiraStoryView
        capHeight={false}
        draft={draft}
        linkKey={linkKey}
        fieldControl={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
            <span className={MUTED}>Criteria from:</span>
            <span className="font-medium text-ui-ink">{acFieldText(draft)}</span>
            {/* The field is chosen per issue type in Settings → Integrations (JiraAcFieldSettings). */}
            {!fixedSource && (
              <button type="button" onClick={() => openSettings('issue-tracker')} className={LINK_BTN}>
                Change in Settings
              </button>
            )}
          </div>
        }
      />
      {/* The people's comments, from the same stored read (docs/TRACKERS.md § Ticket comments) —
          left out where the host shows them itself (the story view's StoryComments). */}
      {withComments && <TicketComments comments={data.comments} />}
    </div>
  );
}

/** A story Limn stored with a run (pasted, or read from Jira at the time). */
function StoredStory({ ticket, url, linkKey }: { ticket: ClaudeReviewTicket; url: string | null; linkKey: boolean }): JSX.Element {
  const d = ticketDraftFromStored(ticket);
  // A pasted story keeps no key; a key known from the block (and its link) is still shown.
  return (
    <JiraStoryView
      capHeight={false}
      linkKey={linkKey}
      draft={{
        ...d,
        ...(ticket.key != null && d.key == null ? { key: ticket.key } : {}),
        ...(url != null && d.url == null ? { url } : {}),
      }}
    />
  );
}

/**
 * The collapsible "Story" of one Story check block. The stored Jira row when Limn can read it for
 * this PR (fetched on open), else the first stored ticket with text.
 */
export function StoryDisclosure({
  prId,
  jiraRef,
  stored,
  url,
  label = 'Ticket',
  linkKey = true,
  withComments = true,
}: {
  /** Any PR on the ticket (the stored tracker row is read through it); null = none, so only `stored`. */
  prId: number | null;
  jiraRef: TicketRef | null;
  // In order of preference: the latest ticket review's snapshot, then an older run's ticket.
  stored: readonly (ClaudeReviewTicket | null | undefined)[];
  url: string | null;
  /** The toggle's words. */
  label?: string;
  /** false: the key is plain text, no link into the tracker (the Story check). */
  linkKey?: boolean;
  /** false: the people's comments are shown by the host (the story view), not here — never twice. */
  withComments?: boolean;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const source = storySourceOf(prId != null ? jiraRef : null, stored);
  if (source.kind === 'none') return null;
  const fallback = stored.find((t): t is ClaudeReviewTicket => t != null) ?? null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="hit inline-flex items-center gap-1 text-meta font-medium text-ui-ink hover:text-ui-ink"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        {label}
      </button>
      {open && (
        <div id={bodyId} className="mt-1.5 rounded-ui border border-ui-line p-2">
          {source.kind === 'jira' ? (
            // `source` is 'jira' only with a PR to read through (above).
            prId != null && <JiraStory prId={prId} jiraRef={source.ref} fallback={fallback} linkKey={linkKey} withComments={withComments} />
          ) : (
            <StoredStory ticket={source.ticket} url={url} linkKey={linkKey} />
          )}
        </div>
      )}
    </div>
  );
}
