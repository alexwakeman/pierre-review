// A TICKET'S OWN STORY, read-only, as markdown — two mounts of one body:
//
//   StoryDisclosure  — the collapsible "Story" in each Story check block (TicketCoverage.tsx): the
//                      key linked to Jira, the title, description and acceptance criteria, and for
//                      a Jira ticket the field the criteria come from, with the picker.
//   TicketStoryModal — the Open PRs ticket key's modal: status, type, assignee, the story, and a
//                      small "Open in Jira".
//
// ⚠ CLICK-GATED. The stored Jira row (`GET /api/pro/prs/:id/jira-ticket?key=`, written by the
// plugin's worker when the PR was received — no Jira call) is fetched only once the disclosure is
// opened or the modal is mounted. Nothing here fetches on a list's or a card's mount. Pure half:
// lib/ticketStory.ts. Every href goes through `safeExternalUrl`.
import { useId, useState } from 'react';
import type { ClaudeReviewTicket, TicketRef } from '@pierre-review/shared';
import { jiraSiteOf } from '../lib/jiraTicket.js';
import { pulledAcField, jiraStoryFromDetails, acFieldText } from '../lib/storyTabs.js';
import { ticketDraftFromStored } from '../lib/claudeReviewFollowUp.js';
import {
  storySourceOf,
  ticketModalFacts,
  ticketModalTitle,
  type TicketModalFacts,
} from '../lib/ticketStory.js';
import type { CardTicket } from '../lib/cardTickets.js';
import { safeExternalUrl } from '../lib/ui.js';
import { useSetJiraAcField, useStoredJiraTicket } from '../hooks/useJiraTicket.js';
import { AcFieldPicker } from './ClaudeReviewFollowUp.js';
import { JiraStoryView, StoryText } from './ClaudeReviewTickets.js';
import { ChevronIcon, ExternalLinkIcon } from './Icons.js';
import { InfoModal } from './InfoModal.js';

const MUTED = 'text-gray-500 dark:text-gray-400';
const ERROR_TEXT = 'text-red-600 dark:text-red-400';
const BTN =
  'whitespace-nowrap rounded border border-gray-300 px-2 py-0.5 text-xs hover:border-gray-400 disabled:opacity-50 dark:border-gray-700 dark:hover:border-gray-500';
const LINK_BTN = 'text-xs text-blue-700 hover:underline disabled:opacity-50 dark:text-blue-300';

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
  const { data, isLoading, isError } = useStoredJiraTicket(prId, jiraRef.key, true);
  const setField = useSetJiraAcField(prId, jiraRef.key);
  const [picking, setPicking] = useState(false);
  if (isLoading) return <p className={`text-xs ${MUTED}`}>Reading {jiraRef.key}…</p>;
  if (isError || data == null) {
    return (
      <div className="space-y-2">
        <p className={`text-xs ${ERROR_TEXT}`}>Could not read {jiraRef.key}.</p>
        {fallback != null && <StoredStory ticket={fallback} url={jiraRef.url} />}
      </div>
    );
  }
  const chosen = pulledAcField(data);
  const draft = jiraStoryFromDetails(jiraRef, data, chosen);
  return (
    <JiraStoryView
      capHeight={false}
      draft={draft}
      fieldControl={
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={MUTED}>Criteria from:</span>
            <span className="font-medium text-gray-800 dark:text-gray-200">{acFieldText(draft)}</span>
            <button
              type="button"
              onClick={() => setPicking((p) => !p)}
              disabled={setField.isPending}
              aria-expanded={picking}
              className={LINK_BTN}
            >
              Change
            </button>
            {setField.isPending && <span className={MUTED}>Saving…</span>}
          </div>
          {picking && (
            <div className="rounded border border-gray-200 p-2 dark:border-gray-800">
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
            <p className={`text-xs ${ERROR_TEXT}`}>{setField.error.message || 'Could not save the field.'}</p>
          )}
        </div>
      }
    />
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
}: {
  prId: number;
  jiraRef: TicketRef | null;
  // In order of preference: the latest ticket review's snapshot, then an older run's ticket.
  stored: readonly (ClaudeReviewTicket | null | undefined)[];
  url: string | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const source = storySourceOf(jiraRef, stored);
  if (source.kind === 'none') return null;
  const fallback = stored.find((t): t is ClaudeReviewTicket => t != null) ?? null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 hover:text-gray-900 dark:text-gray-200 dark:hover:text-gray-50"
      >
        <ChevronIcon dir={open ? 'down' : 'right'} className="shrink-0" />
        Story
      </button>
      {open && (
        <div id={bodyId} className="mt-1.5 rounded border border-gray-200 p-2 dark:border-gray-800">
          {source.kind === 'jira' ? (
            <JiraStory prId={prId} jiraRef={source.ref} fallback={fallback} />
          ) : (
            <StoredStory ticket={source.ticket} url={url} />
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_PILL: Record<'new' | 'indeterminate' | 'done', string> = {
  new: 'bg-gray-500/10 text-gray-700 dark:text-gray-300',
  indeterminate: 'bg-blue-500/10 text-blue-700 dark:text-blue-300',
  done: 'bg-green-500/15 text-green-700 dark:text-green-400',
};
const CHIP = 'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium';

function FactsRow({ f, href }: { f: TicketModalFacts; href: string | null }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
      {f.status != null && (
        <span className={`${CHIP} ${f.statusCategory != null ? STATUS_PILL[f.statusCategory] : STATUS_PILL.new}`}>
          {f.status}
        </span>
      )}
      {f.issueType != null && <span>{f.issueType}</span>}
      {f.assignee != null ? <span>{f.assignee.name}</span> : f.read && <span>Unassigned</span>}
      {href != null && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto inline-flex items-center gap-1 text-xs text-blue-700 hover:underline dark:text-blue-300"
        >
          Open in Jira
          <ExternalLinkIcon size={11} />
        </a>
      )}
    </div>
  );
}

/**
 * The Open PRs ticket modal. Mounted only while open, so the stored row is read on the click.
 * `prId` is any PR that names the ticket (the route reads the row through that PR's workspace).
 */
export function TicketStoryModal({
  ticket,
  prId,
  onClose,
}: {
  ticket: CardTicket;
  prId: number;
  onClose: () => void;
}): JSX.Element {
  const { data, isLoading, isError } = useStoredJiraTicket(prId, ticket.key, true);
  const facts = ticketModalFacts(ticket, data);
  const href = safeExternalUrl(ticket.url) ?? null;
  return (
    <InfoModal title={ticketModalTitle(facts)} onClose={onClose} width="lg">
      <FactsRow f={facts} href={href} />
      {isLoading ? (
        <p className={`text-xs ${MUTED}`}>Reading {ticket.key}…</p>
      ) : isError || data == null ? (
        <p className={`text-xs ${MUTED}`}>Limn has not read this ticket from Jira.</p>
      ) : (
        <div className="space-y-3">
          <StoryText description={data.description} acceptanceCriteria={data.acceptanceCriteria ?? ''} capHeight={false} />
        </div>
      )}
    </InfoModal>
  );
}
