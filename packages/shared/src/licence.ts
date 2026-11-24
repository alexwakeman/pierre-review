// THE COMMERCIAL LICENCE, on the wire (docs/LICENSING.md).
//
// Ensemble is free for an individual, and for an organisation where no more than
// LICENCE_FREE_USERS people use it (the Ensemble License, section 3). Above that the organisation
// needs a commercial licence. The app proves one with a SIGNED key, checked OFFLINE: the website
// signs it (apps/site licence.ts), the backend verifies it (backend licence/key.ts) — nothing is
// ever sent anywhere from the app. The app also counts, on this machine, how many colleagues post
// through Ensemble, and REMINDS the reader above the free limit. It never blocks anything.

/** The Ensemble License's free limit. Mirrors the landing's FREE_TEAM_SIZE; never type the number. */
export const LICENCE_FREE_USERS = 3;

/** The key's text form: `ENS1.<payload base64url>.<Ed25519 signature base64url>`. */
export const LICENCE_KEY_PREFIX = 'ENS1';

/** What a signed key says. Dates are `YYYY-MM-DD`; a key is valid through the end of `exp` (UTC). */
export interface LicencePayload {
  v: 1;
  /** Which signing key signed it (the backend holds the matching public keys). */
  kid: string;
  /** A random id, so two keys for the same organisation differ. */
  lid: string;
  /** The organisation the licence is for. */
  org: string;
  /** How many people may use Ensemble under it. */
  seats: number;
  /** Issued on. */
  iat: string;
  /** Valid through. */
  exp: string;
  /** Where it came from: a Polar purchase, or issued by hand (a free or invoiced licence). */
  src: 'polar' | 'manual';
}

export type LicenceKeyProblem = 'malformed' | 'unknown_signer' | 'bad_signature' | 'expired';

/** GET /api/licence. */
export interface LicenceStatusResponse {
  freeUsers: number;
  /** The stored key, checked now. Null when none is stored. */
  licence:
    | { ok: true; org: string; seats: number; expires: string; source: 'polar' | 'manual' }
    | { ok: false; problem: LicenceKeyProblem }
    | null;
  /**
   * People seen posting through Ensemble in the last LICENCE_USAGE_WINDOW_DAYS days, the reader
   * included, in the GitHub owner (organisation) where the most are seen. A floor: someone who
   * only reads in Ensemble leaves no trace.
   */
  users: { count: number; owner: string | null };
  /** Whether the app should show the reminder now, and why. */
  reminder: {
    show: boolean;
    reason: 'over_free_limit' | 'over_licence_seats' | null;
    /** The end of the one evaluation, once started (ISO). */
    evaluationEndsAt: string | null;
    /** Whether the reader may still start the evaluation. */
    canEvaluate: boolean;
  };
}

/** PUT /api/licence body. */
export interface LicenceKeyRequest {
  key: string;
}

/** How far back the colleague count looks. */
export const LICENCE_USAGE_WINDOW_DAYS = 90;
/** The one evaluation's length. */
export const LICENCE_EVALUATION_DAYS = 30;
/** "Remind me later". */
export const LICENCE_SNOOZE_DAYS = 7;
/** Where to buy and activate. */
export const LICENCE_PRICING_URL = 'https://ensemble.ac/pricing';
export const LICENCE_ACTIVATE_URL = 'https://ensemble.ac/licence';
