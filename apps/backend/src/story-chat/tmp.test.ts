import { describe, expect, it } from 'vitest';
import { chatTmpBase, chatTmpPrefix } from './tmp.js';

describe('the story chat temp folder', () => {
  it('is under /tmp on macOS and Linux, the system one elsewhere', () => {
    expect(chatTmpBase('linux', '/var/folders/x/T', true)).toBe('/tmp');
    expect(chatTmpBase('darwin', '/var/folders/x/T', true)).toBe('/tmp');
    expect(chatTmpBase('win32', 'C:\\Temp', true)).toBe('C:\\Temp');
  });
  it('names this install, so one install never sweeps another one’s folders', () => {
    expect(chatTmpPrefix('/home/a/.limn')).toMatch(/^limn-q-[0-9a-z]{1,5}-$/);
    expect(chatTmpPrefix('/home/a/.limn')).not.toBe(chatTmpPrefix('/home/b/.limn'));
  });
});
