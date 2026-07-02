import { useEffect, useState } from 'react';

// A slim progress bar + percentage for a digest regeneration. The Pro refresh is a SINGLE
// non-streaming request (the server loops repos internally and returns them all at once),
// and unchanged repos are cache-skipped — so there's no honest per-repo denominator to poll.
// Instead this eases toward ~92% while the request is in flight (decelerating, so it never
// stalls at a fixed number nor claims to be done early), then snaps to 100% and fades out
// when `active` goes false. It reads as real progress without inventing a false reading.
export function RegenProgressBar({ active }: { active: boolean }): JSX.Element | null {
  // null = hidden. A number 0–100 = shown at that fill.
  const [pct, setPct] = useState<number | null>(null);

  useEffect(() => {
    if (active) {
      const start = performance.now();
      setPct(8);
      const id = window.setInterval(() => {
        const t = (performance.now() - start) / 1000;
        // 8% → ~92%, asymptotic with a ~5s time-constant (63% of the way by 5s).
        setPct(Math.min(92, 8 + 84 * (1 - Math.exp(-t / 5))));
      }, 200);
      return () => window.clearInterval(id);
    }
    // Finished: complete any in-progress bar to 100%, then fade it out. Reading pct via
    // the functional updater keeps this effect's only dependency `active`.
    setPct((p) => (p == null ? null : 100));
    const hideTimer = window.setTimeout(() => setPct(null), 500);
    return () => window.clearTimeout(hideTimer);
  }, [active]);

  if (pct == null) return null;
  const rounded = Math.round(pct);
  return (
    <div className="flex items-center gap-2 px-0.5" aria-live="polite">
      <div
        className="h-1 flex-1 overflow-hidden rounded-full bg-violet-100 dark:bg-violet-950/40"
        role="progressbar"
        aria-valuenow={rounded}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Regenerating digests"
      >
        <div
          className="h-full rounded-full bg-violet-500 transition-[width] duration-200 ease-out dark:bg-violet-400"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-violet-500 dark:text-violet-300">
        {rounded}%
      </span>
    </div>
  );
}
