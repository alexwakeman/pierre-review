import { useEffect, useRef, useState } from 'react';
import { SPRINT_VISIT_GAP_MS, type SprintSignal, type SprintStory, type SprintStoryStatus } from '@pierre-review/shared';
import { EyeIcon, LinkIcon, LockIcon, ScalesIcon, TimerIcon, WarningIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { storylineFocus, sprintStoryView, stripCards, stripCardsSig, type SprintStripCard } from './sprintStoryModel.js';

// ACTIVITY → THIS SPRINT: THE SPRINT STORY STRIP (`SprintGraphResponse.story` + `.signals`;
// docs/CLAUDE-REVIEW.md § Sprint story). Claude's headline, then its "Sprint focus" sentence under a
// visible label, then ONE row of cards in the ONE order (`stripCards`): Limn's own "Since you last
// looked" and "Pace", Claude's storylines (Dependency path / At risk), then Limn's "Out of step" and
// "Blocked outside the sprint". Every card is labelled with what it is, and clicking it hands its tickets
// to `onFocus` (the graph zooms to them and HIGHLIGHTS them, fading the rest); clicking it again, or
// "Clear", hands [] (clear); another card replaces it. A changed card set clears it.
// Claude's half renders nothing while AI is off — Limn's cards still show (free, no model). With no story
// yet: one short line from `storyStatus` (the thin indeterminate bar while the pass is writing — the
// canvas bar runs with it — else when it will be written, or why it could not be). An OLDER story stays on
// screen, with a quiet "Updating" or the failure line. Every number in Claude's text was counted by Limn
// and checked against what Claude was given; Limn's cards are templates over its own counts.

export interface SprintStoryStripProps {
  story: SprintStory | null;
  /** `SprintGraphResponse.storyStatus`. */
  status: SprintStoryStatus;
  /** `SprintGraphResponse.aiEnabled`. */
  aiEnabled: boolean;
  /** `SprintGraphResponse.signals` — Limn's own cards. */
  signals: readonly SprintSignal[];
  /** The card's node idents to zoom to; [] = clear the focus. */
  onFocus: (idents: string[]) => void;
}

const MUTED = 'text-gray-500 dark:text-gray-400';

const KIND_ICON: Record<SprintStripCard['kind'], (p: { size?: number; className?: string }) => JSX.Element> = {
  since_last: EyeIcon,
  pace: TimerIcon,
  chain: LinkIcon,
  risk: WarningIcon,
  out_of_step: ScalesIcon,
  blocked_outside: LockIcon,
};
const KIND_TINT: Record<SprintStripCard['kind'], string> = {
  since_last: 'text-emerald-600 dark:text-emerald-400',
  pace: 'text-gray-500 dark:text-gray-400',
  chain: 'text-sky-600 dark:text-sky-400',
  risk: 'text-amber-600 dark:text-amber-400',
  out_of_step: 'text-amber-600 dark:text-amber-400',
  blocked_outside: 'text-amber-600 dark:text-amber-400',
};

const GAP_MINUTES = Math.round(SPRINT_VISIT_GAP_MS / 60_000);

function StoryInfo({ aiEnabled }: { aiEnabled: boolean }): JSX.Element {
  return (
    <div className="space-y-2 text-sm">
      {aiEnabled && (
        <>
          <p>
            Claude writes the headline, the <strong>Sprint focus</strong> (the sprint&rsquo;s main areas of work) and the{' '}
            <strong>Dependency path</strong> and <strong>At risk</strong> cards from the sprint graph, after a sprint read that changed something.
            Limn picks the tickets for each card and counts every number; an answer with a number Limn did not give Claude is thrown away.
          </p>
          <p>A dependency path is shown only while a ticket on it still waits on unfinished work.</p>
        </>
      )}
      <p>Limn writes the other cards itself, from what it has stored:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          <strong>Since you last looked</strong>: tickets that changed stage, tickets added to the sprint and pull requests merged since your last
          visit. A visit ends after {GAP_MINUTES} minutes away from this page. Shown from your second visit on.
        </li>
        <li>
          <strong>Pace</strong>: how much of the sprint&rsquo;s time has gone (today counts) beside how many of its tickets are Complete. Shown when the
          sprint has dates.
        </li>
        <li>
          <strong>Out of step</strong>: the tracker and the code disagree &mdash; a ticket In review with no open pull request (its code already merged,
          or no pull request at all), Complete with one still open, or Not started with one open.
        </li>
        <li>
          <strong>Blocked outside the sprint</strong>: sprint tickets that depend on a ticket outside the sprint that is not Complete.
        </li>
      </ul>
      <p>Click a card to zoom the graph to its tickets and pick them out with a pink ring. Click it again, or Clear, to see the whole sprint.</p>
    </div>
  );
}

export function SprintStoryStrip({ story, status, aiEnabled, signals, onFocus }: SprintStoryStripProps): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const view = sprintStoryView({ aiEnabled, story, status });
  const cards = stripCards(view.kind === 'story' ? view.story.storylines : [], signals);
  // A different card set (a new pass, the sprint moved): the pick may name a card that is gone or changed.
  const sig = stripCardsSig(cards);
  const lastSig = useRef(sig);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    if (lastSig.current === sig) return;
    lastSig.current = sig;
    if (selectedRef.current != null) {
      setSelected(null);
      onFocus([]);
    }
  }, [sig, onFocus]);
  const hasHead = view.kind === 'story' || view.kind === 'message';
  if (!hasHead && cards.length === 0) return null;
  const note = view.kind === 'story' ? view.note : null;
  const clear =
    selected != null ? (
      <button
        type="button"
        onClick={() => {
          setSelected(null);
          onFocus([]);
        }}
        className="ml-auto shrink-0 rounded px-1.5 text-xs font-normal text-gray-600 underline-offset-2 hover:underline dark:text-gray-300"
      >
        Clear
      </button>
    ) : null;
  const info = (
    <InfoButton title="The sprint story">
      <StoryInfo aiEnabled={aiEnabled} />
    </InfoButton>
  );
  return (
    <section data-testid="sprint-story" data-state={status.state} data-stale={status.stale ? 'true' : undefined} aria-label="Sprint story" className="space-y-2">
      {view.kind === 'story' ? (
        <p className="flex items-start gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
          <span>{view.story.headline}</span>
          {info}
          {note?.kind === 'updating' && (
            <span data-testid="sprint-story-updating" className={`mt-0.5 shrink-0 text-xs font-normal ${MUTED}`}>
              Updating
            </span>
          )}
          {clear}
        </p>
      ) : view.kind === 'message' ? (
        <p className={`flex items-center gap-2 text-xs ${MUTED}`}>
          {view.writing && (
            <SprintProgressBar
              progress={{ kind: 'busy', label: 'Writing the sprint story' }}
              testId="sprint-story-progress"
              className="h-[3px] w-16 shrink-0 rounded-full"
            />
          )}
          <span>{view.text}</span>
          {info}
          {clear}
        </p>
      ) : (
        <p className="flex items-center gap-1.5">
          {info}
          {clear}
        </p>
      )}
      {view.kind === 'story' && view.story.focus != null && (
        <p data-testid="sprint-story-focus" className="text-xs text-gray-700 dark:text-gray-200">
          <span className={`mr-1 text-[11px] font-medium ${MUTED}`}>Sprint focus</span>{' '}
          {view.story.focus}
        </p>
      )}
      {note?.kind === 'failed' && <p className={`text-xs ${MUTED}`}>{note.text}</p>}
      {cards.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          {cards.map((c) => {
            const Icon = KIND_ICON[c.kind];
            const on = selected === c.key;
            return (
              <li key={c.key}>
                <button
                  type="button"
                  aria-pressed={on}
                  data-card={c.kind}
                  onClick={() => {
                    const next = storylineFocus(selected, c.key, c.idents);
                    setSelected(next.selected);
                    onFocus(next.idents);
                  }}
                  className={`flex h-full w-full flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                    on
                      ? 'border-pink-500 bg-pink-50 ring-1 ring-pink-500 dark:border-pink-400 dark:bg-pink-950/40 dark:ring-pink-400'
                      : 'border-gray-200 hover:border-gray-400 hover:bg-gray-50 dark:border-gray-800 dark:hover:border-gray-600 dark:hover:bg-gray-900'
                  }`}
                >
                  {/* The card's function, visible: what KIND of card this is. */}
                  <span className="flex items-center gap-1 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                    <Icon size={12} className={`shrink-0 ${KIND_TINT[c.kind]}`} />
                    {c.label}
                  </span>
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">{c.title}</span>
                  <span className="text-xs text-gray-600 dark:text-gray-300">{c.sentence}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
