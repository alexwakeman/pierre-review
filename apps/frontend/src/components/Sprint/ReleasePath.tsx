import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReleaseCheckResult } from '@pierre-review/shared';
import { useOpenStory } from '../../lib/ticketTab.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { usePinnedTabs } from '../../store/pinnedTabs.js';
import { ArrowIcon, ExternalLinkIcon, LinkIcon, PartialCircleIcon, StarIcon } from '../Icons.js';
import { InfoButton } from '../InfoModal.js';
import { FOCUS_RING } from '../ui/cx.js';
import { PLAN_CARDS_SHOWN, planWindow, type LadderRowModel, type LadderStopModel, type PlanCard, type WorkChipModel, type WorkPrChip } from './releaseGraphModel.js';

// THE PATH TO NEWER RELEASES (docs/RELEASES.md § Releases tab): the release graph (shared `releaseGraph`,
// folded on read in ReleasesView — nothing here fetches) drawn as
//
//   • `ReleasePlanStrip` — "Do these first": the plan's first moves as cards, the first THE best next move.
//   • `ReleaseLadders`   — "Path to newer releases": ONE ROW PER REPOSITORY, left → right: the candidate (★)
//     → each stop (its tag, what it adds, what the tracker's links add, "with web w1.1.0") → "Still checking".
//
// ⚠ A LADDER, NEVER A FREE NODE-LINK GRAPH. Picked-together points are a MARKER on the stop ("with web
// w1.1.0") that scrolls to and lights the other row's stop, not drawn connectors: each row scrolls sideways
// on its own at phone width, so a line between two rows would detach the moment either row scrolls.

/** One work item: a ticket opens its story, a ticket only the tracker names opens the tracker, a new tag is
 *  words; a ticket's open PRs follow it. */
export function WorkChip({ chip }: { chip: WorkChipModel }): JSX.Element {
  const openStory = useOpenStory();
  const base = `inline-flex max-w-full items-center gap-1 rounded-ui px-1.5 text-meta ${FOCUS_RING}`;
  const tone = chip.viaLink ? 'border border-dashed border-ui-line text-ui-ink' : 'bg-ui-raise text-ui-ink';
  let main: JSX.Element;
  if (chip.kind === 'story' && chip.ident != null) {
    const ident = chip.ident;
    main = (
      <button
        type="button"
        title={chip.title}
        onClick={() => openStory({ ident, key: chip.key ?? ident, title: chip.ticketTitle })}
        className={`${base} ${tone} font-medium hover:bg-ui-hover`}
        data-testid="release-work-chip"
        data-work={chip.id}
      >
        {chip.label}
      </button>
    );
  } else if (chip.kind === 'tracker') {
    const href = safeExternalUrl(chip.url);
    main =
      href != null ? (
        <a href={href} target="_blank" rel="noreferrer noopener" title={chip.title} className={`${base} ${tone} font-medium hover:bg-ui-hover`} data-testid="release-work-chip" data-work={chip.id}>
          {chip.label}
          <ExternalLinkIcon size={10} className="shrink-0" />
        </a>
      ) : (
        <span title={chip.title} className={`${base} ${tone} font-medium`} data-testid="release-work-chip" data-work={chip.id}>
          {chip.label}
        </span>
      );
  } else {
    main = (
      <span title={chip.title} className={`${base} bg-ui-raise text-ui-ink`} data-testid="release-work-chip" data-work={chip.id}>
        {chip.label}
      </span>
    );
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1">
      {main}
      {chip.prs.map((p) => (
        <WorkPr key={p.key} pr={p} />
      ))}
      {chip.inCycle && <span className="text-meta text-ui-warn" title="These tickets wait on each other in the tracker">waits in a loop</span>}
    </span>
  );
}

function WorkPr({ pr }: { pr: WorkPrChip }): JSX.Element {
  const openPrDetailTab = usePinnedTabs((s) => s.openPrDetailTab);
  const cls = `inline-flex items-center rounded-ui px-1 text-meta text-ui-warn underline decoration-ui-line underline-offset-2 hover:decoration-ui-ink ${FOCUS_RING}`;
  const title = `Open pull request ${pr.label}`;
  if (pr.prId == null) {
    return (
      <a href={safeExternalUrl(pr.url)} target="_blank" rel="noreferrer noopener" title={title} className={cls}>
        {pr.label}
      </a>
    );
  }
  const prId = pr.prId;
  return (
    <button
      type="button"
      title={title}
      onClick={() =>
        openPrDetailTab(
          { id: prId, number: pr.number, title: pr.label, repoFullName: pr.repoFullName, authorLogin: null, authorDisplayName: null, authorAvatarUrl: null },
          { fromActivity: true },
        )
      }
      className={cls}
    >
      {pr.label}
    </button>
  );
}

