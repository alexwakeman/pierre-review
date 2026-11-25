// Verify a signed licence key OFFLINE (docs/LICENSING.md). No network, ever: the website signed it
// with a private key, and the matching public keys are built into the app (public-keys.ts).
import { createPublicKey, verify } from 'node:crypto';
import { LICENCE_KEY_PREFIX, type LicenceKeyProblem, type LicencePayload } from '@pierre-review/shared';
import { LICENCE_PUBLIC_KEYS } from './public-keys.js';

export type LicenceCheck = { ok: true; payload: LicencePayload } | { ok: false; problem: LicenceKeyProblem };

const B64URL = /^[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parsePayload(json: string): LicencePayload | null {
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  if (p == null || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.kid !== 'string' || typeof o.lid !== 'string' || typeof o.org !== 'string') return null;
  if (o.org.trim() === '' || o.org.length > 200) return null;
  if (typeof o.seats !== 'number' || !Number.isInteger(o.seats) || o.seats < 1) return null;
  if (typeof o.iat !== 'string' || !DATE.test(o.iat) || typeof o.exp !== 'string' || !DATE.test(o.exp)) return null;
  if (o.src !== 'polar' && o.src !== 'manual') return null;
  return { v: 1, kid: o.kid, lid: o.lid, org: o.org, seats: o.seats, iat: o.iat, exp: o.exp, src: o.src };
}

/** The last instant a key is valid: the end of its `exp` day, UTC. */
export function licenceExpiresAtMs(exp: string): number {
  return Date.parse(`${exp}T23:59:59.999Z`);
}

/**
 * Check a pasted key. `publicKeys` is injectable for tests; the app passes the built-in list.
 * Whitespace and line breaks (a key copied out of an email) are ignored.
 */
export function checkLicenceKey(
  text: string,
  nowMs: number,
  publicKeys: Readonly<Record<string, string>> = LICENCE_PUBLIC_KEYS,
): LicenceCheck {
  const key = text.replace(/\s+/g, '');
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== LICENCE_KEY_PREFIX) return { ok: false, problem: 'malformed' };
  const [, body, sig] = parts as [string, string, string];
  if (!B64URL.test(body) || !B64URL.test(sig)) return { ok: false, problem: 'malformed' };
  const payload = parsePayload(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload == null) return { ok: false, problem: 'malformed' };
  const x = Object.hasOwn(publicKeys, payload.kid) ? publicKeys[payload.kid] : undefined;
  if (x === undefined) return { ok: false, problem: 'unknown_signer' };
  let good = false;
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    good = verify(null, Buffer.from(`${LICENCE_KEY_PREFIX}.${body}`, 'utf8'), pub, Buffer.from(sig, 'base64url'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, problem: 'bad_signature' };
  if (nowMs > licenceExpiresAtMs(payload.exp)) return { ok: false, problem: 'expired' };
  return { ok: true, payload };
}
