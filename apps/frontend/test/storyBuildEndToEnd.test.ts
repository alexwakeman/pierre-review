// "Build end to end"'s ticket step, in one line (components/StoryBuild/TicketUpdatePanel.tsx).
import { describe, expect, it } from 'vitest';
import { endToEndTicketLine } from '../src/components/StoryBuild/TicketUpdatePanel.js';

const at = '2026-11-12T12:00:00.000Z';

describe('endToEndTicketLine', () => {
  it('waits while the step has not run', () => {
    expect(endToEndTicketLine(null)).toEqual({ text: 'Updating the Jira ticket…', bad: false });
  });
  it('names the fields written and the comment', () => {
    expect(endToEndTicketLine({ at, updated: ['description', 'acceptanceCriteria'], commented: true, skipped: null, error: null })).toEqual({
      text: "Limn updated the ticket's description and acceptance criteria and commented on it in Jira.",
      bad: false,
    });
  });
  it('says when only a comment was posted', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: true, skipped: null, error: null }).text).toBe(
      'Limn commented on the ticket in Jira. The plan did not change the ticket text.',
    );
  });
  it('a failure reads as bad, with its sentence', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: true, skipped: null, error: 'Jira refused the change.' })).toEqual({
      text: 'Limn commented on the ticket in Jira. The plan did not change the ticket text. Jira refused the change.',
      bad: true,
    });
  });
  it('another tracker: nothing written', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: false, skipped: 'not_jira', error: null }).text).toBe(
      'Limn updates Jira tickets only, so it did not change this one.',
    );
  });
});
