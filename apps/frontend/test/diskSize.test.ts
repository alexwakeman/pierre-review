import { describe, expect, it } from 'vitest';
import { diskSizeText } from '../src/lib/diskSize.js';

describe('diskSizeText', () => {
  it('says megabytes whole and gigabytes to one decimal', () => {
    expect(diskSizeText(0)).toBe('0 MB');
    expect(diskSizeText(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(diskSizeText(1023 * 1024 * 1024)).toBe('1,023 MB');
    expect(diskSizeText(1.44 * 1024 ** 3)).toBe('1.4 GB');
    expect(diskSizeText(2 * 1024 ** 3)).toBe('2 GB');
  });
});
