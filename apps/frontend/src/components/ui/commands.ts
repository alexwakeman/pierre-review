import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { create } from 'zustand';

// THE COMMAND REGISTRY behind ⌘K (docs/redesign/DESIGN.md § Command palette).
//
// The palette must reach EVERY destination and EVERY pull request. It knows none of them itself:
// screens and the shell REGISTER what they offer while they are mounted.
//
//  • `useRegisterCommands(sourceId, commands)` — a fixed list (destinations, a screen's actions).
//    Registered on mount, replaced when the list changes, removed on unmount. Memoise the list.
//  • `useCommandProvider(id, provider)` — a function of the query, for things too many to list up
//    front (pull requests, tickets, "Search everything for …"). Called on every keystroke, so it
//    must be synchronous and cheap: read data already in memory (React Query cache), never fetch.
//
// A command RUNS through the stores (setActivityRepo, openPrDetailTab, openSettings…), exactly as a
// click would — never a second path to a screen, so URL state and history stay correct.

export interface Command {
  /** Unique within its source. */
  id: string;
  title: string;
  /** Section heading in the palette. See GROUP_ORDER. */
  group: CommandGroup;
  /** Extra words that should find it ("approve", "lgtm"). */
  keywords?: readonly string[];
  /** Dim text on the right (a repo#number, a key name). */
  hint?: string;
  /** Shortcut keys, shown as Kbd ("1", "G I"). */
  shortcut?: string;
  /** An icon from Icons.tsx. */
  icon?: ReactNode;
  run: () => void;
}

export type CommandGroup = 'Actions' | 'Go to' | 'Pull requests' | 'Tickets' | 'Settings' | 'Search' | 'Help';

/** Section order in the palette. Results keep this order within an equal score. */
export const GROUP_ORDER: readonly CommandGroup[] = ['Actions', 'Go to', 'Pull requests', 'Tickets', 'Search', 'Settings', 'Help'];

export type CommandProvider = (query: string) => readonly Command[];

interface RegistryState {
  sources: Record<string, readonly Command[]>;
  providers: Record<string, CommandProvider>;
  open: boolean;
  /** The text the palette opens with ("" normally). */
  initialQuery: string;
  /**
   * What is typed in the palette NOW ("" while closed). Published so an async source (the server
   * search, hooks/usePaletteSearch.tsx) can fetch for it and hand its answer to a synchronous
   * provider; providers themselves still never fetch.
   */
  query: string;
  setQuery: (q: string) => void;
  setSource: (id: string, commands: readonly Command[] | null) => void;
  setProvider: (id: string, provider: CommandProvider | null) => void;
  openPalette: (initialQuery?: string) => void;
  closePalette: () => void;
  togglePalette: () => void;
}

export const useCommandRegistry = create<RegistryState>((set) => ({
  sources: {},
  providers: {},
  open: false,
  initialQuery: '',
  query: '',
  setQuery: (q) => set({ query: q }),
  setSource: (id, commands) =>
    set((s) => {
      const sources = { ...s.sources };
      if (commands == null) delete sources[id];
      else sources[id] = commands;
      return { sources };
    }),
  setProvider: (id, provider) =>
    set((s) => {
      const providers = { ...s.providers };
      if (provider == null) delete providers[id];
      else providers[id] = provider;
      return { providers };
    }),
  openPalette: (initialQuery = '') => set({ open: true, initialQuery, query: initialQuery }),
  closePalette: () => set({ open: false, query: '' }),
  togglePalette: () => set((s) => ({ open: !s.open, initialQuery: '', query: '' })),
}));

/** Open the palette from anywhere (a "Search or jump" button, a keyboard handler). */
export function openCommandPalette(initialQuery?: string): void {
  useCommandRegistry.getState().openPalette(initialQuery);
}

export function useRegisterCommands(sourceId: string, commands: readonly Command[] | null): void {
  const setSource = useCommandRegistry((s) => s.setSource);
  useEffect(() => {
    setSource(sourceId, commands);
    return () => setSource(sourceId, null);
  }, [sourceId, commands, setSource]);
}

export function useCommandProvider(id: string, provider: CommandProvider | null): void {
  const setProvider = useCommandRegistry((s) => s.setProvider);
  useEffect(() => {
    setProvider(id, provider);
    return () => setProvider(id, null);
  }, [id, provider, setProvider]);
}

// ── ranking (pure; test/uiPrimitives.test.ts) ────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

const WORD_SPLIT = /[\s/#·:,.()-]+/;

/** "otp" finds "Open the pull…": the term is a prefix of the title's word initials. */
function initialsMatch(term: string, title: string): boolean {
  const initials = title
    .split(WORD_SPLIT)
    .filter(Boolean)
    .map((w) => w[0])
    .join('');
  return term.length >= 2 && initials.startsWith(term);
}

/** How well ONE term matches a command; 0 = not at all. */
function termScore(term: string, c: Command): number {
  const title = norm(c.title);
  if (title.startsWith(term)) return 100;
  if (title.split(WORD_SPLIT).some((w) => w.startsWith(term))) return 80;
  if (title.includes(term)) return 60;
  const extra = [...(c.keywords ?? []), c.hint ?? ''].map(norm);
  if (extra.some((k) => k.startsWith(term))) return 50;
  if (extra.some((k) => k.includes(term))) return 40;
  if (initialsMatch(term, title)) return 30;
  return 0;
}

/**
 * Rank commands for a query. Every word of the query must match (title, keywords or hint). An empty
 * query keeps every command, grouped in GROUP_ORDER, in registration order. Ties keep group order,
 * then registration order — so the list never reshuffles between keystrokes for equal matches.
 */
export function rankCommands(commands: readonly Command[], query: string, limit = 60): Command[] {
  const terms = norm(query).trim().split(/\s+/).filter(Boolean);
  const scored: Array<{ c: Command; score: number; i: number }> = [];
  commands.forEach((c, i) => {
    if (terms.length === 0) {
      scored.push({ c, score: 0, i });
      return;
    }
    let total = 0;
    for (const t of terms) {
      const s = termScore(t, c);
      if (s === 0) return;
      total += s;
    }
    scored.push({ c, score: total, i });
  });
  const g = (c: Command): number => {
    const at = GROUP_ORDER.indexOf(c.group);
    return at < 0 ? GROUP_ORDER.length : at;
  };
  scored.sort((a, b) => b.score - a.score || g(a.c) - g(b.c) || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.c);
}

/** Every registered command plus every provider's answer for `query`, de-duplicated by id. */
export function collectCommands(
  sources: Record<string, readonly Command[]>,
  providers: Record<string, CommandProvider>,
  query: string,
): Command[] {
  const seen = new Set<string>();
  const out: Command[] = [];
  const add = (key: string, c: Command): void => {
    const k = `${key}:${c.id}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  for (const [src, list] of Object.entries(sources)) for (const c of list) add(src, c);
  for (const [pid, p] of Object.entries(providers)) {
    let res: readonly Command[] = [];
    try {
      res = p(query);
    } catch {
      res = [];
    }
    for (const c of res) add(pid, c);
  }
  return out;
}
