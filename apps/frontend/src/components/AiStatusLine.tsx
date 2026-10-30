import { useEffect, useState, type ReactNode } from 'react';

// THE ONE STATUS LINE FOR EVERY AGENTIC PASS while it loads or runs — Claude Review, Check threads,
// the impact note, the work-plan wording, sprint summaries and themes, sprint Ask, the docs check.
// Plain text, no spinner: the stage in words, an optional count ("4 of 12"), and the time since it
// started. Each surface feeds it what it already has (a live stream, a poll, or a request's own
// pending state); this component fetches nothing.

/** "0:07", "2:15", "1:02:03". Exported for tests. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The words the line prints, without the clock. Exported for tests. */
export function aiStatusText(stage: string, count?: { done: number; total: number } | null): string {
  const base = stage.replace(/[.…\s]+$/, '');
  return count != null && count.total > 0
    ? `${base}: ${Math.min(count.done, count.total)} of ${count.total}…`
    : `${base}…`;
}

function toMs(since: string | number | Date | null | undefined): number | null {
  if (since == null) return null;
  const t = since instanceof Date ? since.getTime() : typeof since === 'number' ? since : Date.parse(since);
  return Number.isFinite(t) ? t : null;
}

export function AiStatusLine({
  stage,
  since,
  count,
  className = '',
  children,
}: {
  /** What is happening, in words: "Checking threads", "Summarising tickets". */
  stage: string;
  /** When it started. Omitted ⇒ the clock starts when the line mounts. */
  since?: string | number | Date | null;
  count?: { done: number; total: number } | null;
  className?: string;
  /** A trailing control, e.g. Cancel. */
  children?: ReactNode;
}): JSX.Element {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const start = toMs(since) ?? mountedAt;
  return (
    <span
      data-testid="ai-status-line"
      className={`inline-flex flex-wrap items-center gap-x-1.5 text-meta text-ai-ink ${className}`}
    >
      {/* ⚠ Only the stage is a live region: the clock ticks every second and would be announced
          every second. */}
      <span role="status" aria-live="polite">
        {aiStatusText(stage, count)}
      </span>
      <span aria-hidden="true" className="tabular-nums text-ui-mute">
        {formatElapsed(now - start)}
      </span>
      {children}
    </span>
  );
}
