import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// THE STORY ENGINE shared by the landing's animated explanations (EnsembleStory,
// BuildStory). A story is a list of PHASES, each starting AT a time (ms from Play) and
// belonging to one caption STEP. The picture carries one class per phase reached
// (`p-<phase>`), and CSS shows each mark from its phase on.
//
// It plays once when the picture comes into view; Replay plays it again. goTo(k) shows
// every earlier step finished, then plays step k's own phases (the ‹ › arrows).
// The prerendered page, no JS and reduced motion are STILL: every phase reached, nothing
// moving, and the caption replaced by the full list of steps (StoryCaption).
// ---------------------------------------------------------------------------

export interface StoryPlayer<P extends string> {
  root: React.RefObject<HTMLDivElement>;
  reached: Set<P>;
  still: boolean;
  played: boolean;
  /** The caption step on screen: 0 before anything has played. */
  step: number;
  play: () => void;
  goTo: (k: number) => void;
  /** `p-<phase>` for every phase reached, plus `still`. */
  phaseClasses: string;
}

export function useStory<P extends string>(
  phases: readonly P[],
  at: Record<P, number>,
  stepOf: Record<P, number>,
  stepCount: number,
): StoryPlayer<P> {
  const [reached, setReached] = useState<Set<P>>(() => new Set(phases));
  const [still, setStill] = useState(true);
  const [played, setPlayed] = useState(false);
  // The step the reader moved to with the arrows (null while the story plays by itself).
  const [picked, setPicked] = useState<number | null>(null);
  const timers = useRef<number[]>([]);
  const root = useRef<HTMLDivElement>(null);

  const clear = (): void => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  const play = (): void => {
    clear();
    setReached(new Set());
    setPlayed(true);
    setPicked(null);
    for (const ph of phases) {
      timers.current.push(window.setTimeout(() => setReached((r) => new Set(r).add(ph)), at[ph]));
    }
  };

  const goTo = (k: number): void => {
    const n = Math.min(Math.max(k, 1), stepCount);
    clear();
    setPlayed(true);
    setPicked(n);
    setReached(new Set(phases.filter((p) => stepOf[p] < n)));
    const own = phases.filter((p) => stepOf[p] === n);
    const first = Math.min(...own.map((p) => at[p]));
    for (const ph of own) {
      timers.current.push(window.setTimeout(() => setReached((r) => new Set(r).add(ph)), at[ph] - first + 150));
    }
  };

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || typeof IntersectionObserver === 'undefined') return;
    // The section is below the fold, so the reset to the start is not seen.
    setStill(false);
    setReached(new Set());
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          play();
        }
      },
      { threshold: 0.55 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      clear();
    };
    // play/clear only touch refs and setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const last = phases.filter((p) => reached.has(p)).pop();
  const step = picked ?? (last != null ? stepOf[last] : 0);
  const phaseClasses = [still ? 'still' : '', ...phases.filter((p) => reached.has(p)).map((p) => `p-${p}`)]
    .filter(Boolean)
    .join(' ');
  return { root, reached, still, played, step, play, goTo, phaseClasses };
}
