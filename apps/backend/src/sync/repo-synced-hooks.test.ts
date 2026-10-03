import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetRepoSyncedHooksForTest, notifyRepoSynced, registerRepoSyncedHook } from './repo-synced-hooks.js';

// The plugin's "a PR was received" kick (the Jira ticket worker) rides this seam. It must be a
// KICK: called with the repo, never awaited, and a throwing or rejecting handler never escapes.
describe('repo-synced hooks', () => {
  afterEach(() => _resetRepoSyncedHooksForTest());

  it('calls every handler with the account and repo', () => {
    const a = vi.fn();
    const b = vi.fn();
    registerRepoSyncedHook(a);
    registerRepoSyncedHook(b);
    notifyRepoSynced({ accountId: 3, repoId: 7 }, { warn: () => {} });
    expect(a).toHaveBeenCalledWith({ accountId: 3, repoId: 7 });
    expect(b).toHaveBeenCalledWith({ accountId: 3, repoId: 7 });
  });

  it('a throwing or rejecting handler is logged, never thrown, and does not stop the others', async () => {
    const warn = vi.fn();
    const after = vi.fn();
    registerRepoSyncedHook(() => {
      throw new Error('boom');
    });
    registerRepoSyncedHook(() => Promise.reject(new Error('later')));
    registerRepoSyncedHook(after);
    expect(() => notifyRepoSynced({ accountId: 1, repoId: 2 }, { warn })).not.toThrow();
    expect(after).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not wait for a slow handler', () => {
    let resolved = false;
    registerRepoSyncedHook(() => new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 50)));
    notifyRepoSynced({ accountId: 1, repoId: 2 }, { warn: () => {} });
    expect(resolved).toBe(false);
  });
});
