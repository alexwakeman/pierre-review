# Licensing: signed keys and the reminder

How Ensemble knows an organisation holds a commercial licence, and how it reminds one that does not.
The licence terms themselves are in `LICENSE` (the Ensemble License 1.0: free for an individual and
for an organisation where no more than three people use Ensemble; a commercial licence above that).

## The rules

1. **The app never calls home.** A licence key is checked OFFLINE, on the reader's computer, against
   public keys built into the app. The app sends nothing to Corevo, to Polar or to anyone else for
   licensing. The one network step happens on the website, in the buyer's browser, when they choose.
2. **A reminder, never a block.** The colleague count and the reminder block nothing: the reminder is
   a circle in the one toast cluster, and every choice on it quiets it.
2a. **Organisation features need a key** (2026-11-24). Team policy (docs/TEAM-POLICY.md) is applied
   only while the copy holds a VALID key or its one 30-day evaluation runs: `orgFeaturesUnlockedFor`
   (licence/status.ts; cheap, no count) on the server, shared `orgFeaturesUnlocked` over a status.
   Team size does not matter (a small team asks for a free key). Nothing else is locked. The licence
   text (`LICENSE`) is unchanged: it governs who may use the software, not which features exist.
3. **The free limit is ONE constant**: `LICENCE_FREE_USERS` (packages/shared `licence.ts`, 3). The
   landing's `FREE_TEAM_SIZE` mirrors it.

## The key

`ENS1.<payload base64url>.<Ed25519 signature base64url>`. The signature is over the UTF-8 bytes of
`ENS1.<payload base64url>`. The payload is JSON (`LicencePayload`, packages/shared):

| Field | Meaning |
|---|---|
| `v` | 1 |
| `kid` | which signing key signed it |
| `lid` | a random id, so two keys for one organisation differ |
| `org` | the organisation, as the buyer typed it |
| `seats` | how many people may use Ensemble under it |
| `iat`, `exp` | issued on, valid through (`YYYY-MM-DD`; valid until the end of `exp`, UTC) |
| `src` | `polar` (activated from a purchase) or `manual` (issued by hand) |

⚠ **The format is a contract with every released copy.** Change it only by adding a new prefix
(`ENS2`) and verifying both. `apps/backend/src/licence/licence.test.ts` imports the WEBSITE's signer
on purpose, so a change on one side that the other cannot read fails the backend suite.

### Signing keys

- `pnpm --filter @pierre-review/site licence:keygen [kid]` makes a key pair on the owner's computer.
  The PRIVATE half (a JSON JWK) goes in the website's environment as `LICENCE_SIGNING_KEY` and in a
  password manager, nowhere else. The PUBLIC half (`x`, 43 characters) goes in
  `apps/backend/src/licence/public-keys.ts` under its `kid`.
- Until a public key is listed there, every key reads `unknown_signer`: the shipped list is empty.
- **Rotation:** add the new `kid` beside the old one and switch the website's key. Keys already sold
  stay valid until they expire. Removing a `kid` revokes every key it signed.

### Where keys come from

1. **A purchase (Polar).** Polar emails the buyer a Polar licence key (the "License Keys" benefit on
   each licence product). The buyer pastes it, with their organisation's name, on
   `ensemble.ac/licence`. The website (`POST /api/licence/activate`, apps/site `licence.ts`) asks Polar
   `POST /v1/license-keys/validate` (server to server, an organisation access token with
   `license_keys:write`), requires `status: granted`, maps the key's `benefit_id` to seats
   (`POLAR_BENEFIT_SEATS`), and signs a key. A subscription's Polar key has no `expires_at`, so the
   signed key runs a year and the buyer activates again at renewal. Rate limit: 10 an hour per IP.
2. **By hand.** `pnpm --filter @pierre-review/site licence:issue -- --org "…" --seats N --expires
   YYYY-MM-DD` with `LICENCE_SIGNING_KEY` set: a free licence (a design partner, a charity) or one
   paid by invoice. Polar is not involved.

Activation is off (503) unless the website has `LICENCE_SIGNING_KEY`, `POLAR_ACCESS_TOKEN`,
`POLAR_ORGANIZATION_ID` and `POLAR_BENEFIT_SEATS` (apps/site/README.md § Environment).

## In the app

- **Storage:** `accounts.licence_key` (migration 0218), stored as typed, re-checked on every read.
  `PUT /api/licence` refuses a key that does not check out now and says why (`problem`).
- **Settings → Licence** (`LicenceSection`): the free limit, the colleague count, the stored key's
  state, and the box to paste a key.
- **The count** (`licence/status.ts` `countEnsembleUsers`): per GitHub owner, the distinct people
  behind Ensemble-posted review comments, PR comments and reviews (`limn_posted_by_user_id`) in the
  last 90 days, not the reader, plus one for the reader. The owner with the most is reported.
  ⚠ **A floor and a guess**: someone who only reads in Ensemble posts nothing and is not seen; on a
  public repository an outside contributor who runs Ensemble is counted with the owner. That is why
  it may only drive a reminder.

## The reminder

Pure half `decideReminder` (licence/status.ts); pinned by licence.test.ts.

- **Shows** when the count is above `LICENCE_FREE_USERS` and no valid key is stored
  (`over_free_limit`), or a valid key's `seats` are fewer than the count (`over_licence_seats`).
- **Quiet** during the ONE 30-day evaluation ("We're evaluating", `accounts.licence_evaluation_ends_at`,
  offered until used) and for 7 days after "Remind me in 7 days" (the X;
  `accounts.licence_reminder_snoozed_until`).
- **Never** shows at or under the free limit, and never blocks anything.
- `LicenceReminderToast` (tone `neutral`), its "Enter a key" opens Settings at focus `licence`.

## Routes

`GET /api/licence`, `PUT /api/licence` `{ key }`, `DELETE /api/licence`, `POST /api/licence/evaluating`,
`POST /api/licence/later` — docs/API.md § Licence. DB only: no GitHub call, no model, no rate-limit tier.
