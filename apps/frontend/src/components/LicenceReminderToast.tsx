import { LICENCE_FREE_USERS, LICENCE_PRICING_URL } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useLicenceAction, useLicenceStatus } from '../hooks/useLicence.js';
import { useSettingsModal } from '../store/settingsModal.js';
import { HeaderToast, ToastLineButton, ToastList, ToastRow } from './HeaderToasts.js';
import { PeopleIcon } from './Icons.js';

// THE LICENCE REMINDER (docs/LICENSING.md § The reminder): a circle in the ONE toast cluster when
// more than LICENCE_FREE_USERS people are seen posting through Ensemble in one organisation and no
// licence covers them. ⚠ A REMINDER, NEVER A BLOCK: nothing in the app reads it, every choice quiets
// it, and the count it quotes is a floor (people who only read are not seen).
//
//   Enter a key      → Settings → Licence
//   We're evaluating → the ONE 30-day evaluation (offered until used)
//   X                → "Remind me in 7 days"
export function LicenceReminderToast(): JSX.Element | null {
  const { data } = useLicenceStatus();
  const openSettings = useSettingsModal((s) => s.openSettings);
  const evaluate = useLicenceAction((_: void) => api.startLicenceEvaluation());
  const later = useLicenceAction((_: void) => api.snoozeLicenceReminder());
  if (data?.reminder?.show !== true) return null;

  const n = data.users.count;
  const where = data.users.owner != null ? ` in ${data.users.owner}` : '';
  const summary =
    data.reminder.reason === 'over_licence_seats' && data.licence?.ok
      ? `${n} people use Ensemble${where}; your licence covers ${data.licence.seats}.`
      : `${n} people use Ensemble${where}. Above ${LICENCE_FREE_USERS}, an organisation needs a licence.`;

  return (
    <HeaderToast
      testId="licence-reminder-toast"
      tone="neutral"
      icon={<PeopleIcon size={13} />}
      label="Licence"
      summary={summary}
      action={<ToastLineButton onClick={() => openSettings('licence')}>Enter a key</ToastLineButton>}
      onDismiss={() => later.mutate(undefined)}
      dismissLabel="Remind me in 7 days"
    >
      <ToastList>
        {data.reminder.canEvaluate && (
          <ToastRow>
            <button type="button" className="hit text-ui-ink underline" onClick={() => evaluate.mutate(undefined)}>
              We&rsquo;re evaluating: remind us in 30 days
            </button>
          </ToastRow>
        )}
        <ToastRow>
          <a href={LICENCE_PRICING_URL} target="_blank" rel="noreferrer" className="hit text-ui-ink underline">
            See the prices
          </a>
        </ToastRow>
        <ToastRow>
          <span className="text-ui-mute">Counted on this computer from who posts through Ensemble. Nothing is sent.</span>
        </ToastRow>
      </ToastList>
    </HeaderToast>
  );
}
