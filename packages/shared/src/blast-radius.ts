import {
  BLAST_HIGH_SURFACES,
  BLAST_SENSITIVITY_DEFAULT,
  BLAST_THRESHOLDS,
  type BlastLevel,
  type BlastRadiusConfig,
  type BlastSignals,
  type BlastSurface,
  type ResolvedBlastConfig,
} from './types.js';

// THE ONE BLAST-RADIUS RESOLVER (docs/BLAST-RADIUS.md). Moved here from the SPA's lib/ui.ts, which
// re-exports it, so the server's auto-approve impact gate reads the exact fold every chip reads.
// ⚠ Never fork a copy on either side — a second resolver is how the board and the gate disagree.

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   BLAST RADIUS — the ONE resolver
   ─────────────────────────────────────────────────────────────────────────────────────────────

   "How far can this change reach?" — the second, ORTHOGONAL reading beside the large-PR flag
   above. The backend does the hard half (`db/blast-radius.ts` classifies the paths and folds a
   signal vector); the wire then carries SIGNALS, never a level, so the comparison is a pure
   render-time operation — changing the sensitivity dial in Settings repaints every surface with
   no cache invalidation anywhere.

   ⚠ EVERY SURFACE DECIDES HERE AND NOWHERE ELSE. Pending cards, the PR-detail header and the
   vis-timeline tooltip all call `blastRadius`. A per-component `signals.codeFiles > 15` is how
   the board and the timeline come to disagree about the same pull request.

   The rules that end in "say nothing", which is why the return is nullable rather than a verdict
   carrying an `unknown`:

     1. NO SIGNALS is UNKNOWN, never "low". Measured at ~10% of open pull requests (no stored
        per-file breakdown, or a size nobody ever observed). No chip, and in particular no
        "unknown" chrome — a reader who can tell an unmeasured pull request from a low-blast one
        is reading a claim we did not make.
     2. TRUNCATED READS ASYMMETRICALLY, and it is the safety rule of the whole feature. GitHub's
        `files(first: 100)` truncates exactly the BIGGEST pull requests, so every count is a
        floor. HIGH may still be asserted (a missing file can only ADD reach); LOW may not, and a
        truncated pull request that fires no high arm degrades to UNKNOWN. Enforced once, here,
        rather than by convention at four call sites. */

/** One reason a pull request landed in its level — the evidence, in the words the chip renders. */
export interface BlastReason {
  /** `surface` — a contract was touched · `spread` — it is wide · `volume` — it is big ·
   *  `hub` — it touches a file everything else changes with · `contained` — why it is LOW. */
  kind: 'surface' | 'spread' | 'volume' | 'hub' | 'contained';
  text: string;
}

/** The rendered verdict. `null` from `blastRadius` means "draw nothing" — covering BOTH "we
 *  don't know" and "we know but may not say", which are deliberately the same answer on screen. */
export interface BlastVerdict {
  level: Exclude<BlastLevel, 'unknown'>;
  /** Ranked, most-consequential first. Never empty. */
  reasons: BlastReason[];
  /** Full sentence for a `title=` / accessible label. */
  label: string;
  /** The one-word visible level, e.g. `Low`. */
  short: string;
  /** TRUE when the ONLY thing making this high is its size — i.e. this chip and the large-PR
   *  flag beside it would be saying the same thing twice.
   *
   *  ⚠ THE ANTI-DOUBLE-COUNT RULE. A 2,000-line PR would otherwise get an amber "2,000 code
   *  lines" from `largePrFlag` AND a "High" chip whose only reason is those same 2,000 lines.
   *  The flag is the one that keeps the number, so a `volumeOnly` chip renders its LEVEL without
   *  restating the magnitude. The chip's job is the non-obvious reasons — surfaces, spread,
   *  hubs — which nothing else on the row reports. */
  volumeOnly: boolean;
}

/**
 * Apply an account's stored config (or the product defaults) into the numbers the resolver reads.
 *
 * Lives in `packages/shared` (real code, vendored into the release — PACKAGING) so the SPA and the
 * server apply the SAME fold: the SPA for every chip, the server for the auto-approve impact gate
 * (review/claude-review/auto-post.ts). Nothing is mirrored anywhere.
 */
export function resolveBlastConfig(
  stored: BlastRadiusConfig | null | undefined,
): ResolvedBlastConfig {
  const sensitivity = stored?.sensitivity ?? BLAST_SENSITIVITY_DEFAULT;
  const base = BLAST_THRESHOLDS[sensitivity] ?? BLAST_THRESHOLDS[BLAST_SENSITIVITY_DEFAULT];
  return {
    sensitivity,
    surfacesOff: stored?.surfacesOff ?? [],
    // Overrides land ON TOP of the dial rather than replacing it, so an account that pinned one
    // number still tracks the product defaults for the other five.
    thresholds: { ...base, ...(stored?.overrides ?? {}) },
    isDefault: stored == null,
  };
}

