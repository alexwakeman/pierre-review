import type { PrBranchStack, PrCriteriaCheck, PrStackMember } from '@pierre-review/shared';
import { criteriaCheckTone, criteriaDoneWords } from '@pierre-review/shared';
import { BranchIcon, CheckIcon, CloseIcon, WarningIcon } from '../Icons.js';
import { Menu, type MenuEntry } from '../ui/Menu.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { CARD_NEUTRAL_CHIP, CARD_TONE_CHIP } from './PrCardShell.js';
import { MERGE_TONE_CHIP, relativeTime } from '../../lib/ui.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';

// THE PR CHIPS (docs/FRONTEND.md § PR chips; shared `pr-chips.ts`): "2 of 3 in stack" and
// "Criteria 3/4", drawn the same way on the Open PRs rows and cards, the Pending card and the PR
// detail header. (The third, "Large", is `LargePrFlag`, which sits beside the size figures.)
//
// ⚠ IT FETCHES NOTHING: both facts ride the payload that mounted it (the Pending board may not fetch
// on mount). Absent fields render nothing — unknown is never zero.
//
// `interactive={false}` for a surface whose row is itself the control (the Open PRs list row): the
// chips are then plain text with the same words in their titles, and no nested button.

export interface PrChipsFields {
  branchStack?: PrBranchStack | null;
  criteria?: PrCriteriaCheck[];
}

/** "2 of 3 in stack", or "2 stacked on this" at a branch point with nothing below it. Pure. */
export function stackChipLabel(s: PrBranchStack): string {
  if (s.chain.length >= 2) return `${s.position} of ${s.chain.length} in stack`;
  return `${s.children.length} stacked on this`;
}

/** The stack chip's title: what lands before and after this PR. Pure. */
export function stackChipTitle(s: PrBranchStack): string {
  const parts: string[] = [];
  if (s.parent != null) parts.push(`Lands after #${s.parent.number} (${s.parent.title}).`);
  if (s.children.length > 0) {
    parts.push(`${s.children.map((c) => `#${c.number}`).join(', ')} ${s.children.length === 1 ? 'lands' : 'land'} after this.`);
  }
  return parts.join(' ');
}

/** The criteria chip's words. `several` = the PR has more than one checked ticket. Pure. */
export function criteriaChipText(c: PrCriteriaCheck, several: boolean): { label: string; title: string } {
  const head = several && c.key != null ? `${c.key} criteria` : 'Criteria';
  // The chip counts every DONE criterion; its title names the outside-code ones apart.
  const outside = c.metOutsideCode ?? 0;
  const label = `${head} ${c.met + outside}/${c.total}${c.olderHead ? ' · older commit' : ''}`;
  const rest: string[] = [];
  if (c.notMet > 0) rest.push(`${c.notMet} not met`);
  if (c.partlyMet > 0) rest.push(`${c.partlyMet} partly met`);
  if (c.unsettled > 0) rest.push(`${c.unsettled} unclear`);
  const who = c.key != null ? `${c.key}: ` : '';
  const title =
    `${who}${outside > 0 ? `${criteriaDoneWords(c)} acceptance criteria` : `${c.met} of ${c.total} acceptance criteria met`}${rest.length > 0 ? ` (${rest.join(', ')})` : ''}. ` +
    `Checked ${relativeTime(c.checkedAt)}${c.olderHead ? ', on an older commit of this PR' : ''}.`;
  return { label, title };
}

const TONE_CLASS = {
  met: MERGE_TONE_CHIP.ok,
  partly: MERGE_TONE_CHIP.warn,
  not_met: MERGE_TONE_CHIP.bad,
} as const;

const TONE_ICON = { met: CheckIcon, partly: WarningIcon, not_met: CloseIcon } as const;

function CriteriaChip({ c, several, interactive }: { c: PrCriteriaCheck; several: boolean; interactive: boolean }): JSX.Element {
  const openStory = useOpenStory();
  const tone = criteriaCheckTone(c);
  const Icon = TONE_ICON[tone];
  const { label, title } = criteriaChipText(c, several);
  const cls = cx(CARD_TONE_CHIP, TONE_CLASS[tone]);
  const body = (
    <>
      <Icon size={11} aria-hidden />
      {label}
    </>
  );
  // A pasted story (`manual:` ident, no key) has no story tab to open.
  if (!interactive || c.key == null) {
    return (
      <span className={cls} title={title} data-testid="pr-chip-criteria">
        {body}
      </span>
    );
  }
  const key = c.key;
  return (
    <button
      type="button"
      className={cx(cls, 'hover:brightness-95', FOCUS_RING)}
      title={`${title} Open the story.`}
      data-testid="pr-chip-criteria"
      data-noactivate
      onClick={(e) => {
        e.stopPropagation();
        openStory({ ident: c.ident, key, title: c.title });
      }}
    >
      {body}
    </button>
  );
}

function StackChip({ s, interactive }: { s: PrBranchStack; interactive: boolean }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((st) => st.openPrDetailTab);
  const label = stackChipLabel(s);
  const title = stackChipTitle(s);
  const body = (
    <>
      <BranchIcon size={11} aria-hidden />
      {label}
    </>
  );
  if (!interactive) {
    return (
      <span className={CARD_NEUTRAL_CHIP} title={title} data-testid="pr-chip-stack">
        {body}
      </span>
    );
  }
  const self = s.chain[s.position - 1]?.prId ?? null;
  const open = (m: PrStackMember) => () =>
    openPrDetailTab(
      { id: m.prId, number: m.number, title: m.title, repoFullName: '', authorLogin: null, authorDisplayName: null, authorAvatarUrl: null },
      { fromActivity: true },
    );
  const entry = (m: PrStackMember): MenuEntry => ({
    id: `pr-${m.prId}`,
    label: `#${m.number} ${m.title}`,
    text: `${m.number} ${m.title}`,
    disabled: m.prId === self,
    ...(m.prId === self ? { hint: 'this PR' } : {}),
    onSelect: open(m),
  });
  const inChain = new Set(s.chain.map((m) => m.prId));
  const others = s.children.filter((c) => !inChain.has(c.prId));
  const items: MenuEntry[] = [
    { heading: 'Stack, bottom first', id: 'h-stack' },
    ...s.chain.map(entry),
    ...(others.length > 0 ? [{ heading: 'Also on this branch', id: 'h-children' } as MenuEntry, ...others.map(entry)] : []),
  ];
  return (
    <Menu
      label="Pull requests in this stack"
      items={items}
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={cx(CARD_NEUTRAL_CHIP, 'hover:text-ui-ink', FOCUS_RING)}
          title={title}
          data-testid="pr-chip-stack"
          data-noactivate
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            props.onClick();
          }}
        >
          {body}
        </button>
      )}
    />
  );
}

export function PrChips({
  pr,
  interactive = true,
  className,
}: {
  pr: PrChipsFields;
  interactive?: boolean;
  className?: string;
}): JSX.Element | null {
  const stack = pr.branchStack ?? null;
  const criteria = pr.criteria ?? [];
  if (stack == null && criteria.length === 0) return null;
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-1', className)} data-testid="pr-chips">
      {stack != null && <StackChip s={stack} interactive={interactive} />}
      {criteria.map((c) => (
        <CriteriaChip key={c.ident} c={c} several={criteria.length > 1} interactive={interactive} />
      ))}
    </span>
  );
}
