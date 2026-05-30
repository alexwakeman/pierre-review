import type { TimelineEvent, TimelinePr, User } from '@gh-team-monitor/shared';
import { escapeHtml, userLabel } from '../../lib/ui.js';

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

// 10px glyphs, matching the timeline's existing inline-SVG icon language.
const GLYPH = {
  comment: `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="#f59e0b"/></svg>`,
  review: `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#22c55e"/><path d="M4.5 8.3 L7 10.8 L11.5 5.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pr: `<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="#a78bfa" d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/></svg>`,
} as const;

function stat(kind: keyof typeof GLYPH, value: string | number, title: string): string {
  return `<span class="tl-stat" title="${escapeHtml(title)}">${GLYPH[kind]}<span>${value}</span></span>`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// HTML for a vis-timeline user-row group label: avatar + name + a compact
// interaction summary. Zero-valued stats are omitted to keep the row readable.
export function renderUserLabel(
  user: User | undefined,
  uid: number,
  stats: UserStats | undefined,
): string {
  const name = userLabel(user, uid);
  const avatar = user?.avatarUrl
    ? `<img class="tl-user-avatar" src="${escapeHtml(user.avatarUrl)}" width="18" height="18" loading="lazy" referrerpolicy="no-referrer" alt="" />`
    : `<span class="tl-user-avatar tl-user-avatar-fallback">${escapeHtml((name[0] ?? '?').toUpperCase())}</span>`;

  const s = stats ?? emptyStats();
  const prClosedTotal = s.prsMerged + s.prsClosed;
  const parts: string[] = [];
  if (s.comments) parts.push(stat('comment', s.comments, plural(s.comments, 'comment')));
  if (s.reviews) parts.push(stat('review', s.reviews, `${plural(s.reviews, 'review')} given`));
  if (s.prsOpen || prClosedTotal) {
    parts.push(
      stat(
        'pr',
        `${s.prsOpen}/${prClosedTotal}`,
        `PRs authored: ${s.prsOpen} open · ${s.prsMerged} merged · ${s.prsClosed} closed`,
      ),
    );
  }
  const statsHtml = parts.length
    ? `<span class="tl-user-stats">${parts.join('')}</span>`
    : '';

  return (
    `<div class="tl-user">` +
    avatar +
    `<span class="tl-user-name">${escapeHtml(name)}</span>` +
    statsHtml +
    `</div>`
  );
}
