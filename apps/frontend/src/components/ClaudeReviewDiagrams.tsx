// DESIGN DIAGRAMS in the Claude Review tab (docs/FRONTEND.md § Design diagrams): the PR's own design
// and, when the PR is on a ticket with more than one pull request, the whole story's. Drawn by a
// separate Sonnet run after each finished review; Redraw queues one now. `DiagramSlotView` is also what
// This Sprint's ticket drawer shows for a story.
//
// Rules:
//  - Every string from the server renders as PLAIN TEXT; the design renders through <DesignGrid>.
//  - A newer run that refused or failed NEVER hides the last good design: the slot carries both.
//  - Only the reads poll, and only while a run is queued or running (or just after a review).
//  - A card's click-through: THIS PR's file → `onOpenInChanges` (same pane); another PR's (a story
//    card) → `openPrChangesAt`, which opens that PR's pane on its Changes tab at the file.
import {
  aiModelWords,
  aiProviderName,
  type DesignCell,
  type SequenceDiagramMember,
  type SequenceDiagramSlot,
  type StorySequenceDiagramSlot,
} from '@pierre-review/shared';
import { useAiCapabilities, useAiProvider } from '../hooks/useAiCapabilities.js';
import { redrawRefusalText, slotDrawing, slotStatusLine } from '../lib/sequenceDiagrams.js';
import { memberForRef } from '../lib/designGrid.js';
import {
  useRedrawStoryDiagram,
  useRedrawingStory,
  usePrSequenceDiagrams,
  useRedrawPrDiagram,
  useRedrawingPr,
} from '../hooks/useSequenceDiagrams.js';
import { useFilters } from '../store/filters.js';
import { REVIEW_ITEM_TITLE, REVIEW_META, REVIEW_PROSE } from '../lib/reviewStyles.js';
import { DesignGrid, type OpenDesignFile } from './DesignGrid.js';
import { InfoButton } from './InfoModal.js';
import { ReviewSection } from './ReviewSection.js';
import { aiRunLabel } from '@pierre-review/shared';

export { redrawRefusalText };

const BTN =
  'rounded-ui border border-gray-300 px-2 py-0.5 text-meta text-gray-700 hover:border-gray-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-gray-700 dark:text-gray-200 dark:hover:border-gray-500';

type OpenInChanges = (path: string, line: number | null, side: 'LEFT' | 'RIGHT') => void;

/** How the grid reads — the ONE legend, behind the ⓘ of every Design heading. */
export function DesignLegend({ story }: { story: boolean }): JSX.Element {
  const provider = useAiProvider();
  return (
    <div className="space-y-2">
      <p>
        {aiModelWords(provider, 'Sonnet')} reads the change and the code around it, then lays out how it is built: the stages across, the
        layers down, one card per job, with the pattern it uses.
      </p>
      <p>
        The key under the grid names each card border. Grey arrows are the hand-offs that matter; a numbered one is
        named in the key too.
      </p>
      {story && <p>Each card names the pull request that does it.</p>}
      <p>Click a card to open its file in the Changes tab. Empty cells are expected.</p>
      <p>
        It is drawn again after a review of a new commit, unless that is turned off in Settings. Pull requests that
        change no code get none.
      </p>
      <p>{aiProviderName(provider)} works the design out from the code, so check it before relying on it.</p>
    </div>
  );
}

/** One subject's design: its title, caption, the grid itself and the status line. */
export function DiagramSlotView({
  slot,
  redrawing,
  label,
  openFile,
}: {
  slot: SequenceDiagramSlot;
  redrawing: boolean;
  // What the design shows, for assistive tech ("Design of this pull request").
  label: string;
  openFile?: OpenDesignFile;
}): JSX.Element {
  const d = slot.diagram;
  const line = slotStatusLine(slot, redrawing);
  return (
    <div className="space-y-1.5">
      {d != null && d.design != null && (
        <>
          {d.title != null && <p className={REVIEW_ITEM_TITLE}>{d.title}</p>}
          {d.caption != null && <p className={REVIEW_PROSE}>{d.caption}</p>}
          {!d.current && <p className={REVIEW_META}>Drawn for an earlier commit.</p>}
          {d.model && <p className={REVIEW_META}>{aiRunLabel(d.provider, d.model)}</p>}
          <DesignGrid
            design={d.design}
            members={d.kind === 'story' ? d.members : []}
            label={d.title != null ? `${label}: ${d.title}` : label}
            openFile={openFile}
          />
        </>
      )}
      {line != null && <p className={REVIEW_META}>{line}</p>}
    </div>
  );
}

