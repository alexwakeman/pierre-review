// MARKDOWN → JIRA WIKI (text.ts `markdownToJiraWiki`): what the ticket update writes to Jira's
// description. Each rule, and the round trip through `jiraWikiToMarkdown` (what Limn reads back).
import { describe, expect, it } from 'vitest';
import { jiraWikiToMarkdown, markdownToJiraWiki } from './text.js';

describe('markdownToJiraWiki', () => {
  it('headings, quotes and rules', () => {
    expect(markdownToJiraWiki('# Title\n## Sub\n> quoted\n---')).toBe('h1. Title\nh2. Sub\nbq. quoted\n----');
  });

  it('bullet and numbered lists, nested by indent', () => {
    expect(markdownToJiraWiki('- one\n  - one.a\n- two\n\n1. first\n2. second\n   - inner')).toBe(
      '* one\n** one.a\n* two\n\n# first\n# second\n#* inner',
    );
  });

  it('inline marks: bold, italic, strike, code, links, images', () => {
    expect(markdownToJiraWiki('**bold** and *it* and ~~gone~~ with `a*b*c` see [docs](https://x.io/a) ![](https://x.io/i.png)')).toBe(
      '*bold* and _it_ and -gone- with {{a*b*c}} see [docs|https://x.io/a] !https://x.io/i.png!',
    );
  });

  it('fenced code is copied verbatim', () => {
    expect(markdownToJiraWiki('```ts\nconst a = **b**;\n```\n```\nplain\n```')).toBe('{code:ts}\nconst a = **b**;\n{code}\n{noformat}\nplain\n{noformat}');
  });

  it('tables: the header row and the body rows', () => {
    expect(markdownToJiraWiki('| A | B |\n| --- | --- |\n| 1 | **2** |')).toBe('|| A || B ||\n| 1 | *2* |');
  });

  it('GIVEN / WHEN / THEN lines and plain text pass through', () => {
    const t = 'GIVEN a report\nWHEN I press Download CSV\nTHEN a file downloads';
    expect(markdownToJiraWiki(t)).toBe(t);
  });

  it('reads back as the same markdown (the round trip)', () => {
    const md = '## Context\nUsers want **CSV**.\n\n- Every report\n   - large ones stream\n1. AC one\n\n> note\n\n```sql\nselect 1;\n```';
    expect(jiraWikiToMarkdown(markdownToJiraWiki(md))).toBe(md);
  });
});
