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

// DETERMINISTIC priority = LOC (additions + deletions) × hours-since-opened. Higher =
// more urgent (a big change that's been open a long time). The AI only narrates; the
// renderer orders every PR list (sprint report + repo digests) by this score, so ordering
// never depends on the prompt. A PR with no known open time sorts to the bottom (score 0).
const priorityOf = (r: DigestPrRef): number => {
  const loc = r.additions + r.deletions;
  const ageHours = r.openedAt
    ? Math.max(0, (Date.now() - Date.parse(r.openedAt)) / 3_600_000)
    : 0;
  return loc * ageHours;
};
// Highest priority first. Returns <0 when `a` outranks `b`.
const byPriority = (a: DigestPrRef, b: DigestPrRef): number =>
  priorityOf(b) - priorityOf(a);

// Compact a diff count so a huge PR ("+30033 −6428") stays on one line inside the narrow Diff
// column instead of overflowing into the Summary cell: 10k+ collapses to "30k", everything
// smaller keeps its exact number. Defensive against non-finite input.
const fmtDelta = (n: number): string =>
  Number.isFinite(n) && n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n ?? 0);

interface Block {
  kind: 'headline' | 'header' | 'subhead' | 'prose' | 'prtable';
  text?: string; // headline / header / subhead / prose
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
// of the leading punctuation the reference usually sat behind. Because the PR reference is
// often the sentence's grammatical subject, stripping it leaves a predicate fragment — so we
// capitalise the first letter, otherwise the summary reads as if it starts mid-sentence.
function stripRefs(text: string, index: PrRefIndex): string {
  const stripped = text
    .replace(new RegExp(REF_SOURCE, 'g'), (full, ...rest) => {
      // Reconstruct a match-like array for resolveMatch: [full, g1, g2, g3, ...].
      const groups = rest.slice(0, 3);
      const ref = resolveMatch(
        [full, ...groups] as unknown as RegExpMatchArray,
        index,
      );
      return ref?.prId != null ? '' : full; // strip resolved, keep unknown "#N"
    })
    .replace(/\s{2,}/g, ' ')
    // --- Dangling-list cleanup -----------------------------------------------------------
    // Removing the resolved "#N" tokens can strand the list punctuation that joined them:
    // "Three bumps in progress: #1, #2, and #3, all awaiting review" first becomes
    // "Three bumps in progress: , , and , all awaiting review". These defensive passes repair
    // that leftover punctuation so the narrative reads as a sentence again. They only touch
    // separators / orphaned conjunctions, NEVER the unknown "#N" tokens we deliberately KEPT
    // above (a kept ref still has real text around it — "#5, #6 both pending" — so no comma
    // run collapses onto it). Order matters; each pass is idempotent and can't throw on odd input.
    .replace(/\s*[,;](?:\s*[,;])+\s*/g, ', ') // collapse runs of commas/semicolons from adjacent removed refs
    .replace(/,\s*(?:and|or)\s*,/gi, ',') // orphaned conjunction between two separators: ", and ," -> ","
    .replace(/(^|[:,])\s*(?:and|or)\b\s*/gi, '$1 ') // stranded leading conjunction after start / ":" / ","
    .replace(/\s+(?:and|or)\s*([,.;:])/gi, '$1') // stranded trailing conjunction before punctuation
    .replace(/:\s*,/g, ':') // dangling ": ," left right after a colon
    .replace(/\s+([,.;:])/g, '$1') // no space before punctuation
    .replace(/,(?:\s*,)+/g, ',') // re-collapse any comma runs the passes above created
    .replace(/[\s,;:]+([.!?])/g, '$1') // trailing ", ." / stray separators before a sentence-ender
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:,.\-–—·•]+/, '') // strip the leading punctuation the ref usually sat behind
    .replace(/[\s,;:]+$/, '') // strip a stray leading/trailing lone comma the removal left behind
    .trim();
  // Capitalise a leading lowercase letter so the remaining clause reads as a sentence
  // (leave @mentions, #refs and already-capitalised text untouched).
  return /^[a-z]/.test(stripped) ? stripped[0]!.toUpperCase() + stripped.slice(1) : stripped;
}

