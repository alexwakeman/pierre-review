import { useQuery } from '@tanstack/react-query';
import type { CloneStorageResponse } from '@pierre-review/shared';
import { api } from '../../api/client.js';
import { useAiCapabilities } from '../../hooks/useAiCapabilities.js';
import { diskSizeText } from '../../lib/diskSize.js';
import { InfoButton } from '../InfoModal.js';
import { SectionShell } from './ui.js';

// Settings → AI → Disk space: one line saying what Limn's clone cache holds (GET /api/storage/clones;
// backend review/worktree-gc.ts). Machine-wide, so the key has no `ws:` segment. Read when the AI
// tab opens (the tab mounts its sections), never polled. Nothing to set: the sweep runs by itself.
export function DiskSpaceSection(): JSX.Element | null {
  const caps = useAiCapabilities();
  const q = useQuery<CloneStorageResponse>({
    queryKey: ['clone-storage'],
    queryFn: () => api.cloneStorage(),
    enabled: caps.enabled,
    retry: false,
    staleTime: 60_000,
  });
  if (!caps.enabled) return null;
  const d = q.data;
  return (
    <SectionShell
      title="Disk space"
      info={
        <InfoButton title="Disk space">
          <p>
            Limn keeps one copy of each repository an AI run has read, and checks a pull request out
            for each run. A run removes its checkout when it ends.
          </p>
          <p>
            A checkout left behind by a crash, or for a pull request that has merged or closed, is
            removed when Limn starts and when a new run begins. A checkout holding a fix you have not
            pushed is kept until you push or discard it, for up to 14 days.
          </p>
        </InfoButton>
      }
    >
      <p className="text-body text-ui-ink" role="status">
        {d == null ? (
          q.isError ? 'Could not read the disk.' : 'Reading…'
        ) : (
          <>
            Repositories {diskSizeText(d.cloneBytes)} · {d.checkouts === 1 ? '1 checkout' : `${d.checkouts} checkouts`}
            {d.checkouts > 0 ? ` (${diskSizeText(d.checkoutBytes)})` : ''}
            {d.freedBytes30d != null && d.freedBytes30d > 0 ? ` · ${diskSizeText(d.freedBytes30d)} freed in 30 days` : ''}
          </>
        )}
      </p>
    </SectionShell>
  );
}
