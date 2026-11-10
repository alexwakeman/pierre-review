// THE ASSIGNEE PICKER'S CHOICES (lib/ticketAssignees.ts; docs/TRACKERS.md § The assignee change):
//   1. "Unassigned" is always offered first (while it matches what was typed), marked when nobody is.
//   2. The current assignee comes next and is marked; everyone else keeps the tracker's order.
//   3. Typing narrows by every word, ignoring case and accents, over the name and the second line.
//   4. At most ASSIGNEE_CHOICES_SHOWN people are drawn; the rest are counted.
import { describe, expect, it } from 'vitest';
import type { TicketAssignable } from '@pierre-review/shared';
import { ASSIGNEE_CHOICES_SHOWN, assigneeChoices, assigneeMatches, isCurrentAssignee } from '../src/lib/ticketAssignees.js';

const u = (id: string, name: string, detail: string | null = null): TicketAssignable => ({ id, name, detail, avatarUrl: null });
const USERS = [u('1', 'Ada Lovelace', 'ada@acme.io'), u('2', 'Chloé Martin'), u('3', 'zoe-ng', 'Zoe Ng')];
const labels = (r: ReturnType<typeof assigneeChoices>): string[] =>
  r.choices.map((c) => (c.kind === 'unassigned' ? `Unassigned${c.current ? '*' : ''}` : `${c.user.name}${c.current ? '*' : ''}`));

describe('assigneeChoices', () => {
  it('Unassigned first, marked when nobody is assigned', () => {
    expect(labels(assigneeChoices(USERS, '', null))).toEqual(['Unassigned*', 'Ada Lovelace', 'Chloé Martin', 'zoe-ng']);
  });

  it('the current assignee is next and marked, matched as the ticket spells the name', () => {
    expect(labels(assigneeChoices(USERS, '', 'Zoe Ng'))).toEqual(['Unassigned', 'zoe-ng*', 'Ada Lovelace', 'Chloé Martin']);
    expect(isCurrentAssignee(USERS[0]!, 'ada  lovelace')).toBe(true);
    expect(isCurrentAssignee(USERS[0]!, null)).toBe(false);
  });

  it('typing narrows by every word, without case or accents, and hides Unassigned when it does not match', () => {
    expect(labels(assigneeChoices(USERS, 'chloe', null))).toEqual(['Chloé Martin']);
    expect(labels(assigneeChoices(USERS, 'ACME ada', null))).toEqual(['Ada Lovelace']);
    expect(labels(assigneeChoices(USERS, 'unas', 'Ada Lovelace'))).toEqual(['Unassigned']);
    expect(assigneeChoices(USERS, 'nobody here', null).choices).toEqual([]);
    expect(assigneeMatches(USERS[2]!, 'zoe ng')).toBe(true);
  });

  it('draws at most ASSIGNEE_CHOICES_SHOWN people and counts the rest', () => {
    const many = Array.from({ length: ASSIGNEE_CHOICES_SHOWN + 7 }, (_, i) => u(String(i), `Person ${i}`));
    const r = assigneeChoices(many, '', null);
    expect(r.choices.filter((c) => c.kind === 'person')).toHaveLength(ASSIGNEE_CHOICES_SHOWN);
    expect(r.hidden).toBe(7);
  });
});
