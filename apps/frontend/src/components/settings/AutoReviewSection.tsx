import { useEffect, useState } from 'react';
import {
  AUTO_FIX_DAILY_CAP,
  AUTO_FIX_DEFAULT_INCLUDE,
  AUTO_POST_DEFAULT_KINDS,
  AUTO_POST_DEFAULT_SCOPE,
  type AutoFixInclude,
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
 *
 * Under it, two more switches ride the same `autoPost` object (both OFF by default, migration 0091 /
 * pg 0078): `autoVerdict` (the review's event becomes Claude's stricter verdict — only when the
 * reader's own last review was a comment, never on their own PR) and `autoResolve` (Limn's own
 * threads, once a later review finds them fixed). AUTO FIX gains "Always include" (one checkbox per
 * fix-picker section; style bots off by default) and "Push automatically" (OFF) — `autoFix` on the
 * same route, dimmed while auto fix is off.
 */

const KIND_ROWS: Array<{ key: keyof AutoPostKinds; label: string }> = [
  { key: 'blockers', label: 'Blockers' },
  { key: 'warnings', label: 'Warnings' },
  { key: 'nits', label: 'Nits' },
  { key: 'questions', label: 'Questions, on the line they ask about where possible' },
  { key: 'ciFailures', label: 'CI failure reasons, in one PR comment' },
  { key: 'storyGaps', label: 'Story gaps, on the PR they belong to' },
  { key: 'notAskedFor', label: 'Work the story did not ask for' },
];

const sameKinds = (a: AutoPostKinds, b: AutoPostKinds): boolean =>
  KIND_ROWS.every(({ key }) => a[key] === b[key]);

const FIX_ROWS: Array<{ key: keyof AutoFixInclude; label: string }> = [
  { key: 'findings', label: 'Claude’s findings' },
  { key: 'earlierFindings', label: 'Earlier findings not fixed yet' },
  { key: 'judgedThreads', label: 'Threads Claude says to fix' },
  { key: 'untouchedThreads', label: 'Threads nobody has answered' },
  { key: 'ciFailures', label: 'CI failure reasons' },
  { key: 'styleBots', label: 'Style bot comments (SonarCloud, Codecov…)' },
];
const sameInclude = (a: AutoFixInclude, b: AutoFixInclude): boolean =>
  FIX_ROWS.every(({ key }) => a[key] === b[key]);
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
  const storedVerdict = storedPost?.autoVerdict === true;
  const storedResolve = storedPost?.autoResolve === true;
  const [verdict, setVerdict] = useState(storedVerdict);
  const [resolve, setResolve] = useState(storedResolve);
  const storedInclude: AutoFixInclude = stored?.autoFix?.include ?? AUTO_FIX_DEFAULT_INCLUDE;
  const storedIncludeKey = FIX_ROWS.map(({ key }) => (storedInclude[key] ? '1' : '0')).join('');
  const storedPush = stored?.autoFix?.autoPush === true;
  const [include, setInclude] = useState<AutoFixInclude>(storedInclude);
  const [autoPush, setAutoPush] = useState(storedPush);
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
  useEffect(() => {
    setVerdict(storedVerdict);
  }, [workspaceId, storedVerdict]);
  useEffect(() => {
    setResolve(storedResolve);
  }, [workspaceId, storedResolve]);
  useEffect(() => {
    setInclude(storedInclude);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, storedIncludeKey]);
  useEffect(() => {
    setAutoPush(storedPush);
  }, [workspaceId, storedPush]);

  if (workspaceId == null || settings.data == null) {
    return <ScopePendingSection title="Auto Claude review" failed={settings.isError} />;
  }
  const cap = parseCap(capText);
  const capDirty = cap != null && cap !== storedCap;
  const postDirty =
    postOn !== storedPostOn ||
    scope !== storedScope ||
    !sameKinds(kinds, storedKinds) ||
    verdict !== storedVerdict ||
    resolve !== storedResolve;
  const fixSettingsDirty = autoPush !== storedPush || !sameInclude(include, storedInclude);

  return (
    <SectionShell
      title="Auto Claude review"
      desc="Claude reviews each new PR a person opens in this workspace, with the same model and budget as the Review button. It runs on your own Claude Code or Anthropic API key."
      info={
        <InfoButton title="Auto Claude review">
          <p>
            Only PRs a person opens after you turn this on are reviewed. Drafts wait until they are
            marked ready. PRs opened by bots are skipped.
          </p>
          <p>
            A reviewed PR is reviewed again when new commits are pushed, or when a person or a
            review bot adds review comments. A first push after a quiet spell starts a review at
            once. Pushes during a review or within 5 minutes of one, and new comments, wait until
            the PR has been quiet for 5 minutes, or 20 minutes at most. Limn’s own comments never
            start a review.
          </p>
          <p>
            These re-reviews count towards the daily limit. Reviews you start yourself always go
            first.
          </p>
        </InfoButton>
      }
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
            Only PRs opened after you turn this on.
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
              {!on
                ? 'Runs only after an auto review, so it is off while auto review is off.'
                : autoPush
                  ? 'After an auto review of a PR you opened, prepare a fix and push it.'
                  : 'After an auto review of a PR you opened, prepare a fix. Nothing is pushed.'}
            </span>
          </span>
        </label>
        <InfoButton title="Auto AI Fix">
          <p>
            When an auto review of a PR you opened finishes, Limn prepares one AI Fix from that
            review. Unless you turn on Push automatically, the fix waits in the AI Fix tab until
            you press Push. A push is never forced; if it fails, the AI Fix tab says so.
          </p>
          <p>
            Other people’s PRs are never fixed automatically. At most {AUTO_FIX_DAILY_CAP} auto fixes per PR a day,
            and none while a fix is running or waiting to be pushed.
          </p>
        </InfoButton>
      </div>
      <div className={`space-y-1 pl-10 text-xs ${on && fixOn ? '' : 'opacity-60'}`}>
        <fieldset className="space-y-1">
          <legend className="font-medium text-gray-700 dark:text-gray-200">Always include</legend>
          {FIX_ROWS.map(({ key, label }) => (
            <label key={key} className="flex items-start gap-2 text-gray-700 dark:text-gray-200">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={include[key]}
                onChange={(e) => setInclude((v) => ({ ...v, [key]: e.target.checked }))}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={autoPush}
            onChange={(e) => setAutoPush(e.target.checked)}
          />
          <span>
            <span className="font-medium text-gray-700 dark:text-gray-200">Push automatically</span>
            <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
              Pushes a finished fix to the PR’s branch. Not built or tested first.
            </span>
          </span>
        </label>
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
              Limn posts as you, with your GitHub account. Findings go in one review, with
              questions on the lines they ask about. The review only comments unless you turn on
              Approve or request changes. On GitHub it counts as your review.
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
              <span>Your own PRs, and PRs you are asked to review or have reviewed or commented on</span>
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
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={verdict}
              onChange={(e) => setVerdict(e.target.checked)}
            />
            <span>
              <span className="font-medium text-gray-700 dark:text-gray-200">
                Approve or request changes for me
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                Approves only with no blockers or warnings. Only when your last review was a
                comment, never on your own PRs.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={resolve}
              onChange={(e) => setResolve(e.target.checked)}
            />
            <span>
              <span className="font-medium text-gray-700 dark:text-gray-200">
                Resolve Limn’s threads once fixed
              </span>
              <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400">
                When a later review finds a posted comment fixed, Limn replies and resolves it.
              </span>
            </span>
          </label>
        </div>
      </div>
      <SaveButton
        dirty={cap != null && (on !== storedOn || fixOn !== storedFix || capDirty || postDirty || fixSettingsDirty)}
        saving={update.isPending}
        onClick={() =>
          update.mutate({
            enabled: on,
            autoFixEnabled: fixOn,
            ...(capDirty && cap != null ? { dailyCap: cap } : {}),
            ...(postDirty
              ? { autoPost: { enabled: postOn, scope, kinds, autoVerdict: verdict, autoResolve: resolve } }
              : {}),
            ...(fixSettingsDirty ? { autoFix: { include, autoPush } } : {}),
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
