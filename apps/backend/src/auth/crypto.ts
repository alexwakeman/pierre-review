import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

// AES-256-GCM sealing of per-account GitHub access tokens at rest. The key is
// ENCRYPTION_KEY (32 bytes as 64 hex chars; generate with `openssl rand -hex 32`).
// Stored form is `iv:tag:ciphertext`, each base64. Tokens are decrypted in-memory
// per call and NEVER logged.
const ALGO = 'aes-256-gcm';

function key(): Buffer {
  const k = Buffer.from(config.encryptionKey, 'hex');
  if (k.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must be 32 bytes as 64 hex chars (openssl rand -hex 32).',
    );
  }
  return k;
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(enc: string): string {
  const parts = enc.split(':');
  if (parts.length !== 3) throw new Error('malformed encrypted token');
  const [ivB64, tagB64, ctB64] = parts as [string, string, string];
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
