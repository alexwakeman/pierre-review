import { useEffect, useMemo, useState } from 'react';
import type { SlackDigestCadence, WorkspaceSlackTargetUpdate } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import {
  useDeleteSlackTarget,
  useSlackTarget,
  useUpdateSlackTarget,
} from '../../hooks/useSlackTarget.js';
import { InfoButton } from '../InfoModal.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { Field, SectionShell, inputCls, CheckInput } from './ui.js';
import { SaveState, useAutoSave, useEchoGuard } from './autosave.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';
import { Select, type SelectOption } from '../ui/index.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number): string => {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${am ? 'AM' : 'PM'}`;
};
const HOUR_OPTIONS = HOURS.map((h) => ({ value: String(h), label: hourLabel(h) }));

/**
 * The Slack digest for the CURRENTLY-SELECTED workspace.
 *
 * ⚠ THERE IS NO PICKER AND NO "APPLY TO ALL" ANY MORE. This section used to edit the account's
 * whole SELECTION of workspaces at once, which meant a write here could add — or, by omission,
 * silently cancel — deliveries for teams the reader was not looking at. It now edits ONE row, the
 * one named in the heading, through `/api/pro/slack/target?workspace=`.
 *
 * ⚠ THE COST DISCLOSURE SURVIVED THE PICKER, AND HAD TO. Every workspace with a target generates
 * its OWN sprint report on every send — a billed model call each — and with no screen listing all
 * of them, `configuredCount of cap` is the ONLY warning a reader gets before the write is refused.
 * Both numbers are the server's, so the sentence and the rule cannot drift apart.
 *
 * ⚠ THE WEBHOOK FIELD IS WRITE-ONLY. The API never returns a stored URL, so an EMPTY field means
 * "keep what is stored", never "clear it". There is deliberately no account-level webhook to
 * inherit from either: a nullable "inherit" column is the null-means-INHERIT bug class, and
 * inheriting a webhook is the worst case of it — a new team's private figures would silently land
 * in a channel somebody configured years ago.
 *
 * ⚠ TURNING IT OFF IS A VERB, AND THERE ARE TWO OF THEM. `cadence: 'off'` PAUSES and keeps the
 * channel; "Stop sending" DELETEs the row, which is what frees a slot under the cap.
 *
 * ⚠ THE "REVIEW BOTS" BLOCK IS A FIELD ON THIS ROW, NOT A SETTING SOMEWHERE ELSE. It used to be
 * `pro_settings.bot_slack_digest`, one flag per ACCOUNT, edited in a separate "Review bots"
 * section of this modal — a premise that died when the digest itself became per-workspace: from
 * that point one account flag decided the CONTENT of N independently-scheduled messages about N
 * different teams' bots, and a team with no bots got a section about somebody else's problem. It
 * is a checkbox on this form as of plugin migration 0033 (`WorkspaceSlackTargetUpdate.botDigest`),
 * under the schedule it belongs to, saved with it. It needs no fence precisely BECAUSE it is now
 * the same grain as everything around it.
 *
 * SAVES AS YOU GO (./autosave.tsx). On a STORED row each cadence, hour and tick writes at once. The
 * webhook is a SECRET: it is written only on an explicit commit (blur or Enter) of a non-empty URL,
 * never per keystroke, and the field clears once stored. With no row yet the schedule is held here
 * and goes in with the webhook that creates the row.
 *
 * ⚠ THE WORKSPACE IS NAMED ONCE, IN THE MODAL'S "Workspace" HEADING, NOT IN THIS TITLE. The name
 * is still load-bearing — there is no picker in Settings, so a reader must be able to see which
 * team they are retuning — but three sections each appending "— acme-web" was one fact three
 * times. The name STAYS in the sentences where it disambiguates one workspace from ANOTHER (the
 * cap disclosure points at a different team's settings), and only there.
 */
const CADENCE_OPTIONS: readonly SelectOption<SlackDigestCadence>[] = [
  { value: 'off', label: 'Off (paused, channel kept)' },
  { value: 'daily', label: 'Daily' },
  { value: 'twice_daily', label: 'Twice daily' },
];

