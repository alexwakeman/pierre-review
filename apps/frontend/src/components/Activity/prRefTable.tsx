import { useMemo, type ReactNode } from 'react';
import type { DigestPrRef, User } from '@pierre-review/shared';
import { useUsers } from '../../hooks/useTimeline.js';
import { CI_META, indexUsers, relativeTime } from '../../lib/ui.js';
import { Avatar } from '../CommentCard.js';
import { UserName } from '../UserName.js';
import {
  buildPrRefIndex,
  renderInlineMarkdown,
  resolveMatch,
  REF_SOURCE,
  type PrRefIndex,
} from './prRefLinks.js';

// The AI summaries (per-repo digest + sprint report) render PR-referencing bullets as a
// TABLE instead of inline prose: one row per referenced PR (PR · CI · age · author · diff)
// with the bullet's narrative in a rowspanned "summary" column. Rows/groups are ordered by
// severity (CI failing → oldest → largest diff), so what needs attention floats up. Bullets
// with NO PR reference (the throughput headline, metric lines) stay as prose. Shared by
// DigestMarkdown (per-repo) and the sprint report so both present PRs identically.

const isRed = (ci: DigestPrRef['ciStatus']): boolean =>
  ci === 'failure' || ci === 'error';
const openedTs = (r: DigestPrRef): number =>
  r.openedAt ? Date.parse(r.openedAt) : Number.POSITIVE_INFINITY;
const loc = (r: DigestPrRef): number => r.additions + r.deletions;
// More severe = red CI, then older, then larger. Returns <0 when `a` is more severe.
const bySeverity = (a: DigestPrRef, b: DigestPrRef): number =>
  (isRed(b.ciStatus) ? 1 : 0) - (isRed(a.ciStatus) ? 1 : 0) ||
  openedTs(a) - openedTs(b) ||
  loc(b) - loc(a);

interface Block {
  kind: 'headline' | 'header' | 'prose' | 'prtable';
  text?: string; // headline / header / prose
  groups?: { prs: DigestPrRef[]; summary: string }[]; // prtable
}

// Which resolved PR refs a line mentions (deduped, in order of appearance).
function refsIn(text: string, index: PrRefIndex): DigestPrRef[] {
  const out: DigestPrRef[] = [];
  const seen = new Set<string>();
  const re = new RegExp(REF_SOURCE, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    const ref = resolveMatch(m, index);
    if (ref?.prId != null) {
      const key = `${ref.repoFullName}#${ref.prNumber}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(ref);
      }
    }
  }
  return out;
}

// The bullet text with the resolved PR tokens removed (they get their own column), tidied
// of the leading punctuation the reference usually sat behind.
function stripRefs(text: string, index: PrRefIndex): string {
  const re = new RegExp(REF_SOURCE, 'g');
  return text
    .replace(re, (full, ...rest) => {
      // Reconstruct a match-like array for resolveMatch: [full, g1, g2, g3, ...].
      const groups = rest.slice(0, 3);
      const ref = resolveMatch(
        [full, ...groups] as unknown as RegExpMatchArray,
        index,
      );
      return ref?.prId != null ? '' : full; // strip resolved, keep unknown "#N"
    })
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:,.\-–—·•]+/, '')
    .trim();
}

// Parse the summary markdown into an ordered list of blocks, coalescing consecutive
// PR-referencing bullets into severity-ordered table groups.
function parseBlocks(markdown: string, index: PrRefIndex): Block[] {
  const lines = markdown
    .split('\n')
    // Strip code-span backticks — the model sometimes wraps a PR token in them, which would
    // otherwise defeat the ref regex / render literal `…` around the link.
    .map((l) => l.replace(/`/g, '').trim())
    .filter((l) => l !== '');
  const blocks: Block[] = [];
  let pending: { prs: DigestPrRef[]; summary: string }[] = [];
  let headlineDone = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    // Order groups by their most-severe PR.
    pending.sort((a, b) => bySeverity(a.prs[0]!, b.prs[0]!));
    blocks.push({ kind: 'prtable', groups: pending });
    pending = [];
  };
  for (const raw of lines) {
    const header = /^#{1,6}\s+(.*)$/.exec(raw);
    const bullet = raw.replace(/^[-*]\s+/, '');
    // The FIRST line is always the overview headline (the digest's throughput line / the
    // sprint report's bold lead-in), even if it happens to mention a PR — mirrors the old
    // DigestMarkdown, which rendered the first bullet as the headline unconditionally. Refs
    // inside it still linkify inline (renderInlineMarkdown), just not as a table row.
    if (!headlineDone) {
      headlineDone = true;
      blocks.push({ kind: 'headline', text: header ? (header[1] ?? '') : bullet });
      continue;
    }
    const refs = refsIn(raw, index);
    if (refs.length > 0) {
      // A PR bullet → a table group (severity-ordered rows). Buffer consecutive ones.
      refs.sort(bySeverity);
      pending.push({ prs: refs, summary: stripRefs(bullet, index) });
      continue;
    }
    flush();
    if (header) blocks.push({ kind: 'header', text: header[1] });
    else blocks.push({ kind: 'prose', text: bullet });
  }
  flush();
  return blocks;
}

