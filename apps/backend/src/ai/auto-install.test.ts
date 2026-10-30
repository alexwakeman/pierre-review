// The first-boot AI download (ai/auto-install.ts): what it asks for, when it stays out of the way,
// and its ONE retry.
import { describe, expect, it, vi } from 'vitest';
import { AUTO_INSTALL_RETRY_MS, autoInstallProviders, runAutoInstall, type AutoInstallDeps } from './auto-install.js';
import type { AiRuntimeInstallResult, AiRuntimeState } from './runtime.js';

const st = (runtime: AiRuntimeState) => ({ runtime, runtimeMessage: null });
const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(
  claude: AiRuntimeState,
  codex: AiRuntimeState,
  results: AiRuntimeInstallResult[] = [{ ok: true }],
  over: Partial<AutoInstallDeps> = {},
) {
  const install = vi.fn(async () => results.shift() ?? { ok: true as const });
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  const d: AutoInstallDeps = {
    enabled: true,
    claude: () => st(claude),
    codex: () => st(codex),
    install,
    schedule: (fn, ms) => scheduled.push({ fn, ms }),
    log: { info: () => {}, warn: () => {} },
    ...over,
  };
  return { d, install, scheduled };
}

describe('autoInstallProviders', () => {
  it('asks for nothing when both are ready, or while a download runs', () => {
    expect(autoInstallProviders(st('ready'), st('ready'))).toBeNull();
    expect(autoInstallProviders(st('installing'), st('absent'))).toBeNull();
    expect(autoInstallProviders(st('ready'), st('installing'))).toBeNull();
  });
  it('a ready Claude is left alone: only what is missing is asked for', () => {
    expect(autoInstallProviders(st('absent'), st('absent'))).toEqual(['claude', 'codex']);
    expect(autoInstallProviders(st('ready'), st('failed'))).toEqual(['codex']);
    expect(autoInstallProviders(st('ready'), st('absent'))).toEqual(['codex']);
    expect(autoInstallProviders(st('absent'), st('ready'))).toEqual(['claude']);
  });
});

describe('runAutoInstall', () => {
  it('does nothing when switched off (LIMN_AI_DISABLED / LIMN_AI_AUTO_INSTALL=false)', async () => {
    const { d, install } = deps('absent', 'absent', [], { enabled: false });
    runAutoInstall(d);
    await flush();
    expect(install).not.toHaveBeenCalled();
  });

  it('downloads both on a first boot, without waiting on the caller', async () => {
    const { d, install, scheduled } = deps('absent', 'absent');
    expect(runAutoInstall(d)).toBeUndefined();
    await flush();
    expect(install).toHaveBeenCalledWith(['claude', 'codex']);
    expect(scheduled).toHaveLength(0);
  });

  it('a failure is retried ONCE, later — never a loop', async () => {
    const fail = { ok: false as const, message: 'offline' };
    const { d, install, scheduled } = deps('absent', 'absent', [fail, fail, fail]);
    runAutoInstall(d);
    await flush();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.ms).toBe(AUTO_INSTALL_RETRY_MS);
    scheduled[0]!.fn();
    await flush();
    expect(install).toHaveBeenCalledTimes(2);
    expect(scheduled).toHaveLength(1);
  });
});
