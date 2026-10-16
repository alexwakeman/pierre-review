import { useEffect, useRef, useState } from 'react';
import { mermaidConfig, readMermaidTokens } from '../lib/mermaidTheme.js';
import { CopyButton } from './CopyButton.js';

// ONE MERMAID DIAGRAM — the shared renderer for the sequence diagrams (Claude Review tab, This
// Sprint's ticket drawer). docs/FRONTEND.md § Sequence diagrams.
//
//   LAZY       `mermaid` is a dynamic import (its own chunks), loaded on the first diagram shown — it
//              never enters the initial bundle.
//   STRICT     initialised with securityLevel 'strict' and plain-text labels (lib/mermaidTheme.ts);
//              the source was validated and stripped by the server before it was stored.
//   THEMED     the app's `--ai-*` tokens through Mermaid's 'base' theme, re-rendered when the page
//              flips between light and dark (the `dark` class on <html>).
//   FALLBACK   a render error shows the SOURCE in a code block, never a blank box. Copy is always
//              there (the Mermaid source, verbatim).

type MermaidApi = typeof import('mermaid')['default'];
let loading: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then((m) => m.default);
  return loading;
}

// Mermaid's render() keeps module state between its parse and layout passes, so two diagrams drawn at
// once (the Claude Review tab shows the PR's and the story's together) can break each other: every
// render goes through ONE chain, in order.
let chain: Promise<unknown> = Promise.resolve();
function renderInTurn<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => undefined);
  return next;
}

let seq = 0;
const isDark = (): boolean => document.documentElement.classList.contains('dark');

function useDarkClass(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

type RenderState = { status: 'loading' } | { status: 'ok'; svg: string } | { status: 'error' };

export function SequenceDiagram({ source, label }: { source: string; label: string }): JSX.Element {
  const dark = useDarkClass();
  const [state, setState] = useState<RenderState>({ status: 'loading' });
  const [showSource, setShowSource] = useState(false);
  // Actual size by default (a wide flow shrunk to the pane is unreadable); Fit shows the whole shape.
  const [fit, setFit] = useState(false);
  const idRef = useRef<string>('');
  if (idRef.current === '') idRef.current = `limn-mmd-${(seq += 1)}`;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const id = `${idRef.current}-${dark ? 'd' : 'l'}`;
    void renderInTurn(() => loadMermaid()
      .then(async (mermaid) => {
        const css = getComputedStyle(document.documentElement);
        mermaid.initialize(
          mermaidConfig(
            readMermaidTokens((n) => css.getPropertyValue(n), dark),
            dark,
          ) as Parameters<MermaidApi['initialize']>[0],
        );
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setState({ status: 'ok', svg });
      })
      .catch((err: unknown) => {
        console.warn('sequence diagram did not render', err);
        if (!cancelled) setState({ status: 'error' });
      })
      .finally(() => {
        // Mermaid leaves its scratch element behind on a parse error.
        document.getElementById(`d${id}`)?.remove();
        document.getElementById(id)?.remove();
      }));
    return () => {
      cancelled = true;
    };
  }, [source, dark]);

  return (
    <div className="space-y-1">
      {state.status === 'loading' && <p className="text-xs text-gray-500 dark:text-gray-400">Drawing the diagram…</p>}
      {state.status === 'error' && (
        <p className="text-xs text-amber-700 dark:text-amber-300">This diagram could not be drawn. Its source is below.</p>
      )}
      {state.status === 'ok' && (
        <div
          role="img"
          aria-label={label}
          className={`max-h-[70vh] overflow-auto rounded border border-gray-200 bg-[rgb(var(--ai-surface))] p-2 dark:border-gray-800 [&_svg]:mx-auto [&_svg]:h-auto ${fit ? '[&_svg]:max-w-full' : '[&_svg]:max-w-none'}`}
          // Mermaid's own output at securityLevel 'strict' (sanitised by its DOMPurify pass), from a
          // source the server validated.
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        {state.status === 'ok' && (
          <button
            type="button"
            aria-pressed={fit}
            onClick={() => setFit((v) => !v)}
            className="text-xs text-sky-700 hover:underline dark:text-sky-300"
          >
            {fit ? 'Actual size' : 'Fit to width'}
          </button>
        )}
        {state.status === 'ok' && (
          <button
            type="button"
            aria-expanded={showSource}
            onClick={() => setShowSource((v) => !v)}
            className="text-xs text-sky-700 hover:underline dark:text-sky-300"
          >
            {showSource ? 'Hide source' : 'Show source'}
          </button>
        )}
        <CopyButton text={source} what="diagram source" title="Copy the Mermaid source" />
      </div>
      {(state.status === 'error' || showSource) && (
        <pre className="max-h-80 overflow-auto rounded bg-gray-50 px-2 py-1 font-mono text-xs leading-snug text-gray-800 dark:bg-gray-900 dark:text-gray-200">
          {source}
        </pre>
      )}
    </div>
  );
}
