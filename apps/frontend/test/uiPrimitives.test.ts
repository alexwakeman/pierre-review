import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexAfterRemoval, nextIndex, resolveListKey } from '../src/components/ui/listNav.js';
import { collectCommands, rankCommands, type Command } from '../src/components/ui/commands.js';
import { isPaletteChord, isTypingTarget, shortcutBlocked } from '../src/components/ui/keys.js';
import {
  finalizeUndoOffer,
  removeOptimistically,
  resetUndoForTests,
  undoLast,
  useUndoStore,
} from '../src/components/ui/undo.js';
import { claimActivePopover } from '../src/lib/activePopover.js';

// The redesign's primitives keep their behaviour in pure modules so it can be pinned here, without
// a DOM (docs/redesign/DESIGN.md).

describe('list keyboard model', () => {
  it('moves and clamps, and lands on the first row from no selection', () => {
    expect(nextIndex(null, 5, 'next')).toBe(0);
    expect(nextIndex(null, 5, 'last')).toBe(4);
    expect(nextIndex(0, 5, 'prev')).toBe(0);
    expect(nextIndex(4, 5, 'next')).toBe(4);
    expect(nextIndex(2, 5, 'first')).toBe(0);
    expect(nextIndex(9, 5, 'next')).toBe(0); // stale index after the list shrank
    expect(nextIndex(0, 0, 'next')).toBeNull();
  });

  it('j/k always count; arrows, Enter, Home, End only with focus inside the list', () => {
    const out = { focusInside: false, actionKeys: ['a', 'm', 'e'] };
    const inside = { ...out, focusInside: true };
    expect(resolveListKey('j', out)).toEqual({ kind: 'move', move: 'next' });
    expect(resolveListKey('k', out)).toEqual({ kind: 'move', move: 'prev' });
    expect(resolveListKey('ArrowDown', out)).toBeNull();
    expect(resolveListKey('Enter', out)).toBeNull();
    expect(resolveListKey('ArrowDown', inside)).toEqual({ kind: 'move', move: 'next' });
    expect(resolveListKey('Enter', inside)).toEqual({ kind: 'open' });
    expect(resolveListKey('End', inside)).toEqual({ kind: 'move', move: 'last' });
    expect(resolveListKey('G', out)).toEqual({ kind: 'move', move: 'last' });
  });

  it('action keys are the screen’s own letters, case-insensitive, and never shadow j/k', () => {
    const opts = { focusInside: false, actionKeys: ['a', 'm', 'j'] };
    expect(resolveListKey('M', opts)).toEqual({ kind: 'action', key: 'm' });
    expect(resolveListKey('x', opts)).toBeNull();
    expect(resolveListKey('j', opts)).toEqual({ kind: 'move', move: 'next' });
  });

  it('after a removal the selection stays in the same slot, or steps back at the end', () => {
    expect(indexAfterRemoval(2, 5)).toBe(2);
    expect(indexAfterRemoval(4, 5)).toBe(3);
    expect(indexAfterRemoval(0, 1)).toBeNull();
  });
});

describe('shortcut guard', () => {
  const key = (k: string, target: unknown = null, mods: Partial<KeyboardEvent> = {}) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    target: target as EventTarget | null,
    ...mods,
  });
  const el = (tagName: string, attrs: Record<string, string> = {}) => ({
    tagName,
    isContentEditable: false,
    getAttribute: (n: string) => attrs[n] ?? null,
  });

  it('treats text fields as typing and checkboxes as not', () => {
    expect(isTypingTarget(el('INPUT') as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'search' }) as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el('INPUT', { type: 'checkbox' }) as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(el('TEXTAREA') as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el('DIV', { role: 'combobox' }) as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(el('BUTTON') as unknown as EventTarget)).toBe(false);
  });

  it('blocks a letter while typing, with a modifier, or while a popover holds the slot', () => {
    expect(shortcutBlocked(key('j'))).toBe(false);
    expect(shortcutBlocked(key('j', el('INPUT')))).toBe(true);
    expect(shortcutBlocked(key('k', null, { metaKey: true }))).toBe(true);
    const release = claimActivePopover(() => {});
    expect(shortcutBlocked(key('j'))).toBe(true);
    release();
    expect(shortcutBlocked(key('j'))).toBe(false);
  });

  it('⌘K and Ctrl+K are the palette chord; plain K is not', () => {
    expect(isPaletteChord({ key: 'k', metaKey: true, ctrlKey: false, altKey: false })).toBe(true);
    expect(isPaletteChord({ key: 'K', metaKey: false, ctrlKey: true, altKey: false })).toBe(true);
    expect(isPaletteChord({ key: 'k', metaKey: false, ctrlKey: false, altKey: false })).toBe(false);
  });
});

