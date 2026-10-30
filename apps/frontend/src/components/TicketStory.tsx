// A TICKET'S OWN STORY, read-only, as markdown — two mounts of one body:
//
//   StoryDisclosure  — the collapsible "Story" in each Story check block (TicketCoverage.tsx) and the
//                      "As written in Jira" of the Story section (Activity/TicketStorySection.tsx):
//                      the key linked to Jira, the title, description and acceptance criteria, and
//                      for a Jira ticket the field the criteria come from, with the picker, and the
//                      people's comments, collapsed (TicketComments.tsx).
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
import { useSetJiraAcField, useStoredJiraTicket } from '../hooks/useJiraTicket.js';
import { AcFieldPicker } from './ClaudeReviewFollowUp.js';
import { JiraStoryView, StoryText } from './ClaudeReviewTickets.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { TicketComments } from './TicketComments.js';

const MUTED = 'text-ui-mute';
const ERROR_TEXT = 'text-ui-danger';
const BTN =
  'inline-flex h-7 items-center whitespace-nowrap rounded-ui bg-ui-raise px-2.5 text-meta font-medium text-ui-ink hover:bg-ui-hover disabled:cursor-not-allowed disabled:opacity-50 touch:h-10 touch:px-3';
const LINK_BTN = 'text-meta text-ui-accent hover:underline disabled:opacity-50';

/** The stored Jira row, with the criteria-field line and picker. */
function JiraStory({
  prId,
  jiraRef,
  fallback,
}: {
  prId: number;
  jiraRef: TicketRef;
  fallback: ClaudeReviewTicket | null;
}): JSX.Element {
  const { data, isLoading, isError, error } = useStoredJiraTicket(prId, jiraRef.key, true);
  const setField = useSetJiraAcField(prId, jiraRef.key);
  const [picking, setPicking] = useState(false);
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
        {fallback != null && <StoredStory ticket={fallback} url={jiraRef.url} />}
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
        fieldControl={
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta">
              <span className={MUTED}>Criteria from:</span>
              <span className="font-medium text-ui-ink">{acFieldText(draft)}</span>
              {!fixedSource && (
              <button
                type="button"
                onClick={() => setPicking((p) => !p)}
                disabled={setField.isPending}
                aria-expanded={picking}
                className={LINK_BTN}
              >
                Change
              </button>
              )}
              {setField.isPending && <span className={MUTED}>Saving…</span>}
            </div>
            {picking && (
              <div className="rounded-ui border border-ui-line p-2">
                <AcFieldPicker
                  fetched={{ details: data, site: jiraSiteOf(jiraRef.url), chosen }}
                  allowNone={false}
                  disabled={setField.isPending}
                  onChoose={(id) => {
                    if (id === '' || id === chosen) return;
                    setField.mutate(id, { onSuccess: () => setPicking(false) });
                  }}
                />
                {data.acFieldSource === 'setting' && (
                  <button
                    type="button"
                    onClick={() => setField.mutate(null, { onSuccess: () => setPicking(false) })}
                    disabled={setField.isPending}
                    className={`mt-1.5 ${BTN}`}
                  >
                    Reset to default
                  </button>
                )}
              </div>
            )}
            {setField.isError && (
              <p className={`text-meta ${ERROR_TEXT}`}>{setField.error.message || 'Could not save the field.'}</p>
            )}
          </div>
        }
      />
      {/* The people's comments, from the same stored read (docs/TRACKERS.md § Ticket comments). */}
      <TicketComments comments={data.comments} />
    </div>
  );
}

/** A story Limn stored with a run (pasted, or read from Jira at the time). */
function StoredStory({ ticket, url }: { ticket: ClaudeReviewTicket; url: string | null }): JSX.Element {
  const d = ticketDraftFromStored(ticket);
  // A pasted story keeps no key; a key known from the block (and its link) is still shown.
  return (
    <JiraStoryView
      capHeight={false}
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
  label = 'Story',
}: {
  /** Any PR on the ticket (the stored tracker row is read through it); null = none, so only `stored`. */
  prId: number | null;
  jiraRef: TicketRef | null;
  // In order of preference: the latest ticket review's snapshot, then an older run's ticket.
  stored: readonly (ClaudeReviewTicket | null | undefined)[];
  url: string | null;
  /** The toggle's words. */
  label?: string;
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
            prId != null && <JiraStory prId={prId} jiraRef={source.ref} fallback={fallback} />
          ) : (
            <StoredStory ticket={source.ticket} url={url} />
          )}
        </div>
      )}
    </div>
  );
}
