// THE TICKET LAYOUT FOLD (packages/shared/src/ticket-layout.ts): what the plan's draft ticket update
// must keep, and where criteria that live in the description are written. Pure.
import { describe, expect, it } from 'vitest';
import {
  acSectionText,
  compareTicketLayout,
  describeTicketLayout,
  findAcSection,
  spliceAcSection,
  ticketLayoutOf,
} from '@pierre-review/shared';
import { acLocationOf } from './ac-location.js';
import { criteriaFieldFormat, findWikiAcSection, neutraliseNewWikiMarkup, plainOneLine, spliceWikiAcSection } from './jira/text.js';

describe('ticketLayoutOf', () => {
  it('reads each list style', () => {
    expect(ticketLayoutOf('1. one\n2. two\n3. three').listStyle).toBe('numbered');
    expect(ticketLayoutOf('- one\n* two').listStyle).toBe('bulleted');
    expect(ticketLayoutOf('- [ ] one\n- [x] two').listStyle).toBe('checklist');
    expect(ticketLayoutOf('| AC | Done |\n|---|---|\n| one | yes |\n| two | no |')).toMatchObject({ listStyle: 'table', itemCount: 2 });
    expect(ticketLayoutOf('Some words.\n\nMore words.').listStyle).toBe('paragraphs');
    expect(ticketLayoutOf('').listStyle).toBe('empty');
    expect(ticketLayoutOf('1. one\n2. two\n- a\n- b').listStyle).toBe('mixed');
  });

  it('reads GIVEN / WHEN / THEN, as lines or inside a list', () => {
    expect(ticketLayoutOf('Given a user\nWhen they log in\nThen they see home')).toMatchObject({ listStyle: 'gherkin', gherkin: true, itemCount: 1 });
    expect(ticketLayoutOf('1. **Given** a\n   When b\n   Then c\n2. Given d\n   Then e')).toMatchObject({ listStyle: 'numbered', gherkin: true });
    expect(ticketLayoutOf('- When it rains').gherkin).toBe(false);
  });

  it('lists headings in order and skips fenced code', () => {
    const l = ticketLayoutOf('## Context\ntext\n```\n## not a heading\n- not an item\n```\n### **Scope**\n- a');
    expect(l.headings).toEqual(['Context', 'Scope']);
    expect(l.itemCount).toBe(1);
  });

  it('describes a layout in a few words', () => {
    expect(describeTicketLayout(ticketLayoutOf('1. Given a\n2. Then b'))).toBe('a numbered list, 2 items, GIVEN / WHEN / THEN');
    expect(describeTicketLayout(ticketLayoutOf(''))).toBe('empty');
  });
});

describe('compareTicketLayout', () => {
  const cmp = (a: string, b: string, what: 'description' | 'criteria' = 'description') =>
    compareTicketLayout(ticketLayoutOf(a), ticketLayoutOf(b), what);

  it('keeps: same headings in order (new ones allowed), same style', () => {
    expect(cmp('## Context\n## Scope', '## Context\n## New\n## Scope')).toEqual([]);
    expect(cmp('1. a\n2. b', '1. a\n2. b\n3. c', 'criteria')).toEqual([]);
  });

  it('names a dropped heading, a moved heading, a changed style, a lost GIVEN / WHEN / THEN', () => {
    expect(cmp('## Context\n## Scope', '## Context')).toEqual(['The description drops the heading "Scope".']);
    expect(cmp('## Scope\n## Notes', '## Notes\n## Scope')).toEqual(['"Notes" now comes before "Scope".']);
    expect(cmp('1. a\n2. b', '- a\n- b', 'criteria')).toEqual(['The criteria were a numbered list; the draft uses bullets.']);
    expect(cmp('1. Given a\n2. Then b', '1. a\n2. b', 'criteria')).toEqual([
      'The criteria were written as GIVEN / WHEN / THEN; the draft is not.',
    ]);
  });

  it('a loose original (paragraphs, mixed) does not pin a style; at most six problems', () => {
    expect(cmp('words', '- a', 'criteria')).toEqual([]);
    const many = Array.from({ length: 9 }, (_, i) => `## H${i}`).join('\n');
    expect(cmp(many, '')).toHaveLength(6);
  });
});

