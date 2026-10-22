// Small helpers shared by the demo server's modules.

export const NOT_IN_DEMO_MESSAGE = 'Not available in the demo.';

/** The SPA's error shape (`{ error, message }`): `api/client.ts` shows `message` to the reader. */
export function notInDemo(status = 409): { status: number; body: unknown } {
  return { status, body: { error: 'NotInDemo', message: NOT_IN_DEMO_MESSAGE } };
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** A 40-character hex string, for simulated commit shas. */
export function fakeSha(seed: number): string {
  let out = '';
  let x = (seed * 2654435761) >>> 0;
  while (out.length < 40) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out += x.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}
