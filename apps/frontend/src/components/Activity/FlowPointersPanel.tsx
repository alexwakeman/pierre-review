import type { FlowPointerKind, FlowPrLink } from '@pierre-review/shared';
import {
  useFlowPointers,
  useFlowPointersGenerating,
  useGenerateFlowPointers,
} from '../../hooks/useFlowPointers.js';
import { SparkleIcon } from '../Icons.js';
import { PrLink } from './ChronologyTables.js';

// Chronology's POINTERS — the one model-written block on the panel, and styled apart from
// everything around it (the `--ai-*` tokens and the sparkle), because a sentence a model wrote must
// never be mistaken for a figure the code measured.
//
// ⚠ THE MODEL WRITES SENTENCES AND CITES PULL REQUESTS — NOTHING ELSE. It never writes a figure
// (the plugin drops any sentence with a digit), never names a person, and every citation was
// checked against the evidence; the links under each pointer come from the LIVE fold.
//
// ⚠ NOTHING GENERATES ON ITS OWN. The GET reads the cache; the button is the only thing that spends.

const KIND_LABEL: Record<FlowPointerKind, string> = {
  pattern: 'Pattern',
  example: 'Worth copying',
  try: 'Try',
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function FlowPointersPanel({
  workspaceId,
  days,
}: {
  workspaceId: number | null;
  days: number;
}): JSX.Element | null {
  const q = useFlowPointers(workspaceId, days);
  const generate = useGenerateFlowPointers(workspaceId, days);
  const generating = useFlowPointersGenerating(workspaceId, days);
  const data = q.data;
  if (data == null || !data.enabled) return null;

  const links = new Map<number, FlowPrLink>(data.links.map((l) => [l.prId, l]));
  const result = data.result;
  const last = generate.data;

  return (
    <section
      data-testid="chronology-pointers"
      className="rounded-lg border border-ai-border bg-ai-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparkleIcon size={14} className="text-ai-signal" />
          <h4 className="text-sm font-semibold text-ai-ink">Pointers</h4>
          {result != null && data.stale && (
            <span className="rounded border border-ai-hairline px-1.5 text-[11px] text-ai-ink">
              Out of date
            </span>
          )}
        </div>
        {!data.empty && (
          <button
            type="button"
            disabled={generating}
            onClick={() => generate.mutate()}
            className="rounded border border-ai-border px-2.5 py-1 text-xs font-medium text-ai-ink hover:bg-ai-surface-2 disabled:opacity-50"
          >
            {generating ? 'Writing…' : result == null ? 'Write pointers' : 'Rewrite'}
          </button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ai-ink">
        Written by a model from the pull requests above: patterns, examples worth copying, and things
        to try. It names no one and writes no figures — the figures are the charts.
      </p>

      {data.empty ? (
        <p className="mt-3 text-xs text-ai-ink">Nothing merged in this window to write about.</p>
      ) : result == null ? (
        <p className="mt-3 text-xs text-ai-ink">
          {q.isLoading ? 'Loading…' : 'No pointers for this window yet. Writing them uses AI credits.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {result.pointers.map((p, i) => (
            <li key={i} className="border-l-2 border-ai-signal/50 pl-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ai-signal">
                {KIND_LABEL[p.kind] ?? p.kind}
              </div>
              <p className="text-sm leading-relaxed text-ai-ink">{p.text}</p>
              <div className="mt-1 flex flex-col gap-0.5 text-xs">
                {p.cites.map((id) => {
                  const l = links.get(id);
                  return l ? <PrLink key={id} pr={l} /> : null;
                })}
              </div>
            </li>
          ))}
        </ul>
      )}

      {result != null && (
        <p className="mt-3 text-[11px] text-ai-ink">
          Written {when(result.generatedAt)} over {result.prCount} pull requests.
          {result.droppedPointers > 0 &&
            ` ${result.droppedPointers} ${result.droppedPointers === 1 ? 'pointer was' : 'pointers were'} dropped for citing nothing real or breaking a rule.`}
          {result.droppedIds > 0 &&
            ` ${result.droppedIds} ${result.droppedIds === 1 ? 'citation' : 'citations'} to pull requests outside the evidence ${result.droppedIds === 1 ? 'was' : 'were'} removed.`}
        </p>
      )}
      {last?.throttled && (
        <p className="mt-1 text-[11px] text-ai-ink">Written moments ago — try again in a minute.</p>
      )}
      {last?.creditsExhausted && (
        <p className="mt-1 text-[11px] text-ai-ink">Out of AI credits for this month.</p>
      )}
      {generate.isError && (
        <p className="mt-1 text-[11px] text-rose-700 dark:text-rose-400">
          {(generate.error as Error)?.message ?? 'Could not write pointers.'}
        </p>
      )}
    </section>
  );
}
