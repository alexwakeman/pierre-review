import type { DerivedState, TimelinePr } from '@gh-team-monitor/shared';
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

// Status indicators shown only on (emphasised) open bars: CI dot, merge
// warning, "N new" badge, thread dots.
function statusLine(pr: TimelinePr): string {
  const bits: string[] = [];
  const ci = CI_META[pr.ciStatus];
  if (ci) {
    bits.push(
      `<span class="pr-ci" style="background:${ci.color}" title="${ci.label}"></span>`,
    );
  }
  const warn = mergeWarning(pr.mergeable, pr.mergeStateStatus);
  if (warn) bits.push(`<span class="pr-warn" title="merge: ${warn}">⚠</span>`);

  const n = pr.newSinceLastViewed;
  const newTotal = n ? n.commits + n.comments + n.reviews : 0;
  if (newTotal > 0) {
    bits.push(`<span class="pr-new" title="new since last viewed">👁 ${newTotal}</span>`);
  }

  const dots = threadDots(pr);
  if (dots) bits.push(`<span class="pr-dots">${dots}</span>`);

  if (bits.length === 0) return '';
  return `<div class="pr-status">${bits.join('')}</div>`;
}

// HTML content for a vis-timeline PR range item.
export function renderPrBar(pr: TimelinePr): string {
  const draft = pr.isDraft ? '<span class="pr-draft-tag">draft</span>' : '';
  const stalled = pr.isStalled ? '<span class="pr-stall" title="Stalled">●</span>' : '';
  const title =
    `<div class="pr-bar-inner">` +
    `<span class="pr-num">#${pr.number}</span>` +
    `${draft}` +
    `<span class="pr-title">${escapeHtml(pr.title)}</span>` +
    `${stalled}` +
    `</div>`;

  // Open PRs read as "live" — full title + status line. Closed/merged recede.
  if (pr.state === 'open') {
    return title + statusLine(pr);
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
