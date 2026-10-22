import { useMemo } from 'react';
import type {
  AiFixPickerItem,
  AiFixPickerPreview,
  AiFixPickerSection,
  ClaudeFindingSeverity,
  ClaudeReview,
  PrDetail,
  TicketReview,
} from '@pierre-review/shared';
import { useTicketReviews, useTicketReviewsByIds } from '../../hooks/useTicketReview.js';
import {
  alreadyPostedReraiseIds,
  reraisedStatusByFindingId,
  withoutPraise,
} from '../../lib/claudeReviewFollowUp.js';
import { FindingRow } from '../ClaudeReviewTab.js';
import { FollowUpRow } from '../ClaudeReviewFollowUp.js';
import { ThreadRow } from '../ClaudeReviewThreads.js';
import { CiFailureRow } from '../ClaudeReviewCiFailures.js';
import { SonarIssueRow } from '../ClaudeReviewSonar.js';
import { CriterionRow, MissingRow } from '../TicketReviewParts.js';
import {
  PICKER_SECTION_LABEL,
  PICKER_SECTION_ORDER,
  budgetCutKeys,
  isPicked,
  type PickerOverrides,
} from './fixPickerModel.js';

// THE FIX PICKER — what a manual "Fix from review" will hand the fixer, before it starts. Grouped by
// section, each item ticked or not. The folds (defaults, ticks, the budget) live in
// `fixPickerModel.ts`; this file only draws.
//
// ⚠ EACH ITEM IS DRAWN WITH THE CLAUDE REVIEW TAB'S OWN CARD for its kind — FindingRow,
// FollowUpRow, ThreadRow, CiFailureRow, SonarIssueRow, CriterionRow / MissingRow — with `actions={false}` and the
// tick box in the card's `selection` slot. Never a copy of a card's markup here: a second copy is a
// card that drifts. The server names the card (`AiFixPickerItem.card`); findings and earlier
// findings are joined against the source review, ticket gaps against Story check's own query. An
// item whose card data is not on hand (still loading, or an older server) draws the plain row.

export {
  PICKER_SECTION_LABEL,
  PICKER_SECTION_ORDER,
  budgetCutKeys,
  isPicked,
  pickedKeys,
  type PickerOverrides,
} from './fixPickerModel.js';

const SEVERITY_LABEL: Record<ClaudeFindingSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Warning',
  nit: 'Nit',
  question: 'Question',
  praise: 'Praise',
};
const SEVERITY_CLASS: Partial<Record<ClaudeFindingSeverity, string>> = {
  blocker: 'bg-red-500/10 text-red-700 dark:text-red-300',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  nit: 'bg-gray-500/10 text-gray-600 dark:text-gray-300',
};
const WONT_FIT_CHIP =
  'whitespace-nowrap rounded bg-amber-500/10 px-1 py-px text-[11px] text-amber-700 dark:text-amber-300';
const NO_PATHS: ReadonlySet<string> = new Set();

function where(path: string | null, line: number | null): string | null {
  if (!path) return null;
  return line != null ? `${path}:${line}` : path;
}

