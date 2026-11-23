import { SectionShell } from './ui.js';

// SETTINGS → LICENCE: who needs a commercial licence, said inside the app itself. Ensemble has no
// sign-in, no telemetry and no licence check, so this line and the pricing page are the only places
// an organisation learns it must pay. No prices here: they live on the website (one place), and a
// price typed into the app would go stale with every released copy.

const PRICING_URL = 'https://ensemble.ac/pricing';
const LICENSE_URL = 'https://github.com/alexwakeman/pierre-review/blob/main/LICENSE';

export function LicenceSection(): JSX.Element {
  return (
    <SectionShell title="Licence" desc="Every feature is in this copy. The licence decides who may use it free.">
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Free for you on your own, and for an organisation where 3 or fewer people use Ensemble.</li>
        <li>
          More than 3 people in your organisation (affiliates counted together) need one licence a year for the
          organisation.{' '}
          <a href={PRICING_URL} target="_blank" rel="noreferrer" className="hit text-ui-ink underline">
            See the prices
          </a>
          .
        </li>
        <li>
          Count everyone who runs Ensemble or works with it directly. A colleague who only sees its comments on GitHub
          does not count.{' '}
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="hit text-ui-ink underline">
            Read the licence
          </a>
          .
        </li>
      </ul>
    </SectionShell>
  );
}
