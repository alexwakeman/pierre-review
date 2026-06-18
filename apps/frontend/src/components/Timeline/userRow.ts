import type { TimelineEvent, TimelinePr, User } from '@pierre-review/shared';
import { escapeHtml, profileUrl, userLabel } from '../../lib/ui.js';

// A user's level of interaction within the loaded timeframe, shown on their row
// label. Comments = PR + review-thread comments; reviews = submitted reviews;
// PRs = ones they authored, split by state.
export interface UserStats {
  comments: number;
  reviews: number;
  prsOpen: number;
  prsMerged: number;
  prsClosed: number;
}

function emptyStats(): UserStats {
  return { comments: 0, reviews: 0, prsOpen: 0, prsMerged: 0, prsClosed: 0 };
}

// Tally per-actor / per-author activity once per data load. Computed from the
// full timeframe (not the derived-state-filtered PR subset) so the numbers stay
// stable as the user toggles thread-state filters.
export function computeUserStats(
  events: TimelineEvent[],
  prs: TimelinePr[],
): Map<number, UserStats> {
  const m = new Map<number, UserStats>();
  const at = (id: number): UserStats => {
    let s = m.get(id);
    if (!s) {
      s = emptyStats();
      m.set(id, s);
    }
    return s;
  };

  for (const e of events) {
    if (e.actorId == null) continue;
    if (e.type === 'pr_comment' || e.type === 'review_comment') at(e.actorId).comments++;
    else if (e.type === 'review_submitted') at(e.actorId).reviews++;
  }
  for (const p of prs) {
    if (p.authorId == null) continue;
    const s = at(p.authorId);
    if (p.state === 'open') s.prsOpen++;
    else if (p.state === 'merged') s.prsMerged++;
    else s.prsClosed++;
  }
  return m;
}

// Maintainer shield — shown next to a contributor who has merged a PR in this
// repo (our proxy for "has merge rights"). Purple to echo the pr_merged marker.
const SHIELD_GLYPH = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="#8957e5" d="M8 .8 2.2 2.9v4.2c0 3.3 2.5 6.4 5.8 7.3 3.3-.9 5.8-4 5.8-7.3V2.9L8 .8Z"/><path d="M5.2 8 7.1 9.9 10.9 6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// Bar-chart glyph for the per-contributor metrics toggle — opens a popover with the
// same numbers spelled out in a labelled table (the inline glyph summary is quick to
// skim but easy to misread).
const STATS_GLYPH = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="2" y="9" width="3" height="5" rx="0.5" fill="currentColor"/><rect x="6.5" y="6" width="3" height="8" rx="0.5" fill="currentColor"/><rect x="11" y="3" width="3" height="11" rx="0.5" fill="currentColor"/></svg>`;

// HTML for a vis-timeline user-row group label: avatar + name (+ maintainer shield +
// metrics-toggle). The interaction numbers themselves live in the metrics popover.
export function renderUserLabel(
  user: User | undefined,
  uid: number,
  stats: UserStats | undefined,
  isMerger = false,
  gid?: string,
  isCollapsed = false,
): string {
  const name = userLabel(user, uid);
  const avatar = user?.avatarUrl
    ? `<img class="tl-user-avatar" src="${escapeHtml(user.avatarUrl)}" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : `<span class="tl-user-avatar tl-user-avatar-fallback">${escapeHtml((name[0] ?? '?').toUpperCase())}</span>`;

  // Link the name to the contributor's GitHub profile when we know their login.
  // `stopPropagation` keeps the click from also hitting vis's row handler, and
  // the link opens in a new tab. vis's sanitizer is disabled (see VIS_OPTIONS),
  // so the <a> survives; the login + name are still escaped for safety.
  const nameHtml = user?.githubLogin
    ? `<a class="tl-user-name tl-user-name-link" href="${escapeHtml(profileUrl(user.githubLogin))}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(`@${user.githubLogin} on GitHub`)}" onclick="event.stopPropagation()">${escapeHtml(name)}</a>`
    : `<span class="tl-user-name">${escapeHtml(name)}</span>`;

  const mergerBadge = isMerger
    ? `<span class="tl-merger" title="Has merge rights — has merged a PR in this repo">${SHIELD_GLYPH}</span>`
    : '';

  // Metrics toggle — opens a labelled-table popover of the same stats. A capturing
  // click listener on the timeline container (Timeline/index.tsx) handles it by
  // matching `data-stats-gid`; we only emit the affordance. On the name line so it
  // stays visible even when the row is collapsed (which hides the stats span).
  // Omitted when no gid is supplied.
  const statsToggle = gid
    ? `<button type="button" class="tl-stats-toggle" data-stats-gid="${escapeHtml(gid)}" title="Show metrics" aria-label="Show contributor metrics">${STATS_GLYPH}</button>`
    : '';

  // Collapse/expand caret — shrinks the row to just this label (its bars + markers
  // hidden via subgroupVisibility). A capturing click listener on the timeline
  // container (Timeline/index.tsx) does the toggle by matching `data-collapse-gid`;
  // we only emit the affordance here. Omitted when no gid is supplied.
  const caretTitle = isCollapsed ? 'Expand row' : 'Collapse row';
  const caret = gid
    ? `<button type="button" class="tl-collapse-caret" data-collapse-gid="${escapeHtml(gid)}" title="${escapeHtml(caretTitle)}" aria-label="${escapeHtml(caretTitle)}">${isCollapsed ? '▸' : '▾'}</button>`
    : '';

  // Layout: a left gutter (caret + avatar) beside the name line — the name (+ maintainer
  // shield + metrics toggle). The per-contributor metrics used to render inline under the
  // name, but the numbers were visually noisy; they now live behind the metrics-toggle
  // popover instead (computeUserStats still feeds it). [[six-feature-batch-2026-06]]
  return (
    `<div class="tl-user">` +
    caret +
    avatar +
    `<span class="tl-user-main">` +
    `<span class="tl-user-name-line">${nameHtml}${mergerBadge}${statsToggle}</span>` +
    `</span>` +
    `</div>`
  );
}
