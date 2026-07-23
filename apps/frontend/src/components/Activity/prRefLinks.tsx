import type { ReactNode } from 'react';
import type { DigestPrRef } from '@pierre-review/shared';

// Shared PR-reference linkification for the AI summaries (the Feed per-repo digest AND
// the Insights sprint report). A resolved ref ALWAYS renders in the canonical
// `owner/name#N` format (from the resolved data), so both summaries present PRs
// IDENTICALLY regardless of whether the model emitted a bare `#N` (digest, per-repo) or
// a fully-qualified `owner/name#N` (sprint report, cross-repo). The PR title rides in
// the hover tooltip; a click opens the PR detail tab.

export interface PrRefIndex {
  byKey: Map<string, DigestPrRef>; // "owner/name#N" → ref (cross-repo, unambiguous)
  byNumber: Map<number, DigestPrRef>; // N → ref (per-repo fallback; first wins)
}

export function buildPrRefIndex(prRefs: DigestPrRef[]): PrRefIndex {
  const byKey = new Map<string, DigestPrRef>();
  const byNumber = new Map<number, DigestPrRef>();
  for (const r of prRefs) {
    if (r.prId == null) continue;
    byKey.set(`${r.repoFullName}#${r.prNumber}`, r);
    if (!byNumber.has(r.prNumber)) byNumber.set(r.prNumber, r);
  }
  return { byKey, byNumber };
}

// Matches a fully-qualified `owner/name#N` (a slash before the #) OR a bare `#N`.
export const REF_SOURCE = /([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)|#(\d+)/.source;

// Resolve which capture of a REF_SOURCE match points at (a repo-qualified key or a bare
// number), returning the ref (or undefined). Shared by the linkifier + the table renderer.
// A QUALIFIED `owner/name#N` resolves ONLY by its exact key — NO byNumber fallback: a
// cross-repo summary can name a repo/number pair that isn't in the ref set, and falling back
// to byNumber would silently mislink it to a DIFFERENT repo's same-numbered PR (the bevy ↔
// three.js #33485 hazard). An unresolved qualified token stays inert plain text. Only a BARE
// `#N` (single-repo digest context) uses byNumber.
export function resolveMatch(
  m: RegExpExecArray | RegExpMatchArray,
  index: PrRefIndex,
): DigestPrRef | undefined {
  const qualified = m[1] != null;
  const num = Number(qualified ? m[2] : m[3]);
  return qualified ? index.byKey.get(`${m[1]}#${num}`) : index.byNumber.get(num);
}

// Linkify the PR references in one line of text.
export function renderRefTokens(
  line: string,
  index: PrRefIndex,
  onOpenPr: (ref: DigestPrRef) => void,
  keyPrefix = '',
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const re = new RegExp(REF_SOURCE, 'g'); // fresh instance → no shared lastIndex state
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) != null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    const qualified = m[1] != null;
    const num = Number(qualified ? m[2] : m[3]);
    // Qualified refs resolve by exact key ONLY (see resolveMatch) — no byNumber fallback, so a
    // mis-scoped owner/name#N can never mislink to another repo's same-numbered PR.
    const ref = qualified ? index.byKey.get(`${m[1]}#${num}`) : index.byNumber.get(num);
    if (ref != null) {
      const label = `${ref.repoFullName}#${ref.prNumber}`;
      out.push(
        <button
          key={`${keyPrefix}r${k++}`}
          type="button"
          onClick={() => onOpenPr(ref)}
          className="font-semibold text-sky-600 hover:underline dark:text-sky-400"
          title={ref.title ?? label}
        >
          {label}
        </button>,
      );
    } else {
      out.push(m[0]); // unresolved reference — leave the raw token as plain text
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// Render one line with **bold** segments + inline PR links (the sprint report's markdown
// uses a bold headline; the digest is plain bullets so this collapses to renderRefTokens).
export function renderInlineMarkdown(
  text: string,
  index: PrRefIndex,
  onOpenPr: (ref: DigestPrRef) => void,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.flatMap((p, i): ReactNode[] => {
    const bold = /^\*\*([^*]+)\*\*$/.exec(p);
    if (bold != null) {
      return [
        <strong key={`b${i}`}>
          {renderRefTokens(bold[1] ?? '', index, onOpenPr, `b${i}-`)}
        </strong>,
      ];
    }
    return renderRefTokens(p, index, onOpenPr, `t${i}-`);
  });
}