// Parse the summary markdown into an ordered list of blocks, coalescing consecutive
// PR-referencing bullets into severity-ordered table groups.
function parseBlocks(markdown: string, index: PrRefIndex): Block[] {
  const lines = markdown
    .split('\n')
    // Strip code-span backticks — the model sometimes wraps a PR token in them, which would
    // otherwise defeat the ref regex / render literal `…` around the link.
    .map((l) => l.replace(/`/g, '').trim())
    // Drop blanks and markdown horizontal rules (`---` / `***` / `___`) — the model uses one
    // to divide the metrics from the action items, which would otherwise render as a stray bullet.
    .filter((l) => l !== '' && !/^[-–—*_]{3,}$/.test(l));
  const blocks: Block[] = [];
  let pending: { prs: DigestPrRef[]; summary: string }[] = [];
  let headlineDone = false;
  const flush = (): void => {
    if (pending.length === 0) return;
    // Order groups by their highest-priority PR (LOC × hours-open, deterministic).
    pending.sort((a, b) => byPriority(a.prs[0]!, b.prs[0]!));
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
      // A PR bullet → a table group (priority-ordered rows). Buffer consecutive ones.
      refs.sort(byPriority);
      pending.push({ prs: refs, summary: stripRefs(bullet, index) });
      continue;
    }
    // A wholly-bold line (e.g. the model's per-repo "**owner/name**" section labels that
    // precede each repo's action items) → a section subheading, not a bulleted prose line.
    const boldOnly = /^\*\*(.+)\*\*$/.exec(bullet);
    flush();
    if (header) blocks.push({ kind: 'header', text: header[1] });
    else if (boldOnly) blocks.push({ kind: 'subhead', text: boldOnly[1] });
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
      {/* Fixed layout + a SHARED colgroup so every table renders identical column geometry.
          The sprint report emits one table per repo (separated by repo-name lines), so
          without this each repo's columns sized to its own content and the tables didn't
          line up — this makes them all align. */}
      <table className="w-full min-w-[852px] table-fixed border-collapse text-[12px]">
        <colgroup>
          <col style={{ width: '320px' }} />
          <col style={{ width: '24px' }} />
          <col style={{ width: '84px' }} />
          <col style={{ width: '110px' }} />
          {/* Diff column: wide enough for "+30k −6428" (or a full 5-digit +/− pair) on one
              nowrap line so a huge diff never overflows into the Summary cell. */}
          <col style={{ width: '104px' }} />
          <col />
        </colgroup>
        <thead>
          <tr className="text-left text-[9px] font-semibold uppercase tracking-wide text-gray-400">
            <th className="pb-1 pr-2 font-semibold">Pull request</th>
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
                    {/* The repo is already known from the section subheading, so show
                        #<number> + the PR TITLE (not owner/name#n) — far more legible. The
                        title wraps within the widened column rather than truncating. */}
                    <button
                      type="button"
                      onClick={() => onOpenPr(pr)}
                      className="block text-left leading-snug hover:underline"
                      title={`${pr.repoFullName}#${pr.prNumber}${pr.title ? ` — ${pr.title}` : ''}`}
                    >
                      <span className="font-semibold text-sky-600 dark:text-sky-400">
                        #{pr.prNumber}
                      </span>{' '}
                      <span className="text-gray-700 dark:text-gray-200">{pr.title ?? ''}</span>
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
                  <td className="overflow-hidden py-1 pr-2">
                    <span className="flex min-w-0 items-center gap-1 text-[11px] text-gray-600 dark:text-gray-300">
                      <span className="shrink-0">
                        <Avatar user={u} size={13} />
                      </span>
                      <span className="min-w-0 truncate">
                        {u ? (
                          <UserName user={u} fallbackId={pr.authorId ?? 0} />
                        ) : (
                          (pr.authorLogin ?? '—')
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1 pr-2 text-[11px]">
                    <span className="font-mono text-green-600 dark:text-green-400">+{fmtDelta(pr.additions)}</span>{' '}
                    <span className="font-mono text-red-500 dark:text-red-400">−{fmtDelta(pr.deletions)}</span>
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
        if (b.kind === 'subhead') {
          return (
            <div
              key={i}
              className="pt-1.5 text-[12px] font-semibold text-gray-700 dark:text-gray-200"
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
