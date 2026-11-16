import type { ReactNode } from 'react';
import type { StoryPlayer } from './useStory';
import './story.css';

export interface StoryStep {
  h: string;
  p: ReactNode;
}

/**
 * The card under a story's picture: the step number, its heading and sentence, Replay and
 * the ‹ › arrows (← → with focus inside). Every caption sits in the same grid cell and only
 * the current one shows, so the card is always as tall as the longest step: nothing below
 * it moves as the story plays. STILL: the full list of steps instead. Either way a hidden
 * list carries every step for screen readers.
 */
export function StoryCaption<P extends string>({
  steps,
  player,
  intro,
}: {
  steps: StoryStep[];
  player: StoryPlayer<P>;
  /** The line before anything has played. */
  intro: string;
}): JSX.Element {
  const { still, step, played, play, goTo } = player;
  return (
    <>
      {still ? (
        <ol className="story-all">
          {steps.map((s, i) => (
            <li key={s.h}>
              <span className="cap-n">{i + 1}</span>
              <span>
                <b>{s.h}.</b> {s.p}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div
          className="story-cap"
          aria-live="polite"
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' && step > 1) goTo(step - 1);
            else if (e.key === 'ArrowRight' && step < steps.length) goTo(step + 1);
            else return;
            e.preventDefault();
          }}
        >
          <div className="cap-stack">
            <p className="cap-wait" aria-hidden={step !== 0} data-on={step === 0 || undefined}>
              {intro}
            </p>
            {steps.map((s, i) => (
              <div key={s.h} className="cap-step" aria-hidden={step !== i + 1} data-on={step === i + 1 || undefined}>
                <span className="cap-n">
                  {i + 1} / {steps.length}
                </span>
                <h3>{s.h}</h3>
                <p>{s.p}</p>
              </div>
            ))}
          </div>
          <div className="cap-nav">
            {played && step === steps.length && (
              <button type="button" className="cap-replay" onClick={play}>
                Replay
              </button>
            )}
            <button type="button" className="cap-arrow" aria-label="Previous step" disabled={step <= 1} onClick={() => goTo(step - 1)}>
              ‹
            </button>
            <button
              type="button"
              className="cap-arrow"
              aria-label="Next step"
              disabled={step >= steps.length}
              onClick={() => goTo(step + 1)}
            >
              ›
            </button>
          </div>
        </div>
      )}

      <ol className="vh">
        {steps.map((s) => (
          <li key={s.h}>
            {s.h}: {s.p}
          </li>
        ))}
      </ol>
    </>
  );
}
