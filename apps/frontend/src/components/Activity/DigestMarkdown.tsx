import type { ReactNode } from 'react';
import type { DigestPrRef } from '@pierre-review/shared';

// Linkify "#<number>" tokens in one line against the resolved PR refs. Only numbers
// that resolved to a real PR become clickable; everything else stays plain text.
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
    } else {
      out.push(`#${num}`);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// Render a digest's bulleted markdown change-report, linkifying "#<number>" PR tokens
// into clickable buttons (open the PR as a new tab). A flat, equal-priority "- " bullet
// list (no promoted/highlighted lead), rendered a touch larger for legibility. No full
// markdown engine.
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

  const bullets = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.replace(/^[-*]\s+/, ''));

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
          <span className="min-w-0">{renderTokens(line, byNumber, onOpenPr)}</span>
        </li>
      ))}
    </ul>
  );
}
