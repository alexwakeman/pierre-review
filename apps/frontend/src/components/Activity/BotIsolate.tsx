import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { AutomatedReviewerKind } from '@pierre-review/shared';
import { effectiveIsolated, toggleIsolated } from '../../lib/botIsolate.js';

// THE ISOLATED BOT, SHARED BY EVERY PER-BOT CHART ON THE BOTS PAGE.
//
// One value per BotsView mount (the rail and the per-repo Bots tab each own one), held here rather
// than in the filters store: it is a reading aid, not a filter, so it is not persisted and it does
// not survive leaving the page. Every chart's legend writes it; every chart reads it and dims the
// other bots (`lib/botIsolate.ts`).

interface BotIsolateValue {
  isolated: string | null;
  toggle: (key: string) => void;
}

const BotIsolateContext = createContext<BotIsolateValue | null>(null);

export function BotIsolateProvider({ children }: { children: ReactNode }): JSX.Element {
  const [isolated, setIsolated] = useState<string | null>(null);
  const toggle = useCallback((key: string) => setIsolated((cur) => toggleIsolated(cur, key)), []);
  const value = useMemo(() => ({ isolated, toggle }), [isolated, toggle]);
  return <BotIsolateContext.Provider value={value}>{children}</BotIsolateContext.Provider>;
}

/** The shared isolation; a chart mounted outside a provider keeps its own (so a legend click is
 *  never a dead button). */
export function useBotIsolate(): BotIsolateValue {
  const ctx = useContext(BotIsolateContext);
  const [local, setLocal] = useState<string | null>(null);
  const localToggle = useCallback((key: string) => setLocal((cur) => toggleIsolated(cur, key)), []);
  const fallback = useMemo(() => ({ isolated: local, toggle: localToggle }), [local, localToggle]);
  return ctx ?? fallback;
}

export interface IsolateLegendBot {
  key: string;
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
}

/**
 * The click-to-isolate legend: one button per bot (swatch + its label — an Ensemble poster reads
 * "Ensemble · alice", the stored label). Pressing one isolates that bot on every chart on the page;
 * pressing it again clears. Renders nothing for fewer than two bots: there is nothing to pick.
 */
export function BotIsolateLegend({
  bots,
  botColor,
}: {
  bots: IsolateLegendBot[];
  botColor: (bot: { login?: string | null; kind: AutomatedReviewerKind }) => string;
}): JSX.Element | null {
  const { isolated, toggle } = useBotIsolate();
  if (bots.length <= 1) return null;
  const eff = effectiveIsolated(
    isolated,
    bots.map((b) => b.key),
  );
  return (
    <div className="mt-1 flex flex-wrap gap-x-1 gap-y-0.5" role="group" aria-label="Bots">
      {bots.map((b) => {
        const on = eff === b.key;
        const faint = eff != null && !on;
        const color = botColor({ login: b.login, kind: b.kind });
        return (
          <button
            key={b.key}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(b.key)}
            title={on ? 'Show every bot' : `Show only ${b.label}`}
            className={`hit inline-flex items-center gap-1 rounded-ui px-1 py-0.5 text-meta hover:bg-ui-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${
              on ? 'font-medium text-ui-ink' : faint ? 'text-ui-faint' : 'text-ui-mute'
            }`}
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: color, opacity: faint ? 0.35 : 1 }}
            />
            {b.label}
          </button>
        );
      })}
    </div>
  );
}
