import { useEffect, useState } from 'react';
import { useAiCapabilities } from '../hooks/useAiCapabilities.js';
import { useWorkspaceAutoReview } from '../hooks/useWorkspaceAutoReview.js';
import { useFilters } from '../store/filters.js';
import { useSettingsModal } from '../store/settingsModal.js';
import {
  autoReviewCapCopy,
  autoReviewCapDismissKey,
  autoReviewCapState,
  pruneCapDismissals,
} from '../lib/autoReviewCap.js';
import { HeaderToast, ToastLineButton } from './HeaderToasts.js';
import { ReviewIcon } from './Icons.js';

// THE DAILY AUTO-REVIEW LIMIT, as a card in the ONE toast cluster (HeaderToasts.tsx) — never a
// strip or `fixed` toast of its own. Near the cap (≥ 80%, ≥ 2 used) it says how many are used;
// at the cap it says auto reviews stopped, when they start again (the next 00:00 UTC, in local
// time) and offers Settings at the auto-review section, where the cap is changed.
//
// It reads the auto-review GET's `usage` (DB only, the same query as the Open PRs counter) and
// re-reads it once a minute while auto review is on. Shown only while AI runs here
// (`me.ai.enabled`) and auto review is on for the workspace (the GET sends `usage` only then).
// A dismissal holds for one (workspace, UTC day, state) and is kept in this browser only.

const STORAGE_KEY = 'limn:auto-review-cap-dismissed';
const POLL_MS = 60_000;

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw != null ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(keys: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // A blocked store: the dismissal lasts this session only.
  }
}

export function AutoReviewCapToast(): JSX.Element | null {
  const aiOn = useAiCapabilities().enabled;
  const workspaceId = useFilters((s) => s.workspaceId);
  const { data, refetch } = useWorkspaceAutoReview(aiOn, workspaceId);
  const openSettings = useSettingsModal((s) => s.openSettings);
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [now, setNow] = useState(() => Date.now());

  const on = aiOn && workspaceId != null && data?.workspaceId === workspaceId && data.autoReview.enabled;
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => {
      setNow(Date.now());
      void refetch();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [on, refetch]);

  if (!on || workspaceId == null) return null;
  const view = autoReviewCapState(data?.usage);
  if (view == null) return null;
  const key = autoReviewCapDismissKey(workspaceId, view);
  if (dismissed.includes(key)) return null;
  const { label, summary } = autoReviewCapCopy(view, now);
  const reached = view.state === 'reached';
  const dismiss = (): void => {
    const next = [...pruneCapDismissals(dismissed, view), key];
    setDismissed(next);
    writeDismissed(next);
  };
  return (
    <HeaderToast
      testId="auto-review-cap-toast"
      tone="ai"
      icon={<ReviewIcon size={13} />}
      label={label}
      summary={summary}
      action={
        reached ? <ToastLineButton onClick={() => openSettings('auto-review')}>Change limit</ToastLineButton> : undefined
      }
      onDismiss={dismiss}
    />
  );
}
