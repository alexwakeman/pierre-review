/**
 * Tokenisers + the interner the diff runs on.
 *
 * Everything the resolver diffs — lines at file grain, words inside one contested region — is
 * turned into an array of small integers first. The diff then compares numbers, which is what
 * makes the O(ND) inner loop cheap enough to run over a whole file and again over every
 * conflicted region.
 *
 * ⚠ `tokenizeWords(text).join('') === text` is a HARD invariant, not a nicety. The wand's
 * word-level merge reassembles a region by concatenating token runs, so a tokeniser that
 * dropped or normalised a byte would silently commit different text than the user read.
 * `tokens.test.ts` pins it over code, CRLF, tabs, unicode identifiers and emoji.
 */

/**
 * Split into: runs of word characters, runs of whitespace, and one code point for anything
 * else. Unicode-aware on both counts — `ünicode` is ONE token, and an astral code point (an
 * emoji, a rare CJK ideograph) is one token rather than two lone surrogates.
 */
const WORD_TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[\s\S]/gu;

export function tokenizeWords(text: string): string[] {
  return text.match(WORD_TOKEN_RE) ?? [];
}

/** True when a token is entirely whitespace. The disjointness rule needs REAL evidence that
 *  two authors worked on different things, and a single space between two edits is not it. */
export function isWhitespaceToken(token: string): boolean {
  return token.length > 0 && token.trim().length === 0;
}

/**
 * Map token strings to dense integer ids. One interner per diff pair, so ids are only ever
 * compared within the arrays that produced them.
 */
export class TokenInterner {
  private readonly ids = new Map<string, number>();

  id(token: string): number {
    const existing = this.ids.get(token);
    if (existing !== undefined) return existing;
    const next = this.ids.size;
    this.ids.set(token, next);
    return next;
  }

  /** How many distinct tokens have been seen. */
  get size(): number {
    return this.ids.size;
  }
}

/** Intern a whole array in one pass. */
export function internAll(tokens: readonly string[], interner: TokenInterner): number[] {
  const out = new Array<number>(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    // noUncheckedIndexedAccess: the loop bound guarantees it, the compiler does not.
    out[i] = interner.id(tokens[i] as string);
  }
  return out;
}

/**
 * Split a UTF-8 string into lines WITHOUT their terminators, plus whether the text ended with
 * one. `\r` stays attached to its line, so a CRLF file round-trips byte for byte.
 *
 * An empty file is zero lines and no terminator — NOT one empty line, which would commit a
 * newline into a file that never had one.
 */
export function splitLines(text: string): { lines: string[]; finalNewline: boolean } {
  if (text.length === 0) return { lines: [], finalNewline: false };
  const finalNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}
