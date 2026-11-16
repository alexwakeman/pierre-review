import type { StoryBuild } from '@pierre-review/shared';
import { useStoryBuildHowToTestSeen } from '../../hooks/useStoryBuild.js';
import { useStoryChat } from '../../hooks/useStoryChat.js';
import { useOpenStory } from '../../lib/ticketTab.js';
import { useStoryChatFocus } from '../../store/storyChatFocus.js';
import { CloseIcon } from '../Icons.js';
import { Button } from '../ui/Button.js';

// HOW TO TEST AFTER A BUILD (docs/STORY-BUILD.md § How to test after a build). When a build stored its work,
// Ensemble asked the story chat its ready-made "How to test" question. The build tab points at the answer
// until the reader opens it (the story view, on that chat) or dismisses it — once, then never again for
// that answer (`howToTest.seen`). Reads one story chat (its turns say whether the answer is written yet).

/** The pointer's words for the chat's latest turn. Pure (test/storyBuildHowToTest.test.ts). */
export function howToTestLine(status: 'running' | 'done' | 'failed' | 'stopped' | null): string {
  if (status === 'running') return 'Ensemble is writing how to test this story, in the story chat.';
  if (status === 'failed' || status === 'stopped') return 'Ensemble could not write how to test this story. Ask again in the story chat.';
  return 'How to test this story is ready, in the story chat.';
}

export function HowToTestPointer({ build }: { build: StoryBuild }): JSX.Element | null {
  const h = build.howToTest ?? null;
  const show = h != null && !h.seen;
  const chat = useStoryChat(show ? h.chatId : null);
  const seen = useStoryBuildHowToTestSeen(build.workspaceId, build.ident);
  const openStory = useOpenStory();
  const request = useStoryChatFocus((s) => s.request);
  if (!show || h == null) return null;
  const last = chat.data?.turns.at(-1)?.status ?? null;
  const open = (): void => {
    request(build.ident, h.chatId);
    openStory({ ident: build.ident, key: build.ticketKey, title: build.ticketTitle });
    seen.mutate(build.id);
  };
  return (
    <div
      data-testid="story-build-how-to-test"
      role="status"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-ui bg-ui-surface px-4 py-3 ring-1 ring-inset ring-ui-accent/40"
    >
      <p className="m-0 min-w-0 flex-1 text-body text-ui-ink">{howToTestLine(last)}</p>
      <Button size="sm" data-testid="story-build-how-to-test-open" onClick={open}>
        Open in the story
      </Button>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        disabled={seen.isPending}
        onClick={() => seen.mutate(build.id)}
        className="flex h-7 w-7 items-center justify-center rounded-ui text-ui-faint hover:bg-ui-hover hover:text-ui-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent touch:h-10 touch:w-10"
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}
