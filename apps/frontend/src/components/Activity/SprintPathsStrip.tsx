import { useEffect, useRef, useState } from 'react';
import { SPRINT_VISIT_GAP_MS, type SprintPaths, type SprintPathsStatus, type SprintSignal } from '@pierre-review/shared';
import { EyeIcon, LinkIcon, LockIcon, PinIcon, ScalesIcon, TimerIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { SprintProgressBar } from './SprintProgressBar.js';
import { cardFocus, sprintPathsView, stripCards, stripCardsSig, type SprintStripCard } from './sprintPathsModel.js';

// ACTIVITY → THIS SPRINT: THE CRITICAL-PATHS STRIP (`SprintGraphResponse.paths` + `.signals`;
// docs/CLAUDE-REVIEW.md § Sprint paths). ONE row of cards in the ONE order (`stripCards`): Limn's own
// "Since you last looked" and "Pace", the sprint builder's critical paths (riskiest first, each labelled
// with its risk and listing its tickets in order) and call-outs, then Limn's "Out of step" and "Blocked
// outside the sprint". Clicking a card hands its tickets to `onFocus` (the graph zooms to them and
// HIGHLIGHTS them); clicking it again, or "Clear", hands [] (clear). A changed card set clears it.
// Claude's half renders nothing while AI is off — Limn's cards still show (free, no model). With no paths
// yet: one short line from `pathsStatus`. OLDER paths stay on screen, with a quiet "Updating" or the
// failure line. Claude's text carries no number: every number on the page is Limn's.

export interface SprintPathsStripProps {
  paths: SprintPaths | null;
  /** `SprintGraphResponse.pathsStatus`. */
  status: SprintPathsStatus;
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
  path: LinkIcon,
  callout: PinIcon,
  out_of_step: ScalesIcon,
  blocked_outside: LockIcon,
};
const tintOf = (c: SprintStripCard): string => {
  if (c.kind === 'path') {
    if (c.risk === 'high') return 'text-rose-600 dark:text-rose-400';
    if (c.risk === 'medium') return 'text-amber-600 dark:text-amber-400';
    return 'text-gray-500 dark:text-gray-400';
  }
  if (c.kind === 'since_last') return 'text-emerald-600 dark:text-emerald-400';
  if (c.kind === 'pace') return 'text-gray-500 dark:text-gray-400';
  if (c.kind === 'callout') return 'text-sky-600 dark:text-sky-400';
  return 'text-amber-600 dark:text-amber-400';
};

const GAP_MINUTES = Math.round(SPRINT_VISIT_GAP_MS / 60_000);

function PathsInfo({ aiEnabled }: { aiEnabled: boolean }): JSX.Element {
  return (
    <div className="space-y-2 text-sm">
      {aiEnabled && (
        <p>
          Claude picks the <strong>critical paths</strong> &mdash; the chains of tickets that most put the sprint at risk, riskiest first, each
          listed in the order the work must happen &mdash; and up to three <strong>call-outs</strong>, after a sprint read that changed something.
          Limn builds the map Claude reads and counts every number; Claude&rsquo;s words carry none.
        </p>
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

export function SprintPathsStrip({ paths, status, aiEnabled, signals, onFocus }: SprintPathsStripProps): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const view = sprintPathsView({ aiEnabled, paths, status });
  const cards = stripCards(view.kind === 'paths' ? view.paths : null, signals);
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
  const hasHead = view.kind === 'paths' || view.kind === 'message';
  if (!hasHead && cards.length === 0) return null;
  const note = view.kind === 'paths' ? view.note : null;
  const calm = view.kind === 'paths' && view.paths.paths.length === 0 && view.paths.callouts.length === 0;
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
    <InfoButton title="Critical paths">
      <PathsInfo aiEnabled={aiEnabled} />
    </InfoButton>
  );
  return (
    <section data-testid="sprint-paths" data-state={status.state} data-stale={status.stale ? 'true' : undefined} aria-label="Critical paths" className="space-y-2">
      {view.kind === 'paths' ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-800 dark:text-gray-100">
          <span>{calm ? 'No critical paths in this sprint.' : 'Critical paths'}</span>
          {info}
          {note?.kind === 'updating' && (
            <span data-testid="sprint-paths-updating" className={`shrink-0 text-xs font-normal ${MUTED}`}>
              Updating
            </span>
          )}
          {clear}
        </p>
      ) : view.kind === 'message' ? (
        <p className={`flex items-center gap-2 text-xs ${MUTED}`}>
          {view.writing && (
            <SprintProgressBar
              progress={{ kind: 'busy', label: 'Finding the critical paths' }}
              testId="sprint-paths-progress"
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
                    const next = cardFocus(selected, c.key, c.idents);
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
                    <Icon size={12} className={`shrink-0 ${tintOf(c)}`} />
                    {c.label}
                  </span>
                  <span className="text-xs font-semibold text-gray-800 dark:text-gray-100">{c.title}</span>
                  {c.tickets.length > 0 && <span className="text-[11px] text-gray-600 dark:text-gray-300">{c.tickets.join(c.kind === 'path' ? ' → ' : ', ')}</span>}
                  {c.sentence != null && <span className="text-xs text-gray-600 dark:text-gray-300">{c.sentence}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
