import type { TimelineEvent } from '@gh-team-monitor/shared';

export interface MarkerVisual {
  svg: string;
  color: string;
  label: string;
  // True when the glyph is a small inset circle (top sits ~3px below the marker
  // box top). The own-work connector stem extends down to meet the curve — see
  // `.ev-round` in index.css. Square/full-bleed glyphs already reach the box top.
  round?: boolean;
}

const C = {
  reviewComment: '#f59e0b',
  prComment: '#9ca3af',
  approved: '#22c55e',
  changes: '#f97316',
  commented: '#9ca3af',
  dismissed: '#9ca3af',
  commit: '#6b7280',
  lifecycle: '#3b82f6',
};

function svgWrap(inner: string): string {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${inner}</svg>`;
}

const filledCircle = (c: string) => svgWrap(`<circle cx="8" cy="8" r="5" fill="${c}"/>`);
const outlinedCircle = (c: string) =>
  svgWrap(`<circle cx="8" cy="8" r="4.5" fill="none" stroke="${c}" stroke-width="2"/>`);
const dashedCircle = (c: string) =>
  svgWrap(
    `<circle cx="8" cy="8" r="4.5" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2.2 2"/>`,
  );
const square = (c: string) => svgWrap(`<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="${c}"/>`);
const check = (c: string) =>
  svgWrap(
    `<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M4.5 8.3 L7 10.8 L11.5 5.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
const chevron = (c: string) =>
  svgWrap(
    `<circle cx="8" cy="8" r="7" fill="${c}"/><path d="M4.5 6.5 L8 10 L11.5 6.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
const bubble = (c: string) =>
  svgWrap(
    `<path d="M2.5 4.5 a1.5 1.5 0 0 1 1.5-1.5 h8 a1.5 1.5 0 0 1 1.5 1.5 v4 a1.5 1.5 0 0 1 -1.5 1.5 h-5 l-2.5 2.2 v-2.2 h-0 a1.5 1.5 0 0 1 -1.5 -1.5 z" fill="none" stroke="${c}" stroke-width="1.5"/>`,
  );

export function markerVisual(ev: TimelineEvent): MarkerVisual {
  switch (ev.type) {
    case 'review_comment':
      return { svg: filledCircle(C.reviewComment), color: C.reviewComment, label: 'Review comment', round: true };
    case 'pr_comment':
      return { svg: outlinedCircle(C.prComment), color: C.prComment, label: 'PR comment', round: true };
    case 'commit_pushed':
      return { svg: square(C.commit), color: C.commit, label: 'Commit pushed' };
    case 'review_submitted':
      switch (ev.reviewState) {
        case 'approved':
          return { svg: check(C.approved), color: C.approved, label: 'Approved' };
        case 'changes_requested':
          return { svg: chevron(C.changes), color: C.changes, label: 'Changes requested' };
        case 'dismissed':
          return { svg: dashedCircle(C.dismissed), color: C.dismissed, label: 'Review dismissed', round: true };
        default:
          return { svg: bubble(C.commented), color: C.commented, label: 'Review comment' };
      }
    default:
      return { svg: filledCircle(C.lifecycle), color: C.lifecycle, label: 'Event', round: true };
  }
}

export function markerHtml(ev: TimelineEvent): string {
  const v = markerVisual(ev);
  return `<div class="ev-marker-inner${v.round ? ' ev-round' : ''}">${v.svg}</div>`;
}

// Clusters are homogeneous by kind so a burst of commits never mixes with a
// burst of comments. Each kind gets its own colour + glyph on the +N badge.
export type ClusterKind = 'commit' | 'comment' | 'review';

function clusterGlyph(inner: string): string {
  return `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">${inner}</svg>`;
}

const KIND_VISUAL: Record<ClusterKind, { color: string; glyph: string; label: string }> = {
  commit: {
    color: C.commit,
    glyph: clusterGlyph(`<rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="#fff"/>`),
    label: 'commits',
  },
  comment: {
    color: C.reviewComment,
    glyph: clusterGlyph(`<circle cx="8" cy="8" r="5" fill="#fff"/>`),
    label: 'comments',
  },
  review: {
    color: C.approved,
    glyph: clusterGlyph(
      `<path d="M4.5 8.3 L7 10.8 L11.5 5.5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ),
    label: 'reviews',
  },
};

export function clusterHtml(count: number, kind: ClusterKind): string {
  const v = KIND_VISUAL[kind];
  return `<div class="ev-cluster-inner" style="background:${v.color}" title="${count} ${v.label}">${v.glyph}+${count}</div>`;
}