function StepDisc({ step, best }: { step: number; best: boolean }): JSX.Element {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-meta font-semibold ${best ? 'bg-ui-accent-fill text-ui-on-accent' : 'bg-ui-raise text-ui-ink ring-1 ring-ui-line'}`}
      title={best ? 'The best next step' : `Step ${step}`}
    >
      {step}
    </span>
  );
}

/** "Do these first": the plan's first moves (3, then "Show all n"); the first card is THE best next move. */
export function ReleasePlanStrip({ cards }: { cards: PlanCard[] }): JSX.Element | null {
  const [all, setAll] = useState(false);
  if (cards.length === 0) return null;
  const { shown } = planWindow(cards, all);
  return (
    <section aria-label="Do these first" className="space-y-1.5" data-testid="release-plan">
      <h3 className="text-meta font-medium text-ui-mute">Do these first</h3>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((c) => (
          <li
            key={c.step}
            data-testid="release-move"
            data-best={c.best || undefined}
            className={`flex min-w-0 gap-2 rounded-ui border p-2.5 ${c.best ? 'border-2 border-ui-accent bg-ui-raise' : 'border-ui-line bg-ui-surface'}`}
          >
            <StepDisc step={c.step} best={c.best} />
            <div className="min-w-0 flex-1 space-y-1">
              {c.best && <p className="text-meta font-semibold text-ui-ink">Best next step</p>}
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-meta text-ui-mute">Finish</span>
                {c.work.map((w) => (
                  <WorkChip key={w.id} chip={w} />
                ))}
              </div>
              {c.unlocks != null && <p className={`text-meta ${c.best ? 'font-medium text-ui-ink' : 'text-ui-mute'}`}>{c.unlocks}</p>}
            </div>
          </li>
        ))}
      </ol>
      {cards.length > PLAN_CARDS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((a) => !a)}
          data-testid="release-plan-all"
          className={`inline-flex h-7 items-center rounded-ui px-2 text-meta font-medium text-ui-mute hover:bg-ui-hover hover:text-ui-ink touch:h-9 ${FOCUS_RING}`}
        >
          {all ? 'Show fewer' : `Show all ${cards.length}`}
        </button>
      )}
    </section>
  );
}

/** "Path to newer releases": one ladder per repository, the ⓘ beside the heading. */
export function ReleaseLadders({ rows, check }: { rows: LadderRowModel[]; check: ReleaseCheckResult }): JSX.Element | null {
  const stopEls = useRef(new Map<string, HTMLElement>());
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (lit == null) return;
    const t = window.setTimeout(() => setLit(null), 1600);
    return () => window.clearTimeout(t);
  }, [lit]);
  const register = useCallback((key: string, el: HTMLElement | null) => {
    if (el == null) stopEls.current.delete(key);
    else stopEls.current.set(key, el);
  }, []);
  const show = useCallback((key: string) => {
    stopEls.current.get(key)?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    setLit(key);
  }, []);
  if (rows.length === 0) return null;
  const tracker = check.trackerName ?? 'the tracker';
  return (
    <section aria-label="Path to newer releases" className="space-y-2 rounded-ui border border-ui-line p-3" data-testid="release-ladders">
      <div className="flex items-center gap-2">
        <h3 className="text-body font-medium text-ui-ink">Path to newer releases</h3>
        <InfoButton title="Path to newer releases">
          <p>
            Each row is one repository. It starts at the candidate (★), the newest tag you can release now. Each box to its right is a
            newer tag and the work it still needs: releasing a tag ships everything below it, so every box needs what the boxes
            before it need, plus what it shows.
          </p>
          <p>
            “Waits on … (link in {tracker})” is work {tracker} says a ticket is blocked by. It is not part of the release rule, but the ticket
            cannot really be finished first, so the plan counts it. “With web w1.1.0” means the two tags must be released together: a
            ticket has work in both.
          </p>
          <p>
            “Do these first” is the plan. In one repository it is exact: the next box is always the least work. Across repositories it
            takes, step by step, the work that makes the most tags releasable for the fewest tickets. The numbers on the boxes are the
            steps that release them.
          </p>
          <p>“Still reading its tickets” and “Still checking” mean the work shown is the least it needs: there may be more.</p>
        </InfoButton>
      </div>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.repoId} data-testid="release-ladder" data-repo={r.repoName} className="min-w-0">
            <p className="text-meta font-medium text-ui-ink">{r.repoName}</p>
            <div className="overflow-x-auto pb-1">
              <ol className="flex w-max items-stretch gap-1.5 pt-1">
                <li className="flex w-28 shrink-0 flex-col justify-center sm:w-36 gap-0.5 rounded-ui border border-ui-line bg-ui-surface px-2.5 py-2" data-testid="release-ladder-candidate">
                  {r.candidate != null ? (
                    <>
                      <span className="flex items-center gap-1 text-body font-medium text-ui-ink">
                        <StarIcon size={12} className="shrink-0 text-ui-accent" />
                        <span className="truncate">{r.candidate}</span>
                      </span>
                      <span className="text-meta text-ui-mute">Releasable now</span>
                    </>
                  ) : (
                    <span className="text-meta text-ui-mute">Nothing releasable yet</span>
                  )}
                </li>
                {r.stops.map((s) => (
                  <Fragment key={s.key}>
                    <LadderArrow />
                    <LadderStop stop={s} tracker={tracker} lit={lit === s.key} register={register} onShow={show} />
                  </Fragment>
                ))}
                {r.checkingFrom != null && (
                  <>
                    <LadderArrow />
                    <li className="flex w-28 shrink-0 items-center gap-1.5 rounded-ui border border-dashed sm:w-36 border-ui-line px-2.5 py-2 text-meta text-ui-mute" data-testid="release-ladder-checking">
                      <PartialCircleIcon size={12} className="shrink-0" />
                      <span>Still checking from {r.checkingFrom}</span>
                    </li>
                  </>
                )}
              </ol>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LadderArrow(): JSX.Element {
  return (
    <li aria-hidden className="flex shrink-0 items-center text-ui-mute">
      <ArrowIcon size={12} />
    </li>
  );
}

function LadderStop({
  stop,
  tracker,
  lit,
  register,
  onShow,
}: {
  stop: LadderStopModel;
  tracker: string;
  lit: boolean;
  register: (key: string, el: HTMLElement | null) => void;
  onShow: (key: string) => void;
}): JSX.Element {
  const best = stop.step === 1;
  const border = best ? 'border-2 border-ui-accent' : stop.partial ? 'border border-dashed border-ui-line' : 'border border-ui-line';
  return (
    <li
      ref={(el) => register(stop.key, el)}
      data-testid="release-ladder-stop"
      data-tag={stop.tagName}
      data-step={stop.step ?? undefined}
      className={`flex w-48 shrink-0 flex-col gap-1 sm:w-56 rounded-ui bg-ui-surface px-2.5 py-2 transition-shadow ${border} ${lit ? 'ring-2 ring-ui-accent' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-body font-medium text-ui-ink">{stop.tagName}</span>
        {stop.tagsWords != null && <span className="shrink-0 text-meta text-ui-mute">{stop.tagsWords}</span>}
        {stop.step != null && (
          <span className="ml-auto">
            <StepDisc step={stop.step} best={best} />
          </span>
        )}
      </div>
      {stop.adds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-meta text-ui-mute">Needs</span>
          {stop.adds.map((w) => (
            <WorkChip key={w.id} chip={w} />
          ))}
        </div>
      )}
      {stop.via.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="release-ladder-via">
          <span className="text-meta text-ui-mute">Waits on</span>
          {stop.via.map((w) => (
            <WorkChip key={w.id} chip={w} />
          ))}
          <span className="text-meta text-ui-mute">(link in {tracker})</span>
        </div>
      )}
      {stop.withPoints.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onShow(p.target)}
          title={`Released together with ${p.words}: show it`}
          data-testid="release-ladder-with"
          className={`inline-flex w-fit items-center gap-1 rounded-ui text-meta text-ui-ink underline decoration-ui-line underline-offset-2 hover:decoration-ui-ink ${FOCUS_RING}`}
        >
          <LinkIcon size={11} className="shrink-0 text-ui-mute" />
          with {p.words}
        </button>
      ))}
      {stop.partial && (
        <span className="flex items-center gap-1 text-meta text-ui-mute">
          <PartialCircleIcon size={11} className="shrink-0" />
          Still reading its tickets
        </span>
      )}
    </li>
  );
}