function PrTable({
  groups,
  onOpenPr,
  usersById,
  index,
}: {
  groups: { prs: DigestPrRef[]; summary: string }[];
  onOpenPr: (ref: DigestPrRef) => void;
  usersById: Map<number, User>;
  index: PrRefIndex;
}): JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-[9px] font-semibold uppercase tracking-wide text-gray-400">
            <th className="pb-1 pr-2 font-semibold">PR</th>
            <th className="pb-1 pr-2 font-semibold">CI</th>
            <th className="pb-1 pr-2 font-semibold">Age</th>
            <th className="pb-1 pr-2 font-semibold">Author</th>
            <th className="pb-1 pr-2 font-semibold">Diff</th>
            <th className="pb-1 font-semibold">Summary</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g, gi) =>
            g.prs.map((pr, ri) => {
              const ci = pr.ciStatus ? CI_META[pr.ciStatus] : null;
              const u = pr.authorId != null ? usersById.get(pr.authorId) : undefined;
              return (
                <tr
                  key={`${gi}-${pr.prId}`}
                  className="border-t border-gray-100 align-top dark:border-gray-800/60"
                >
                  <td className="py-1 pr-2">
                    <button
                      type="button"
                      onClick={() => onOpenPr(pr)}
                      className="whitespace-nowrap font-semibold text-sky-600 hover:underline dark:text-sky-400"
                      title={pr.title ?? undefined}
                    >
                      {pr.repoFullName}#{pr.prNumber}
                    </button>
                  </td>
                  <td className="py-1 pr-2">
                    <span
                      className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400"
                      title={ci?.label ?? 'no checks'}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full"
                        style={ci ? { background: ci.color } : { boxShadow: 'inset 0 0 0 1px #9ca3af' }}
                        aria-hidden
                      />
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-[11px] text-gray-500 dark:text-gray-400">
                    {pr.openedAt ? relativeTime(pr.openedAt) : '—'}
                  </td>
                  <td className="py-1 pr-2">
                    <span className="inline-flex items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                      <Avatar user={u} size={13} />
                      {u ? (
                        <UserName user={u} fallbackId={pr.authorId ?? 0} />
                      ) : (
                        (pr.authorLogin ?? '—')
                      )}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-[11px]">
                    <span className="font-mono text-green-600 dark:text-green-400">+{pr.additions}</span>{' '}
                    <span className="font-mono text-red-500 dark:text-red-400">−{pr.deletions}</span>
                  </td>
                  {ri === 0 && (
                    <td
                      rowSpan={g.prs.length}
                      className="py-1 align-top text-[12px] leading-relaxed text-gray-700 dark:text-gray-200"
                    >
                      {g.summary
                        ? renderInlineMarkdown(g.summary, index, onOpenPr)
                        : null}
                    </td>
                  )}
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}

// The unified summary renderer: prose stays prose, PR-referencing bullets become a
// severity-ordered table. Used by both the per-repo digest and the sprint report.
export function SummaryMarkdown({
  markdown,
  prRefs,
  onOpenPr,
}: {
  markdown: string;
  prRefs: DigestPrRef[];
  onOpenPr: (ref: DigestPrRef) => void;
}): JSX.Element {
  const { data: users } = useUsers();
  const usersById = useMemo(() => indexUsers(users), [users]);
  const index = useMemo(() => buildPrRefIndex(prRefs), [prRefs]);
  const blocks = useMemo(() => parseBlocks(markdown, index), [markdown, index]);

  const render = (nodes: ReactNode[]): ReactNode => nodes;
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => {
        if (b.kind === 'prtable') {
          return (
            <PrTable
              key={i}
              groups={b.groups!}
              onOpenPr={onOpenPr}
              usersById={usersById}
              index={index}
            />
          );
        }
        if (b.kind === 'headline') {
          return (
            <div
              key={i}
              className="border-l-2 border-violet-400 pl-2 text-[13px] font-semibold leading-relaxed text-gray-800 dark:border-violet-500 dark:text-gray-100"
            >
              {render(renderInlineMarkdown(b.text ?? '', index, onOpenPr))}
            </div>
          );
        }
        if (b.kind === 'header') {
          return (
            <div
              key={i}
              className="pt-1 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              {render(renderInlineMarkdown(b.text ?? '', index, onOpenPr))}
            </div>
          );
        }
        return (
          <div
            key={i}
            className="flex gap-1.5 text-[13px] leading-relaxed text-gray-700 dark:text-gray-200"
          >
            <span aria-hidden="true" className="select-none text-gray-400">
              •
            </span>
            <span className="min-w-0">
              {render(renderInlineMarkdown(b.text ?? '', index, onOpenPr))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
