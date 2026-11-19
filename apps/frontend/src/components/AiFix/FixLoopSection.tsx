// AI FIX'S OWN REVIEW LOOP in the AI Fix tab (AiFix.loop; docs/CLAUDE-REVIEW.md § AI Fix → The review loop):
// the rounds strip (round k: found / fixed / answered / pushed back / cannot meet), the progress or the stop
// line, the criteria the agent says cannot be done (still NOT MET), each round's findings behind a toggle, and
// Stop while it works. The pure folds are lib/aiFixSession.ts (`fixLoopStrip`, `fixLoopStatusLine`, …).
import { useState } from 'react';
import { aiFixLoopRunning, cannotMeetLine, type AiFixLoop } from '@pierre-review/shared';
import { fixLoopCannotMeetLines, fixLoopStatusLine, fixLoopStrip, type FixLoopStripRow } from '../../lib/aiFixSession.js';
import { useCancelFix } from '../../hooks/useAiFix.js';
import { InfoButton } from '../InfoModal.js';
import { ChevronIcon } from '../Icons.js';

const TONE: Record<FixLoopStripRow['tone'], string> = {
  ok: 'text-ui-success',
  open: 'text-ui-warn',
  running: 'text-ui-mute',
  bad: 'text-ui-danger',
};

const RESPONSE_WORDS: Record<string, string> = {
  fixed: 'Fixed',
  answered: 'Answered',
  pushed_back: 'Pushed back',
  not_applicable: 'Not applicable',
  cannot_meet: 'Cannot meet',
  not_reported: 'Not answered',
};

/** `showProgress`: say the round here — false when the session's status line already says it (said ONCE). */
export function FixLoopSection({ prId, loop, showProgress = true }: { prId: number; loop: AiFixLoop; showProgress?: boolean }): JSX.Element {
  const running = aiFixLoopRunning(loop);
  const cancel = useCancelFix(prId);
  const [open, setOpen] = useState<number | null>(null);
  const rows = fixLoopStrip(loop);
  const progress = showProgress ? fixLoopStatusLine(loop) : null;
  const cannot = fixLoopCannotMeetLines(loop);
  return (
    <section data-testid="ai-fix-loop" className="mt-3 rounded-ui border border-ui-line p-2">
      <div className="flex flex-wrap items-center gap-2 text-meta">
        <span className="font-medium text-ui-ink">Review rounds</span>
        <InfoButton title="Review rounds">
          <p>
            After the agent fixes, Ensemble reviews its work before anything is pushed. The agent fixes, answers or
            pushes back on each point, and Ensemble reviews again, up to {loop.rounds} {loop.rounds === 1 ? 'round' : 'rounds'} (Settings → AI → AI Fix).
          </p>
          <p className="mt-2">The review runs on a copy of the fix in Ensemble. Nothing reaches GitHub until you push, or a push rule you switched on pushes.</p>
          <p className="mt-2">After the push, the last review shows in the AI Review tab as the review of the pushed commit. It is not posted.</p>
        </InfoButton>
        {running && (
          <button
            type="button"
            data-testid="ai-fix-loop-stop"
            className="ml-auto inline-flex h-7 items-center rounded-ui bg-ui-raise px-2.5 text-meta text-ui-ink hover:bg-ui-hover disabled:opacity-50"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Stop
          </button>
        )}
      </div>
      {progress != null && (
        <p data-testid="ai-fix-loop-progress" className="mt-1 text-meta text-ui-mute">
          {progress}
        </p>
      )}
      {!running && loop.stopLine != null && (
        <p data-testid="ai-fix-loop-stop-line" className="mt-1 text-meta text-ui-mute">
          {loop.stopLine}
        </p>
      )}
      {rows.length > 0 && (
        <ol data-testid="ai-fix-loop-rounds" className="mt-2 space-y-1">
          {rows.map((r) => {
            const round = loop.history.find((h) => h.round === r.round)!;
            const expanded = open === r.round;
            const any = round.findings.length + round.criteria.length > 0;
            return (
              <li key={r.round} data-testid="ai-fix-loop-round" className="text-meta">
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 text-left disabled:cursor-default"
                  aria-expanded={any ? expanded : undefined}
                  disabled={!any}
                  onClick={() => setOpen(expanded ? null : r.round)}
                >
                  {any && <ChevronIcon dir={expanded ? 'down' : 'right'} size={12} className="shrink-0" />}
                  <span className="font-medium text-ui-ink">{r.title}</span>
                  <span className={TONE[r.tone]}>{r.status}</span>
                  <span className="text-ui-mute">
                    {r.cells.map((c) => `${c.n} ${c.label}`).join(' · ')}
                  </span>
                </button>
                {expanded && (
                  <ul className="mt-1 space-y-1 border-l border-ui-line pl-3">
                    {round.findings.map((f) => (
                      <li key={`f${f.id}`}>
                        <span className="text-ui-mute">{f.severity}</span> <span className="text-ui-ink">{f.title}</span>{' '}
                        <span className="font-mono text-ui-mute">
                          {f.path}
                          {f.line != null ? `:${f.line}` : ''}
                        </span>
                        {f.response != null && (
                          <div className="text-ui-mute">
                            {RESPONSE_WORDS[f.response.action] ?? f.response.action}
                            {f.response.text ? `: ${f.response.text}` : ''}
                          </div>
                        )}
                      </li>
                    ))}
                    {round.criteria.map((c) => (
                      <li key={`c${c.ref}`}>
                        <span className="font-mono text-ui-mute">{c.ref}</span> <span className="text-ui-ink">{c.text}</span>
                        {c.status === 'met_unlinked' && (
                          <div className="text-ui-mute" data-testid="ai-fix-loop-met-unlinked">
                            Only in a pull request on the same branch that is not linked to the ticket
                          </div>
                        )}
                        {c.response != null && (
                          <div className="text-ui-mute">
                            {c.response.action === 'cannot_meet'
                              ? cannotMeetLine(c.response.text)
                              : `${RESPONSE_WORDS[c.response.action] ?? c.response.action}${c.response.text ? `: ${c.response.text}` : ''}`}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {cannot.length > 0 && (
        <ul data-testid="ai-fix-loop-cannot-meet" className="mt-2 space-y-0.5 text-meta">
          {cannot.map((c) => (
            <li key={c.ref}>
              <span className="font-mono text-ui-mute">{c.ref}</span> <span className="text-ui-ink">{c.text}</span>
              <div className="text-ui-warn">{c.line}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
