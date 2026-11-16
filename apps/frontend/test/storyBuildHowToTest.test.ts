// The build tab's "How to test" pointer (components/StoryBuild/HowToTestPointer.tsx): its one line per state
// of the story chat's answer, and the hand-off to the story view's chat panel (store/storyChatFocus.ts).
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyBuildHowToTest.test.ts
import { describe, expect, it } from 'vitest';
import { howToTestLine } from '../src/components/StoryBuild/HowToTestPointer.js';
import { useStoryChatFocus } from '../src/store/storyChatFocus.js';

describe('how to test after a build', () => {
  it('one line per state of the answer', () => {
    expect(howToTestLine('running')).toBe('Ensemble is writing how to test this story, in the story chat.');
    expect(howToTestLine('done')).toBe('How to test this story is ready, in the story chat.');
    expect(howToTestLine(null)).toBe('How to test this story is ready, in the story chat.');
    expect(howToTestLine('failed')).toMatch(/could not write/);
  });

  it('the story view takes the requested chat once, and only for its own story', () => {
    useStoryChatFocus.getState().request('jira:x#A-1', 42);
    expect(useStoryChatFocus.getState().take('jira:x#B-2')).toBeNull();
    expect(useStoryChatFocus.getState().take('jira:x#A-1')).toBe(42);
    expect(useStoryChatFocus.getState().take('jira:x#A-1')).toBeNull();
  });
});
