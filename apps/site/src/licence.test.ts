// Licence activation on the website: a Polar licence key in, a signed Ensemble key out
// (docs/LICENSING.md). The app-side check of the same keys is apps/backend licence/licence.test.ts.
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { activateWithPolar, parseBenefitSeats, type PolarConfig } from './licence.js';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const pair = generateKeyPairSync('ed25519');
const signer = { key: pair.privateKey, kid: 'k1' };
const polar: PolarConfig = {
  apiUrl: 'https://api.polar.test',
  token: 'polar_oat_test',
  organizationId: 'org_1',
  benefitSeats: parseBenefitSeats('ben_10=10, ben_25=25,bad, ben_x=0'),
};

function fakePolar(status: number, body: unknown): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const run = (fetchImpl: typeof fetch, polarKey = 'ENS-POLAR-1') =>
  activateWithPolar({ polarKey, organisation: '  Acme Ltd ', polar, signer, nowMs: NOW, fetchImpl });

describe('POLAR_BENEFIT_SEATS', () => {
  it('reads id=seats pairs and drops the malformed ones', () => {
    expect([...polar.benefitSeats]).toEqual([
      ['ben_10', 10],
      ['ben_25', 25],
    ]);
  });
});

describe('activation', () => {
  it('asks Polar with the organisation id and token, then signs a key for the benefit’s seats', async () => {
    const { fetchImpl, calls } = fakePolar(200, { status: 'granted', benefit_id: 'ben_25', expires_at: null });
    const r = await run(fetchImpl);
    expect(calls[0]!.url).toBe('https://api.polar.test/v1/license-keys/validate');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ key: 'ENS-POLAR-1', organization_id: 'org_1' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer polar_oat_test');
    expect(r).toMatchObject({ ok: true, org: 'Acme Ltd', seats: 25, expires: '2027-11-24' });
    if (!r.ok) throw new Error('unreachable');
    const [prefix, body, sig] = r.key.split('.') as [string, string, string];
    expect(prefix).toBe('ENS1');
    expect(verify(null, Buffer.from(`ENS1.${body}`), pair.publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toMatchObject({ v: 1, kid: 'k1', src: 'polar', seats: 25 });
  });

  it('keeps Polar’s own expiry when the key has one', async () => {
    const { fetchImpl } = fakePolar(200, { status: 'granted', benefit_id: 'ben_10', expires_at: '2027-03-01T00:00:00Z' });
    expect(await run(fetchImpl)).toMatchObject({ ok: true, seats: 10, expires: '2027-03-01' });
  });

  it('refuses an unknown, inactive, expired or non-Ensemble key, and says why', async () => {
    expect(await run(fakePolar(404, {}).fetchImpl)).toMatchObject({ ok: false, error: 'polar_key_unknown' });
    expect(await run(fakePolar(200, { status: 'revoked', benefit_id: 'ben_10' }).fetchImpl)).toMatchObject({
      ok: false,
      error: 'polar_key_inactive',
    });
    expect(await run(fakePolar(200, { status: 'granted', benefit_id: 'ben_other' }).fetchImpl)).toMatchObject({
      ok: false,
      error: 'polar_key_not_ensemble',
    });
    expect(
      await run(fakePolar(200, { status: 'granted', benefit_id: 'ben_10', expires_at: '2026-01-01T00:00:00Z' }).fetchImpl),
    ).toMatchObject({ ok: false, error: 'polar_key_expired' });
  });

  it('says Polar could not be reached instead of throwing', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await run(down)).toMatchObject({ ok: false, status: 502, error: 'polar_unreachable' });
  });
});
