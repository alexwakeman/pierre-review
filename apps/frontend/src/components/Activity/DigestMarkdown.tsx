import type { ReactNode } from 'react';
import type { DigestPrRef } from '@pierre-review/shared';

// Linkify "#<number>" tokens in one line against the resolved PR refs. A resolved PR
// renders as ONE link unifying the number and the PR title ("#123 Fix the thing") — bold,
// no code/chip styling — that opens the PR detail tab. The title comes from resolved data
// (never the model); no author is shown. Unresolved numbers stay plain text.
function renderTokens(
  line: string,
  byNumber: Map<number, DigestPrRef>,
  onOpenPr: (ref: DigestPrRef) => void,
): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /#(\d+)/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) != null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const num = Number(m[1]);
    const ref = byNumber.get(num);
    if (ref != null) {
      const title = ref.title?.trim();
      const label = title != null && title !== '' ? `#${num} ${title}` : `#${num}`;
      out.push(
        <button
          key={`r${key++}`}
          type="button"
          onClick={() => onOpenPr(ref)}
          className="font-semibold text-sky-600 hover:underline dark:text-sky-400"
          title={title ?? `Open PR #${num}`}
        >
          {label}
        </button>,
      );
    } else {
      out.push(`#${num}`);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

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
  const byNumber = new Map<number, DigestPrRef>();
  for (const r of prRefs) if (r.prId != null) byNumber.set(r.prNumber, r);

  // Count the DISTINCT resolved PRs a bullet references (unresolved "#N" don't count).
  const resolvedPrCount = (line: string): number => {
    const nums = new Set<number>();
    for (const t of line.matchAll(/#(\d+)/g)) {
      const n = Number(t[1]);
      if (byNumber.has(n)) nums.add(n);
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
            {renderTokens(line, byNumber, onOpenPr)}
          </li>
        ) : (
          <li
            key={i}
            className="flex gap-1.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-200"
          >
            <span aria-hidden="true" className="select-none text-gray-400">
              •
            </span>
            <span className="min-w-0">{renderTokens(line, byNumber, onOpenPr)}</span>
          </li>
        ),
      )}
    </ul>
  );
}
