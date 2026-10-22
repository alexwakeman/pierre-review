import { useQuery } from '@tanstack/react-query';
import type { ProSettings } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Per-account settings (`/api/pro/settings`). ⚠ WHAT IS LEFT ON THIS ROUTE IS THE
// COMPARISON-WINDOW MODE AND THE BOT TOGGLES. Three settings moved to the WORKSPACE grain and none kept an account default beneath
// it: the Slack digest (plugin 0030), and the sprint cadence + the Jira/Linear tracker (plugin
// 0031) — all three now read/write `useWorkspaceProSettings` / `useSlackTarget`.
// `ProSettings.sprint.cadenceDays`, `.startDate` and `.issue` still ride the wire but are ALWAYS
// empty, so nothing may branch on them; the PUT schema silently STRIPS them.
// Fetched only when `enabled`. Sole consumer: `BotRoiPanel`, which reads the deprecated legacy
// cost blob. One shared key + a 60s staleTime.
export function useProSettings(enabled: boolean) {
  return useQuery<ProSettings>({
    queryKey: ['pro-settings'],
    queryFn: api.proSettings,
    enabled,
    staleTime: 60_000,
  });
}

// ⚠ THERE IS NO `useUpdateProSettings` ANY MORE, AND ITS ABSENCE IS THE POINT. The
// comparison-window MODE was the last live field on the account patch and moved to the workspace
// row in plugin migration 0032 (`useUpdateWorkspaceProSettings`, `comparisonMode`); the bot
// Slack-digest flag moved to the delivery row in 0033 (`useUpdateSlackTarget`, `botDigest`).
// Every remaining key in `ProSettingsUpdate` is silently STRIPPED by the PUT schema, so the hook
// would have been a mutation that always succeeds and never changes anything — the worst shape a
// settings write can have, because the UI reads back "saved".
//
// ⚠ THE INVALIDATION IT OWNED MOVED WITH THE SETTING, NOT WITH THE HOOK. It swept
// `['workspace-insights']` / `['workspace-metrics-detail']` on a `sprint` patch because the
// comparison window re-frames the flow metrics and those queries otherwise only refetch on the
// 5-min sync cadence. `useUpdateWorkspaceProSettings` now fires that sweep for a `comparisonMode`
// patch as well as a `sprint` one — dropping it there would have made Save look inert until the
// next sync.
