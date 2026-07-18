import { useMe } from '../../hooks/useTriage.js';
import { useSetBenchmarkConsent } from '../../hooks/useBenchmark.js';
import { SectionShell } from './ui.js';

// Cross-org benchmark consent (CLOUD-ONLY, CORE/free). Lets an account opt in to contributing
// de-identified, AGGREGATE-ONLY weekly review-bot stats to the anonymous benchmark network, so a
// later feature can show how their bots compare to peers. Independent of pro_settings (it's a
// plain flag on /api/me), and available to EVERY cloud account — free or paid — because the
// network needs volume to be worth anything. Rendered only in cloud (see SettingsModal's gate).
export function BenchmarkConsentSection(): JSX.Element {
  const { data: me } = useMe();
  const optIn = me?.benchmarkOptIn ?? false;
  const setConsent = useSetBenchmarkConsent();
  // Optimistic label: reflect the in-flight target so the switch feels responsive.
  const shown = setConsent.isPending ? (setConsent.variables ?? optIn) : optIn;

  return (
    <SectionShell
      title="Contribute to the bot benchmark"
      desc="Opt in to share anonymous, aggregate stats about how your review bots perform, so we can build a neutral cross-team benchmark — e.g. “your CodeRabbit is 38% acted-on vs a 45% peer median”. Off by default."
    >
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-sky-600"
          checked={shown}
          disabled={setConsent.isPending}
          onChange={(e) => setConsent.mutate(e.target.checked)}
        />
        <span className="text-xs text-gray-600 dark:text-gray-300">
          {shown
            ? 'Contributing anonymous weekly bot stats to the benchmark network.'
            : 'Not contributing — turn on to help build the benchmark.'}
        </span>
      </label>

      <ul className="mt-1 space-y-1 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">What&rsquo;s shared:</span>{' '}
          per-vendor weekly counts only — threads, comments, acted-on, untouched, and your
          org-size band. Known vendors only (CodeRabbit, Copilot, …).
        </li>
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">What&rsquo;s never shared:</span>{' '}
          no code, comment text, PR titles, logins, or repository names. In-house bots are
          excluded.
        </li>
        <li>
          <span className="font-medium text-gray-600 dark:text-gray-300">Reversible:</span> turning
          this off immediately deletes everything you&rsquo;ve contributed. Aggregates are only
          ever shown across many teams (k-anonymised).
        </li>
      </ul>

      {setConsent.isError && (
        <div className="text-[11px] text-red-500">
          {(setConsent.error as Error)?.message ?? 'Couldn’t update your choice.'}
        </div>
      )}
    </SectionShell>
  );
}
