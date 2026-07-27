import type { User } from '@pierre-review/shared';
import { escapeHtml, profileUrl, userLabel } from '../../lib/ui.js';

// Maintainer shield — shown next to a contributor who has merged a PR in this
// repo (our proxy for "has merge rights"). Purple to echo the pr_merged marker.
const SHIELD_GLYPH = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="#8957e5" d="M8 .8 2.2 2.9v4.2c0 3.3 2.5 6.4 5.8 7.3 3.3-.9 5.8-4 5.8-7.3V2.9L8 .8Z"/><path d="M5.2 8 7.1 9.9 10.9 6" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// HTML for a vis-timeline user-row group label: avatar + name (+ maintainer shield).
// Clicking the name opens the shared user popover (contribution totals + links) — the
// same affordance every handle in the app now has. The old bar-chart metrics toggle was
// removed with it: that popover showed a windowed subset of what this one shows.
export function renderUserLabel(
  user: User | undefined,
  uid: number,
  isMerger = false,
  gid?: string,
  isCollapsed = false,
): string {
  const name = userLabel(user, uid);
  const avatar = user?.avatarUrl
    ? `<img class="tl-user-avatar" src="${escapeHtml(user.avatarUrl)}" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : `<span class="tl-user-avatar tl-user-avatar-fallback">${escapeHtml((name[0] ?? '?').toUpperCase())}</span>`;

  // The name opens the user popover. A DELEGATED capture listener on the timeline
  // container (Timeline/index.tsx) handles it by matching `data-user-gid` — vis re-creates
  // these labels on every rebuild, so an inline handler couldn't survive (and an inline
  // `onclick` would need `script-src 'unsafe-inline'`, which the CSP does not grant).
  // It stays an <a href> to the GitHub profile so a middle/⌘-click still opens the profile
  // in a new tab, and so a plain click degrades to the old behaviour if the script is gone;
  // the listener preventDefaults an unmodified click. vis's sanitizer is disabled (see
  // VIS_OPTIONS) so the <a> survives; the login + name are still escaped for safety.
  const nameHtml =
    user?.githubLogin && gid
      ? `<a class="tl-user-name tl-user-name-link" data-user-gid="${escapeHtml(gid)}" href="${escapeHtml(profileUrl(user.githubLogin))}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(`@${user.githubLogin} — activity & stats`)}">${escapeHtml(name)}</a>`
      : user?.githubLogin
        ? `<a class="tl-user-name tl-user-name-link" href="${escapeHtml(profileUrl(user.githubLogin))}" target="_blank" rel="noreferrer noopener" title="${escapeHtml(`@${user.githubLogin} on GitHub`)}">${escapeHtml(name)}</a>`
        : `<span class="tl-user-name">${escapeHtml(name)}</span>`;

  const mergerBadge = isMerger
    ? `<span class="tl-merger" title="Has merge rights — has merged a PR in this repo">${SHIELD_GLYPH}</span>`
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
  // shield). The per-contributor metrics used to render inline under the name, then behind a
  // bar-chart toggle; both are gone — the numbers now live in the shared user popover the
  // name itself opens, which is account-wide rather than window-scoped.
  return (
    `<div class="tl-user">` +
    caret +
    avatar +
    `<span class="tl-user-main">` +
    `<span class="tl-user-name-line">${nameHtml}${mergerBadge}</span>` +
    `</span>` +
    `</div>`
  );
}
