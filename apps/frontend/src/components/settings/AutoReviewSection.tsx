import { useEffect, useState } from 'react';
import {
  AUTO_FIX_DAILY_CAP,
  AUTO_POST_DEFAULT_KINDS,
  AUTO_POST_DEFAULT_SCOPE,
  type AutoPostKinds,
  type AutoPostScope,
} from '@pierre-review/shared';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { AiAuthLine, AiRuntimeSetup } from '../AiSetup.js';
import { InfoButton } from '../InfoModal.js';
import {
  useSetWorkspaceAutoReview,
  useWorkspaceAutoReview,
} from '../../hooks/useWorkspaceAutoReview.js';
import { dateTime } from '../../lib/ui.js';
import { SaveButton, SectionShell } from './ui.js';

const CAP_MIN = 1;
const CAP_MAX = 500;
/** The typed cap → an integer in range, or null when it is not one. */
function parseCap(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= CAP_MIN && n <= CAP_MAX ? n : null;
}
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
 * 0083 / pg 0070) — OFF by default since 0084 / pg 0071. It only runs after an auto review of the reader's own PR, so
 * it is DIMMED and inert while auto review is off; its value is kept, never cleared, so turning
 * auto review back on restores it. One Save writes both.
 *
 * THE DAILY CAP (`dailyCap`, `workspaces.auto_review_daily_cap`, migration 0085 / pg 0072) is an
 * integer 1..500 typed beside the switch; the server stores it as an override (20 = the default).
 * A text box with a numeric keypad, not `type="number"`, so a half-typed value is visible and an
 * invalid one shuts Save with a reason instead of being clamped silently. Same Save as the rest.
 *
 * AUTO-POSTING (`autoPost`, `workspaces.auto_post_enabled` + `auto_post_settings`, migration 0087 /
 * pg 0074) — OFF until switched on. A master switch, the WHICH-PRs choice and one checkbox per kind.
 * Every control under the master switch is DIMMED, never disabled, while it is off (the reader can
 * set it up first), and the whole block is dimmed while auto review is off (it acts on auto runs
 * only). Same Save as the rest; only what changed is sent.
 */

const KIND_ROWS: Array<{ key: keyof AutoPostKinds; label: string }> = [
  { key: 'blockers', label: 'Blockers' },
  { key: 'warnings', label: 'Warnings' },
  { key: 'nits', label: 'Nits' },
  { key: 'questions', label: 'Questions, each as its own PR comment' },
  { key: 'storyGaps', label: 'Story gaps, on the PR they belong to' },
  { key: 'notAskedFor', label: 'Work the story did not ask for' },
];

const sameKinds = (a: AutoPostKinds, b: AutoPostKinds): boolean =>
  KIND_ROWS.every(({ key }) => a[key] === b[key]);
