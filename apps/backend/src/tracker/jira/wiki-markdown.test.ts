// Jira wiki markup → markdown (src/jira/text.ts `jiraWikiToMarkdown`): the ticket description is
// shown read-only as markdown in the Claude Review panel.
import { describe, expect, it } from 'vitest';
import { jiraWikiToMarkdown } from './text.js';

describe('jiraWikiToMarkdown', () => {
  it('rewrites the common constructs', () => {
    const md = jiraWikiToMarkdown(
      [
        'h2. Goal',
        'As a *user* I want {{reset}} via [docs|https://x.io/a] and [https://y.io].',
        '* one',
        '** nested',
        '# first',
        '# second',
        '{code:java}',
        'int *x* = 1;',
        '{code}',
        '||A||B||',
        '|1|2|',
        '{quote}',
        'quoted *text*',
        '{quote}',
        '2 * 3 * 4',
        '----',
      ].join('\n'),
    );
    expect(md).toBe(
      [
        '## Goal',
        'As a **user** I want `reset` via [docs](https://x.io/a) and <https://y.io>.',
        '- one',
        '   - nested',
        '1. first',
        '1. second',
        '```java',
        'int *x* = 1;',
        '```',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '> quoted **text**',
        '2 * 3 * 4',
        '---',
      ].join('\n'),
    );
  });

  it('plain text is unchanged, and an unclosed code block is closed', () => {
    expect(jiraWikiToMarkdown('As a user\nI want a reset link')).toBe('As a user\nI want a reset link');
    expect(jiraWikiToMarkdown('{noformat}\nraw *x*')).toBe('```\nraw *x*\n```');
  });
  it('drops colour tags and reads a smart-link card as a link', () => {
    expect(jiraWikiToMarkdown('- {color:#0747a6}*AC1*{color} - On upload')).toBe('- **AC1** - On upload');
    expect(jiraWikiToMarkdown('see [https://x.atlassian.net/browse/A-1|https://x.atlassian.net/browse/A-1|smart-link]')).toBe(
      'see [https://x.atlassian.net/browse/A-1](https://x.atlassian.net/browse/A-1)',
    );
  });
  it('an image becomes a short marker and never splits a table cell', () => {
    expect(jiraWikiToMarkdown('See !image-1.png|width=326,alt="image-1.png"! and !shot.jpg!')).toBe(
      'See (image: image-1.png) and (image: shot.jpg)',
    );
    expect(jiraWikiToMarkdown('|*AC1*|upload !a.png|width=1! here|')).toBe('| **AC1** | upload (image: a.png) here |');
    // Prose with exclamation marks is not an image.
    expect(jiraWikiToMarkdown('Wow! Done!')).toBe('Wow! Done!');
  });

  it('a row whose cells span several lines stays ONE row, lines joined with <br>, nothing dropped', () => {
    const wiki = [
      '||*Ref*||*GIVEN / WHEN*||*Current*||',
      '|*AC1*|*GIVEN* the user is on Upload',
      '[https://x.atlassian.net/browse/B-850|https://x.atlassian.net/browse/B-850|smart-link]',
      '*WHEN* they upload a file',
      '!image-1.png|width=326,alt="image-1.png"!',
      '* first point',
      ' [https://x.atlassian.net/browse/B-852|https://x.atlassian.net/browse/B-852|smart-link]|*THEN* the Task List loads|',
      '|*AC2*|one line|old|',
    ].join('\n');
    const md = jiraWikiToMarkdown(wiki).split('\n');
    expect(md).toEqual([
      '| **Ref** | **GIVEN / WHEN** | **Current** |',
      '| --- | --- | --- |',
      '| **AC1** | **GIVEN** the user is on Upload<br>[https://x.atlassian.net/browse/B-850](https://x.atlassian.net/browse/B-850)<br>**WHEN** they upload a file<br>(image: image-1.png)<br>• first point<br>[https://x.atlassian.net/browse/B-852](https://x.atlassian.net/browse/B-852) | **THEN** the Task List loads |',
      '| **AC2** | one line | old |',
    ]);
  });

  it('an unterminated row stops at a blank line or the end, keeping its text', () => {
    expect(jiraWikiToMarkdown('|a|b\nmore\n\nAfter')).toBe('| a | b<br>more |\n\nAfter');
    expect(jiraWikiToMarkdown('|a|b\nmore')).toBe('| a | b<br>more |');
  });
});