const SURFACE_LABEL: Record<BlastSurface, string> = {
  db_migration: 'a database migration',
  db_schema: 'a database schema',
  sql: 'SQL',
  public_types: 'published types',
  idl: 'a service contract',
  openapi: 'an API description',
  infra: 'infrastructure',
  auth: 'auth or security code',
  ci: 'CI workflows',
  deps: 'dependencies',
};

/** English list: "a", "a and b", "a, b and c". */
function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}

/** `3 code files` / `1 code file`. Private: the SPA's `count` (lib/ui.ts) is the public one. */
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The three wire fields the resolver reads. Structural, exactly like `largePrFlag`'s argument
 *  and for the same reason: the ONE function then serves `TimelinePr`, `InsightPrRef` and
 *  `ConsolidatedFeedItem` without any of them being named here.
 *
 *  ⚠ `codeLoc` is READ FROM THE SAME FIELD THE LARGE-PR FLAG USES rather than duplicated into
 *  `BlastSignals`. One fact, one grain — a second copy is how the chip and the flag come to
 *  quote different line counts for one pull request. */
export interface BlastPrFields {
  blast?: BlastSignals | null;
  codeLoc?: number | null;
  codeLocIsLowerBound?: boolean;
}

/**
 * How far can this pull request reach, and why?
 *
 * All three payloads carry `blast` and `codeLoc` as TRAILING OPTIONAL fields, so a response
 * persisted to IndexedDB before this feature existed simply reads as unknown and draws nothing.
 */