/** Opens a story member's Changes tab at a file (another PR's pane). */
export function useOpenMemberFile(): (m: SequenceDiagramMember, path: string, fromActivity?: boolean) => void {
  const openPrChangesAt = useFilters((s) => s.openPrChangesAt);
  return (m, path, fromActivity) =>
    openPrChangesAt(
      {
        id: m.prId,
        number: m.number,
        title: m.title,
        repoFullName: m.repo,
        authorLogin: null,
        authorDisplayName: null,
        authorAvatarUrl: null,
      },
      path,
      fromActivity ? { fromActivity: true } : undefined,
    );
}

/** The review tab's section. Absent where agentic AI does not run. */
export function ClaudeReviewDiagramsSection({
  prId,
  reviewFinishedAt,
  onOpenInChanges,
}: {
  prId: number;
  // The shown review's finish time: the read waits a short while for the design it queues.
  reviewFinishedAt: string | null;
  // This pane's own "show in Changes" (PrDetail owns the tab state).
  onOpenInChanges?: OpenInChanges;
}): JSX.Element | null {
  const ai = useAiCapabilities();
  const finishedMs = reviewFinishedAt != null ? Date.parse(reviewFinishedAt) : NaN;
  const q = usePrSequenceDiagrams(prId, ai.enabled, Number.isFinite(finishedMs) ? finishedMs : null);
  const redraw = useRedrawPrDiagram(prId);
  const redrawing = useRedrawingPr(prId);
  const openMember = useOpenMemberFile();
  if (!ai.enabled || q.data == null) return null;
  const data = q.data;
  const drawing = redrawing || slotDrawing(data.pr);
  const refusal = redrawRefusalText(redraw.data);
  const openOwn: OpenDesignFile | undefined =
    onOpenInChanges != null ? (_cell, path) => onOpenInChanges(path, null, 'RIGHT') : undefined;

  return (
    <ReviewSection
      title="Design"
      info={
        <InfoButton title="Design">
          <DesignLegend story={data.stories.length > 0} />
        </InfoButton>
      }
      actions={
        <button type="button" className={BTN} disabled={drawing} onClick={() => redraw.mutate()}>
          {drawing ? 'Drawing…' : data.pr.diagram != null ? 'Redraw' : 'Draw'}
        </button>
      }
    >
      <DiagramSlotView slot={data.pr} redrawing={redrawing} label="Design of this pull request" openFile={openOwn} />
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-red-600 dark:text-red-400">{redraw.error.message}</p>}
      {data.stories.map((s) => (
        <StorySlotBlock
          key={s.ident}
          slot={s}
          openFile={(cell, path) => {
            const m = memberForRef(cell.pr, s.diagram?.members ?? []);
            if (m == null) return;
            if (m.prId === prId && onOpenInChanges != null) onOpenInChanges(path, null, 'RIGHT');
            else openMember(m, path);
          }}
        />
      ))}
    </ReviewSection>
  );
}

/** One ticket's whole-story design inside the review section, with its own Redraw. */
function StorySlotBlock({
  slot,
  openFile,
}: {
  slot: StorySequenceDiagramSlot;
  openFile: (cell: DesignCell, path: string) => void;
}): JSX.Element {
  const redraw = useRedrawStoryDiagram(slot.ident);
  const redrawing = useRedrawingStory(slot.ident);
  const drawing = redrawing || slotDrawing(slot);
  const refusal = redrawRefusalText(redraw.data);
  return (
    <div className="space-y-1.5 border-t border-gray-200 pt-3 dark:border-gray-800">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-meta font-semibold text-gray-700 dark:text-gray-200">
          Story design{slot.ticketKey != null ? ` · ${slot.ticketKey}` : ''} · {slot.memberCount} pull requests
        </h4>
        {slot.memberCount >= 2 && (
          <button type="button" className={`ml-auto ${BTN}`} disabled={drawing} onClick={() => redraw.mutate()}>
            {drawing ? 'Drawing…' : slot.diagram != null ? 'Redraw' : 'Draw'}
          </button>
        )}
      </div>
      <DiagramSlotView slot={slot} redrawing={redrawing} label="Design of the whole story" openFile={openFile} />
      {refusal != null && <p className={REVIEW_META}>{refusal}</p>}
      {redraw.isError && <p className="text-meta text-red-600 dark:text-red-400">{redraw.error.message}</p>}
    </div>
  );
}
