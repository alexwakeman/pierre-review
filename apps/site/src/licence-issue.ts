// `pnpm --filter @pierre-review/site licence:issue -- --org "Acme Ltd" --seats 10 --expires 2027-12-31`
// Issue a licence key by hand: a FREE licence (a design partner, a charity, a friend), or one paid
// by invoice. Needs LICENCE_SIGNING_KEY in the environment (the same private key the website uses).
// Prints the key to send to the customer; they paste it into Settings → Licence.
import { isoDate, loadSigningKey, makePayload, signLicence } from './licence.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const org = arg('org');
const seats = Number(arg('seats'));
const expires = arg('expires');
const raw = process.env.LICENCE_SIGNING_KEY;
const usage = 'usage: licence:issue -- --org "Acme Ltd" --seats 10 --expires 2027-12-31  (LICENCE_SIGNING_KEY set)';

if (!org || !Number.isInteger(seats) || seats < 1 || !expires || !/^\d{4}-\d{2}-\d{2}$/.test(expires) || !raw) {
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}
const signer = loadSigningKey(raw);
const now = Date.now();
const payload = makePayload({ kid: signer.kid, org, seats, nowMs: now, expMs: Date.parse(`${expires}T12:00:00Z`), src: 'manual' });
process.stdout.write(
  `\nLicence for ${payload.org}: ${seats} people, valid through ${payload.exp} (issued ${isoDate(now)}).\n` +
    `Send this key; it goes in Settings → Licence:\n\n${signLicence(payload, signer.key)}\n\n`,
);
