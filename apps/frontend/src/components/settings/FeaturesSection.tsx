import { FEATURE_IDS } from '@pierre-review/shared';
import { useMe } from '../../hooks/useTriage.js';
import { useSetFeatureSettings } from '../../hooks/useFeatureSettings.js';
import { FEATURE_WORDS, nextFeatureSettings } from '../../lib/featureSwitches.js';
import { InfoButton } from '../InfoModal.js';
import { Switch } from '../ui/index.js';
import { SectionShell } from './ui.js';

// SETTINGS → FEATURES (shared features.ts; docs/FRONTEND.md § Features shown). One switch per page the
// sidebar can leave out. ACCOUNT grain, stored server-side (`accounts.feature_settings`), taking
// effect on the click. Hiding is visibility only: a link still opens the page, and every sync, read
// and scoring run carries on. ⚠ The Timeline is the exception: off (the default) means no board, no
// Focus tabs and no board fetch, and a link to it opens Open pull requests.
export function FeaturesSection(): JSX.Element | null {
  const features = useMe().data?.features;
  const save = useSetFeatureSettings();
  // An older server sends no switches: every page shows and there is nothing to set.
  if (features == null) return null;
  return (
    <SectionShell
      title="Features"
      desc="Choose which pages the sidebar shows."
      info={
        <InfoButton title="Features">
          <p>
            A page switched off leaves the sidebar and the search menu. A link to it still opens it, and
            Limn keeps syncing and scoring as before.
          </p>
          <p>
            The Timeline is off until you switch it on. While it is off, a link to it opens Open pull
            requests, and pull requests open in their own tab instead of a Focus tab.
          </p>
          <p>
            Reports and This Sprint switch themselves on when they have something to show. Switch one off
            to keep it hidden.
          </p>
        </InfoButton>
      }
    >
      {FEATURE_IDS.map((id) => (
        <Switch
          key={id}
          data-testid={`feature-switch-${id}`}
          label={FEATURE_WORDS[id].label}
          hint={FEATURE_WORDS[id].hint}
          checked={features[id].visible}
          disabled={save.isPending}
          onChange={(e) => save.mutate(nextFeatureSettings(features, id, e.target.checked))}
        />
      ))}
      {save.isError && <div className="text-meta text-ui-danger">{save.error.message || 'Couldn’t save.'}</div>}
    </SectionShell>
  );
}
