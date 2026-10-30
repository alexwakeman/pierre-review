// "RUN TESTS" — the picker's list (`GET /api/pro/prs/:id/ai-fix/checks`, docs/API.md): the checks the
// PR's head DECLARES (coding/checks/discover.ts, the same function the run uses on its worktree), read
// through ONE GitHub request for the manifest files, plus whether this machine can sandbox them. Asked
// only when the reader ticks "Run tests" (never on mount). Cached per (repo, head) for ten minutes.
import type { AiFixChecksPreview } from '@pierre-review/shared';
import { config } from '../../config.js';
import type { AgentContext } from '../../review/agent-context.js';
import { CHECK_MANIFEST_FILES, detectSandbox, discoverChecks } from '../checks/index.js';
import { getFixPrContext } from './pr-context.js';

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: AiFixChecksPreview }>();

/** For tests. */
export function clearChecksPreviewCache(): void {
  cache.clear();
}

/** The sentence the picker shows when tests cannot run on this machine, or null. */
export function checksUnavailableNote(sandbox: { kind: string; reason: string | null }, allowUnsandboxed: boolean): string | null {
  if (sandbox.kind !== 'none' || allowUnsandboxed) return null;
  return `Tests can’t run here: Limn runs them only inside a sandbox. ${sandbox.reason ?? ''}`.trim();
}

export async function loadChecksPreview(
  ctx: AgentContext,
  input: { accountId: number; prId: number },
): Promise<AiFixChecksPreview | null> {
  const fetchFiles = ctx.github.fetchRepoFiles;
  if (!fetchFiles) return null;
  const pr = await getFixPrContext(ctx, input.accountId, input.prId);
  if (!pr) return null;
  // The synced head: the run itself re-reads the live head and discovers again on its own worktree,
  // so a stale list can only offer a name the run then skips — never run something undeclared.
  let ref = pr.headSha;
  if (!ref) ref = (await ctx.github.fetchPrHeadInfo(input.accountId, pr.owner, pr.name, pr.number)).headSha || null;
  if (!ref) return null;
  const key = `${input.accountId}:${pr.repoId}:${ref}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const files = await fetchFiles(input.accountId, { owner: pr.owner, name: pr.name, ref, paths: CHECK_MANIFEST_FILES });
  const plan = discoverChecks({ read: (p) => files[p] ?? null });
  const sandbox = detectSandbox();
  const value: AiFixChecksPreview = {
    checks: plan.checks.map((c) => ({
      name: c.name,
      kind: c.kind,
      command: c.kind === 'hook' ? `git commit (${c.source})` : c.argv.join(' '),
      source: c.source,
      defaultOn: c.defaultOn,
      needsDocker: c.needsDocker,
      refused: c.refused,
    })),
    sandbox: sandbox.kind,
    unavailable: checksUnavailableNote(sandbox, config.checksAllowUnsandboxed),
    unsandboxed: sandbox.kind === 'none' && config.checksAllowUnsandboxed,
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
