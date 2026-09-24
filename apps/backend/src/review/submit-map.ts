import type { ClaudeFindingSide } from '@pierre-review/shared';
import type {
  ReviewFinding,
  ReviewFollowUpReport,
  ReviewTicketReport,
} from '../pro/contract.js';
// ⚠ `import type` ONLY — the payload type is zod-inferred, and a value import would pull zod in
// wherever this module is loaded. It is reached only from the dynamically imported agent anyway.
import type { SubmitReviewPayload } from './schema.js';
import { buildAnchorIndex, extractHunk, isFindingAnchored } from './post-review.js';

export interface MappedReview {
  scope: SubmitReviewPayload['scopeUsed'];
  summary: string;
  verdict: SubmitReviewPayload['verdict'];
  findings: ReviewFinding[];
  // Passed through VERBATIM; the plugin validates coverage against what it sent.
  followUp?: ReviewFollowUpReport[];
  ticket?: ReviewTicketReport;
}

/**
 * Turn the model's `submit_review` payload into the seam's result half: anchor every finding
 * against the noise-stripped diff (`anchored` / `fileInDiff` / `diffHunk`, the load-bearing
 * posting inputs) and carry the model's `priorRef`, `followUp` and `ticket` through untouched.
 * Pure — split out of agent.ts so it can be tested without the SDK.
 */
export function mapSubmittedReview(payload: SubmitReviewPayload, strippedDiff: string): MappedReview {
  const index = buildAnchorIndex(strippedDiff);
  const findings: ReviewFinding[] = payload.findings.map((f) => {
    const side: ClaudeFindingSide = f.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const line = f.line ?? null;
    return {
      path: f.path,
      line,
      side,
      severity: f.severity,
      title: f.title,
      body: f.body,
      suggestion: f.suggestion ?? null,
      diffHunk: extractHunk(strippedDiff, f.path, line, side),
      anchored: isFindingAnchored(index, f.path, line, side),
      // Whether the file is part of the PR diff at all — distinguishes an unanchored
      // finding that posts inline on the file's first change from one that posts PR-level.
      fileInDiff: index.has(f.path),
      priorRef: f.priorRef ?? null,
    };
  });
  return {
    scope: payload.scopeUsed,
    summary: payload.summary,
    verdict: payload.verdict,
    findings,
    ...(payload.followUp !== undefined ? { followUp: payload.followUp } : {}),
    ...(payload.ticket !== undefined ? { ticket: payload.ticket } : {}),
  };
}