export function blastRadius(
  pr: BlastPrFields,
  config: ResolvedBlastConfig,
): BlastVerdict | null {
  const signals = pr.blast;
  // TRAP 1 — unknown. `== null` catches the undefined of a stale cached payload too.
  if (signals == null) return null;
  const t = config.thresholds;
  const reasons: BlastReason[] = [];

  // ---- HIGH arms, most-consequential first ------------------------------------------------
  //
  // A SURFACE OUTRANKS EVERY SIZE ARM, AND THAT ORDERING IS THE FEATURE: a four-line change to a
  // migration is high and a 900-line change inside one component is not. Reverse them and this
  // becomes a restatement of the large-PR flag.
  const off = new Set(config.surfacesOff);
  const hits = signals.surfaces.filter((s) => BLAST_HIGH_SURFACES.includes(s) && !off.has(s));
  if (hits.length > 0) {
    reasons.push({
      kind: 'surface',
      text: `Touches ${joinWords(hits.map((h) => SURFACE_LABEL[h]))}`,
    });
  }

  // ⚠ A HUB READING OF null IS "THE INDEX DID NOT SPEAK", NOT "NOT A HUB". Only 9 of 22 real
  // repositories clear the coverage floor, so this arm is silent far more often than it fires —
  // and a `hubDegree ?? 0` here would quietly convert every silence into a clean bill of health.
  if (signals.hubDegree != null && signals.hubBar != null && signals.hubDegree >= signals.hubBar) {
    const where = signals.hubPath ? `\`${signals.hubPath}\`` : 'a file here';
    reasons.push({
      kind: 'hub',
      // The number is the evidence, not decoration.
      text: `Touches ${where}, which usually changes alongside ${signals.hubDegree} others`,
    });
  }

  const spread: string[] = [];
  if (signals.subsystems >= t.highSubsystems) spread.push(count(signals.subsystems, 'subsystem', 'subsystems'));
  if (signals.dirs >= t.highDirs) spread.push(count(signals.dirs, 'directory', 'directories'));
  if (signals.codeFiles >= t.highCodeFiles) spread.push(count(signals.codeFiles, 'code file', 'code files'));
  if (spread.length > 0) reasons.push({ kind: 'spread', text: `Spans ${joinWords(spread)}` });

  // ⚠ VOLUME IS LAST, AND IT IS THE ONLY ARM THE LARGE-PR FLAG ALSO REPORTS. Hence `volumeOnly`
  // below: when size is the sole reason, the flag keeps the number and the chip keeps the level.
  // ⚠ `codeLoc` here is the SAME field the flag reads — never a second count folded into
  // `BlastSignals`, which is how two chips on one row come to disagree.
  if (pr.codeLoc != null && pr.codeLoc >= t.highCodeLoc) {
    reasons.push({
      kind: 'volume',
      text: `${pr.codeLoc.toLocaleString()}${pr.codeLocIsLowerBound ? '+' : ''} lines of code changed`,
    });
  }

  if (reasons.length > 0) {
    // ⚠ THE TRIVIAL-CHANGE CAP. A change whose every line is a comment, or which only moved
    // whitespace around, is capped at MEDIUM however it earned HIGH.
    //
    // The case it exists for: golang/go#80721, "crypto/hpke: document sequence counter size" —
    // one file, +4 −2, every changed line a `//` doc comment, HIGH because `crypto/` is a
    // contract surface. The path was right about the FILE and wrong about the CHANGE.
    //
    // ⚠ IT CAPS AT MEDIUM, NEVER LOW, AND THAT IS THE POINT. A comment in a migration is still a
    // change to a file that matters: the reader should look, they just should not have to review
    // it like a schema change. Demoting to low would make the file's consequence disappear
    // entirely, which is the opposite error.
    //
    // ⚠ IT ONLY EVER MOVES DOWNWARD, and only on a POSITIVE reading. `contentKind` is null for
    // the ~98% of pull requests whose diff was never fetched, and null must never demote — see
    // the field's doc for why that asymmetry is the safe one.
    const trivial = signals.contentKind === 'comments' || signals.contentKind === 'formatting';
    if (trivial) {
      const what =
        signals.contentKind === 'comments' ? 'Comments only' : 'Formatting only';
      return {
        level: 'medium',
        // The capped-from reasons are KEPT, below the explanation. The file still matters and the
        // reader is entitled to see what would have made this high.
        reasons: [{ kind: 'contained', text: `${what} — no code behaviour changed` }, ...reasons],
        short: 'Medium',
        label: `${what}, in files that would otherwise read as high reach — ${reasons
          .map((r) => r.text)
          .join('; ')}.`,
        volumeOnly: false,
      };
    }
    return {
      level: 'high',
      reasons,
      short: 'High',
      label: `Wide reach — ${reasons.map((r) => r.text).join('; ')}.`,
      volumeOnly: reasons.every((r) => r.kind === 'volume'),
    };
  }

  // TRAP 2 — a TRUNCATED list that fired no high arm proves NOTHING. Not low, and not medium
  // either: every count below is a floor, so neither a containment claim nor a magnitude is
  // honest. This is the one place the asymmetry is enforced, and it sits BELOW the high arms on
  // purpose — over-threshold stays assertable on a partial list.
  if (signals.truncated) return null;

  // ---- LOW: every containment condition, or nothing ---------------------------------------
  if (signals.codeFiles === 0) {
    // No product code at all. The three phrasings say which kind of nothing, because "no code
    // changed" about a pull request that rewrote the test suite is not what a reviewer means.
    const text =
      signals.testFiles > 0 && signals.nonCodeFiles === 0
        ? 'Tests only — no product code changed'
        : signals.testFiles > 0
          ? 'Tests, docs and config only — no product code changed'
          : 'Docs, config and dependencies only — no code changed';
    return { level: 'low', reasons: [{ kind: 'contained', text }], short: 'Low', label: `${text}.`, volumeOnly: false };
  }

  // ⚠ EACH CONDITION IS CHECKED SEPARATELY SO THE MEDIUM ROW CAN NAME THE ONE THAT FIRED. An
  // earlier cut folded them into one boolean and printed "1 code file across 1 directory" beside
  // the word Medium — a sentence that argues for the OPPOSITE verdict, on a real pull request
  // whose actual discriminator was its 300 lines. A row must say why it is what it is.
  const tooManyFiles = signals.codeFiles > t.lowCodeFiles;
  const tooWide = signals.subsystems > 1;
  const tooLong = pr.codeLoc != null && pr.codeLoc > t.lowCodeLoc;
  // ⚠ An UNKNOWN line count cannot earn containment either — we know which files were touched
  // but not how much of them, which is not enough to promise a quick eyeball.
  const unknownSize = pr.codeLoc == null;

  if (!tooManyFiles && !tooWide && !tooLong && !unknownSize) {
    const bits = [`${count(signals.codeFiles, 'code file', 'code files')} in one area`];
    if (signals.testFiles > 0) bits.push('with tests');
    if (signals.allNew) bits.push('all newly added');
    const text = bits.join(', ');
    return {
      level: 'low',
      reasons: [{ kind: 'contained', text }],
      short: 'Low',
      label: `Contained — ${text}.`,
      volumeOnly: false,
    };
  }

  // MEDIUM: name the condition that actually kept it out of low, most-informative first.
  const why: BlastReason = tooWide
    ? { kind: 'spread', text: `Spans ${count(signals.subsystems, 'subsystem', 'subsystems')}` }
    : tooManyFiles
      ? {
          kind: 'spread',
          text: `${count(signals.codeFiles, 'code file', 'code files')} across ${count(signals.dirs, 'directory', 'directories')}`,
        }
      : tooLong
        ? {
            kind: 'volume',
            text: `${pr.codeLoc!.toLocaleString()}${pr.codeLocIsLowerBound ? '+' : ''} lines across ${count(signals.codeFiles, 'code file', 'code files')}`,
          }
        : {
            // The honest one. We know the file list and not the line counts, so we can say what
            // it touches and must not promise it is small.
            kind: 'spread',
            text: `${count(signals.codeFiles, 'code file', 'code files')}, size not measured`,
          };

  return {
    level: 'medium',
    reasons: [why],
    short: 'Medium',
    label: `Moderate reach — ${why.text}.`,
    volumeOnly: false,
  };
}
