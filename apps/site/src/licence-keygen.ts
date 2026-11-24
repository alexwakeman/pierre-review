// `pnpm --filter @pierre-review/site licence:keygen [kid]` — make a NEW licence signing key pair.
// Run it on your own computer, once. It prints:
//   - LICENCE_SIGNING_KEY: the PRIVATE key. Put it in the website's environment (Railway →
//     the site service → Variables) and a password manager. Never commit it or paste it in a chat.
//   - the PUBLIC key: goes in apps/backend/src/licence/public-keys.ts (safe to share).
import { generateKeyPairSync } from 'node:crypto';

const kid = process.argv[2] ?? 'k1';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
const pub = publicKey.export({ format: 'jwk' }) as { x: string };

process.stdout.write(
  [
    '',
    'PRIVATE — set as LICENCE_SIGNING_KEY on the website (Railway Variables). Keep it secret:',
    JSON.stringify({ kty: 'OKP', crv: 'Ed25519', d: priv.d, x: priv.x, kid }),
    '',
    'PUBLIC — add to apps/backend/src/licence/public-keys.ts:',
    `  ${kid}: '${pub.x}',`,
    '',
  ].join('\n'),
);