export function SlackSection(): JSX.Element {
  const { workspaceId, name } = useSettingsWorkspace();
  const query = useSlackTarget(workspaceId != null, workspaceId);
  const mutation = useUpdateSlackTarget(workspaceId);
  const removal = useDeleteSlackTarget(workspaceId);
  const data = query.data;
  const target = data?.target ?? null;

  /** Typed this session only. '' = keep whatever is stored (the field is write-only). */
  const [webhookUrl, setWebhookUrl] = useState('');
  const [cadence, setCadence] = useState<SlackDigestCadence>('daily');
  const [hour1, setHour1] = useState(9);
  const [hour2, setHour2] = useState(16);
  const [botDigest, setBotDigest] = useState(false);
  const [notifyReviews, setNotifyReviews] = useState(false);
  const [notifyMerges, setNotifyMerges] = useState(false);
  // Claude Review runs only where the agentic features do (local), so its switch shows only there.
  const reviewsCanRun = useAiCapabilities().enabled;
  const [test, setTest] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({
    busy: false,
    msg: null,
    ok: false,
  });

  // ⚠ RE-SEEDED ON THE SERVER VALUE, NOT ON THE RESPONSE OBJECT. React Query hands back a new
  // object identity on every background refetch (a window focus is enough), so a `[data]`
  // dependency would wipe a half-typed webhook and a changed send-hour while the user was still
  // editing. The signature changes only when the stored row actually does — or when the scope
  // moves, which MUST re-seed: the previous workspace's schedule left in the inputs is a schedule
  // the next write would put onto the new one.
  const signature = useMemo(
    () =>
      target == null
        ? `${workspaceId ?? 'none'}:none`
        : `${workspaceId ?? 'none'}:${target.cadence}:${target.hour1}:${target.hour2}:${target.botDigest}:${target.notifyReviews}:${target.notifyMerges}`,
    [target, workspaceId],
  );
  // The typed webhook is intentionally dropped on a re-seed: it is already saved (or the save
  // failed and the user should retype), and holding a secret in component state across a refetch
  // is how it gets re-submitted by accident.
  const echo = useEchoGuard(JSON.stringify([cadence, hour1, hour2, botDigest, notifyReviews, notifyMerges]), workspaceId);
  useEffect(() => {
    if (echo.keepDraft()) return;
    setWebhookUrl('');
    setTest({ busy: false, msg: null, ok: false });
    if (target == null) {
      setCadence('daily');
      setHour1(9);
      setHour2(16);
      setBotDigest(false);
      setNotifyReviews(false);
      setNotifyMerges(false);
      return;
    }
    setCadence(target.cadence);
    setHour1(target.hour1);
    setHour2(target.hour2);
    setBotDigest(target.botDigest);
    setNotifyReviews(target.notifyReviews);
    setNotifyMerges(target.notifyMerges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // ⚠ THE TYPED SECRET IS DROPPED THE MOMENT IT IS STORED, and this is a SEPARATE effect because
  // the seed above cannot see it: a webhook-only save changes no cadence and no hour, so the
  // signature is identical and that effect never runs — the URL would sit in the input, still
  // "dirty", inviting a second submission of a secret already saved. It keys on `mutation.data`
  // (a fresh object per success) and NOT on `isPending`, so a save that FAILS keeps what the user
  // typed rather than making them find the URL again.
  useEffect(() => {
    if (mutation.isSuccess) setWebhookUrl('');
  }, [mutation.isSuccess, mutation.data]);

  // ⚠ THE NAME NOW APPEARS EXACTLY ONCE IN THIS SECTION, in the cap sentence, and only because
  // that sentence names TWO workspaces: the one whose digest must be stopped and the one being
  // added. Everywhere else "this workspace" is unambiguous — the modal's "Workspace" heading has
  // already said which. Prefer the SERVER's name over the rail's: it came back with the row.
  const label = data?.workspaceName ?? name ?? 'this workspace';

  const schedule: WorkspaceSlackTargetUpdate = { cadence, hour1, hour2, botDigest, notifyReviews, notifyMerges };
  // ⚠ ONLY A STORED ROW CAN BE DIRTIED BY A SCHEDULE FIELD. With no row there is nothing to
  // patch — the webhook is what creates one — so cadence, the hours AND the bot block all ride in
  // on the committed URL rather than each being a write of its own.
  const scheduleDirty =
    target != null &&
    (cadence !== target.cadence ||
      hour1 !== target.hour1 ||
      hour2 !== target.hour2 ||
      botDigest !== target.botDigest ||
      notifyReviews !== target.notifyReviews ||
      notifyMerges !== target.notifyMerges);
  const autosave = useAutoSave({
    key: JSON.stringify(schedule),
    ready: workspaceId != null && scheduleDirty,
    busy: mutation.isPending,
    run: () => {
      echo.markSent();
      mutation.mutate(schedule);
    },
  });

  // ⚠ NOTHING RENDERS — AND NOTHING SAVES — AGAINST AN UNRESOLVED SCOPE. A PUT with no
  // `?workspace=` is answered by the account's DEFAULT workspace, which on this surface would post
  // one team's figures into another team's channel.
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Slack" failed={query.isError} />;
  }

  const typed = webhookUrl.trim();
  // A workspace with no stored row and nothing typed cannot be delivered to — the server refuses
  // it (an undeliverable row would sit in the sweep being skipped forever).
  // ⚠ THE CAP BITES ON THE ACT OF ADDING, so it only blocks a workspace that has no row yet. A
  // workspace already configured can always be edited, cap or no cap.
  const wouldExceedCap = target == null && data.configuredCount >= data.cap;
  const webhookProblem = typed !== '' && !/^https:\/\//i.test(typed) ? 'the webhook URL must start with https://.' : null;
  /** The webhook's explicit commit (blur / Enter): the schedule rides along. Never per keystroke. */
  const commitWebhook = (): void => {
    if (typed === '' || webhookProblem != null || wouldExceedCap || mutation.isPending) return;
    mutation.mutate({ ...schedule, webhookUrl: typed });
  };
  /** A select or tick: written at once (on a stored row). */
  const now = <T,>(setter: (v: T) => void) => (v: T): void => {
    autosave.now();
    setter(v);
  };

  const sendTest = async (): Promise<void> => {
    setTest({ busy: true, msg: null, ok: false });
    try {
      const r = await api.testSlackDigest(workspaceId);
      setTest({
        busy: false,
        ok: r.sent,
        msg: r.sent ? 'Sent — check Slack.' : (r.message ?? 'Not sent.'),
      });
    } catch (e) {
      setTest({ busy: false, ok: false, msg: (e as Error).message });
    }
  };

  return (
    <SectionShell
      title="Slack"
      desc="Sends this workspace’s Pending board, sprint summary, merges and auto reviews to a Slack channel."
      info={
        <InfoButton title="Slack">
          <p>
            Each digest lists the team’s Pending tabs: the top 5 of each, every PR once. My turn is
            left out. A short sprint summary follows. Links open the app.
          </p>
          <p>
            The two event messages are off until you switch them on. A review message is sent once
            when an auto review finishes. Reviews you start yourself are never posted to Slack. A
            merge message names who merged the pull request and is sent once per pull request, only
            for merges seen as they happen.
          </p>
          <p>
            Every workspace with a digest writes its own sprint summary on every send, so at most{' '}
            {data.cap} workspaces can have one. A summary is not rewritten when the workspace’s
            activity has not changed.
          </p>
        </InfoButton>
      }
    >
      {removal.isError && (
        <p className="rounded-ui bg-ui-raise px-2 py-1 text-body text-ui-danger">
          {(removal.error as Error).message}
        </p>
      )}

      {target == null && (
        <p className="text-meta text-ui-mute">
          This workspace receives no digest. Add a webhook below to start.
        </p>
      )}

      {/* Gap 9 (docs/TEAM-REVIEW.md): Limn runs on each machine, so two teammates on one channel both post. */}
      <p className="text-meta text-ui-mute" data-testid="slack-one-per-channel">
        Only one person per channel should set this up — each Ensemble posts its own copy.
      </p>

      <Field
        label="Incoming webhook URL"
        hint={
          target != null ? (
            <span className="text-ui-mute">
              A webhook is stored. Enter a new URL to replace it.
            </span>
          ) : (
            'Create one at api.slack.com/apps → Incoming Webhooks.'
          )
        }
      >
        <input
          type="url"
          className={inputCls}
          placeholder={
            target != null ? '•••••••• (unchanged)' : 'https://hooks.slack.com/services/…'
          }
          value={webhookUrl}
          autoComplete="off"
          onChange={(e) => setWebhookUrl(e.target.value)}
          onBlur={commitWebhook}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitWebhook();
          }}
        />
      </Field>

      <div className="flex flex-wrap gap-3">
        <Field group label="Cadence">
          <Select
            label="Cadence"
            value={cadence}
            onChange={now(setCadence)}
            options={CADENCE_OPTIONS}
          />
        </Field>
        {cadence !== 'off' && (
          <Field group label="Send at" hint={target?.timezone ?? 'server time'}>
            <Select
              label="Send at"
              value={String(hour1)}
              onChange={(v) => now(setHour1)(Number(v))}
              options={HOUR_OPTIONS}
            />
          </Field>
        )}
        {cadence === 'twice_daily' && (
          <Field group label="And at">
            <Select
              label="And at"
              value={String(hour2)}
              onChange={(v) => now(setHour2)(Number(v))}
              options={HOUR_OPTIONS}
            />
          </Field>
        )}
      </div>

      {/* ⚠ THE "REVIEW BOTS" BLOCK IS PART OF THIS ROW, AND SITS UNDER THE SCHEDULE IT MODIFIES.
          It is a property of THIS DELIVERY (plugin migration 0033), not an account preference: it
          decides what goes INTO the message configured directly above it. Its previous home was a
          separate account-wide "Review bots" section in this modal, which is deleted — there is no
          longer a second grain here to fence off. */}
      <label className="flex items-start gap-2 text-body">
        <CheckInput
          className="mt-0.5"
          checked={botDigest}
          onChange={(e) => now(setBotDigest)(e.target.checked)}
        />
        <span>
          <span className="font-medium text-ui-ink">
            Include a review-bot summary
          </span>
          <span className="block text-meta text-ui-faint">
            Adds each review bot’s comment count, the share your team used and the number left
            untouched. This workspace’s digest only.
          </span>
        </span>
      </label>

      {/* The two EVENT signals (plugin migration 0040). Same row; the cadence above
          does not gate them — "Off" pauses the digest, not these. */}
      {reviewsCanRun && (
        <label className="flex items-start gap-2 text-body">
          <CheckInput
            className="mt-0.5"
            checked={notifyReviews}
            onChange={(e) => now(setNotifyReviews)(e.target.checked)}
          />
          <span>
            <span className="font-medium text-ui-ink">
              Post when an auto review finishes
            </span>
            <span className="block text-meta text-ui-faint">
              Reviews you start yourself are never posted. The pull request, its verdict and the
              review’s summary. Not the comments.
            </span>
          </span>
        </label>
      )}
      <label className="flex items-start gap-2 text-body">
        <CheckInput
          className="mt-0.5"
          checked={notifyMerges}
          onChange={(e) => now(setNotifyMerges)(e.target.checked)}
        />
        <span>
          <span className="font-medium text-ui-ink">
            Post when a pull request merges
          </span>
          <span className="block text-meta text-ui-faint">
            The pull request and who merged it.
          </span>
        </span>
      </label>

      {/* ⚠ THE CAP, DISCLOSED AS A SENTENCE BEFORE IT REFUSES. Removing the picker removed the one
          screen that listed every delivery, so this line is now the only place a reader can see
          how much of the sweep is already committed. The numbers are the server's. */}
      <p
        className={`text-meta ${wouldExceedCap ? 'text-ui-danger' : 'text-ui-mute'}`}
      >
        {data.configuredCount} of {data.cap} workspaces{' '}
        {data.configuredCount === 1 ? 'has' : 'have'} a digest, each its own report on every send.
        {wouldExceedCap
          ? ` At the maximum — stop one from that workspace’s settings before adding ${label}.`
          : ''}
      </p>

      <SaveState section="Slack" mutation={mutation} dirty={scheduleDirty} invalid={webhookProblem} />

      {target != null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-ui-line pt-3">
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={test.busy}
            className="inline-flex h-7 items-center rounded-ui bg-ui-raise px-2.5 text-body font-medium text-ui-ink hover:bg-ui-hover touch:h-10 disabled:opacity-40"
          >
            {test.busy ? 'Sending…' : 'Send test'}
          </button>
          {test.msg != null && (
            <span
              className={`text-meta ${test.ok ? 'text-ui-success' : 'text-ui-mute'}`}
            >
              {test.msg}
            </span>
          )}
          {target.lastSentAt != null && (
            <span className="text-meta text-ui-faint">
              Last sent {new Date(target.lastSentAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => removal.mutate()}
            disabled={removal.isPending}
            className="hit ml-auto text-meta text-ui-faint underline hover:text-ui-danger disabled:opacity-50"
            title="Delete this workspace's channel and stop the digest. Use cadence 'Off' to pause without losing the webhook."
          >
            {removal.isPending ? 'Stopping…' : 'Stop sending (delete the channel)'}
          </button>
        </div>
      )}
    </SectionShell>
  );
}
