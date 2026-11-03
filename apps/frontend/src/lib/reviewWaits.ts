import type { ReviewTargetOver, ReviewWait, WaitingOnOthersCard } from '@pierre-review/shared';

// THE REVIEW TARGET AND "WAITING ON OTHERS" — the pure words (docs/FRONTEND.md § Waiting on others).
// Every figure is WORKING hours, read off the server (db/review-waits.ts); nothing here computes a
// wait. Pinned by test/reviewWaits.test.ts.

type NameOf = (id: number | null | undefined) => string | null;

/** One decimal under ten, whole hours above — "0.5", "4.4", "12". */
function hoursFigure(h: number): string {
  if (h < 10) return String(Math.round(h * 10) / 10);
  return String(Math.round(h));
}

/** "6h", "4.4h", "<0.1h" — the compact form, for a row. */
export function workHoursShort(h: number): string {
  if (h < 0.1) return '<0.1h';
  return `${hoursFigure(h)}h`;
}

/** "6 working hours", "1 working hour", "a few working minutes". */
export function workHoursLong(h: number): string {
  if (h < 0.1) return 'a few working minutes';
  const n = hoursFigure(h);
  return `${n} working ${n === '1' ? 'hour' : 'hours'}`;
}

/** "Over the 4h review target — waiting 9.5 working hours". The real numbers, both working hours. */
export function overTargetText(o: ReviewTargetOver): string {
  return `Over the ${workHoursShort(o.targetHours)} review target — waiting ${workHoursLong(o.waitedHours)}`;
}

/** Who holds one request: a person's name, or a team's own name. */
export function holderName(h: Pick<ReviewWait, 'userId' | 'teamName'>, nameOf: NameOf): string {
  if (h.userId != null) return nameOf(h.userId) ?? 'someone';
  return h.teamName ?? 'a team';
}

/** "sam", "sam and Platform Team", "sam and 2 others" — longest wait first, as the server sent. */
export function holdersText(holders: readonly ReviewWait[], nameOf: NameOf): string {
  const first = holders[0];
  if (first == null) return 'someone';
  const a = holderName(first, nameOf);
  if (holders.length === 1) return a;
  if (holders.length === 2) return `${a} and ${holderName(holders[1]!, nameOf)}`;
  return `${a} and ${holders.length - 1} others`;
}

/** The waiting row's reason column: "With sam". */
export function waitingWith(card: Pick<WaitingOnOthersCard, 'holders'>, nameOf: NameOf): string {
  return `With ${holdersText(card.holders, nameOf)}`;
}

/** The waiting card's heading: "With sam · 6 working hours". */
export function waitingHeading(
  card: Pick<WaitingOnOthersCard, 'holders' | 'waitHours'>,
  nameOf: NameOf,
): string {
  return `${waitingWith(card, nameOf)} · ${workHoursLong(card.waitHours)}`;
}

/** Is this one request over the target? */
export function holderOverTarget(h: Pick<ReviewWait, 'workHours'>, targetHours: number): boolean {
  return h.workHours > targetHours;
}

/** May the reader nudge this holder? A PERSON (a team request carries no slug to re-ask by), over
 *  the target, in a repo the reader can request reviewers in. Hide, never disable. */
export function nudgeOffered(
  h: Pick<ReviewWait, 'userId' | 'workHours'>,
  targetHours: number,
  viewerCanRequest: boolean,
): boolean {
  return viewerCanRequest && h.userId != null && holderOverTarget(h, targetHours);
}

/** Offer "Ask someone else" when any request is over the target and the reader can request. */
export function askSomeoneElseOffered(
  waits: readonly Pick<ReviewWait, 'workHours'>[],
  targetHours: number,
  viewerCanRequest: boolean,
): boolean {
  return viewerCanRequest && waits.some((w) => holderOverTarget(w, targetHours));
}
