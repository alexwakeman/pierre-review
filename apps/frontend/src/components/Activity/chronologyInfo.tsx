import {
  FLOW_BUDGET_LABEL,
  FLOW_BUDGET_MEASURES,
  FLOW_RULES,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';
import type { CourtSection } from './bottlenecksModel.js';
import {
  BUDGET_SUB,
  clockTime,
  formatShare,
  formatWorkHours,
  workingDaysText,
} from './chronologyModel.js';

// What each Chronology panel is, behind its "i" (components/InfoModal.tsx). One component per
// modal, static product copy — the page itself keeps only figures, charts and one-line disclosures.
//
// ⚠ EVERY NUMBER HERE COMES FROM `FLOW_RULES`, the one spelling the fold reads too
// (packages/shared/src/flow-settings.ts). Retyping a floor as a literal in this file is how the
// explanation and the engine drift apart without a test noticing.
//
// ⚠ NO PERSON, AND NO FINDING. These explain how to read a panel; the only server prose in here is
// each court's `directive`, verbatim, and it is templated and person-free by construction.

function Sub({ children }: { children: string }): JSX.Element {
  return <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-50">{children}</h3>;
}

/** The header's "How Chronology works". */
export function ChronologyAboutInfo({
  settings,
}: {
  settings: ResolvedFlowSettings | null;
}): JSX.Element {
  const calendar =
    settings == null
      ? ''
      : `: ${workingDaysText(settings.days)}, ${clockTime(settings.startMinute)}–${clockTime(
          settings.endMinute,
        )}, ${settings.timeZone}`;
  return (
    <>
      <p>
        Every hour a pull request is open, somebody is holding it: a reviewer who has not looked
        yet, an author who owes a reply, or nobody, because it is approved and waiting to merge.
        Chronology adds up those hours.
      </p>
      <p>
        It measures pull requests a person wrote and a person reviewed or commented on. Pull
        requests opened by automation are measured on the Bots rail.
      </p>
      <p>
        The charts count working hours only{calendar}. Nights, weekends and days off do not count.
        Change them in Settings → Workspace.
      </p>
      <p>
        “By repository” counts clock hours, nights and weekends included, because the rule that
        calls a repository out was set on clock hours.
      </p>
      <p>No person is named on this page.</p>
    </>
  );
}

/** M1 — the working-hours split. */
export function SplitInfo(): JSX.Element {
  return (
    <>
      <p>
        How all the working hours were split between waiting for a reviewer, waiting for the
        author, and waiting to merge after approval.
      </p>
      <p>
        An even split is not the goal. A pull request approved on its first review never waits for
        its author, and that is the best case.
      </p>
      <p>The next chart holds each wait against its budget.</p>
    </>
  );
}

/** M2 — each wait against its budget. */
export function BudgetsInfo(): JSX.Element {
  return (
    <>
      <p>Four waits, in working hours:</p>
      <dl className="space-y-1.5">
        {FLOW_BUDGET_MEASURES.map((m) => (
          <div key={m}>
            <dt className="font-medium text-gray-900 dark:text-gray-50">{FLOW_BUDGET_LABEL[m]}</dt>
            <dd>{BUDGET_SUB[m]}.</dd>
          </div>
        ))}
      </dl>
      <p>
        Each bar ends where three in four pull requests had finished that wait. The dot is the
        median, and the thin line runs on to nine in ten. The dashed line is the budget.
      </p>
      <p>
        Within budget: three in four finished inside the budget. Acceptable: inside the acceptable
        limit. Slow: past it. Too few: fewer than {FLOW_RULES.budgetMinPrs} pull requests, so no
        verdict.
      </p>
      <p>
        An arrow at the right edge means the figure runs past the scale. Point at, focus or tap a
        bar to see its figures.
      </p>
      <p>Budgets are set per workspace in Settings.</p>
    </>
  );
}

/** M3 — every pull request. */
export function ScatterInfo(): JSX.Element {
  return (
    <>
      <p>
        One dot per merged pull request: the day it merged, and how many working hours it was open,
        on a log scale.
      </p>
      <p>Colour shows which wait took most of its working time. Bigger dots changed more lines.</p>
      <p>
        Point at a dot for its breakdown, and click to open it. The table of the slowest lists the
        same pull requests for keyboard and screen readers.
      </p>
    </>
  );
}

/** M4 — what the slow ones have in common. */
export function ContrastInfo(): JSX.Element {
  return (
    <>
      <p>
        Pull requests are ranked by working-hour lead time and split into quarters. The table
        compares the slowest quarter with the fastest, and needs {FLOW_RULES.contrastMinQuartile} in
        each.
      </p>
      <p>
        “Separates” means the slow quarter’s figure is at least {FLOW_RULES.separatesRatio} times
        the fast one’s. “Weakly” means at least {FLOW_RULES.weakRatio} times. A very small gap
        counts as “No”.
      </p>
      <p>By size: median working hours from opened to merged, by lines added plus removed.</p>
      <p>
        By the day it opened: the grey bar is clock time and the dark bar is working hours. The gap
        between them is time outside working hours.
      </p>
      <p>
        A size band or day with fewer than {FLOW_RULES.cutMinPrs} pull requests shows no median.
      </p>
    </>
  );
}

/** M5 — approved and waiting. `dayHours` is one working day, in working hours. */
export function LandingInfo({ dayHours }: { dayHours: number }): JSX.Element {
  return (
    <>
      <p>
        Pull requests that sat approved for more than one working day ({formatWorkHours(dayHours)})
        before they merged. The {FLOW_RULES.landingRows} slowest are listed.
      </p>
      <p>
        “Merged alongside” lists pull requests in other repositories with the same ticket key that
        merged while this one waited. It may have been held for them.
      </p>
    </>
  );
}

/** M6 — who gives the first review. */
export function ConcentrationInfo(): JSX.Element {
  return (
    <>
      <p>
        For each repository: how many people gave first reviews, and how much of it the busiest one
        did. Nobody is named.
      </p>
      <p>A high share is a cover risk for when that person is away.</p>
      <p>
        “Slower” means the busiest reviewer’s first looks take at least{' '}
        {Math.round((FLOW_RULES.slowerRatio - 1) * 100)}% longer than everyone else’s, and at least{' '}
        {Math.round(FLOW_RULES.slowerMinHours * 60)} minutes longer.
      </p>
      <p>
        Medians are in working hours. “—” means fewer than {FLOW_RULES.concentrationMinSide} to go
        on.
      </p>
    </>
  );
}

/** M7 — asking for a review. */
export function RequestsInfo(): JSX.Element {
  return (
    <>
      <p>
        Who was asked to review first: a named person, a team, or nobody. This comes from each pull
        request’s history on GitHub. Nobody is named here.
      </p>
      <p>
        “Request to first look” starts at that first request. “Opened to first look” starts when
        the pull request opened, so it compares all three rows.
      </p>
      <p>
        Medians are in working hours. “—” means none, or fewer than {FLOW_RULES.cutMinPrs} to go on.
      </p>
    </>
  );
}

/** M8 — the model-written pointers. */
export function PointersInfo(): JSX.Element {
  return (
    <>
      <p>
        Written by a model from the pull requests on this page: patterns, examples worth copying,
        and things to try.
      </p>
      <p>
        It names no one and writes no figures; every figure on this page is measured. Each pointer
        links the pull requests it is based on, and a pointer that cites none is dropped.
      </p>
      <p>Writing pointers uses AI credits. Nothing is written until you press the button.</p>
    </>
  );
}

/** M9 — where each pull request sits. */
export function TriangleInfo(): JSX.Element {
  return (
    <>
      <p>
        Each pull request is placed by how its working time split: waiting for a reviewer (top), for
        its author (bottom left) and to merge after approval (bottom right). The ringed dot is the
        workspace as a whole.
      </p>
      <p>
        This is context, not a target. A pull request approved on its first review never goes back
        to its author, so it sits on the right-hand edge. That is the best case, and it is far from
        the middle.
      </p>
    </>
  );
}

/** M10 — by repository, in clock hours, with each court's full advice verbatim. */
export function ByRepositoryInfo({ sections }: { sections: readonly CourtSection[] }): JSX.Element {
  return (
    <>
      <p>Clock hours: nights and weekends count.</p>
      <p>
        A repository needs {FLOW_RULES.minRepoPrs} merged pull requests to be measured. It is called
        out only when one wait holds at least {formatShare(FLOW_RULES.dominantShare)} of its time and
        its slowest quarter took {FLOW_RULES.slowP75ClockHours} clock hours or more. The rest are
        under “Nothing stands out”.
      </p>
      {sections
        .filter((s) => s.directive !== '')
        .map((s) => (
          <div key={s.court} className="space-y-1">
            <Sub>{s.label}</Sub>
            <p>{s.directive}</p>
          </div>
        ))}
    </>
  );
}

/** M11 — merged without a human review. */
export function UnreviewedInfo(): JSX.Element {
  return (
    <>
      <p>
        These merged with no review, comment or approval from a person. That is a branch protection
        setting, not a habit.
      </p>
      <p>
        Only pull requests a person wrote are counted, so automation’s own pull requests do not
        inflate it.
      </p>
      <p>
        A repository is listed from {FLOW_RULES.unreviewedMinCount} such merges and{' '}
        {formatShare(FLOW_RULES.unreviewedMinShare)} of its merges.
      </p>
    </>
  );
}
