import type { DigestPrRef } from '@pierre-review/shared';
import { buildPrRefIndex, renderRefTokens } from './prRefLinks.js';

// PR references render in the shared canonical `owner/name#N` format (from prRefLinks),
// so the Feed digest and the Insights sprint report present PRs identically. The PR
// title rides in the hover tooltip; a click opens the PR detail tab.

// Render a digest's bulleted markdown change-report as a flat, equal-priority list,
// but in a FIXED information order regardless of how the model emitted the bullets:
//   1. the text-only throughput bullet (no PR references) first,
//   2. then bullets mentioning MORE THAN ONE PR,
//   3. then the single-PR bullets.
// "#<number>" tokens linkify to a single clickable PR ref (number + title). No full
// markdown engine — the digests are a plain "- " bullet list. The first line reads as a
// subtle headline (semibold + a violet accent bar, no bullet); the rest keep their bullets.
export function DigestMarkdown({
  markdown,
  prRefs,
  onOpenPr,
}: {
  markdown: string;
  prRefs: DigestPrRef[];
  onOpenPr: (ref: DigestPrRef) => void;
}): JSX.Element {
  const index = buildPrRefIndex(prRefs);

  // Count the DISTINCT resolved PRs a bullet references (unresolved "#N" don't count).
  const resolvedPrCount = (line: string): number => {
    const nums = new Set<number>();
    for (const t of line.matchAll(/#(\d+)/g)) {
      const n = Number(t[1]);
      if (index.byNumber.has(n)) nums.add(n);
    }
    return nums.size;
  };
  // 0 refs (throughput/text) → first · 2+ refs (multi-PR) → second · 1 ref → last.
  const orderGroup = (line: string): number => {
    const c = resolvedPrCount(line);
    return c === 0 ? 0 : c >= 2 ? 1 : 2;
  };

  const bullets = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.replace(/^[-*]\s+/, ''))
    // Stable sort into the three groups (preserve the model's order within a group).
    .map((line, i) => ({ line, i }))
    .sort((a, b) => orderGroup(a.line) - orderGroup(b.line) || a.i - b.i)
    .map((x) => x.line);

  if (bullets.length === 0) return <></>;

  return (
    <ul className="space-y-1">
      {bullets.map((line, i) =>
        // First line = the overview headline: semibold + a thin violet accent bar, no
        // bullet. It ties to the card's amethyst theme and draws the eye without a size bump.
        i === 0 ? (
          <li
            key={i}
            className="border-l-2 border-violet-400 pl-2 text-[13px] font-semibold leading-relaxed text-gray-800 dark:border-violet-500 dark:text-gray-100"
          >
            {renderRefTokens(line, index, onOpenPr, `${i}-`)}
          </li>
        ) : (
          <li
            key={i}
            className="flex gap-1.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-200"
          >
            <span aria-hidden="true" className="select-none text-gray-400">
              •
            </span>
            <span className="min-w-0">{renderRefTokens(line, index, onOpenPr, `${i}-`)}</span>
          </li>
        ),
      )}
    </ul>
  );
}
