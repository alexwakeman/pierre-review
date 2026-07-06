import { useState } from 'react';
import type { SlackDigestCadence } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number): string => {
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${am ? 'AM' : 'PM'}`;
};

// A Slack incoming-webhook that receives the freshly-generated sprint + repo digest on a
// cadence. The webhook URL is write-only (never returned by the API); `configured` reflects
// whether one is stored. The backend cron (Phase 2) sends the report fresh at each due time.
export function SlackSection({ settings, save, saving }: SectionProps): JSX.Element {
  const s = settings.slack;
  const [webhook, setWebhook] = useState<string>('');
  const [cadence, setCadence] = useState<SlackDigestCadence>(s.cadence);
  const [hour1, setHour1] = useState<number>(s.hour1);
  const [hour2, setHour2] = useState<number>(s.hour2);
  const [test, setTest] = useState<{ busy: boolean; msg: string | null; ok: boolean }>({
    busy: false,
    msg: null,
    ok: false,
  });

  const sendTest = async (): Promise<void> => {
    setTest({ busy: true, msg: null, ok: false });
    try {
      const r = await api.testSlackDigest();
      setTest({ busy: false, ok: r.sent, msg: r.sent ? 'Sent — check Slack.' : (r.message ?? 'Not sent.') });
    } catch (e) {
      setTest({ busy: false, ok: false, msg: (e as Error).message });
    }
  };

  const dirty =
    webhook.trim() !== '' ||
    cadence !== s.cadence ||
    hour1 !== s.hour1 ||
    hour2 !== s.hour2;

  return (
    <SectionShell
      title="Slack digest"
      desc="Deliver the sprint + repo digest to a Slack channel on a schedule. Report is generated fresh at send time."
    >
      <Field
        label="Incoming webhook URL"
        hint={
          s.configured ? (
            <span className="text-emerald-500">A webhook is configured. Enter a new URL to replace it, or clear it to disable.</span>
          ) : (
            'Create one at api.slack.com/apps → Incoming Webhooks.'
          )
        }
      >
        <input
          type="url"
          className={inputCls}
          placeholder={s.configured ? '•••••••• (unchanged)' : 'https://hooks.slack.com/services/…'}
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
        />
      </Field>
      <Field label="Cadence">
        <select
          className={inputCls}
          value={cadence}
          onChange={(e) => setCadence(e.target.value as SlackDigestCadence)}
        >
          <option value="off">Off</option>
          <option value="daily">Daily</option>
          <option value="twice_daily">Twice daily</option>
        </select>
      </Field>
      {cadence !== 'off' && (
        <div className="flex gap-2">
          <Field label="Send at" hint={settings.slack.timezone ?? 'server time'}>
            <select className={inputCls} value={hour1} onChange={(e) => setHour1(Number(e.target.value))}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </Field>
          {cadence === 'twice_daily' && (
            <Field label="And at">
              <select className={inputCls} value={hour2} onChange={(e) => setHour2(Number(e.target.value))}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <SaveButton
          dirty={dirty}
          saving={saving}
          onClick={() => {
            const slack: {
              cadence: SlackDigestCadence;
              hour1: number;
              hour2: number;
              webhookUrl?: string;
            } = { cadence, hour1, hour2 };
            // Only send the webhook when the user typed one (write-only; '' would clear it, which
            // we don't want on an unrelated save).
            if (webhook.trim() !== '') slack.webhookUrl = webhook.trim();
            save({ slack });
            setWebhook('');
          }}
        />
        {s.configured && (
          <button
            type="button"
            onClick={sendTest}
            disabled={test.busy}
            className="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {test.busy ? 'Sending…' : 'Send test'}
          </button>
        )}
        {s.configured && (
          // The webhook input is write-only, so an empty save never clears a stored secret. This
          // sends an explicit '' (→ null server-side) to remove it — the "clear it to disable" path.
          <button
            type="button"
            onClick={() => {
              setWebhook('');
              save({ slack: { webhookUrl: '' } });
            }}
            disabled={saving}
            className="rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-40 dark:hover:bg-red-950"
          >
            Remove webhook
          </button>
        )}
        {test.msg != null && (
          <span className={`text-[11px] ${test.ok ? 'text-emerald-500' : 'text-red-500'}`}>
            {test.msg}
          </span>
        )}
      </div>
    </SectionShell>
  );
}
