import { useState } from 'react';
import type { IssueProvider } from '@pierre-review/shared';
import { Field, SaveButton, SectionShell, inputCls, type SectionProps } from './ui.js';

const PLACEHOLDER: Record<IssueProvider, string> = {
  jira: 'https://your-org.atlassian.net',
  linear: 'https://linear.app/your-workspace',
};

// Jira / Linear provider + base URL. When set, PR detail shows deep links for any ticket key
// (e.g. PROJ-123) found in the PR title or head branch — and flags when none is found. Detection
// is compute-on-read (no backfill); see the Pro ticket enricher.
export function IssueLinksSection({ settings, save, saving }: SectionProps): JSX.Element {
  const saved = settings.issue;
  const [provider, setProvider] = useState<IssueProvider | ''>(saved.provider ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(saved.baseUrl ?? '');
  // Project keys as a comma-separated string in the input; parsed to a list on save. The saved
  // list is normalized (uppercase), so compare against its comma-joined form.
  const savedKeys = saved.projectKeys.join(', ');
  const [projectKeys, setProjectKeys] = useState<string>(savedKeys);
  const parsedKeys = projectKeys
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter((k) => k !== '');

  const dirty =
    (provider || null) !== saved.provider ||
    baseUrl.trim() !== (saved.baseUrl ?? '') ||
    parsedKeys.join(',') !== saved.projectKeys.join(',');

  return (
    <SectionShell
      title="Issue tracker"
      desc="Link Jira/Linear tickets detected in a PR's title or branch into the PR details."
    >
      <Field label="Provider">
        <select
          className={inputCls}
          value={provider}
          onChange={(e) => setProvider(e.target.value as IssueProvider | '')}
        >
          <option value="">None</option>
          <option value="jira">Jira</option>
          <option value="linear">Linear</option>
        </select>
      </Field>
      {provider !== '' && (
        <>
          <Field
            label="Base URL"
            hint={
              provider === 'jira'
                ? 'Tickets link to {base}/browse/KEY-123.'
                : 'Tickets link to {base}/issue/KEY-123.'
            }
          >
            <input
              type="url"
              className={inputCls}
              placeholder={PLACEHOLDER[provider]}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </Field>
          <Field
            label="Project keys"
            hint="Optional, comma-separated (e.g. ENG, PROJ). When set, ONLY these prefixes are detected (in the title AND branch) — the most reliable way to avoid false matches like GPT-4 or node-18. Leave blank to detect uppercase keys in the PR title only."
          >
            <input
              type="text"
              className={inputCls}
              placeholder="ENG, PROJ"
              value={projectKeys}
              onChange={(e) => setProjectKeys(e.target.value)}
            />
          </Field>
        </>
      )}
      <SaveButton
        dirty={dirty}
        saving={saving}
        onClick={() =>
          save({
            issue: {
              provider: provider === '' ? null : provider,
              baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
              projectKeys: parsedKeys,
            },
          })
        }
      />
    </SectionShell>
  );
}
