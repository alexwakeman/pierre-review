// BLAKE2b (RFC 7693) with a chosen digest length — only so the local scorer can name its model
// exactly as the severity service does. The service's `model_version` embeds a BLAKE2b-128
// digest of the artifact files, and Node's `crypto` offers BLAKE2b at 512 bits only (the digest
// length is a parameter of the hash, not a truncation, so the 512-bit output cannot be cut down).
// Not for security use. Pinned against Python's `hashlib.blake2b` in blake2b.test.ts.

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

// 64-bit words are held as (lo, hi) uint32 pairs at indexes 2k, 2k+1.
const v = new Uint32Array(32);
const m = new Uint32Array(32);

function add64(a: number, b: number): void {
  const lo = v[a]! + v[b]!;
  let hi = v[a + 1]! + v[b + 1]!;
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

function add64c(a: number, lo0: number, hi0: number): void {
  const lo = v[a]! + lo0;
  let hi = v[a + 1]! + hi0;
  if (lo >= 0x100000000) hi++;
  v[a] = lo;
  v[a + 1] = hi;
}

function G(a: number, b: number, c: number, d: number, ix: number, iy: number): void {
  const x0 = m[ix]!;
  const x1 = m[ix + 1]!;
  const y0 = m[iy]!;
  const y1 = m[iy + 1]!;

  add64(a, b);
  add64c(a, x0, x1);
  // d = (d ^ a) >>> 32
  let xor0 = v[d]! ^ v[a]!;
  let xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = xor1;
  v[d + 1] = xor0;
  add64(c, d);
  // b = (b ^ c) >>> 24
  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor0 >>> 24) ^ (xor1 << 8);
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8);
  add64(a, b);
  add64c(a, y0, y1);
  // d = (d ^ a) >>> 16
  xor0 = v[d]! ^ v[a]!;
  xor1 = v[d + 1]! ^ v[a + 1]!;
  v[d] = (xor0 >>> 16) ^ (xor1 << 16);
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16);
  add64(c, d);
  // b = (b ^ c) >>> 63
  xor0 = v[b]! ^ v[c]!;
  xor1 = v[b + 1]! ^ v[c + 1]!;
  v[b] = (xor1 >>> 31) ^ (xor0 << 1);
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1);
}

export class Blake2b {
  private readonly h = new Uint32Array(16);
  private readonly b = new Uint8Array(128);
  private c = 0; // bytes in the buffer
  private t = 0; // total bytes compressed (fits a double for any realistic input)
  private readonly outlen: number;

  constructor(outlen = 64) {
    if (outlen < 1 || outlen > 64) throw new Error('blake2b digest length must be 1..64');
    this.outlen = outlen;
    this.h.set(IV);
    this.h[0] = this.h[0]! ^ (0x01010000 ^ outlen);
  }

  private compress(last: boolean): void {
    for (let i = 0; i < 16; i++) {
      v[i] = this.h[i]!;
      v[i + 16] = IV[i]!;
    }
    v[24] = v[24]! ^ this.t % 0x100000000;
    v[25] = v[25]! ^ Math.floor(this.t / 0x100000000);
    if (last) {
      v[28] = ~v[28]!;
      v[29] = ~v[29]!;
    }
    for (let i = 0; i < 32; i++) {
      const o = i * 4;
      m[i] = this.b[o]! ^ (this.b[o + 1]! << 8) ^ (this.b[o + 2]! << 16) ^ (this.b[o + 3]! << 24);
    }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r]!;
      G(0, 8, 16, 24, s[0]! * 2, s[1]! * 2);
      G(2, 10, 18, 26, s[2]! * 2, s[3]! * 2);
      G(4, 12, 20, 28, s[4]! * 2, s[5]! * 2);
      G(6, 14, 22, 30, s[6]! * 2, s[7]! * 2);
      G(0, 10, 20, 30, s[8]! * 2, s[9]! * 2);
      G(2, 12, 22, 24, s[10]! * 2, s[11]! * 2);
      G(4, 14, 16, 26, s[12]! * 2, s[13]! * 2);
      G(6, 8, 18, 28, s[14]! * 2, s[15]! * 2);
    }
    for (let i = 0; i < 16; i++) this.h[i] = this.h[i]! ^ v[i]! ^ v[i + 16]!;
  }

  update(data: Uint8Array): this {
    for (let i = 0; i < data.length; i++) {
      if (this.c === 128) {
        this.t += this.c;
        this.compress(false);
        this.c = 0;
      }
      this.b[this.c++] = data[i]!;
    }
    return this;
  }

  digest(): Uint8Array {
    this.t += this.c;
    while (this.c < 128) this.b[this.c++] = 0;
    this.compress(true);
    const out = new Uint8Array(this.outlen);
    for (let i = 0; i < this.outlen; i++) out[i] = this.h[i >> 2]! >>> (8 * (i & 3));
    return out;
  }

  hexdigest(): string {
    return Buffer.from(this.digest()).toString('hex');
  }
}