describe('command ranking', () => {
  const run = (): void => {};
  const cmds: Command[] = [
    { id: 'pending', group: 'Go to', title: 'Pending', keywords: ['my turn'], run },
    { id: 'open', group: 'Go to', title: 'Open pull requests', run },
    { id: 'pr', group: 'Pull requests', title: 'Fix upsert transaction', hint: 'api#113', run },
    { id: 'settings', group: 'Settings', title: 'Settings: AI', run },
    { id: 'theme', group: 'Actions', title: 'Switch light / dark theme', run },
  ];

  it('an empty query keeps everything, grouped in GROUP_ORDER', () => {
    expect(rankCommands(cmds, '').map((c) => c.id)).toEqual(['theme', 'pending', 'open', 'pr', 'settings']);
  });

  it('a title prefix beats a word start beats a keyword', () => {
    expect(rankCommands(cmds, 'pe')[0]?.id).toBe('pending');
    expect(rankCommands(cmds, 'pull').map((c) => c.id)).toEqual(['open']);
    expect(rankCommands(cmds, 'my turn').map((c) => c.id)).toEqual(['pending']);
  });

  it('finds a PR by its repo#number hint and needs every word to match', () => {
    expect(rankCommands(cmds, '113').map((c) => c.id)).toEqual(['pr']);
    expect(rankCommands(cmds, 'fix 113').map((c) => c.id)).toEqual(['pr']);
    expect(rankCommands(cmds, 'fix nothing')).toEqual([]);
  });

  it('collects sources and providers, and survives a throwing provider', () => {
    const all = collectCommands(
      { a: [cmds[0]!], b: [cmds[1]!] },
      {
        p: (q) => (q ? [{ id: 'x', group: 'Search', title: `Search ${q}`, run }] : []),
        boom: () => {
          throw new Error('no');
        },
      },
      'q',
    );
    expect(all.map((c) => c.id)).toEqual(['pending', 'open', 'x']);
  });
});

describe('optimistic removal + undo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetUndoForTests();
  });
  afterEach(() => {
    resetUndoForTests();
    vi.useRealTimers();
  });

  const removed = (scope: string): readonly string[] => useUndoStore.getState().removed[scope] ?? [];

  it('immediate: writes now, hides the row after the slide, and Undo runs the inverse', async () => {
    const commit = vi.fn(async () => {});
    const inverse = vi.fn(async () => {});
    removeOptimistically({ scope: 's', key: '1', label: 'Dismissed', summary: 'api #1', mode: 'immediate', commit, undo: inverse });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().leaving.s).toEqual(['1']);
    vi.advanceTimersByTime(200);
    expect(removed('s')).toEqual(['1']);
    expect(useUndoStore.getState().offer?.label).toBe('Dismissed');
    undoLast();
    expect(removed('s')).toEqual([]);
    expect(inverse).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().offer).toBeNull();
  });

  it('deferred: the write waits for the offer to expire, and Undo cancels it', () => {
    const commit = vi.fn();
    removeOptimistically({ scope: 's', key: '2', label: 'Merging', summary: 'api #2', mode: 'deferred', commit, ms: 1000 });
    vi.advanceTimersByTime(500);
    expect(commit).not.toHaveBeenCalled();
    undoLast();
    vi.advanceTimersByTime(2000);
    expect(commit).not.toHaveBeenCalled();
    expect(removed('s')).toEqual([]);

    removeOptimistically({ scope: 's', key: '3', label: 'Merging', summary: 'api #3', mode: 'deferred', commit, ms: 1000 });
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(useUndoStore.getState().offer).toBeNull();
  });

  it('a newer action settles the older deferred one first', () => {
    const first = vi.fn();
    const second = vi.fn();
    removeOptimistically({ scope: 's', key: 'a', label: 'Merging', summary: 'a', mode: 'deferred', commit: first });
    removeOptimistically({ scope: 's', key: 'b', label: 'Merging', summary: 'b', mode: 'deferred', commit: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    finalizeUndoOffer();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a failed write puts the row back and reports why', async () => {
    const onError = vi.fn();
    removeOptimistically({
      scope: 's',
      key: '4',
      label: 'Dismissed',
      summary: 'api #4',
      mode: 'immediate',
      commit: () => Promise.reject(new Error('GitHub said no')),
      undo: () => {},
      onError,
    });
    vi.advanceTimersByTime(200);
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(removed('s')).toEqual([]);
  });
});

describe('command ranking — initials, and no loose fuzzy matches', () => {
  const run = (): void => {};
  const cmds: Command[] = [
    { id: 'open', group: 'Go to', title: 'Open pull requests', run },
    { id: 'tf', group: 'Pull requests', title: 'Terraform: migrate remote state to S3', run },
  ];
  it('word initials find a command', () => {
    expect(rankCommands(cmds, 'opr').map((c) => c.id)).toEqual(['open']);
  });
  it('scattered letters do not (no subsequence matching)', () => {
    expect(rankCommands(cmds, 'ready')).toEqual([]);
  });
});
