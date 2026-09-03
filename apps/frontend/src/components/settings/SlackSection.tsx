import { useEffect, useMemo, useState } from 'react';
import type { SlackDigestCadence, WorkspaceSlackTargetUpdate } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import {
  useDeleteSlackTarget,
  useSlackTarget,
  useUpdateSlackTarget,
} from '../../hooks/useSlackTarget.js';
import { Field, SaveButton, SectionShell, inputCls } from './ui.js';
import { ScopePendingSection, useSettingsWorkspace } from './workspaceScope.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number): string => {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${am ? 'AM' : 'PM'}`;
};

/**
 * The Slack digest for the CURRENTLY-SELECTED workspace.
 *
 * ⚠ THERE IS NO PICKER AND NO "APPLY TO ALL" ANY MORE. This section used to edit the account's
 * whole SELECTION of workspaces at once, which meant a Save here could add — or, by omission,
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
 * under the schedule it belongs to, saved by this section's one Save. It needs no fence and no
 * second button precisely BECAUSE it is now the same grain as everything around it.
 *
 * ⚠ THE WORKSPACE IS NAMED ONCE, IN THE MODAL'S "Workspace" HEADING, NOT IN THIS TITLE. The name
 * is still load-bearing — there is no picker in Settings, so a reader must be able to see which
 * team they are retuning — but three sections each appending "— acme-web" was one fact three
 * times. The name STAYS in the sentences where it disambiguates one workspace from ANOTHER (the
 * cap disclosure points at a different team's settings), and only there.
 */
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
  // this Save would write onto the new one.
  const signature = useMemo(
    () =>
      target == null
        ? `${workspaceId ?? 'none'}:none`
        : `${workspaceId ?? 'none'}:${target.cadence}:${target.hour1}:${target.hour2}:${target.botDigest}`,
    [target, workspaceId],
  );
  // The typed webhook is intentionally dropped on a re-seed: it is already saved (or the save
  // failed and the user should retype), and holding a secret in component state across a refetch
  // is how it gets re-submitted by accident.
  useEffect(() => {
    setWebhookUrl('');
    setTest({ busy: false, msg: null, ok: false });
    if (target == null) {
      setCadence('daily');
      setHour1(9);
      setHour2(16);
      setBotDigest(false);
      return;
    }
    setCadence(target.cadence);
    setHour1(target.hour1);
    setHour2(target.hour2);
    setBotDigest(target.botDigest);
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

  // ⚠ NOTHING RENDERS — AND NOTHING SAVES — AGAINST AN UNRESOLVED SCOPE. A PUT with no
  // `?workspace=` is answered by the account's DEFAULT workspace, which on this surface would post
  // one team's figures into another team's channel.
  if (workspaceId == null || data == null) {
    return <ScopePendingSection title="Slack digest" failed={query.isError} />;
  }

  const typed = webhookUrl.trim();
  // A workspace with no stored row and nothing typed cannot be delivered to — the server refuses
  // it (an undeliverable row would sit in the sweep being skipped forever). Named here so the Save
  // button explains itself rather than 400-ing.
  const needsWebhook = target == null && typed === '';
  // ⚠ THE CAP BITES ON THE ACT OF ADDING, so it only blocks a workspace that has no row yet. A
  // workspace already configured can always be edited, cap or no cap.
  const wouldExceedCap = target == null && data.configuredCount >= data.cap;
  // ⚠ ONLY A STORED ROW CAN BE DIRTIED BY A SCHEDULE FIELD. With no row there is nothing to
  // patch — the webhook is what creates one — so cadence, the hours AND the bot block all ride in
  // on the typed URL rather than each claiming to be a saveable edit on their own.
  const dirty =
    typed !== '' ||
    (target != null &&
      (cadence !== target.cadence ||
        hour1 !== target.hour1 ||
        hour2 !== target.hour2 ||
        botDigest !== target.botDigest));

  const onSave = (): void => {
    const patch: WorkspaceSlackTargetUpdate = { cadence, hour1, hour2, botDigest };
    // Only send the webhook when one was typed. '' would be a no-op server-side, but sending it
    // makes the request carry a secret-shaped field for no reason.
    if (typed !== '') patch.webhookUrl = typed;
    mutation.mutate(patch);
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
      title="Slack digest"
      desc={
        <>
          Deliver a sprint + repo digest for this workspace to a Slack channel on a schedule. The
          message covers only this workspace’s repos and links back into the app.{' '}
          <span className="font-medium">
            Every workspace with a digest generates its own report on every send
          </span>
          , so at most {data.cap} can have one. Reports are generated fresh at send time and cost
          nothing for a workspace whose activity has not changed.
        </>
      }
    >
      {mutation.isError && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-950 dark:text-red-300">
          {(mutation.error as Error).message}
        </p>
      )}
      {removal.isError && (
        <p className="rounded bg-red-50 px-2 py-1 text-xs text-red-600 dark:bg-red-950 dark:text-red-300">
          {(removal.error as Error).message}
        </p>
      )}

      {target == null && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          This workspace receives no digest. Add a webhook below to start.
        </p>
      )}

      <Field
        label="Incoming webhook URL"
        hint={
          target != null ? (
            <span className="text-emerald-500">
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
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
      </Field>

      <div className="flex gap-2">
        <Field label="Cadence">
          <select
            className={inputCls}
            value={cadence}
            onChange={(e) => setCadence(e.target.value as SlackDigestCadence)}
          >
            <option value="off">Off (paused, channel kept)</option>
            <option value="daily">Daily</option>
            <option value="twice_daily">Twice daily</option>
          </select>
        </Field>
        {cadence !== 'off' && (
          <Field label="Send at" hint={target?.timezone ?? 'server time'}>
            <select
              className={inputCls}
              value={hour1}
              onChange={(e) => setHour1(Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {cadence === 'twice_daily' && (
          <Field label="And at">
            <select
              className={inputCls}
              value={hour2}
              onChange={(e) => setHour2(Number(e.target.value))}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {/* ⚠ THE "REVIEW BOTS" BLOCK RIDES THIS FORM'S SAVE, AND SITS UNDER THE SCHEDULE IT MODIFIES.
          It is a property of THIS DELIVERY (plugin migration 0033), not an account preference: it
          decides what goes INTO the message configured directly above it. Its previous home was a
          separate account-wide "Review bots" section in this modal, which is deleted — there is no
          longer a second grain here to fence off. */}
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={botDigest}
          onChange={(e) => setBotDigest(e.target.checked)}
        />
        <span>
          <span className="font-medium text-gray-700 dark:text-gray-200">
            Include a review-bot summary
          </span>
          <span className="block text-[11px] text-gray-400">
            Adds a deterministic bots block — volume · acted-on · untouched — to this workspace’s
            digest. Other workspaces’ digests are unaffected; each one decides for itself.
          </span>
        </span>
      </label>

      {/* ⚠ THE CAP, DISCLOSED AS A SENTENCE BEFORE IT REFUSES. Removing the picker removed the one
          screen that listed every delivery, so this line is now the only place a reader can see
          how much of the sweep is already committed. The numbers are the server's. */}
      <p
        className={`text-[11px] ${wouldExceedCap ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}
      >
        {data.configuredCount} of {data.cap} workspaces{' '}
        {data.configuredCount === 1 ? 'has' : 'have'} a digest, each its own report on every send.
        {wouldExceedCap
          ? ` At the maximum — stop one from that workspace’s settings before adding ${label}.`
          : ''}
      </p>

      <div className="flex items-center gap-2">
        <SaveButton
          dirty={dirty && !needsWebhook && !wouldExceedCap}
          saving={mutation.isPending}
          onClick={onSave}
        />
        {needsWebhook && dirty && (
          <span className="text-[11px] text-red-500">A webhook URL is required.</span>
        )}
      </div>

      {target != null && (
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 dark:border-gray-800">
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={test.busy}
            className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {test.busy ? 'Sending…' : 'Send test'}
          </button>
          {test.msg != null && (
            <span
              className={`text-[11px] ${test.ok ? 'text-emerald-500' : 'text-gray-500 dark:text-gray-400'}`}
            >
              {test.msg}
            </span>
          )}
          {target.lastSentAt != null && (
            <span className="text-[11px] text-gray-400">
              Last sent {new Date(target.lastSentAt).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => removal.mutate()}
            disabled={removal.isPending}
            className="ml-auto text-[11px] text-gray-400 underline hover:text-red-500 disabled:opacity-50"
            title="Delete this workspace's channel and stop the digest. Use cadence 'Off' to pause without losing the webhook."
          >
            {removal.isPending ? 'Stopping…' : 'Stop sending (delete the channel)'}
          </button>
        </div>
      )}
    </SectionShell>
  );
}
