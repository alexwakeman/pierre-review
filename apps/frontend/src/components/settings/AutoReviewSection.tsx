import { useEffect, useState } from 'react';
import { AUTO_FIX_DAILY_CAP } from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { AiAuthLine, AiRuntimeSetup } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import {
  useSetWorkspaceAutoReview,
  useWorkspaceAutoReview,
} from '../../hooks/useWorkspaceAutoReview.js';
import { dateTime } from '../../lib/ui.js';
import { SaveButton, SectionShell } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

/**
 * AUTO CLAUDE REVIEW for the currently-selected workspace — CORE, on the workspace row (migration
 * 0074 / pg 0061; `GET`/`PUT /api/workspaces/:id/auto-review`). Mounted only where agentic AI runs
 * (`me.ai.enabled`: local, no kill switch); the route is not registered anywhere else, so the
 * switch could never be a promise the sweeper does not keep. OFF until someone turns it on: it
 * spends the reader's own Claude in the background.
 *
 * The copy states the rule and stops: which PRs, how many a day, what it costs to run. Turning it
 * off and on again moves the start, and the "since" line says from when.
 *
 * ⚠ While AI is not set up (no runtime, or no Claude credential) the sweeper queues nothing — a
 * failed run would use up the PR's one automatic review — so the section says so and offers the
 * same setup control as a Run button. The switch stays usable: turning it on early is fine.
 *
 * AUTO AI FIX is the second switch (`autoFixEnabled`, `workspaces.auto_fix_enabled`, migration
 * 0083 / pg 0070) — ON by default. It only runs after an auto review of the reader's own PR, so
 * it is DIMMED and inert while auto review is off; its value is kept, never cleared, so turning
 * auto review back on restores it. One Save writes both.
 */
export function AutoReviewSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const settings = useWorkspaceAutoReview(true, workspaceId);
  const update = useSetWorkspaceAutoReview(workspaceId);
  const ai = useAiCapabilities();
  const aiReady = ai.ready;

  const stored = settings.data?.autoReview ?? null;
  const storedOn = stored?.enabled === true;
  const storedFix = stored?.autoFixEnabled !== false;
  const [on, setOn] = useState(storedOn);
  const [fixOn, setFixOn] = useState(storedFix);
  // Re-seed on the stored VALUE (not the response object — a background refetch hands back a new
  // identity and would undo a half-made edit).
  useEffect(() => {
    setOn(storedOn);
  }, [workspaceId, storedOn]);
  useEffect(() => {
    setFixOn(storedFix);
  }, [workspaceId, storedFix]);

  if (workspaceId == null || settings.data == null) {
    return <ScopePendingSection title="Auto Claude review" failed={settings.isError} />;
  }
  const cap = stored?.dailyCap ?? 20;

  return (
    <SectionShell
      title="Auto Claude review"
      desc="Claude reviews each new PR a person opens in this workspace, once, with the same model and budget as the Review button. It runs on your own Claude Code or Anthropic API key."
    >
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={on}
          onChange={(e) => setOn(e.target.checked)}
        />
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">
            Review new PRs automatically
          </span>
          <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
            Only PRs opened after you turn this on. Drafts wait until they are ready. Bots are
            skipped. At most {cap} a day (UTC); the rest wait for the next day. Reviews you start
            yourself always go first.
          </span>
        </span>
      </label>
      <div className={`flex items-start gap-1 pl-5 text-xs ${on ? '' : 'opacity-60'}`}>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={fixOn}
            disabled={!on}
            onChange={(e) => setFixOn(e.target.checked)}
          />
          <span>
            <span className="font-medium text-gray-700 dark:text-gray-200">
              Auto AI Fix on your own PRs
            </span>
            <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
              {on
                ? 'After an auto review of a PR you opened, prepare a fix. Nothing is pushed.'
                : 'Runs only after an auto review, so it is off while auto review is off.'}
            </span>
          </span>
        </label>
        <InfoButton title="Auto AI Fix">
          <p>
            When an auto review of a PR you opened finishes, Limn prepares one AI Fix from that
            review. It never pushes: the fix waits in the AI Fix tab until you press Push.
          </p>
          <p>
            Other people’s PRs are never fixed automatically. At most {AUTO_FIX_DAILY_CAP} auto fixes per PR a day,
            and none while a fix is running or waiting to be pushed.
          </p>
        </InfoButton>
      </div>
      {!aiReady && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
          <span>Nothing is reviewed until AI is set up.</span>
          {ai.runtime !== 'ready' ? <AiRuntimeSetup /> : <AiAuthLine />}
        </div>
      )}
      {storedOn && stored?.enabledAt != null && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          On since {dateTime(stored.enabledAt)}.
        </p>
      )}
      <SaveButton
        dirty={on !== storedOn || fixOn !== storedFix}
        saving={update.isPending}
        onClick={() => update.mutate({ enabled: on, autoFixEnabled: fixOn })}
      />
      {update.isError && (
        <div className="text-xs text-red-500">
          {(update.error as Error)?.message ?? 'Couldn’t save.'}
        </div>
      )}
    </SectionShell>
  );
}
