import { create } from 'zustand';
import type { ConflictAiConfidence, ConflictAiResolution, ConflictDecision } from '@pierre-review/shared';
import { regionKey, useConflictResolverStore } from './conflictResolver.js';

// ── WHICH DECISIONS ARE CLAUDE'S ─────────────────────────────────────────────────────────────
//
// "Resolve with Claude" pre-fills the resolver with the decisions Claude made. They are ordinary
// decisions in `store/conflictResolver.ts` — counted, gated and committed exactly like the
// reader's own — and THIS store only remembers which of them came from Claude, so a region can
// wear a "Claude" chip with its one-line reason and "Undo all Claude's choices" knows what to clear.
//
// ⚠ A MARK IS ONLY TRUE WHILE THE DECISION IS STILL CLAUDE'S. It is checked against the live
// decision on every read (`activeMark`): the moment the reader takes another side, the chip goes,
// with no write here. There is nothing to keep in sync.
//
// ⚠ PRE-FILLING NEVER OVERWRITES THE READER. A region the reader already decided keeps their
// decision (the wand's rule): Claude fills only what is still undecided.
//
// ⚠ THIS RELAXES "NOTHING IS APPLIED BEFORE THE READER PRESSES SOMETHING" FOR ONE CASE ONLY — a
// "Resolve with Claude" run the reader started. The resolver opened any other way still opens bare.

export interface ClaudeMark {
  decision: ConflictDecision;
  editId: string | null;
  rationale: string;
  confidence: ConflictAiConfidence;
}

export interface ClaudeRunMarks {
  /** The resolver session key (`resolverSessionKey`) these marks were filed under. */
  key: string;
  runId: string;
  /** `${fileIndex}:${regionId}` → Claude's choice. */
  marks: Record<string, ClaudeMark>;
  /** Decidable regions in the files the resolver supports, from the run. */
  decidableTotal: number;
  summary: string | null;
}

/** What applying one answer does to the reader's decisions. Pure, so the mapping is testable. */
export interface ClaudePrefillPlan {
  /** Regions to decide now — every choice whose region the reader has NOT decided. */
  decide: Array<{
    fileIndex: number;
    regionId: number;
    decision: ConflictDecision;
    editId: string | null;
  }>;
  /** Every choice, decided now or not — a mark only shows while the decision matches it. */
  marks: Record<string, ClaudeMark>;
  /** `editId` → the server's lines, for the centre pane. */
  editLines: Record<string, string[]>;
}

export function claudePrefillPlan(
  resolution: ConflictAiResolution,
  existing: Readonly<Record<string, ConflictDecision>>,
): ClaudePrefillPlan {
  const decide: ClaudePrefillPlan['decide'] = [];
  const marks: Record<string, ClaudeMark> = {};
  const editLines: Record<string, string[]> = {};
  for (const c of resolution.choices) {
    // `'suggestion'` is never Claude's; an `'edited'` choice without its handle and lines cannot
    // be rendered or committed, so it is left for the reader.
    if (c.decision === 'suggestion') continue;
    if (c.decision === 'edited' && (c.editId == null || c.lines == null)) continue;
    const rk = regionKey(c.fileIndex, c.regionId);
    marks[rk] = {
      decision: c.decision,
      editId: c.editId,
      rationale: c.rationale,
      confidence: c.confidence,
    };
    if (c.editId != null && c.lines != null) editLines[c.editId] = c.lines;
    if (existing[rk] !== undefined) continue;
    decide.push({ fileIndex: c.fileIndex, regionId: c.regionId, decision: c.decision, editId: c.editId });
  }
  return { decide, marks, editLines };
}

/** Is this mark still the region's live decision? */
export function markIsLive(
  mark: ClaudeMark | undefined,
  decision: ConflictDecision | undefined,
  editId: string | undefined,
): boolean {
  if (mark == null || decision !== mark.decision) return false;
  return mark.decision !== 'edited' || editId === mark.editId;
}

interface ConflictClaudeState {
  /** The resolver session key the overlay has open, or null. */
  activeKey: string | null;
  /** Per resolver session key. Small: one per open overlay, pruned to the active key on apply. */
  runs: Record<string, ClaudeRunMarks>;
  setActiveKey: (key: string | null) => void;
  record: (run: ClaudeRunMarks) => void;
}

export const useConflictClaudeStore = create<ConflictClaudeState>((set) => ({
  activeKey: null,
  runs: {},
  setActiveKey: (activeKey) => set({ activeKey }),
  record: (run) => set((s) => ({ runs: { ...pickKey(s.runs, s.activeKey), [run.key]: run } })),
}));

function pickKey(runs: Record<string, ClaudeRunMarks>, key: string | null): Record<string, ClaudeRunMarks> {
  if (key == null || runs[key] == null) return {};
  return { [key]: runs[key]! };
}

/** Claude's mark on one region of the OPEN resolver, while the decision is still Claude's. */
export function useClaudeMark(fileIndex: number, regionId: number): ClaudeMark | null {
  const key = useConflictClaudeStore((s) => s.activeKey);
  const mark = useConflictClaudeStore((s) =>
    key == null ? undefined : s.runs[key]?.marks[regionKey(fileIndex, regionId)],
  );
  const live = useConflictResolverStore((s) => {
    if (key == null || mark == null) return false;
    const session = s.sessions[key];
    const rk = regionKey(fileIndex, regionId);
    return markIsLive(mark, session?.decisions[rk], session?.editIds[rk]);
  });
  return live && mark != null ? mark : null;
}

/** How many of Claude's choices are still the live decision, for the banner. */
export function useClaudeLiveCount(): { live: number; run: ClaudeRunMarks | null } {
  const key = useConflictClaudeStore((s) => s.activeKey);
  const run = useConflictClaudeStore((s) => (key == null ? null : (s.runs[key] ?? null)));
  const live = useConflictResolverStore((s) => {
    if (key == null || run == null) return 0;
    const session = s.sessions[key];
    if (session == null) return 0;
    let n = 0;
    for (const [rk, mark] of Object.entries(run.marks)) {
      if (markIsLive(mark, session.decisions[rk], session.editIds[rk])) n += 1;
    }
    return n;
  });
  return { live, run };
}

/** Clear every decision that is still Claude's back to undecided. The reader's own stay. */
export function undoAllClaudeChoices(): void {
  const { activeKey: key, runs } = useConflictClaudeStore.getState();
  if (key == null) return;
  const run = runs[key];
  const resolver = useConflictResolverStore.getState();
  const session = resolver.sessions[key];
  if (run == null || session == null) return;
  for (const [rk, mark] of Object.entries(run.marks)) {
    if (!markIsLive(mark, session.decisions[rk], session.editIds[rk])) continue;
    const [f, r] = rk.split(':').map(Number);
    if (f == null || r == null) continue;
    resolver.decideRegion({ key, fileIndex: f, regionId: r, decision: null });
  }
}
