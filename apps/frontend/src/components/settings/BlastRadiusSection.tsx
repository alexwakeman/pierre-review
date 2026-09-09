import { useEffect, useState } from 'react';
import { BLAST_HIGH_SURFACES, type BlastSensitivity, type BlastSurface } from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useBlastConfig, useSetBlastConfig } from '../../hooks/useBlastRadius.js';
import { Field, SaveButton, SectionShell } from './ui.js';

// BLAST RADIUS — CORE / free, both deployment modes, every tier. The sibling of
// LargePrThresholdSection above it, and deliberately shaped the same way: one account-grained
// setting stored server-side, independent of pro_settings, so like that one and
// BenchmarkConsentSection it renders ABOVE SettingsModal's pro-settings loading gate.
//
// ⚠ A DIAL AND A LIST, NOT SIX NUMBERS. The thresholds behind this are six integers per level,
// and exposing them raw is a settings screen nobody fills in. The dial scales the whole set; the
// checkboxes answer the one question the numbers cannot, which is the false positive below.
// (`BlastRadiusConfig.overrides` still carries per-number control on the wire and the server
// honours it — there is just no UI for it, because nobody has needed one.)

const SENSITIVITY: { value: BlastSensitivity; label: string; desc: string }[] = [
  {
    value: 'cautious',
    label: 'Cautious',
    desc: 'Fewer pull requests count as low. Good when a mistake is expensive to undo.',
  },
  {
    value: 'balanced',
    label: 'Balanced',
    desc: 'The default. On a typical repository about a third of open pull requests land in each level.',
  },
  {
    value: 'relaxed',
    label: 'Relaxed',
    desc: 'More pull requests count as low. Good for a fast-moving repository you can roll back easily.',
  },
];

/** Only the surfaces that can force HIGH are worth switching off — `ci` and `deps` never do, so
 *  listing them would offer a control that changes nothing. */
const SURFACE_LABEL: Record<BlastSurface, string> = {
  db_migration: 'Database migrations',
  db_schema: 'Database schemas and models',
  sql: 'SQL files',
  public_types: 'Published type definitions',
  idl: 'Service contracts (protobuf, GraphQL, Thrift)',
  openapi: 'API descriptions (OpenAPI, Swagger)',
  infra: 'Infrastructure (Terraform, Helm, Kubernetes)',
  auth: 'Auth and security code',
  ci: 'CI workflows',
  deps: 'Dependencies',
};

export function BlastRadiusSection(): JSX.Element {
  const { data: me } = useMe();
  const resolved = useBlastConfig();
  const save = useSetBlastConfig();

  // The STORED config is null whenever the account is on the defaults — `isDefault` is what says
  // so, since the resolved values alone cannot distinguish "the user chose Balanced" from "the
  // user chose nothing". Same distinction `largePrCodeLocThresholdIsDefault` draws next door.
  const stored = me?.blastRadius ?? null;

  const [sensitivity, setSensitivity] = useState<BlastSensitivity>(resolved.sensitivity);
  const [off, setOff] = useState<BlastSurface[]>(resolved.surfacesOff);

  // Re-seed when the server value changes (first load, and after a successful save).
  const storedKey = `${resolved.sensitivity}|${[...resolved.surfacesOff].sort().join(',')}`;
  useEffect(() => {
    setSensitivity(resolved.sensitivity);
    setOff(resolved.surfacesOff);
    // Keyed on the resolved values rather than the object, which is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const draftKey = `${sensitivity}|${[...off].sort().join(',')}`;
  const dirty = draftKey !== storedKey;

  const toggle = (s: BlastSurface): void =>
    setOff((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  return (
    <SectionShell
      title="Blast radius"
      desc="How far a pull request can reach — shown beside each one as Low, Medium or High, so you can tell at a glance which need a real review and which just need a look. It reads what a change touches, not how big it is: a four-line database migration is high, a 2,000-line documentation update is low."
    >
      <Field
        label="Sensitivity"
        htmlFor="blast-sensitivity"
        hint={
          <>
            {stored == null ? 'Currently the product default. ' : ''}
            Applies to every workspace, and takes effect everywhere the moment you save.
          </>
        }
      >
        <div id="blast-sensitivity" className="flex flex-col gap-1.5">
          {SENSITIVITY.map((s) => (
            <label key={s.value} className="flex cursor-pointer items-start gap-2 text-[12px]">
              <input
                type="radio"
                name="blast-sensitivity"
                className="mt-0.5"
                checked={sensitivity === s.value}
                onChange={() => setSensitivity(s.value)}
              />
              <span>
                <span className="font-medium text-gray-700 dark:text-gray-200">{s.label}</span>
                <span className="text-gray-500 dark:text-gray-400"> — {s.desc}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      <Field
        label="Ignore these when judging reach"
        htmlFor="blast-surfaces"
        hint={
          <>
            Touching one of these normally makes a pull request high, however small it is. Switch
            one off if it is simply what your repository is made of — a project whose product{' '}
            <em>is</em> a database schema would otherwise see almost every change called high.
          </>
        }
      >
        <div id="blast-surfaces" className="flex flex-col gap-1">
          {BLAST_HIGH_SURFACES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input type="checkbox" checked={off.includes(s)} onChange={() => toggle(s)} />
              <span className="text-gray-600 dark:text-gray-300">{SURFACE_LABEL[s]}</span>
            </label>
          ))}
        </div>
      </Field>

      <SaveButton
        dirty={dirty}
        saving={save.isPending}
        onClick={() => {
          // ⚠ Save the DEFAULTS as null, not as a stored blob. A blob saying "balanced, nothing
          // off" would freeze this account against any future change to the product defaults —
          // the same two-state rule the large-PR threshold follows.
          const isDefaults = sensitivity === 'balanced' && off.length === 0;
          save.mutate(isDefaults ? null : { sensitivity, surfacesOff: off });
        }}
      />

      {save.isError && (
        <div className="text-[11px] text-red-500">
          {(save.error as Error)?.message ?? 'Couldn’t save your blast-radius settings.'}
        </div>
      )}
    </SectionShell>
  );
}
