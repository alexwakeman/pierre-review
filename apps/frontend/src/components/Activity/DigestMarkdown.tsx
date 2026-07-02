import type { ReactNode } from 'react';
import type { DigestPrRef } from '@pierre-review/shared';

// Linkify "#<number>" tokens in one line against the resolved PR refs. A resolved PR
// renders as its "#<number>" link (opens the PR detail tab) followed by the PR's title
// as a clickable inline-`code` chip that enters Focus mode, then "· by <author>". Title
// + author come from resolved data (never the model). Unresolved numbers stay plain text.
function renderTokens(
  line: string,
  byNumber: Map<number, DigestPrRef>,
  onOpenPr: (ref: DigestPrRef) => void,
  onFocusPr: (ref: DigestPrRef) => void,
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
      out.push(
        <button
          key={`r${key++}`}
          type="button"
          onClick={() => onOpenPr(ref)}
          className="font-medium text-sky-600 hover:underline dark:text-sky-400"
          title={ref.title ?? `Open PR #${num}`}
        >
          #{num}
        </button>,
      );
      if (ref.title != null && ref.title.trim() !== '') {
        // The whole title is a clickable inline-`code` chip → Focus PR tab mode.
        out.push(
          <button
            key={`t${key++}`}
            type="button"
            onClick={() => onFocusPr(ref)}
            className="mx-0.5 rounded bg-gray-100 px-1 font-mono text-[12px] text-gray-700 hover:bg-sky-100 hover:text-sky-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-sky-950/50 dark:hover:text-sky-300"
            title={`Focus PR #${num} in its own timeline tab`}
          >
            {ref.title}
          </button>,
        );
      }
      if (ref.authorLogin != null && ref.authorLogin.trim() !== '') {
        out.push(
          <span key={`a${key++}`} className="text-gray-400">
            {' · by '}
            {ref.authorLogin}
          </span>,
        );
      }
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
// "#<number>" tokens linkify to clickable PR refs carrying their title + author. No
// full markdown engine — the digests are a plain "- " bullet list.
export function DigestMarkdown({
  markdown,
  prRefs,
  onOpenPr,
  onFocusPr,
}: {
  markdown: string;
  prRefs: DigestPrRef[];
  onOpenPr: (ref: DigestPrRef) => void;
  onFocusPr: (ref: DigestPrRef) => void;
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
      {bullets.map((line, i) => (
        <li
          key={i}
          className="flex gap-1.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-200"
        >
          <span aria-hidden="true" className="select-none text-gray-400">
            •
          </span>
          <span className="min-w-0">{renderTokens(line, byNumber, onOpenPr, onFocusPr)}</span>
        </li>
      ))}
    </ul>
  );
}
