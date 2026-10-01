// THE REPORTED BUG, AT THE COMPONENT: queue a PR, navigate away, come back — and the merge row
// offered "Merge ▾" again. `mergeQueueStatus` (pendingCardControls.test.ts) is the pure decision;
// this pins that the COMPONENT acts on it and that both MOUNTS feed it, because any one of these
// would bring the bug straight back with every resolver test still green:
//
//   - deleting MergeControl's queued branch (the row is back to a collapsed "Merge ▾");
//   - a mount dropping `inMergeQueue` / `mergeQueueEntryState` / `syncedAt` (the control then only
//     knows the live answer, which on the board is never fetched).
//
// A remount is the collapsed state with no live answer, so that is what is rendered here: a fresh
// QueryClient (nothing cached, nothing fetched — `useMergeOptions(prId, open)` is disabled while
// collapsed) and the synced facts alone.
//
// No JSX: this directory is plain `.ts` (see vitest.config.ts), so the component is instantiated
// with `createElement` and rendered to static markup.
//
// Run from the workspace that HAS vitest:
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MergeQueueEntryState, PrMergeOptions } from '@pierre-review/shared';
import { MergeControl } from '../src/components/MergeControl.js';

/** The markup's text, tags stripped — what the reader sees. */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'");

/** Every button's label, in order. */
const buttonsOf = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1] ?? '').trim());

function render(
  props: {
    inMergeQueue?: boolean | null;
    mergeQueueEntryState?: MergeQueueEntryState | null;
    syncedAt?: number;
    label?: string;
    showQueuePosition?: boolean;
  },
  /** A merge-options answer an earlier click left in the cache (the control stays collapsed, so
   *  it is read, never fetched). Only its queue half is read on the queued path. */
  cachedQueue?: PrMergeOptions['mergeQueue'],
): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cachedQueue !== undefined) {
    qc.setQueryData(['merge-options', 7], { mergeQueue: cachedQueue } as unknown as PrMergeOptions);
  }
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MergeControl, { prId: 7, githubUrl: 'https://github.com/acme/app/pull/7', ...props }),
    ),
  );
}

describe('MergeControl on a remount, from the synced facts alone', () => {
  it('⚠ a queued PR renders the queue status line and "Remove from queue" — never "Merge ▾"', () => {
    const html = render({ inMergeQueue: true, mergeQueueEntryState: 'awaiting_checks', syncedAt: 1 });
    expect(textOf(html)).toContain('In the merge queue · running checks');
    expect(buttonsOf(html)).toEqual(['Remove from queue']);
  });

  it('…and so does the relabelled board trigger ("Update branch" is not offered either)', () => {
    const html = render({
      inMergeQueue: true,
      mergeQueueEntryState: 'queued',
      syncedAt: 1,
      label: 'Update branch',
    });
    expect(buttonsOf(html)).toEqual(['Remove from queue']);
  });

  it('an ejection leads with "Leaving", in the header chip’s own word', () => {
    const html = render({ inMergeQueue: true, mergeQueueEntryState: 'unmergeable', syncedAt: 1 });
    expect(textOf(html)).toContain('Leaving the merge queue');
    expect(textOf(html)).not.toContain('In the merge queue');
  });

  it('⚠ on the board (`showQueuePosition={false}`) a cached position is never printed', () => {
    // An earlier click's answer, still cached: position 2, ~12 min. The board never refetches it,
    // so it would be an old answer printed as current — and absent after a reload, so the row's
    // words would change with the cache. The PR pane keeps it.
    const queue = {
      enabled: true,
      inQueue: true,
      position: 2,
      state: 'AWAITING_CHECKS',
      entryState: 'awaiting_checks' as const,
      estimatedTimeToMergeMs: 12 * 60_000,
    };
    const facts = { inMergeQueue: true, mergeQueueEntryState: 'awaiting_checks' as const, syncedAt: 1 };
    const board = textOf(render({ ...facts, showQueuePosition: false }, queue));
    expect(board).toContain('In the merge queue · running checks');
    expect(board).not.toContain('position');
    expect(board).not.toContain('min');
    // The same words with nothing cached — the reload case.
    expect(textOf(render({ ...facts, showQueuePosition: false }))).toContain(
      'In the merge queue · running checks',
    );
    // The pane's default keeps the position.
    expect(textOf(render(facts, queue))).toContain(
      'In the merge queue · position 2 · running checks · ~12 min',
    );
  });

  it('a PR that is not queued (or not observed) keeps the collapsed Merge trigger', () => {
    for (const inMergeQueue of [false, null, undefined]) {
      const html = render({ inMergeQueue, syncedAt: 1 });
      expect(buttonsOf(html), String(inMergeQueue)).toEqual(['Merge']);
      expect(textOf(html), String(inMergeQueue)).not.toContain('merge queue');
    }
  });
});

// ── BOTH MOUNTS FEED THE SYNCED FACTS ─────────────────────────────────────────────────────────
//
// A source scan, because a mount that stops passing the three props still typechecks (they are
// optional) and still renders — it just forgets the queue on every remount.

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string => readFileSync(`${here}../src/components/${rel}`, 'utf8');

/** The props block of every `<Name …/>` mount in a file. */
function mounts(src: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (let m = re.exec(src); m != null; m = re.exec(src)) {
    const end = src.indexOf('/>', m.index);
    out.push(src.slice(m.index, end));
  }
  return out;
}

const QUEUE_PROPS = ['inMergeQueue=', 'mergeQueueEntryState=', 'syncedAt='];

describe('every merge-row mount passes its synced queue facts', () => {
  it('the PR pane (ChecksTab) — both controls', () => {
    const src = source('ChecksTab.tsx');
    const all = [...mounts(src, 'MergeControl'), ...mounts(src, 'MergeWhenReadyControl')];
    expect(all.length).toBe(2);
    for (const block of all) {
      for (const prop of QUEUE_PROPS) expect(block, prop).toContain(prop);
    }
    // The pane keeps its live position (its merge-options query is kept live beside it).
    for (const block of mounts(src, 'MergeControl')) expect(block).not.toContain('showQueuePosition');
  });

  it('the Pending board — the merge row, and the "Merge when ready" beside it', () => {
    const src = source('Activity/AttentionCards.tsx');
    const merge = mounts(src, 'MergeControl');
    expect(merge.length).toBeGreaterThan(0);
    for (const block of merge) {
      for (const prop of QUEUE_PROPS) expect(block, prop).toContain(prop);
    }
    // ⚠ And the board's row never prints a position: its merge-options answer is never refetched.
    for (const block of merge) expect(block).toContain('showQueuePosition={false}');
    // The conflicts card mounts "Merge when ready" only for an ARMED intent, whose chip renders
    // whatever the queue says; the merge row's mount is the one that must carry the facts.
    const armable = mounts(src, 'MergeWhenReadyControl').filter((b) =>
      QUEUE_PROPS.every((p) => b.includes(p)),
    );
    expect(armable.length).toBe(1);
  });
});
