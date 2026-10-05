// The pure half of the Claude Review "User stories" panel: one TAB per story. Tab names and
// numbering, add / remove / select, pulling STORED Jira tickets into tabs (merge, dedupe, the cap),
// the session memory that keeps the automatic pull from fighting the reader, and the
// acceptance-criteria field the server picked. No JSX, so it is unit-tested from `test/storyTabs.test.ts`.
//
// ⚠ "STORY N" IS THE NUMBER THE SERVER WILL GIVE THE STORY. The shared check
// (`checkClaudeReviewTickets`) DROPS an all-blank story before the request is stored, and every
// later surface (the stories section, the finding chips "Story 2 · AC1", the GitHub comment lead
// `storyCommentLead`) names a story by its index in that STORED list. The panel used to number by
// the raw position in its own list, blank tabs included, so [BMD-1040, (blank), typed] showed the
// typed story as "Story 3" while the run called it "Story 2". `storyIndexAt` counts the stories
// that will be sent, and a blank tab is "New story", never a number.
import { CLAUDE_REVIEW_MAX_TICKETS, storyName } from '@pierre-review/shared';
import type { JiraTicketDetails, TicketRef } from '@pierre-review/shared';
import {
  EMPTY_TICKET_DRAFT,
  isJiraDraft,
  ticketDraftHasContent,
  type TicketDraft,
} from './claudeReviewFollowUp.js';
import { applyAcCandidate, applyJiraTicket, jiraProvenance, serverAcField } from './jiraTicket.js';

// ---- names ----

/** The 0-based index the run will give `drafts[i]` — null for a blank tab (it is not sent). */
export function storyIndexAt(drafts: readonly TicketDraft[], i: number): number | null {
  const d = drafts[i];
  if (d == null || !ticketDraftHasContent(d)) return null;
  let n = 0;
  for (let j = 0; j < i; j += 1) if (ticketDraftHasContent(drafts[j]!)) n += 1;
  return n;
}

/** A tab's name: the Jira key, else "Story N" (as the run will number it), else "New story". */
export function storyTabLabel(drafts: readonly TicketDraft[], i: number): string {
  const d = drafts[i];
  if (d == null) return '';
  if (isJiraDraft(d) && d.key != null && d.key !== '') return d.key;
  const idx = storyIndexAt(drafts, i);
  return idx == null ? 'New story' : storyName({ key: null }, idx);
}

// ---- add / remove / select ----

export const clampTab = (selected: number, length: number): number =>
  length === 0 ? 0 : Math.min(Math.max(selected, 0), length - 1);

/**
 * "+ Add story" on the closed panel: reveal it with a blank story to type into, or with the stories
 * the reader already has this session. The same array when nothing needs adding.
 */
export function storiesOnOpen(drafts: TicketDraft[]): TicketDraft[] {
  return drafts.length === 0 ? [{ ...EMPTY_TICKET_DRAFT }] : drafts;
}

/** Close: blank typed tabs go (they carry nothing); every story with content stays for next time.
 *  The same array when nothing is dropped. */
export function storiesOnClose(drafts: TicketDraft[]): TicketDraft[] {
  const kept = drafts.filter((d) => isJiraDraft(d) || ticketDraftHasContent(d));
  return kept.length === drafts.length ? drafts : kept;
}

/** A new blank typed story at the end, selected. null at the cap (the Add control is hidden). */
export function addStoryTab(
  drafts: readonly TicketDraft[],
  cap: number = CLAUDE_REVIEW_MAX_TICKETS,
): { drafts: TicketDraft[]; selected: number } | null {
  if (drafts.length >= cap) return null;
  return { drafts: [...drafts, { ...EMPTY_TICKET_DRAFT }], selected: drafts.length };
}

/** Remove tab `i`. The selection stays on the same story, or moves to the neighbour that took its place. */
export function removeStoryTab(
  drafts: readonly TicketDraft[],
  i: number,
  selected: number,
): { drafts: TicketDraft[]; selected: number } {
  const next = drafts.filter((_, j) => j !== i);
  const sel = i < selected ? selected - 1 : selected;
  return { drafts: next, selected: clampTab(sel, next.length) };
}

// ---- pulling from Jira ----

const jiraKeysIn = (drafts: readonly TicketDraft[]): Set<string> =>
  new Set(drafts.filter(isJiraDraft).map((d) => d.key).filter((k): k is string => k != null));

