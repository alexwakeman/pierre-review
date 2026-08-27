import type { DerivedState, TimelinePr } from '@pierre-review/shared';
import {
  CI_META,
  DERIVED_STATE_META,
  escapeHtml,
  mergeVerdictWarning,
} from '../../lib/ui.js';

const DOT_ORDER: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

const STATE_LABEL: Record<TimelinePr['state'], string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

// The same drawing `WarningIcon` renders in React (components/Icons.tsx), inlined as a MARKUP
// STRING because a vis-timeline tooltip is raw HTML handed to the library, not a React tree —
// a component cannot go here. `currentColor` still does the work: the icon takes its colour
// from `.pr-tt-warn`, which is the whole reason the ⚠ character had to go (an emoji-presented
// glyph painted its own colour and ignored the row's).
//
// It is a DIRECT child of `.pr-tt-row` (like `.pr-tt-dot`), so the row's `align-items: center`
// centres it. The old `.pr-tt-warn-icon` wrapper only set `font-weight`, which means nothing to
// an SVG, so it is gone — the rule left behind in index.css is now unused.
const WARNING_SVG =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M10.7 3.9 2.4 18.6a1.5 1.5 0 0 0 1.3 2.2h16.6a1.5 1.5 0 0 0 1.3-2.2L13.3 3.9a1.5 1.5 0 0 0-2.6 0z"/>` +
  `<line x1="12" y1="9.5" x2="12" y2="14"/>` +
  `<circle cx="12" cy="17.3" r="1.05" fill="currentColor" stroke="none"/>` +
  `</svg>`;

// CI status as a small coloured dot. Rendered as a LEADING indicator at the very
// start of an open PR's bar (success/fail at a glance) — the rest of the detail
// (merge state, comment stats) now lives in the hover tooltip, not on the bar.
function ciLead(pr: TimelinePr): string {
  const ci = CI_META[pr.ciStatus];
  if (!ci) return '';
  return `<span class="pr-ci pr-ci-lead" style="background:${ci.color}" title="${ci.label}"></span>`;
}

export interface PrBarAuthor {
  label: string;
  avatarUrl: string | null;
}

function authorHtml(author: PrBarAuthor | undefined): string {
  if (!author) return '';
  const avatar = author.avatarUrl
    ? `<img class="pr-avatar" src="${escapeHtml(author.avatarUrl)}" width="14" height="14" loading="lazy" alt="" />`
    : '';
  return `${avatar}<span class="pr-author">${escapeHtml(author.label)}</span>`;
}

export interface PrBarMeta {
  author?: PrBarAuthor;
  // PR has at least one comment (review-thread or issue-level), derived from the
  // lean timeline events. Surfaced in the tooltip, not on the bar.
  hasComments?: boolean;
}

// HTML content for a vis-timeline PR range item. A single, uniform row for every
// PR state — `[CI] #num · author · title · stall` — so open bars are no taller
// than closed/merged ones (the old second status-line row, with its comment glyph
// and thread dots, now lives in the hover tooltip; see prTooltip). The leading CI
// dot only renders for open PRs, where CI is actionable.
export function renderPrBar(pr: TimelinePr, meta: PrBarMeta = {}): string {
  const { author } = meta;
  const draft = pr.isDraft ? '<span class="pr-draft-tag">draft</span>' : '';
  // No stalled glyph: stalled PRs are now colour-coded (an orange bar), so the dot
  // was redundant. "stalled" still appears in the hover tooltip's meta line.
  return (
    `<div class="pr-bar-inner">` +
    (pr.state === 'open' ? ciLead(pr) : '') +
    `<span class="pr-num">#${pr.number}</span>` +
    authorHtml(author) +
    `${draft}` +
    `<span class="pr-title">${escapeHtml(pr.title)}</span>` +
    `</div>`
  );
}

// A coloured-dot row for the tooltip.
function ttRow(color: string, label: string, extraClass = ''): string {
  return (
    `<div class="pr-tt-row ${extraClass}">` +
    `<span class="pr-tt-dot" style="background:${color}"></span>` +
    `<span>${label}</span>` +
    `</div>`
  );
}

// Rich hover tooltip for a PR bar (rendered as HTML via vis — the timeline runs
// with xss disabled, and every interpolated value is escaped/own-controlled). It
// carries the detail the bars used to show on a second row: CI status, merge-state
// warning, and the per-state review-thread breakdown.
export function prTooltip(pr: TimelinePr, meta: PrBarMeta = {}): string {
  const { author, hasComments = false } = meta;
  const rows: string[] = [];

  rows.push(
    `<div class="pr-tt-title">#${pr.number} ${escapeHtml(pr.title)}</div>`,
  );

  const metaBits: string[] = [];
  if (author?.label) metaBits.push(escapeHtml(author.label));
  metaBits.push(STATE_LABEL[pr.state]);
  if (pr.isDraft) metaBits.push('draft');
  if (pr.isStalled) metaBits.push('stalled');
  rows.push(`<div class="pr-tt-meta">${metaBits.join(' · ')}</div>`);

  const ci = CI_META[pr.ciStatus];
  if (ci) rows.push(ttRow(ci.color, ci.label));

  // The single merge verdict — `blocked` now raises the ⚠ here too (a PR with red REQUIRED
  // checks used to show nothing at all, because `mergeable` only reports conflicts).
  const warn = mergeVerdictWarning({
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    isDraft: pr.isDraft,
  });
  if (warn) {
    const why = warn.detail ? ` — ${warn.detail}` : '';
    rows.push(
      `<div class="pr-tt-row pr-tt-warn">${WARNING_SVG}<span>merge: ${escapeHtml(warn.label)}${escapeHtml(why)}</span></div>`,
    );
  }

  const threads = DOT_ORDER.filter((s) => pr.threadCounts[s] > 0);
  if (threads.length > 0) {
    rows.push('<div class="pr-tt-section">Review threads</div>');
    for (const s of threads) {
      const m = DERIVED_STATE_META[s];
      rows.push(ttRow(m.color, `${m.label}: ${pr.threadCounts[s]}`));
    }
  } else if (hasComments) {
    rows.push('<div class="pr-tt-row pr-tt-quiet">Has comments</div>');
  }

  return `<div class="pr-tt">${rows.join('')}</div>`;
}

export function prClassName(pr: TimelinePr, hasComments = false): string {
  const cls = ['pr-bar', `pr-${pr.state}`];
  if (pr.state === 'open') cls.push('pr-emph');
  else cls.push('pr-muted');
  if (pr.isDraft) cls.push('pr-draft');
  if (pr.isStalled) cls.push('pr-stalled');
  if (pr.reviewRequestedFromMe) cls.push('pr-myturn');
  // Review-status outline on OPEN bars only (precedence: changes-requested → approved
  // → has-comments). Mutually exclusive — at most one outline class is added — so a
  // commented-but-approved PR reads as approved, and any blocking review wins.
  if (pr.state === 'open') {
    if (pr.isChangesRequested) cls.push('pr-changes-requested');
    else if (pr.isApproved) cls.push('pr-approved');
    else if (hasComments) cls.push('pr-commented');
  }
  return cls.join(' ');
}
