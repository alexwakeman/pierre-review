import { useEffect, useState } from 'react';

// A slim progress bar + caption. Two modes:
//
//  • DETERMINATE (`value` given): fills to a real 0–100 reading pushed from an SSE
//    stream — the digest refresh reports N/M repos done, Claude Review maps its
//    phase to a fraction. The bar tracks the honest number; `sub` overrides the
//    right-hand caption (e.g. "3/7").
//  • INDETERMINATE (`value` omitted): eases toward ~92% while `active`, decelerating
//    so it never stalls at a fixed number nor claims done early. The pre-SSE fallback.
//
// Either way it snaps to 100% and fades out when `active` goes false.
export function RegenProgressBar({
  active,
  label = 'Regenerating digests',
  timeConstantSec = 5,
  value,
  sub,
}: {
  active: boolean;
  label?: string;
  timeConstantSec?: number;
  /** 0–100 determinate reading; when provided, overrides the easing animation. */
  value?: number | null;
  /** Overrides the right-hand caption (defaults to the rounded percentage). */
  sub?: string;
}): JSX.Element | null {
  // null = hidden. A number 0–100 = shown at that fill.
  const [pct, setPct] = useState<number | null>(null);
  const determinate = value != null;

  useEffect(() => {
    if (active) {
      if (determinate) {
        // Driven externally — track the real reading (re-runs as `value` changes).
        setPct(Math.max(0, Math.min(100, value)));
        return;
      }
      const start = performance.now();
      setPct(8);
      const id = window.setInterval(() => {
        const t = (performance.now() - start) / 1000;
        // 8% → ~92%, asymptotic with a `timeConstantSec` time-constant.
        setPct(Math.min(92, 8 + 84 * (1 - Math.exp(-t / timeConstantSec))));
      }, 200);
      return () => window.clearInterval(id);
    }
    // Finished: complete any in-progress bar to 100%, then fade it out.
    setPct((p) => (p == null ? null : 100));
    const hideTimer = window.setTimeout(() => setPct(null), 500);
    return () => window.clearTimeout(hideTimer);
  }, [active, determinate, value, timeConstantSec]);

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
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-violet-500 transition-[width] duration-200 ease-out dark:bg-violet-400"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums text-violet-500 dark:text-violet-300">
        {sub ?? `${rounded}%`}
      </span>
    </div>
  );
}
