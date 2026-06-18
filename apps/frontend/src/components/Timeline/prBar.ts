import type { DerivedState, TimelinePr } from '@pierre-review/shared';
import {
  CI_META,
  DERIVED_STATE_META,
  escapeHtml,
  mergeWarning,
} from '../../lib/ui.js';

const DOT_ORDER: DerivedState[] = [
  'untouched',
  'replied_unresolved',
  'likely_addressed',
  'resolved',
];

function threadDots(pr: TimelinePr): string {
  return DOT_ORDER.filter((s) => pr.threadCounts[s] > 0)
    .map((s) => {
      const meta = DERIVED_STATE_META[s];
      return `<span class="pr-dot" style="background:${meta.color}" title="${meta.label}: ${pr.threadCounts[s]}"></span><span class="pr-dot-n">${pr.threadCounts[s]}</span>`;
    })
    .join('');
}

// A small speech-bubble glyph marking that the PR has at least one comment
// (review-thread or issue-level). Derived client-side from the lean timeline
// events (see hasComments), so it costs no extra fetch.
function commentIndicator(): string {
  return (
    `<span class="pr-comment-mark" title="Has comments">` +
    `<svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">` +
    `<path d="M2.5 4 a1.5 1.5 0 0 1 1.5-1.5 h8 a1.5 1.5 0 0 1 1.5 1.5 v4 a1.5 1.5 0 0 1 -1.5 1.5 h-5 l-2.5 2.2 v-2.2 a1.5 1.5 0 0 1 -1.5 -1.5 z" fill="currentColor"/>` +
    `</svg></span>`
  );
}

// Status indicators shown only on (emphasised) open bars: CI dot, merge
// warning, comment mark, thread dots. Split out so barIsTall can reuse the exact
// same presence check that decides whether a status line renders.
function statusBits(pr: TimelinePr, hasComments: boolean): string[] {
  const bits: string[] = [];
  const ci = CI_META[pr.ciStatus];
  if (ci) {
    bits.push(
      `<span class="pr-ci" style="background:${ci.color}" title="${ci.label}"></span>`,
    );
  }
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  if (warn) bits.push(`<span class="pr-warn" title="merge: ${warn}">⚠</span>`);

  if (hasComments) bits.push(commentIndicator());

  const dots = threadDots(pr);
  if (dots) bits.push(`<span class="pr-dots">${dots}</span>`);

  return bits;
}

function statusLine(pr: TimelinePr, hasComments: boolean): string {
  const bits = statusBits(pr, hasComments);
  if (bits.length === 0) return '';
  return `<div class="pr-status">${bits.join('')}</div>`;
}

// Whether a PR's bar renders TALLER than the baseline (a second status-line row
// under the title). Only open PRs that actually emit a status line qualify — it
// mirrors renderPrBar exactly, so lane packing can keep equal-height bars together
// (a short merged bar sharing a lane with a tall open one would float above the
// band's bottom, stranding its own-work markers far below it). Keep in lockstep
// with renderPrBar.
export function barIsTall(pr: TimelinePr, hasComments: boolean): boolean {
  return pr.state === 'open' && statusBits(pr, hasComments).length > 0;
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
  // lean timeline events. Surfaces a small comment glyph on the bar.
  hasComments?: boolean;
}

// HTML content for a vis-timeline PR range item.
export function renderPrBar(pr: TimelinePr, meta: PrBarMeta = {}): string {
  const { author, hasComments = false } = meta;
  const draft = pr.isDraft ? '<span class="pr-draft-tag">draft</span>' : '';
  const stalled = pr.isStalled ? '<span class="pr-stall" title="Stalled">●</span>' : '';
  const title =
    `<div class="pr-bar-inner">` +
    `<span class="pr-num">#${pr.number}</span>` +
    authorHtml(author) +
    `${draft}` +
    `<span class="pr-title">${escapeHtml(pr.title)}</span>` +
    `${stalled}` +
    `</div>`;

  // Open PRs read as "live" — full title + status line (carries the comment
  // mark among the other indicators). Closed/merged recede to the title only, so
  // for them the comment mark rides inline at the end of the bar instead.
  if (pr.state === 'open') {
    return title + statusLine(pr, hasComments);
  }
  if (hasComments) {
    return (
      `<div class="pr-bar-inner">` +
      `<span class="pr-num">#${pr.number}</span>` +
      authorHtml(author) +
      `${draft}` +
      `<span class="pr-title">${escapeHtml(pr.title)}</span>` +
      commentIndicator() +
      `${stalled}` +
      `</div>`
    );
  }
  return title;
}

export function prClassName(pr: TimelinePr): string {
  const cls = ['pr-bar', `pr-${pr.state}`];
  if (pr.state === 'open') cls.push('pr-emph');
  else cls.push('pr-muted');
  if (pr.isDraft) cls.push('pr-draft');
  if (pr.isStalled) cls.push('pr-stalled');
  if (pr.reviewRequestedFromMe) cls.push('pr-myturn');
  return cls.join(' ');
}
