import { useState } from 'react';
import {
  LICENCE_ACTIVATE_URL,
  LICENCE_FREE_USERS,
  LICENCE_PRICING_URL,
  type LicenceKeyProblem,
  type LicenceStatusResponse,
} from '@pierre-review/shared';
import { api, LicenceKeyRejected } from '../../api/client.js';
import { useLicenceAction, useLicenceStatus } from '../../hooks/useLicence.js';
import { Button } from '../ui/index.js';
import { Field, SectionShell, inputCls } from './ui.js';

// SETTINGS → LICENCE (docs/LICENSING.md): who needs a licence, the licence key, and how many people
// this machine sees using Ensemble. The key is checked OFFLINE on this computer; nothing here is sent
// anywhere. No prices: they live on the website, and a price typed into the app would go stale in
// every released copy.

const LICENSE_URL = 'https://github.com/alexwakeman/pierre-review/blob/main/LICENSE';
const LINK = 'hit text-ui-ink underline';

const PROBLEM: Record<LicenceKeyProblem, string> = {
  malformed: 'That is not an Ensemble licence key. Copy the whole key from the activation page.',
  unknown_signer: 'This copy of Ensemble does not recognise that key. Update Ensemble, then try again.',
  bad_signature: 'That key has been changed since it was issued. Copy it again from the activation page.',
  expired: 'That licence has expired. Renew it, then activate it again for a new key.',
};

function usersLine(s: LicenceStatusResponse): string {
  const n = s.users.count;
  if (n <= 1) return 'No one else in your repositories has posted through Ensemble in the last 90 days.';
  const where = s.users.owner != null ? ` in ${s.users.owner}` : '';
  return `${n} people, you included, have posted through Ensemble${where} in the last 90 days. People who only read in Ensemble are not counted.`;
}

function licenceLine(s: LicenceStatusResponse): string | null {
  const l = s.licence;
  if (l == null) return null;
  if (!l.ok) return PROBLEM[l.problem];
  return `Licensed to ${l.org} for up to ${l.seats} people, valid through ${l.expires}.`;
}

export function LicenceSection(): JSX.Element {
  const { data } = useLicenceStatus();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useLicenceAction((k: string) => api.saveLicence(k));
  const remove = useLicenceAction((_: void) => api.removeLicence());

  const onSave = (): void => {
    setError(null);
    save.mutate(key, {
      onSuccess: () => setKey(''),
      onError: (e) => setError(e instanceof LicenceKeyRejected ? PROBLEM[e.problem] : 'Ensemble could not save the key. Try again.'),
    });
  };

  const line = data ? licenceLine(data) : null;
  return (
    <SectionShell
      title="Licence"
      desc={`Every feature is in this copy. It is free for one person, and for an organisation where ${LICENCE_FREE_USERS} or fewer people use it.`}
    >
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          More than {LICENCE_FREE_USERS} people in your organisation (affiliates counted together) need one licence a year
          for the organisation.{' '}
          <a href={LICENCE_PRICING_URL} target="_blank" rel="noreferrer" className={LINK}>
            See the prices
          </a>
          .
        </li>
        <li>
          Count everyone who runs Ensemble or works with it directly. A colleague who only sees its comments on GitHub
          does not count.{' '}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className={LINK}>
            Read the licence
          </a>
          .
        </li>
      </ul>

      {data && (
        <p className="mt-3 text-body text-ui-ink" data-testid="licence-users">
          {usersLine(data)}
        </p>
      )}

      {line && (
        <p
          className={`mt-3 text-body ${data?.licence?.ok ? 'text-ui-ink' : 'text-ui-danger'}`}
          data-testid="licence-status"
        >
          {line}
        </p>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <Field
          label={data?.licence?.ok ? 'Replace the licence key' : 'Licence key'}
          htmlFor="licence-key"
          hint={
            <>
              Bought a licence? Get the key on the{' '}
              <a href={LICENCE_ACTIVATE_URL} target="_blank" rel="noreferrer" className={LINK}>
                activation page
              </a>
              . It is checked on this computer; nothing is sent.
            </>
          }
        >
          <textarea
            id="licence-key"
            className={`${inputCls} font-mono`}
            rows={3}
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="ENS1.…"
          />
        </Field>
        {error && (
          <p role="alert" className="text-body text-ui-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={key.trim() === '' || save.isPending} onClick={onSave}>
            Save key
          </Button>
          {data?.licence != null && (
            <Button disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
              Remove key
            </Button>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