/** The tick box every card carries in its header, plus "Won't fit" when the budget cuts it. */
function PickCheck({
  item,
  picked,
  cut,
  disabled,
  onToggle,
}: {
  item: AiFixPickerItem;
  picked: boolean;
  cut: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 pt-0.5">
      <input
        type="checkbox"
        checked={picked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        aria-label={`Include in the fix: ${item.label}`}
      />
      {picked && cut && <span className={WONT_FIT_CHIP}>Won’t fit</span>}
    </span>
  );
}

/** The fallback when an item's card data is not on hand: the label, its place and one line. */
function PlainRow({
  item,
  picked,
  cut,
  disabled,
  onToggle,
}: {
  item: AiFixPickerItem;
  picked: boolean;
  cut: boolean;
  disabled?: boolean;
  onToggle: (on: boolean) => void;
}): JSX.Element {
  const loc = where(item.path, item.line);
  return (
    <li>
      <label
        className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs ${
          picked
            ? 'border-blue-300 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20'
            : 'border-gray-200 dark:border-gray-800'
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={picked}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            {item.severity && SEVERITY_CLASS[item.severity] && (
              <span className={`rounded px-1 py-px text-[11px] font-medium ${SEVERITY_CLASS[item.severity]}`}>
                {SEVERITY_LABEL[item.severity]}
              </span>
            )}
            <span className="break-words text-gray-800 dark:text-gray-100">{item.label}</span>
            {picked && cut && <span className={WONT_FIT_CHIP}>Won’t fit</span>}
          </span>
          {(loc || item.detail) && (
            <span className="mt-0.5 block break-words text-[11px] text-gray-500 dark:text-gray-400">
              {loc && <span className="font-mono">{loc}</span>}
              {loc && item.detail ? ' · ' : ''}
              {item.detail}
            </span>
          )}
        </span>
      </label>
    </li>
  );
}

export function FixPicker({
  preview,
  overrides,
  onChange,
  disabled,
  pr,
  review,
}: {
  preview: AiFixPickerPreview;
  overrides: PickerOverrides;
  onChange: (next: PickerOverrides) => void;
  disabled?: boolean;
  pr: PrDetail;
  // The review the preview was built from (`preview.sourceReviewId`). null while it loads: the
  // finding cards draw as plain rows until then.
  review: ClaudeReview | null;
}): JSX.Element {
  const cut = budgetCutKeys(preview, overrides);
  const bySection = new Map<AiFixPickerSection, AiFixPickerItem[]>();
  for (const i of preview.items) {
    const list = bySection.get(i.section) ?? [];
    list.push(i);
    bySection.set(i.section, list);
  }
  const set = (keys: string[], on: boolean): void => {
    const next = { ...overrides };
    for (const k of keys) next[k] = on;
    onChange(next);
  };

  // The source review, as the Claude Review tab shows it: praise hidden, and the two re-raise chips
  // worked out by the same helpers.
  const source = review != null && review.id === preview.sourceReviewId ? review : null;
  const shown = useMemo(() => (source != null ? withoutPraise(source) : null), [source]);
  const findingsById = useMemo(() => new Map((shown?.findings ?? []).map((f) => [f.id, f])), [shown]);
  const followUpById = useMemo(
    () => new Map((shown?.followUp?.items ?? []).map((it) => [it.priorFindingId, it])),
    [shown],
  );
  const priorStatusById = useMemo(() => (shown != null ? reraisedStatusByFindingId(shown) : new Map()), [shown]);
  const alreadyPostedIds = useMemo(() => (shown != null ? alreadyPostedReraiseIds(shown) : new Set<number>()), [shown]);

  // Ticket gaps: Story check's own query (same key, so usually already cached). That query carries
  // each ticket's LATEST run of any status, while the items come from the latest SUCCEEDED one — so
  // while a newer run is queued, running or failed, the item's own run is fetched by id.
  const storyRunIds = useMemo(() => {
    const ids = new Set<number>();
    for (const i of preview.items) if (i.card?.kind === 'story') ids.add(i.card.ticketReviewId);
    return [...ids].sort((a, b) => a - b);
  }, [preview.items]);
  const tickets = useTicketReviews(pr.id, storyRunIds.length > 0);
  const latestRuns = useMemo(() => {
    const m = new Map<number, TicketReview>();
    for (const t of tickets.data?.tickets ?? []) if (t.review != null) m.set(t.review.id, t.review);
    return m;
  }, [tickets.data]);
  // Only once the per-PR list has answered, so the common case costs no extra request.
  const missingRunIds = useMemo(
    () => (tickets.data == null ? [] : storyRunIds.filter((id) => !latestRuns.has(id))),
    [tickets.data, storyRunIds, latestRuns],
  );
  const fetchedRuns = useTicketReviewsByIds(missingRunIds);
  const ticketRuns = useMemo(() => {
    const m = new Map(latestRuns);
    for (const r of fetchedRuns) m.set(r.id, r);
    return m;
  }, [latestRuns, fetchedRuns]);

  if (preview.items.length === 0) {
    return <p className="text-xs text-gray-500 dark:text-gray-400">The review found nothing to fix.</p>;
  }

  const headSha = source?.headSha ?? pr.headSha;

  const renderItem = (item: AiFixPickerItem): JSX.Element => {
    const picked = isPicked(item, overrides);
    const isCut = cut.has(item.key);
    const onToggle = (on: boolean): void => set([item.key], on);
    const selection = (
      <PickCheck item={item} picked={picked} cut={isCut} disabled={disabled} onToggle={onToggle} />
    );
    const card = item.card;
    switch (card?.kind) {
      case 'finding': {
        const f = findingsById.get(card.findingId);
        if (f == null) break;
        return (
          <FindingRow
            key={item.key}
            prId={pr.id}
            finding={f}
            editable={false}
            prUrl={pr.githubUrl}
            repoFullName={pr.repoFullName}
            headSha={headSha}
            posting={false}
            postError={null}
            inChangeset={f.fileInDiff}
            priorStatus={priorStatusById.get(f.id)}
            alreadyPosted={alreadyPostedIds.has(f.id)}
            actions={false}
            selection={selection}
            docReferences={source?.docReferences ?? null}
          />
        );
      }
      case 'earlier_finding': {
        const it = followUpById.get(card.priorFindingId);
        if (it == null) break;
        return (
          <FollowUpRow
            key={item.key}
            item={it}
            muted={false}
            findingsById={findingsById}
            headMoved={shown?.followUp?.headMoved ?? false}
            changedPaths={NO_PATHS}
            actions={false}
            selection={selection}
          />
        );
      }
      case 'thread':
        return (
          <ThreadRow
            key={item.key}
            t={card.assessment}
            muted={false}
            actions={false}
            selection={selection}
            notCheckedNote={card.inReview ? undefined : 'Claude didn’t check this one.'}
          />
        );
      case 'ci':
        return (
          <CiFailureRow
            key={item.key}
            f={card.item}
            suggestion={card.item.suggestion}
            changedPaths={NO_PATHS}
            selection={selection}
          />
        );
      case 'sonar':
        return <SonarIssueRow key={item.key} issue={card.issue} selection={selection} />;
      case 'story': {
        const run = ticketRuns.get(card.ticketReviewId);
        const ti = run?.items.find((x) => x.id === card.itemId);
        if (run == null || ti == null) break;
        const ctx = { review: run, viewedPrId: pr.id, changedPaths: NO_PATHS, actions: false, selection };
        if (ti.status === 'missing') return <MissingRow key={item.key} item={ti} {...ctx} />;
        const c = run.assessment?.criteria.find((x) => x.ref === ti.ref);
        if (c == null || c.status === 'met') break;
        return <CriterionRow key={item.key} c={c} item={ti} {...ctx} />;
      }
      default:
        break;
    }
    return (
      <PlainRow
        key={item.key}
        item={item}
        picked={picked}
        cut={isCut}
        disabled={disabled}
        onToggle={onToggle}
      />
    );
  };

  return (
    <div className="space-y-3">
      {PICKER_SECTION_ORDER.filter((s) => bySection.has(s)).map((section) => {
        const items = bySection.get(section)!;
        const on = items.filter((i) => isPicked(i, overrides)).length;
        const all = on === items.length;
        return (
          <section key={section} aria-label={PICKER_SECTION_LABEL[section]}>
            <div className="mb-1 flex items-center gap-2">
              <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                {PICKER_SECTION_LABEL[section]}
              </h4>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                {on} of {items.length}
              </span>
              <button
                type="button"
                className="ml-auto text-[11px] text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
                disabled={disabled}
                onClick={() =>
                  set(
                    items.map((i) => i.key),
                    !all,
                  )
                }
              >
                {all ? 'Untick all' : 'Tick all'}
              </button>
            </div>
            <ul className="space-y-1.5">{items.map(renderItem)}</ul>
          </section>
        );
      })}
      {cut.size > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {cut.size} ticked {cut.size === 1 ? 'item does' : 'items do'} not fit in one fix and will be left out.
          Untick something to make room.
        </p>
      )}
    </div>
  );
}
