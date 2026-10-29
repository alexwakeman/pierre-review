import { useCallback, useEffect, useMemo, useState } from 'react';
import { PersonIcon, TicketIcon } from '../components/Icons.js';
import {
  KIND_ICON,
  KIND_LABEL,
  openSearchHit,
  openSearchStory,
  storyPrWords,
} from '../components/Search/searchNav.js';
import { useCommandProvider, useCommandRegistry, type Command } from '../components/ui/commands.js';
import { useFilters } from '../store/filters.js';
import { useSearchDropdown } from './useSearch.js';
import { useWorkspaceOpenPrs } from './useTriage.js';

// THE SERVER SEARCH, INSIDE ⌘K. The palette replaced the FilterBar's search box (GlobalSearch), so
// it answers what that dropdown answered: stories (tickets), people and hits in PR titles, bodies,
// reviews, threads and comments of the active workspace. Same request, same key and the same
// rate-limit tier as the old dropdown (`useSearchDropdown`: ≥ 2 characters, 300ms after the last
// keystroke, scoped to the workspace) — no new endpoint. "Search everything" (useShellCommands)
// still opens the full results tab with snippets, kind filters and paging.
//
// The provider stays synchronous: this hook does the fetching and hands the provider the answer it
// already has. Every command carries the query's words as keywords, so a body match whose title
// says nothing of the query still survives the palette's every-word-must-match ranking — below a
// real title match, which is the order the reader wants.
export function usePaletteSearch(): void {
  const open = useCommandRegistry((s) => s.open);
  const query = useCommandRegistry((s) => s.query);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    if (!open) {
      setDebounced('');
      return;
    }
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [open, query]);
  const { data } = useSearchDropdown(open ? debounced : '');
  const { data: openPrs } = useWorkspaceOpenPrs();

  const commands = useMemo<Command[]>(() => {
    if (data == null || debounced.length < 2) return [];
    const words = debounced.toLowerCase().split(/\s+/).filter(Boolean);
    // An open PR is already a "Pull requests" command (useShellCommands); its title hit is not
    // listed twice.
    const listed = new Set((openPrs?.prs ?? []).map((p) => p.id));
    const out: Command[] = [];
    for (const s of data.stories ?? []) {
      out.push({
        id: `story:${s.ident}`,
        group: 'Tickets',
        title: `${s.key}${s.title ? ` ${s.title}` : ''}`,
        hint: [s.status, storyPrWords(s)].filter(Boolean).join(' · '),
        keywords: words,
        icon: <TicketIcon size={14} />,
        run: () => openSearchStory(s),
      });
    }
    for (const p of data.people ?? []) {
      out.push({
        id: `person:${p.id}`,
        group: 'Search',
        title: p.displayName != null ? `${p.login} · ${p.displayName}` : p.login,
        hint: `${p.matchCount} match${p.matchCount === 1 ? '' : 'es'}`,
        keywords: words,
        icon: <PersonIcon size={14} />,
        run: () => useFilters.getState().openSearchDetail(p.login),
      });
    }
    for (const h of data.hits ?? []) {
      if (h.kind === 'pr' && listed.has(h.prId)) continue;
      const Icon = KIND_ICON[h.kind];
      const short = h.repoFullName.split('/')[1] ?? h.repoFullName;
      out.push({
        id: `hit:${h.kind}:${h.refId}`,
        group: 'Search',
        // A PR hit reads as its title; a review, thread or comment as the words that matched.
        title: h.kind === 'pr' ? h.prTitle : h.snippet.replace(/\s+/g, ' ').trim() || h.prTitle,
        hint: `${KIND_LABEL[h.kind]} · ${short}#${h.prNumber}`,
        keywords: [...words, h.prTitle],
        icon: <Icon size={14} />,
        run: () => openSearchHit(h),
      });
    }
    return out;
  }, [data, debounced, openPrs]);

  const provider = useCallback((): readonly Command[] => commands, [commands]);
  useCommandProvider('search:server', provider);
}
