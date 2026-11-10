import { personNameKey, type TicketAssignable } from '@pierre-review/shared';

// THE ASSIGNEE PICKER'S CHOICES (components/Ticket/TicketAssigneePicker.tsx; docs/TRACKERS.md § The
// assignee change). Pure: the people the tracker lists, narrowed by what the reader typed. "Unassigned"
// is always first while it matches, then the current assignee, then everyone else in the tracker's
// (name) order. At most ASSIGNEE_CHOICES_SHOWN people are drawn; typing narrows the rest.

export const ASSIGNEE_CHOICES_SHOWN = 50;
export const UNASSIGNED_LABEL = 'Unassigned';

export type AssigneeChoice =
  | { kind: 'unassigned'; current: boolean }
  | { kind: 'person'; user: TicketAssignable; current: boolean };

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** True when every word typed is part of the person's name or second line. */
export function assigneeMatches(user: Pick<TicketAssignable, 'name' | 'detail'>, query: string): boolean {
  const words = fold(query).split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return true;
  const hay = fold(`${user.name} ${user.detail ?? ''}`);
  return words.every((w) => hay.includes(w));
}

/** Whether a listed person is the ticket's assignee now (as the ticket spells the name). */
export function isCurrentAssignee(user: Pick<TicketAssignable, 'name'>, currentName: string | null): boolean {
  return currentName != null && currentName.trim() !== '' && personNameKey(user.name) === personNameKey(currentName);
}

export function assigneeChoices(
  users: readonly TicketAssignable[],
  query: string,
  currentName: string | null,
): { choices: AssigneeChoice[]; hidden: number } {
  const choices: AssigneeChoice[] = [];
  if (assigneeMatches({ name: UNASSIGNED_LABEL, detail: null }, query)) {
    choices.push({ kind: 'unassigned', current: currentName == null || currentName.trim() === '' });
  }
  const matching = users.filter((u) => assigneeMatches(u, query));
  const current = matching.filter((u) => isCurrentAssignee(u, currentName));
  const rest = matching.filter((u) => !isCurrentAssignee(u, currentName));
  const people = [...current, ...rest];
  for (const user of people.slice(0, ASSIGNEE_CHOICES_SHOWN)) {
    choices.push({ kind: 'person', user, current: isCurrentAssignee(user, currentName) });
  }
  return { choices, hidden: Math.max(0, people.length - ASSIGNEE_CHOICES_SHOWN) };
}
