import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SprintTicketRow } from '@pierre-review/shared';
import {
  applyAllSuggestions,
  changedFields,
  draftBaseMoved,
  draftPristine,
  draftStorageKey,
  freshDraft,
  loadStoredDraft,
  rebaseDraft,
  replaceQuoteInMarkdown,
  storeDraft,
  type ApplyAllFinding,
  type ApplyAllProposal,
  type DraftField,
  type TicketDraft,
} from '../../lib/ticketDraft.js';

// The opened ticket's DRAFT (lib/ticketDraft.ts): a copy of its text the reader edits before one
// "Update in <tracker>". Component state, mirrored to localStorage per (workspace, ticket) as an unsent
// draft — never the source of truth, never required.
//
// ⚠ When the ticket's stored text moves under the draft (a `replaceBases` hash differs), each moved
//   field restarts from the new text when it holds nothing worth keeping (`rebaseDraft`: unedited, now
//   equal to the ticket, or just written from this card). Anything else is `moved` — the card says so
//   once and offers Discard, and Update is shut: writing the draft over newer text would lose someone's
//   edit (and the server refuses it as `ticket_changed` anyway).

export interface LastReplace {
  field: DraftField;
  findingId: string;
  before: string;
  after: string;
}

export interface TicketDraftApi {
  draft: TicketDraft;
  /** The fields the draft changed against its own base, in write order. */
  changed: DraftField[];
  /** The ticket's stored text moved under an edited field. */
  moved: boolean;
  setField: (field: DraftField, text: string) => void;
  /** Replace a finding's quote with its suggestion in place; false when the quote is gone. */
  replaceFinding: (field: DraftField, findingId: string, quote: string, suggestion: string) => boolean;
  /** The last Replace, while its result still stands (Undo). */
  lastReplace: LastReplace | null;
  undoReplace: () => void;
  /** "Apply all suggestions" (`applyAllSuggestions`) as ONE step; the count applied (0 = nothing). */
  applyAll: (findings: readonly ApplyAllFinding[], proposals: readonly ApplyAllProposal[], editable: (f: DraftField) => boolean) => number;
  /** The last "Apply all", while its result still stands (Undo restores the draft before it). */
  lastApplyAll: { applied: number } | null;
  undoApplyAll: () => void;
  discard: () => void;
  /** Call for each field the tracker confirmed written (at the base it was written over). */
  markWritten: (field: DraftField) => void;
  /** Fields written and waiting for the re-read. */
  written: DraftField[];
}

export function useTicketDraft(t: SprintTicketRow, workspaceId: number): TicketDraftApi {
  const key = draftStorageKey(workspaceId, t.ident);
  const [draft, setDraft] = useState<TicketDraft>(() => loadStoredDraft(key) ?? freshDraft(t));
  const [lastReplace, setLastReplace] = useState<LastReplace | null>(null);
  const [lastAll, setLastAll] = useState<{ before: TicketDraft; after: TicketDraft; applied: number } | null>(null);
  // field → the base hash it was written over.
  const [writtenAt, setWrittenAt] = useState<Partial<Record<DraftField, string>>>({});

  const moved = draftBaseMoved(draft, t);

  useEffect(() => {
    if (!moved) return;
    const next = rebaseDraft(draft, t, writtenAt);
    if (next !== draft) {
      setDraft(next);
      setLastReplace(null);
      setWrittenAt({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moved, t.replaceBases.description.hash, t.replaceBases.acceptanceCriteria?.hash]);

  // The unsent draft survives a reload; a pristine one leaves nothing behind.
  useEffect(() => {
    storeDraft(key, draftPristine(draft) ? null : draft);
  }, [key, draft]);

  const setField = useCallback((field: DraftField, text: string) => {
    setDraft((d) => (field === 'criteria' && d.text.criteria == null ? d : { ...d, text: { ...d.text, [field]: text } }));
  }, []);

  const replaceFinding = useCallback(
    (field: DraftField, findingId: string, quote: string, suggestion: string): boolean => {
      const before = draft.text[field];
      if (before == null) return false;
      const after = replaceQuoteInMarkdown(before, quote, suggestion);
      if (after == null) return false;
      setDraft((d) => ({
        ...d,
        text: { ...d.text, [field]: after },
        replaced: d.replaced.includes(findingId) ? d.replaced : [...d.replaced, findingId],
      }));
      setLastReplace({ field, findingId, before, after });
      return true;
    },
    [draft.text],
  );

  const standing = lastReplace != null && draft.text[lastReplace.field] === lastReplace.after ? lastReplace : null;

  const undoReplace = useCallback(() => {
    if (standing == null) return;
    setDraft((d) => ({
      ...d,
      text: { ...d.text, [standing.field]: standing.before },
      replaced: d.replaced.filter((id) => id !== standing.findingId),
    }));
    setLastReplace(null);
  }, [standing]);

  const applyAll = useCallback(
    (findings: readonly ApplyAllFinding[], proposals: readonly ApplyAllProposal[], editable: (f: DraftField) => boolean): number => {
      const res = applyAllSuggestions(draft, findings, proposals, editable);
      if (res.applied === 0) return 0;
      setDraft(res.draft);
      setLastReplace(null);
      setLastAll({ before: draft, after: res.draft, applied: res.applied });
      return res.applied;
    },
    [draft],
  );

  const standingAll = lastAll != null && lastAll.after === draft ? lastAll : null;

  const undoApplyAll = useCallback(() => {
    if (standingAll == null) return;
    setDraft(standingAll.before);
    setLastAll(null);
  }, [standingAll]);

  const discard = useCallback(() => {
    setWrittenAt({});
    setDraft(freshDraft(t));
    setLastReplace(null);
    setLastAll(null);
  }, [t]);

  const markWritten = useCallback(
    (field: DraftField) => {
      const at = draft.bases[field];
      if (at != null) setWrittenAt((w) => ({ ...w, [field]: at }));
      setLastReplace(null);
    },
    [draft.bases],
  );

  const changed = useMemo(() => changedFields(draft.base, draft.text), [draft]);
  const written = (Object.keys(writtenAt) as DraftField[]).filter((f) => writtenAt[f] === draft.bases[f]);

  return {
    draft,
    changed,
    moved: moved && !draftPristine(draft),
    setField,
    replaceFinding,
    lastReplace: standing,
    undoReplace,
    applyAll,
    lastApplyAll: standingAll != null ? { applied: standingAll.applied } : null,
    undoApplyAll,
    discard,
    markWritten,
    written,
  };
}