export function AutoReviewSection(): JSX.Element {
  const { workspaceId } = useSettingsWorkspace();
  const settings = useWorkspaceAutoReview(true, workspaceId);
  const update = useSetWorkspaceAutoReview(workspaceId);
  const ai = useAiCapabilities();
  const aiReady = ai.ready;

  const stored = settings.data?.autoReview ?? null;
  const storedOn = stored?.enabled === true;
  const storedFix = stored?.autoFixEnabled === true;
  const [on, setOn] = useState(storedOn);
  const [fixOn, setFixOn] = useState(storedFix);
  const storedCap = stored?.dailyCap ?? 20;
  const [capText, setCapText] = useState(String(storedCap));
  const storedPost = stored?.autoPost ?? null;
  const storedPostOn = storedPost?.enabled === true;
  const storedScope: AutoPostScope = storedPost?.scope ?? AUTO_POST_DEFAULT_SCOPE;
  const storedKinds: AutoPostKinds = storedPost?.kinds ?? AUTO_POST_DEFAULT_KINDS;
  const storedKindsKey = KIND_ROWS.map(({ key }) => (storedKinds[key] ? '1' : '0')).join('');
  const [postOn, setPostOn] = useState(storedPostOn);
  const [scope, setScope] = useState<AutoPostScope>(storedScope);
  const [kinds, setKinds] = useState<AutoPostKinds>(storedKinds);
  // Re-seed on the stored VALUE (not the response object — a background refetch hands back a new
  // identity and would undo a half-made edit).
  useEffect(() => {
    setOn(storedOn);
  }, [workspaceId, storedOn]);
  useEffect(() => {
    setFixOn(storedFix);
  }, [workspaceId, storedFix]);
  useEffect(() => {
    setCapText(String(storedCap));
  }, [workspaceId, storedCap]);
  useEffect(() => {
    setPostOn(storedPostOn);
  }, [workspaceId, storedPostOn]);
  useEffect(() => {
    setScope(storedScope);
  }, [workspaceId, storedScope]);
  useEffect(() => {
    setKinds(storedKinds);
    // Keyed on the VALUES, not the object (a refetch hands back a new one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, storedKindsKey]);

  if (workspaceId == null || settings.data == null) {
    return <ScopePendingSection title="Auto Claude review" failed={settings.isError} />;
  }
  const cap = parseCap(capText);
  const capDirty = cap != null && cap !== storedCap;
  const postDirty = postOn !== storedPostOn || scope !== storedScope || !sameKinds(kinds, storedKinds);

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
            skipped. Reviews you start yourself always go first.
          </span>
        </span>
      </label>
      <div className={`pl-5 text-xs ${on ? '' : 'opacity-60'}`}>
        <label className="flex flex-wrap items-center gap-1.5 text-gray-700 dark:text-gray-200">
          <span>Up to</span>
          <input
            type="text"
            inputMode="numeric"
            aria-label="Auto reviews a day"
            aria-invalid={cap == null}
            className="w-16 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs dark:border-gray-600 dark:bg-gray-800"
            value={capText}
            onChange={(e) => setCapText(e.target.value)}
          />
          <span>auto reviews a day (UTC). The rest wait for the next day.</span>
        </label>
        <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
          New pushes and review comments on a PR that was already reviewed count too.
        </span>
        {cap == null && (
          <span className="mt-0.5 block text-xs text-red-500">
            Enter a whole number from {CAP_MIN} to {CAP_MAX}.
          </span>
        )}
      </div>
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
      <div className={`space-y-1.5 border-t border-gray-200 pt-2 text-xs dark:border-gray-700 ${on ? '' : 'opacity-60'}`}>
        <div className="flex items-start gap-1">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={postOn}
              onChange={(e) => setPostOn(e.target.checked)}
            />
            <span>
              <span className="font-medium text-gray-700 dark:text-gray-200">
                Post Claude reviews to GitHub automatically
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                {on
                  ? 'Auto reviews only, as soon as they finish. Reviews you start yourself keep the Post button.'
                  : 'Auto reviews only, so nothing is posted while auto review is off.'}
              </span>
            </span>
          </label>
          <InfoButton title="Posting automatically">
            <p>
              Limn posts as you, with your GitHub account. Findings go in one review that only
              comments: it never approves and never requests changes. On GitHub that counts as your
              review.
            </p>
            <p>
              Nothing is posted twice: a comment already on the PR, from any earlier review, is
              left out, and so is anything you ignored. Merged, closed and draft PRs, and PRs opened
              by bots, are never posted on. A review request to a team does not make a PR yours:
              Limn does not know which teams you are in.
            </p>
            <p>If a post fails, the Claude Review tab says so and the Post button stays.</p>
          </InfoButton>
        </div>
        <div className={`space-y-1.5 pl-5 ${postOn ? '' : 'opacity-60'}`}>
          <fieldset className="space-y-1">
            <legend className="font-medium text-gray-700 dark:text-gray-200">Which PRs</legend>
            <label className="flex items-start gap-2 text-gray-700 dark:text-gray-200">
              <input
                type="radio"
                name="auto-post-scope"
                className="mt-0.5"
                checked={scope === 'mine'}
                onChange={() => setScope('mine')}
              />
              <span>PRs you are asked to review, and your own</span>
            </label>
            <label className="flex items-start gap-2 text-gray-700 dark:text-gray-200">
              <input
                type="radio"
                name="auto-post-scope"
                className="mt-0.5"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              <span>Every PR auto review covers</span>
            </label>
          </fieldset>
          <fieldset className="space-y-1">
            <legend className="font-medium text-gray-700 dark:text-gray-200">What to post</legend>
            {KIND_ROWS.map(({ key, label }) => (
              <label key={key} className="flex items-start gap-2 text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={kinds[key]}
                  onChange={(e) => setKinds((k) => ({ ...k, [key]: e.target.checked }))}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
        </div>
      </div>
      <SaveButton
        dirty={cap != null && (on !== storedOn || fixOn !== storedFix || capDirty || postDirty)}
        saving={update.isPending}
        onClick={() =>
          update.mutate({
            enabled: on,
            autoFixEnabled: fixOn,
            ...(capDirty && cap != null ? { dailyCap: cap } : {}),
            ...(postDirty ? { autoPost: { enabled: postOn, scope, kinds } } : {}),
          })
        }
      />
      {update.isError && (
        <div className="text-xs text-red-500">
          {(update.error as Error)?.message ?? 'Couldn’t save.'}
        </div>
      )}
    </SectionShell>
  );
}
