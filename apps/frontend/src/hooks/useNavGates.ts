import { useAiCapabilities } from './useAiCapabilities.js';
import { useMe } from './useTriage.js';
import type { NavGates } from '../components/shell/nav.js';

/** What the sidebar, bottom bar, key sheet and ⌘K list (Settings → Features + the AI gate). */
export function useNavGates(): NavGates {
  const aiOn = useAiCapabilities().enabled;
  const features = useMe().data?.features;
  return { aiOn, features };
}