// A blank typed tab carries nothing, so a pull that adds stories replaces it rather than letting it
// hold a slot under the cap.
const keepsSlot = (d: TicketDraft): boolean => isJiraDraft(d) || ticketDraftHasContent(d);

/**
 * The detected keys a pull would add: Jira tickets Limn can read for this PR, not already a tab,
 * not in `skip`, in detection order. `keys` fits under the cap; `overCap` is the rest.
 */
export function jiraKeysToPull(
  fillable: readonly Pick<TicketRef, 'key'>[],
  drafts: readonly TicketDraft[],
  opts: { skip?: ReadonlySet<string>; cap?: number } = {},
): { keys: string[]; overCap: string[] } {
  const cap = opts.cap ?? CLAUDE_REVIEW_MAX_TICKETS;
  const have = jiraKeysIn(drafts);
  const seen = new Set<string>();
  const wanted: string[] = [];
  for (const t of fillable) {
    if (have.has(t.key) || seen.has(t.key) || opts.skip?.has(t.key)) continue;
    seen.add(t.key);
    wanted.push(t.key);
  }
  const room = Math.max(0, cap - drafts.filter(keepsSlot).length);
  return { keys: wanted.slice(0, room), overCap: wanted.slice(room) };
}

/**
 * Pulled Jira stories into the tab list. A key already a tab is REPLACED IN PLACE (a refresh); a
 * new one is appended while there is room. When anything is added, blank typed tabs are dropped
 * first. `selected` is the first added tab, else the first refreshed one, else null.
 */
export function mergePulledStories(
  drafts: readonly TicketDraft[],
  pulled: readonly TicketDraft[],
  cap: number = CLAUDE_REVIEW_MAX_TICKETS,
): { drafts: TicketDraft[]; selected: number | null; added: string[]; refreshed: string[]; overCap: string[] } {
  const have = jiraKeysIn(drafts);
  const adds = pulled.some((p) => p.key != null && !have.has(p.key));
  const out = adds ? drafts.filter(keepsSlot) : [...drafts];
  const added: string[] = [];
  const refreshed: string[] = [];
  const overCap: string[] = [];
  let firstAdded: number | null = null;
  let firstRefreshed: number | null = null;
  for (const p of pulled) {
    if (p.key == null) continue;
    const at = out.findIndex((d) => isJiraDraft(d) && d.key === p.key);
    if (at >= 0) {
      out[at] = p;
      if (!refreshed.includes(p.key) && !added.includes(p.key)) refreshed.push(p.key);
      firstRefreshed ??= at;
    } else if (out.length < cap) {
      out.push(p);
      added.push(p.key);
      firstAdded ??= out.length - 1;
    } else {
      overCap.push(p.key);
    }
  }
  return { drafts: out, selected: firstAdded ?? firstRefreshed, added, refreshed, overCap };
}