describe('findAcSection / spliceAcSection', () => {
  const desc = '# Story\n## Context\nWhy.\n## Acceptance criteria\n1. old\n### Detail\nnested\n## Notes\nkeep';

  it('finds the section up to the next heading of the same or a higher level, nested headings inside', () => {
    expect(findAcSection(desc)).toEqual({ heading: 'Acceptance criteria', start: 3, end: 7 });
    expect(acSectionText(desc)).toBe('1. old\n### Detail\nnested');
    expect(findAcSection('## AC\n- a')?.heading).toBe('AC');
    expect(findAcSection('## Definition of Done\n- a')?.heading).toBe('Definition of Done');
    expect(findAcSection('```\n## Acceptance criteria\n```\ntext')).toBeNull();
    expect(findAcSection('## Accounts\n- a')).toBeNull();
  });

  it('a bold label line (Jira\'s *Acceptance Criteria:*) is a section up to the next heading or label; spliced in place', () => {
    const md = 'Story.\n\n**Acceptance Criteria:**\n- old\n\n**Notes:**\nkeep';
    expect(findAcSection(md)).toEqual({ heading: 'Acceptance Criteria', start: 2, end: 5 });
    expect(acLocationOf(null, null, md)).toEqual({ kind: 'description', heading: 'Acceptance Criteria' });
    expect(spliceAcSection(md, '- new', null)).toBe('Story.\n\n**Acceptance Criteria:**\n\n- new\n\n**Notes:**\nkeep');
    expect(findAcSection('**AC**:\n- a\n## Next')).toEqual({ heading: 'AC', start: 0, end: 2 });
  });

  it('an exact "Acceptance criteria" / "AC" section wins over an earlier "Definition of Done" or "Criteria"; "Acceptance testing" is none', () => {
    const md = '## Definition of Done\n- docs\n## Acceptance Criteria\n1. a';
    expect(findAcSection(md)).toEqual({ heading: 'Acceptance Criteria', start: 2, end: 4 });
    expect(acSectionText(md)).toBe('1. a');
    expect(spliceAcSection(md, '1. b', null)).toBe('## Definition of Done\n- docs\n## Acceptance Criteria\n\n1. b');
    expect(findAcSection('## Acceptance testing\n- x')).toBeNull();
    expect(findAcSection('## Acceptance testing\n- x\n## Criteria\n- y')?.heading).toBe('Criteria');
  });

  it('replaces the section body and keeps the rest', () => {
    expect(spliceAcSection(desc, '1. new', null)).toBe('# Story\n## Context\nWhy.\n## Acceptance criteria\n\n1. new\n\n## Notes\nkeep');
  });

  it('appends a section when there is none (heading given, else "Acceptance criteria")', () => {
    expect(spliceAcSection('Story.', '- a', null)).toBe('Story.\n\n## Acceptance criteria\n\n- a');
    expect(spliceAcSection('', '- a', 'Done when')).toBe('## Done when\n\n- a');
  });
});

describe('acLocationOf (tracker/ac-location.ts)', () => {
  it('a custom field, an AC heading in the description, a body rule, or none', () => {
    expect(acLocationOf('customfield_10', 'AC', 'x')).toEqual({ kind: 'field', fieldId: 'customfield_10', fieldName: 'AC' });
    expect(acLocationOf(null, null, '## Acceptance Criteria\n- a')).toEqual({ kind: 'description', heading: 'Acceptance Criteria' });
    expect(acLocationOf('github:task_list', 'Task list', 'story')).toEqual({ kind: 'description', heading: null });
    expect(acLocationOf('linear:heading', 'x', 'story')).toEqual({ kind: 'description', heading: 'Acceptance criteria' });
    expect(acLocationOf('github:sub_issues', 'Sub-issues', 'story')).toMatchObject({ kind: 'field' });
    expect(acLocationOf(null, null, 'story')).toEqual({ kind: 'none' });
    expect(acLocationOf('description', null, 'story')).toEqual({ kind: 'none' });
  });
});

describe('the criteria block of a LIVE wiki description (tracker/jira/text.ts)', () => {
  it('replaces only the block under an hN. heading; every other byte kept; {code} skipped', () => {
    const wiki = '{code}\nh2. Acceptance criteria\n{code}\nh1. Story\n{color:red}x{color}\nh2. Acceptance criteria\n# a\nh3. Sub\n\nh2. Notes\n!i.png!';
    expect(findWikiAcSection(wiki)).toEqual({ heading: 'Acceptance criteria', start: 5, end: 9 });
    expect(spliceWikiAcSection(wiki, '# b', null)).toBe('{code}\nh2. Acceptance criteria\n{code}\nh1. Story\n{color:red}x{color}\nh2. Acceptance criteria\n# b\n\nh2. Notes\n!i.png!');
  });

  it('a bold label, and an exact name over Definition of Done; no section ⇒ appended', () => {
    expect(findWikiAcSection('h2. Definition of Done\n* d\n*Acceptance Criteria:*\n* a\nh2. Next')).toEqual({ heading: 'Acceptance Criteria', start: 2, end: 4 });
    expect(spliceWikiAcSection('Story', '* a', null)).toBe('Story\n\nh2. Acceptance criteria\n* a');
    expect(spliceWikiAcSection('', '* a', 'Done when')).toBe('h2. Done when\n* a');
  });
});

describe('the draft\'s new Jira mentions and macros (tracker/jira/text.ts)', () => {
  it('escapes a mention or macro the ticket does not hold; keeps the ones it does', () => {
    const got = neutraliseNewWikiMarkup('Ping [~accountid:123] and {html}<b>x</b>{html}; ask [~bob].', 'Owner: [~bob]');
    expect(got.changed).toBe(true);
    expect(got.text).toBe('Ping \\[~accountid:123] and \\{html}<b>x</b>\\{html}; ask [~bob].');
    expect(neutraliseNewWikiMarkup('ask [~bob]', 'Owner: [~bob]')).toEqual({ text: 'ask [~bob]', changed: false });
  });
});

describe('the Jira field format (tracker/jira/text.ts)', () => {
  it('criteriaFieldFormat: text area / system string → wiki, text field → plain, else refused', () => {
    expect(criteriaFieldFormat({ type: 'string', custom: 'x:textarea' })).toBe('wiki');
    expect(criteriaFieldFormat({ type: 'string' })).toBe('wiki');
    expect(criteriaFieldFormat({ type: 'string', custom: 'x:textfield' })).toBe('plain');
    expect(criteriaFieldFormat({ type: 'option', custom: 'x:select' })).toBeNull();
    expect(criteriaFieldFormat({ type: 'string', custom: 'app:checklist' })).toBeNull();
    expect(criteriaFieldFormat(undefined)).toBeNull();
  });

  it('plainOneLine strips markdown to one line', () => {
    expect(plainOneLine('## Head\n- **bold** and *it*\n- [ ] `code` [link](https://x.io)\n> quote')).toBe('Head bold and it code link quote');
    expect(plainOneLine('1. one\n2. two')).toBe('one two');
  });
});
