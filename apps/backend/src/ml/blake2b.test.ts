import { describe, expect, it } from 'vitest';
import { Blake2b } from './blake2b.js';

// Expected values are Python's `hashlib.blake2b(...).hexdigest()`.
describe('Blake2b', () => {
  const b2 = (data: Uint8Array, outlen?: number) => new Blake2b(outlen).update(data).hexdigest();
  const pattern = new Uint8Array(256_000).map((_, i) => i % 256);

  it('matches hashlib at 128 bits', () => {
    expect(b2(new Uint8Array(0), 16)).toBe('cae66941d9efbd404e4d88758ea67670');
    expect(b2(Buffer.from('abc'), 16)).toBe('cf4ab791c62b8d2b2109c90275287816');
    expect(b2(pattern, 16)).toBe('53b77b188c91a7d66c490e9489b2fc73');
  });

  it('matches hashlib at 512 bits', () => {
    expect(b2(new Uint8Array(0)).slice(0, 32)).toBe('786a02f742015903c6c6fd852552d272');
    expect(b2(Buffer.from('abc')).slice(0, 32)).toBe('ba80a53f981c4d0d6a2797b69f12f6e9');
    expect(b2(pattern).slice(0, 32)).toBe('4cd02c933730d72a97ba20952fd9fff3');
  });

  it('is the same over several updates', () => {
    const h = new Blake2b(16).update(Buffer.from('ab')).update(Buffer.from('c'.repeat(300)));
    expect(h.hexdigest()).toBe('1f4adb35f91431e47e269a6afc101fe0');
  });
});