/** Fetch several tickets at once; one failure never loses the others. Key order is kept. */
export async function pullJiraTickets(
  keys: readonly string[],
  fetchOne: (key: string) => Promise<JiraTicketDetails>,
): Promise<{ ok: { key: string; details: JiraTicketDetails }[]; failed: { key: string; message: string }[] }> {
  const settled = await Promise.allSettled(keys.map((k) => fetchOne(k)));
  const ok: { key: string; details: JiraTicketDetails }[] = [];
  const failed: { key: string; message: string }[] = [];
  settled.forEach((r, i) => {
    const key = keys[i]!;
    if (r.status === 'fulfilled') ok.push({ key, details: r.value });
    else failed.push({ key, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { ok, failed };
}

const listKeys = (keys: readonly string[]): string =>
  keys.length <= 1 ? (keys[0] ?? '') : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;

/** The one short line after a pull, or null when everything arrived. */
export function pullNote(
  failed: readonly { key: string; message: string }[],
  overCap: readonly string[],
  cap: number = CLAUDE_REVIEW_MAX_TICKETS,
): string | null {
  const parts: string[] = [];
  if (failed.length === 1) parts.push(`Could not read ${failed[0]!.key}: ${failed[0]!.message.replace(/\.$/, '')}.`);
  else if (failed.length > 1) parts.push(`Could not read ${listKeys(failed.map((f) => f.key))}.`);
  if (overCap.length > 0) parts.push(`${listKeys(overCap)} not added: ${cap} stories is the limit.`);
  return parts.length > 0 ? parts.join(' ') : null;
}

// ---- the automatic pull ----

/**
 * Session memory for the automatic pull, per PR: the detected-key set it already acted on (so a
 * remount or tab switch never pulls again) and the keys the reader REMOVED (so it never re-adds
 * one). A manual "Pull all" ignores `removed` and clears it for the keys it pulls.
 */
export interface StoryPullMemory {
  shouldAutoPull: (prId: number, detectedKeys: readonly string[]) => boolean;
  noteAutoPull: (prId: number, detectedKeys: readonly string[]) => void;
  // An automatic pull whose answer was dropped (the panel unmounted first): let the next mount try.
  clearAutoPull: (prId: number) => void;
  removed: (prId: number) => ReadonlySet<string>;
  noteRemoved: (prId: number, keys: readonly string[]) => void;
  unremove: (prId: number, keys: readonly string[]) => void;
}

const keySet = (keys: readonly string[]): string => [...new Set(keys)].sort().join(',');

export function createStoryPullMemory(): StoryPullMemory {
  const attempted = new Map<number, string>();
  const removedByPr = new Map<number, Set<string>>();
  return {
    shouldAutoPull: (prId, keys) => keys.length > 0 && attempted.get(prId) !== keySet(keys),
    noteAutoPull: (prId, keys) => {
      attempted.set(prId, keySet(keys));
    },
    clearAutoPull: (prId) => {
      attempted.delete(prId);
    },
    removed: (prId) => removedByPr.get(prId) ?? new Set<string>(),
    noteRemoved: (prId, keys) => {
      const s = removedByPr.get(prId) ?? new Set<string>();
      for (const k of keys) s.add(k);
      removedByPr.set(prId, s);
    },
    unremove: (prId, keys) => {
      const s = removedByPr.get(prId);
      if (s) for (const k of keys) s.delete(k);
    },
  };
}

/**
 * What the automatic pull fetches for this PR now: [] when it already ran for this detected-key
 * set, or when every detected key is already a tab, was removed by the reader, or has no room.
 * The caller records the attempt (`noteAutoPull`) whether or not anything is fetched, so a failure
 * never loops.
 */
export function autoPullKeys(
  memory: StoryPullMemory,
  prId: number,
  fillable: readonly Pick<TicketRef, 'key'>[],
  drafts: readonly TicketDraft[],
  cap: number = CLAUDE_REVIEW_MAX_TICKETS,
): string[] {
  const detected = fillable.map((t) => t.key);
  if (!memory.shouldAutoPull(prId, detected)) return [];
  return jiraKeysToPull(fillable, drafts, { skip: memory.removed(prId), cap }).keys;
}

// ---- the acceptance-criteria field ----

/**
 * A story from a fetched ticket: title and description, the criteria from field `chosenId` ('' =
 * none, criteria left empty), the field it came from and the issue type, plus Jira provenance.
 */
export function jiraStoryFromDetails(
  ref: Pick<TicketRef, 'key' | 'url'>,
  details: JiraTicketDetails,
  chosenId: string,
  now: Date = new Date(),
): TicketDraft {
  const filled = applyAcCandidate(applyJiraTicket(EMPTY_TICKET_DRAFT, details), details.candidates, chosenId);
  const c = chosenId === '' ? undefined : details.candidates.find((x) => x.id === chosenId);
  return {
    ...filled,
    ...jiraProvenance(ref, now),
    acField: c != null ? { id: c.id, name: c.name } : null,
    issueTypeId: details.issueType?.id ?? null,
  };
}

/**
 * The field a pull uses: the one the SERVER picked for the stored ticket (the workspace's choice for
 * its issue type, else the name match). The panel no longer decides this itself.
 */
export const pulledAcField = (details: JiraTicketDetails): string => serverAcField(details);

/** "Criteria from" value on a Jira tab. */
export function acFieldText(d: Pick<TicketDraft, 'acField'>): string {
  if (d.acField === undefined) return 'not recorded';
  if (d.acField === null) return 'none';
  return d.acField.name;
}

/**
 * Whether a story's criteria markdown OPENS with its own "Acceptance criteria" heading (Jira fields
 * often do: `h1. *ACCEPTANCE CRITERIA*`), so the tab does not print the label above it twice.
 */
export function criteriaHasOwnHeading(md: string): boolean {
  const first = md.trimStart().split('\n', 1)[0] ?? '';
  const m = first.match(/^#{1,6}\s+(.*)$/);
  if (m == null) return false;
  const text = m[1]!.replace(/[*_`:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return text === 'acceptance criteria';
}
