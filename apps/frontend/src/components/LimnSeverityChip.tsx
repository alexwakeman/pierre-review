import { LIMN_SEVERITY_WORD, isLimnSeverity, type LimnSeverity } from '@pierre-review/shared';
import { vendorInk } from '../lib/ui.js';

// The severity a LIMN-POSTED finding carries, on its thread (Changes tab pills, the Threads only
// view) and its PR-level comment (Comments tab). The words are the review's own, the same ones the
// GitHub comment leads with (shared `limnSeverityLead`). Drawn like the ML severity pill on bot
// comments (MlSeverityBadge), with the colour run through `vendorInk` so the text clears AA on both
// grounds (test/limnSeverityChip.test.ts).
//
// RENDERS NOTHING WITHOUT A SEVERITY, and never fetches: the value rides the PR detail payload
// (`ThreadDetail.limnSeverity` / `PrCommentDetail.limnSeverity`).
export const LIMN_SEVERITY_COLOR: Record<LimnSeverity, string> = {
  blocker: '#dc2626',
  warning: '#ea580c',
  nit: '#78716c',
  question: '#0284c7',
};

export function LimnSeverityChip({ severity }: { severity: LimnSeverity | null | undefined }): JSX.Element | null {
  if (!isLimnSeverity(severity)) return null;
  const color = LIMN_SEVERITY_COLOR[severity];
  const word = LIMN_SEVERITY_WORD[severity];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-meta font-semibold"
      style={{ backgroundColor: `${color}1a`, ...vendorInk(color) }}
      title={`${word}: the severity of Limn’s review comment`}
      data-limn-severity={severity}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {word}
    </span>
  );
}
