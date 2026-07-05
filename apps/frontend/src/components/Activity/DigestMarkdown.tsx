import type { DigestPrRef } from '@pierre-review/shared';
import { SummaryMarkdown } from './prRefTable.js';

// A per-repo digest's change-report. PR-referencing bullets render as a severity-ordered
// TABLE (PR · CI · age · author · diff · summary); the throughput headline + any non-PR
// prose stay as text. Shared with the sprint report via SummaryMarkdown, so both AI
// summaries present PRs identically. (Was a plain reordered bullet <ul>.)
export function DigestMarkdown({
  markdown,
  prRefs,
  onOpenPr,
}: {
  markdown: string;
  prRefs: DigestPrRef[];
  onOpenPr: (ref: DigestPrRef) => void;
}): JSX.Element {
  return <SummaryMarkdown markdown={markdown} prRefs={prRefs} onOpenPr={onOpenPr} />;
}
