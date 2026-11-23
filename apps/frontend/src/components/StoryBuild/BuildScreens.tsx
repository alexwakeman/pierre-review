import { useState } from 'react';
import { storyBuildPath, type SandboxLiveShot, type StoryBuild, type StoryBuildScreen } from '@pierre-review/shared';
import { usePostStoryBuildScreens } from '../../hooks/useStoryBuild.js';
import { dateTime } from '../../lib/ui.js';
import { InfoButton } from '../InfoModal.js';
import { Button } from '../ui/Button.js';

// THE SCREENS THE AGENT LOOKED AT (the build report's `screens`; docs/SANDBOX.md § The browser). A SELF-REPORT:
// the agent's own verdict, said as such. The screenshots are Ensemble's checked copies, loaded only when the reader
// presses "Show screenshots" (never on mount), from the build's own route.

export const SCREEN_VERDICT_WORDS: Record<StoryBuildScreen['verdict'], string> = {
  matches: 'Matches',
  differs: 'Differs',
  no_design: 'No design to compare',
};

export function BuildScreens({ build }: { build: StoryBuild }): JSX.Element | null {
  const screens = build.screens ?? [];
  if (screens.length === 0) return null;
  return (
    <div data-testid="story-build-screens-list">
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-meta text-ui-mute">The agent says, for each screen it looked at in the browser:</span>
        <InfoButton title="Screens">
          <p>The agent took these screenshots during the build and compared each screen with the design, or with your existing screens when the ticket has none. The verdict is its own.</p>
          <p className="mt-2">Ensemble checked that each picture is an image before copying it out of the sandbox.</p>
        </InfoButton>
      </div>
      <ul className="space-y-3">
        {screens.map((s, i) => (
          <ScreenRow key={`${i}-${s.name}`} buildId={build.id} screen={s} />
        ))}
      </ul>
      <TicketPost build={build} />
    </div>
  );
}

/** "Post screenshots to the ticket" (Jira or Linear; ONE press, claimed on the server; never tried again after a write). */
function TicketPost({ build }: { build: StoryBuild }): JSX.Element | null {
  const post = usePostStoryBuildScreens(build.workspaceId, build.ident);
  const t = build.screensTicket;
  if (t == null || !t.offered) return null;
  const err = post.error instanceof Error ? post.error.message : null;
  return (
    <div data-testid="story-build-screens-ticket" className="mt-3 flex flex-wrap items-center gap-2 border-t border-ui-line pt-3">
      {t.postedAt != null ? (
        <span className="text-meta text-ui-mute">
          Posted to {build.ticketKey} on {dateTime(t.postedAt)}: {t.attachments ?? 0} screenshot{t.attachments === 1 ? '' : 's'} and one comment.
        </span>
      ) : t.error != null ? (
        <span className="text-meta text-ui-danger">{t.error} Some screenshots may be on the ticket already.</span>
      ) : (
        <>
          <Button size="sm" variant="secondary" data-testid="story-build-screens-post" disabled={post.isPending || t.posting} busy={post.isPending} busyLabel="Posting…" onClick={() => post.mutate(build.id)}>
            Post screenshots to {build.ticketKey}
          </Button>
          <InfoButton title="Post screenshots to the ticket">
            <p>Ensemble adds the screenshots to the ticket, and posts one comment that shows them with the agent&rsquo;s verdicts. On Jira it uses your Jira login; on Linear, the workspace&rsquo;s Linear key. Once per build.</p>
          </InfoButton>
          {err != null && <span className="text-meta text-ui-danger">{err}</span>}
        </>
      )}
    </div>
  );
}

function ScreenRow({ buildId, screen }: { buildId: number; screen: StoryBuildScreen }): JSX.Element {
  const [shown, setShown] = useState(false);
  return (
    <li data-testid="story-build-screen" data-verdict={screen.verdict} className="text-body text-ui-ink">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{screen.name}</span>
        <span className={screen.verdict === 'differs' ? 'text-meta font-medium text-ui-warn' : 'text-meta text-ui-mute'}>{SCREEN_VERDICT_WORDS[screen.verdict]}</span>
        {screen.comparedWith != null && <span className="text-meta text-ui-mute">· with {screen.comparedWith}</span>}
      </div>
      {screen.note !== '' && <p className="mt-0.5 max-w-3xl break-words text-meta text-ui-mute">{screen.note}</p>}
      {screen.shots.length > 0 && (
        <div className="mt-1">
          {!shown ? (
            <Button size="sm" variant="secondary" data-testid="story-build-screen-show" onClick={() => setShown(true)}>
              Show screenshots ({screen.shots.length})
            </Button>
          ) : (
            <div className="flex flex-wrap items-start gap-2">
              {screen.shots.map((shot) => (
                <a key={shot.sha} href={storyBuildPath('shot', { id: buildId, sha: shot.sha })} target="_blank" rel="noreferrer noopener" title={shot.name}>
                  <img
                    data-testid="story-build-screen-shot"
                    src={storyBuildPath('shot', { id: buildId, sha: shot.sha })}
                    alt={`${screen.name}: ${shot.name}`}
                    className="max-h-64 max-w-full rounded-ui border border-ui-line"
                  />
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * LIVE SCREENSHOTS (docs/SANDBOX.md § The browser → Live screenshots): the newest screenshots the agent took in the
 * build's browser, shown as they land (the session's `shots` frames). Each is Ensemble's checked copy, from the build's
 * own route. A click opens it full size.
 */
export function LiveShots({ buildId, shots, live }: { buildId: number; shots: readonly SandboxLiveShot[]; live: boolean }): JSX.Element | null {
  if (shots.length === 0) return null;
  return (
    <div data-testid="story-build-live-shots">
      <p className="mb-2 text-meta text-ui-mute">
        {live ? 'What the agent sees in the browser, newest first.' : 'What the agent saw in the browser, newest first.'}
      </p>
      <ul className="flex flex-wrap items-start gap-2">
        {shots.map((s) => (
          <li key={s.sha}>
            <a href={storyBuildPath('shot', { id: buildId, sha: s.sha })} target="_blank" rel="noreferrer noopener" title={s.name}>
              <img data-testid="story-build-live-shot" src={storyBuildPath('shot', { id: buildId, sha: s.sha })} alt={s.name} loading="lazy" className="max-h-40 max-w-full rounded-ui border border-ui-line" />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
