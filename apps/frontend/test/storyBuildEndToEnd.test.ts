// "Build end to end"'s ticket step, in one line (components/StoryBuild/TicketUpdatePanel.tsx).
import { describe, expect, it } from 'vitest';
import { endToEndTicketLine } from '../src/components/StoryBuild/TicketUpdatePanel.js';

const at = '2026-11-12T12:00:00.000Z';

describe('endToEndTicketLine', () => {
  it('waits while the step has not run', () => {
    expect(endToEndTicketLine(null)).toEqual({ text: 'Updating the Jira ticket…', bad: false });
  });
  it('counts the screenshots that went with the comment', () => {
    expect(endToEndTicketLine({ at, updated: ['description'], commented: true, skipped: null, error: null, screenshots: 3 }).text).toBe(
      "Ensemble updated the ticket's description and commented on it in Jira with 3 screenshots.",
    );
    expect(endToEndTicketLine({ at, updated: [], commented: true, skipped: null, error: null, screenshots: 1 }).text).toBe(
      'Ensemble commented on the ticket in Jira with 1 screenshot. The plan did not change the ticket text.',
    );
  });
  it('names the fields written and the comment', () => {
    expect(endToEndTicketLine({ at, updated: ['description', 'acceptanceCriteria'], commented: true, skipped: null, error: null })).toEqual({
      text: "Ensemble updated the ticket's description and acceptance criteria and commented on it in Jira.",
      bad: false,
    });
  });
  it('says when only a comment was posted', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: true, skipped: null, error: null }).text).toBe(
      'Ensemble commented on the ticket in Jira. The plan did not change the ticket text.',
    );
  });
  it('a failure reads as bad, with its sentence', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: true, skipped: null, error: 'Jira refused the change.' })).toEqual({
      text: 'Ensemble commented on the ticket in Jira. The plan did not change the ticket text. Jira refused the change.',
      bad: true,
    });
  });
  it('another tracker: nothing written', () => {
    expect(endToEndTicketLine({ at, updated: [], commented: false, skipped: 'not_jira', error: null }).text).toBe(
      'Ensemble updates Jira tickets only, so it did not change this one.',
    );
  });
});
