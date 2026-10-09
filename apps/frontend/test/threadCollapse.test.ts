// The Threads tab's open/closed rule and what a resolve does to it (lib/threadCollapse.ts).
import { describe, expect, it } from 'vitest';
import {
  applyResolveEvents,
  effectiveResolved,
  EMPTY_THREAD_COLLAPSE,
  pruneOverrides,
  threadIsOpen,
  toggleExpanded,
} from '../src/lib/threadCollapse.js';

const open = (state = EMPTY_THREAD_COLLAPSE, opts: { server: boolean; selected?: boolean; id?: number }) => {
  const id = opts.id ?? 1;
  return threadIsOpen({
    resolved: effectiveResolved(opts.server, id, state.overrides),
    selected: opts.selected ?? false,
    threadId: id,
    state,
  });
};

describe('threadIsOpen', () => {
  it('unresolved is open, resolved is one line, selection forces it open', () => {
    expect(open(undefined, { server: false })).toBe(true);
    expect(open(undefined, { server: true })).toBe(false);
    expect(open(undefined, { server: true, selected: true })).toBe(true);
  });
  it('the reader can open and close a resolved thread', () => {
    const s = toggleExpanded(EMPTY_THREAD_COLLAPSE, 1);
    expect(open(s, { server: true })).toBe(true);
    expect(open(toggleExpanded(s, 1), { server: true })).toBe(false);
  });
});

describe('a resolve collapses the thread at once', () => {
  it('before the refetch, even when it is the selected thread', () => {
    const s = applyResolveEvents(EMPTY_THREAD_COLLAPSE, [{ threadId: 1, resolved: true }]);
    expect(open(s, { server: false })).toBe(false);
    expect(open(s, { server: false, selected: true })).toBe(false);
  });
  it('closes a thread the reader had opened', () => {
    const opened = toggleExpanded(EMPTY_THREAD_COLLAPSE, 1);
    const s = applyResolveEvents(opened, [{ threadId: 1, resolved: true }]);
    expect(open(s, { server: true })).toBe(false);
  });
  it('the reader can re-open it afterwards', () => {
    const s = toggleExpanded(applyResolveEvents(EMPTY_THREAD_COLLAPSE, [{ threadId: 1, resolved: true }]), 1);
    expect(open(s, { server: true, selected: true })).toBe(true);
  });
  it('unresolving re-opens it; writes apply in order', () => {
    const s = applyResolveEvents(EMPTY_THREAD_COLLAPSE, [
      { threadId: 1, resolved: true },
      { threadId: 1, resolved: false },
    ]);
    expect(open(s, { server: true, selected: true })).toBe(true);
    expect(open(s, { server: true })).toBe(true);
  });
  it('touches no other thread', () => {
    const s = applyResolveEvents(EMPTY_THREAD_COLLAPSE, [{ threadId: 1, resolved: true }]);
    expect(open(s, { server: true, selected: true, id: 2 })).toBe(true);
  });
});

describe('pruneOverrides', () => {
  it('drops a local verdict once the server agrees, and keeps it until then', () => {
    const s = applyResolveEvents(EMPTY_THREAD_COLLAPSE, [{ threadId: 1, resolved: true }]);
    expect(pruneOverrides(s, new Map([[1, false]]))).toBe(s);
    expect(pruneOverrides(s, new Map([[1, true]])).overrides.size).toBe(0);
    expect(pruneOverrides(s, new Map()).overrides.size).toBe(0);
  });
  it('a pruned resolve stays collapsed for the selected thread', () => {
    const s = pruneOverrides(
      applyResolveEvents(EMPTY_THREAD_COLLAPSE, [{ threadId: 1, resolved: true }]),
      new Map([[1, true]]),
    );
    expect(open(s, { server: true, selected: true })).toBe(false);
  });
});
