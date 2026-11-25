// The public halves of the licence signing keys (docs/LICENSING.md § Keys). A signed licence key
// names its signer (`kid`); a key from a signer not listed here reads as `unknown_signer`.
//
// Each value is the Ed25519 public key's `x` (base64url, 43 characters), printed by
// `pnpm --filter @pierre-review/site licence:keygen`. Public: it can only CHECK a signature. The
// private half lives in the website's environment (LICENCE_SIGNING_KEY) and nowhere else.
//
// ⚠ ADD a new signer beside the old one, never replace it: keys already sold stay valid until they
// expire. Remove a signer only to revoke everything it signed.
export const LICENCE_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  // k1: '<x from licence:keygen>',
};
