// THE THREADS TAB: the review threads without the code (it was the Changes tab's "Threads only"
// view). Inline in the diff they still live in Changes; every thread link lands through ONE helper.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend changesThreads
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PR_DETAIL_TABS } from '../src/store/filters.js';
import { createThreadResolveBus } from '../src/hooks/useResolveEvents.js';

const location = { pathname: '/app/', search: '' };
(globalThis as unknown as { window: unknown }).window = {
  location,
  history: { replaceState: (): void => {} },
};
const { readFromUrl } = await import('../src/hooks/useUrlState.js');

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string =>
  readFileSync(join(here, '../src/components', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the Threads tab', () => {
  it('is a PR detail tab, between Activity and Changes', () => {
    expect([...PR_DETAIL_TABS].slice(0, 4)).toEqual(['overview', 'activity', 'threads', 'changes']);
    expect(read('PrDetail.tsx')).toMatch(/'overview',\s*'activity',\s*'threads',\s*'changes'/);
  });

  it('?prTab=threads opens it, keeping the named thread', () => {
    location.search = '?view=pr-detail:5&prTab=threads&thread=9';
    const out = readFromUrl();
    expect(out.prDetailTab).toEqual({ prId: 5, tab: 'threads' });
    expect(out.selectedThreadId).toBe(9);
  });

  it('every thread selection is shown through ONE helper; rung 4 lands on Threads', () => {
    const src = read('PrDetail.tsx');
    // The selected-thread effect and the Pending comment-card jump both go through showThread.
    expect(src.match(/showThread\(selectedThreadId\)/g)).toHaveLength(1);
    expect(src).toMatch(/showThread\(thread\.id\)/);
    // The Claude Review tab's thread rows too.
    expect(src).toMatch(/onOpenThread=\{showThread\}/);
    const show = src.slice(src.indexOf('const showThread = '), src.indexOf('const openPrFocused'));
    expect(show).toMatch(/setPrDetailTab\(prId, 'threads'\)/);
  });

  it('keeps the guarded filters, the rename-aware fold and "Show in context"', () => {
    const detail = read('PrDetail.tsx');
    expect(detail).toMatch(/selectedPrId === prId \? rawThreadStateFilter : EMPTY_THREAD_STATE_FILTER/);
    expect(detail).toMatch(/<PrThreadsTab[\s\S]*?stateFilter=\{threadStateFilter\}[\s\S]*?openInChangesFor=\{openInChangesFor\}/);
    const tab = read('pr/PrThreadsTab.tsx');
    expect(tab).toMatch(/indexThreadsByPath\(pr\.threads, files\)/);
    expect(tab).toMatch(/pathFor=\{pathFor\}/);
    // A cache read, never a fetch.
    expect(tab).toMatch(/enabled: false/);
  });
});

describe('the Changes tab sticky bar', () => {
  it('is sticky, has no Threads only toggle, and no file delta', () => {
    const src = read('ChangesTab.tsx');
    const header = src.slice(src.indexOf('function Header('), src.indexOf('export function ChangesTab('));
    // Pins under PrDetail's sticky tab strip below md (`--pr-tabs-h`, 0 from md up).
    expect(header).toMatch(/className="sticky top-\[var\(--pr-tabs-h,0px\)\] z-30/);
    expect(src).not.toMatch(/threadsOnly|Threads only|changes-threads/);
    // The PR header already states these.
    expect(header).not.toMatch(/changedFilesCount|pr\.additions|pr\.deletions/);
  });
});

describe('a resolve collapses its inline thread', () => {
  it('the bus reaches only the thread that was resolved, until it unsubscribes', () => {
    const bus = createThreadResolveBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.subscribe(1, a);
    bus.subscribe(2, b);
    bus.emit({ threadId: 1, resolved: true });
    expect(a).toHaveBeenCalledWith(true);
    expect(b).not.toHaveBeenCalled();
    offA();
    bus.emit({ threadId: 1, resolved: false });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('the inline pill shuts on a resolve and opens on an unresolve', () => {
    expect(read('diff/FileDiffView.tsx')).toMatch(
      /bus\.subscribe\(thread\.id, \(resolved\) => decide\(!resolved\)\)/,
    );
  });

  it('ChangesTab records the decision before telling the pill, so an unmounted pill comes back shut', () => {
    const src = read('ChangesTab.tsx');
    const set = src.indexOf('threadOpenMemory.set(e.threadId, !e.resolved)');
    const emit = src.indexOf('resolveBus.emit(e)');
    expect(set).toBeGreaterThan(0);
    expect(emit).toBeGreaterThan(set);
  });
});
