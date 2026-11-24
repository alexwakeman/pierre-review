// LICENCE KEYS: signing (docs/LICENSING.md in the repository root).
//
// A licence key is `ENS1.<payload base64url>.<Ed25519 signature base64url>`, the signature over the
// bytes of `ENS1.<payload base64url>`. The app (apps/backend licence/key.ts) verifies it OFFLINE
// with the public key built into it; only this service holds the private key
// (LICENCE_SIGNING_KEY). ⚠ The format is a contract with every released copy of the app: change it
// only by adding a new version prefix.
//
// Two ways a key is made:
//   - POST /api/licence/activate: a buyer pastes the licence key Polar emailed them; we check it
//     with Polar and return a signed key (activateWithPolar below).
//   - `pnpm --filter @pierre-review/site licence:issue`: issued by hand — a free licence, or one
//     paid by invoice (licence-issue.ts).
import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';

export const LICENCE_KEY_PREFIX = 'ENS1';

export interface LicencePayload {
  v: 1;
  kid: string;
  lid: string;
  org: string;
  seats: number;
  iat: string;
  exp: string;
  src: 'polar' | 'manual';
}

/** The private signing key from LICENCE_SIGNING_KEY: the JSON JWK `licence:keygen` printed. */
export function loadSigningKey(jwkJson: string): { key: KeyObject; kid: string } {
  const jwk = JSON.parse(jwkJson) as { kty?: string; crv?: string; d?: string; x?: string; kid?: string };
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d || !jwk.x) {
    throw new Error('LICENCE_SIGNING_KEY is not an Ed25519 private JWK (run licence:keygen)');
  }
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: jwk.x }, format: 'jwk' });
  return { key, kid: jwk.kid ?? 'k1' };
}

export const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function signLicence(payload: LicencePayload, key: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = sign(null, Buffer.from(`${LICENCE_KEY_PREFIX}.${body}`, 'utf8'), key).toString('base64url');
  return `${LICENCE_KEY_PREFIX}.${body}.${sig}`;
}

export function makePayload(input: {
  kid: string;
  org: string;
  seats: number;
  nowMs: number;
  expMs: number;
  src: 'polar' | 'manual';
}): LicencePayload {
  return {
    v: 1,
    kid: input.kid,
    lid: randomUUID(),
    org: input.org.trim(),
    seats: input.seats,
    iat: isoDate(input.nowMs),
    exp: isoDate(input.expMs),
    src: input.src,
  };
}

/** POLAR_BENEFIT_SEATS: `benefitId=10,benefitId=25,…` — which Polar benefit grants how many seats. */
export function parseBenefitSeats(raw: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [id, n] = part.split('=').map((s) => s.trim());
    const seats = Number(n);
    if (id && Number.isInteger(seats) && seats > 0) out.set(id, seats);
  }
  return out;
}

export interface PolarConfig {
  apiUrl: string;
  token: string;
  organizationId: string;
  benefitSeats: Map<string, number>;
}

export type ActivateResult =
  | { ok: true; key: string; org: string; seats: number; expires: string }
  | { ok: false; status: number; error: string; message: string };

const YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Check a Polar licence key with Polar (server to server) and sign an Ensemble key for it.
 * A subscription's Polar key has no expiry, so the signed key runs a year; the buyer activates
 * again at renewal.
 */
export async function activateWithPolar(input: {
  polarKey: string;
  organisation: string;
  polar: PolarConfig;
  signer: { key: KeyObject; kid: string };
  nowMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ActivateResult> {
  const f = input.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${input.polar.apiUrl}/v1/license-keys/validate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.polar.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: input.polarKey.trim(), organization_id: input.polar.organizationId }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 502, error: 'polar_unreachable', message: 'We could not reach Polar. Try again in a minute.' };
  }
  if (res.status === 404 || res.status === 422) {
    return { ok: false, status: 400, error: 'polar_key_unknown', message: 'Polar does not recognise that licence key.' };
  }
  if (!res.ok) {
    return { ok: false, status: 502, error: 'polar_error', message: 'Polar could not check the key. Try again in a minute.' };
  }
  const body = (await res.json()) as { status?: string; benefit_id?: string; expires_at?: string | null };
  if (body.status !== 'granted') {
    return { ok: false, status: 400, error: 'polar_key_inactive', message: 'That licence key is no longer active.' };
  }
  const seats = body.benefit_id ? input.polar.benefitSeats.get(body.benefit_id) : undefined;
  if (seats === undefined) {
    return { ok: false, status: 400, error: 'polar_key_not_ensemble', message: 'That key is not for an Ensemble licence.' };
  }
  const polarExp = body.expires_at ? Date.parse(body.expires_at) : NaN;
  const expMs = Number.isFinite(polarExp) ? polarExp : input.nowMs + YEAR;
  if (expMs < input.nowMs) {
    return { ok: false, status: 400, error: 'polar_key_expired', message: 'That licence key has expired.' };
  }
  const payload = makePayload({
    kid: input.signer.kid,
    org: input.organisation,
    seats,
    nowMs: input.nowMs,
    expMs,
    src: 'polar',
  });
  return { ok: true, key: signLicence(payload, input.signer.key), org: payload.org, seats, expires: payload.exp };
}
