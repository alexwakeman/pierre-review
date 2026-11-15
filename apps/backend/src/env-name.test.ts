import { describe, expect, it } from 'vitest';
import { envName, envNameSet, legacyEnvName, readEnv } from './env-name.js';

describe('user-set environment variables: ENSEMBLE_ wins, LIMN_ still read', () => {
  it('names', () => {
    expect(envName('DATA_DIR')).toBe('ENSEMBLE_DATA_DIR');
    expect(legacyEnvName('DATA_DIR')).toBe('LIMN_DATA_DIR');
  });

  it('reads ENSEMBLE_X first, then LIMN_X', () => {
    expect(readEnv({ ENSEMBLE_AI_PROVIDER: 'codex', LIMN_AI_PROVIDER: 'claude' }, 'AI_PROVIDER')).toBe('codex');
    expect(readEnv({ LIMN_AI_PROVIDER: 'claude' }, 'AI_PROVIDER')).toBe('claude');
    expect(readEnv({ ENSEMBLE_AI_PROVIDER: 'claude' }, 'AI_PROVIDER')).toBe('claude');
    expect(readEnv({}, 'AI_PROVIDER')).toBeUndefined();
  });

  it('a blank ENSEMBLE_X does not hide LIMN_X', () => {
    expect(readEnv({ ENSEMBLE_AI_DISABLED: '  ', LIMN_AI_DISABLED: 'true' }, 'AI_DISABLED')).toBe('true');
    expect(readEnv({ ENSEMBLE_AI_DISABLED: '' }, 'AI_DISABLED')).toBeUndefined();
  });

  it('says which name is set', () => {
    expect(envNameSet({ ENSEMBLE_DATA_DIR: '/x', LIMN_DATA_DIR: '/y' }, 'DATA_DIR')).toBe('ENSEMBLE_DATA_DIR');
    expect(envNameSet({ LIMN_DATA_DIR: '/y' }, 'DATA_DIR')).toBe('LIMN_DATA_DIR');
    expect(envNameSet({}, 'DATA_DIR')).toBeNull();
  });
});
