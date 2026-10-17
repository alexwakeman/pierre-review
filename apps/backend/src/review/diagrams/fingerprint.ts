import { createHash } from 'node:crypto';
import type { StoredPrFile } from '@pierre-review/shared';
import { codeLocFor, isNonCodeFile } from '../../db/code-loc.js';

// "IS THIS DIAGRAM STILL TRUE?" and "SHOULD A FINISHED REVIEW DRAW ONE?" — PURE, clock-free.
//
//   PR       sha256(versions | 'pr' | prId | headSha). A push makes it stale; nothing else does
//            (a comment, a CI result or a re-review on the same head never redraws it).
//   STORY    sha256(versions | 'story' | ident | sorted "prId:headSha:state"). A member pushed, merged,
//            joined or left. ⚠ The ticket TEXT is deliberately not in it: a reworded description does
//            not change the code's flow.
//
// ⚠ Nothing derived from `Date.now()` may enter a fingerprint, or a PR nobody touched would redraw
// (and re-bill) on a timer. Bump SEQUENCE_DIAGRAM_VERSION when what a run produces for the same
// inputs changes (the prompt's rules, the validator) — every stored diagram then reads stale once.
// DESIGN_DIAGRAM_VERSION is the design grid's own number (folded in beside it): its arrival made
// every Mermaid-era fingerprint stale, so every current head is drawn once more, as a design. Bump it
// when the design prompt, the validator or the layer vocabulary changes what a run produces.

export const SEQUENCE_DIAGRAM_VERSION = 1;
export const DESIGN_DIAGRAM_VERSION = 1;
const VERSION = `v${SEQUENCE_DIAGRAM_VERSION}.d${DESIGN_DIAGRAM_VERSION}`;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function prDiagramFingerprint(prId: number, headSha: string): string {
  return sha256([VERSION, 'pr', String(prId), headSha].join('\n'));
}

export interface StoryFingerprintMember {
  prId: number;
  headSha: string;
  state: 'open' | 'merged';
}

/** Member order does not matter. */
export function storyDiagramFingerprint(ident: string, members: readonly StoryFingerprintMember[]): string {
  const parts = members.map((m) => `${m.prId}:${m.headSha}:${m.state}`).sort();
  return sha256([VERSION, 'story', ident, ...parts].join('\n'));
}

// ---- does the change touch CODE? ----
//
// Through the existing classifier (db/code-loc.ts `isNonCodeFile` — prose, structured config,
// generated/vendored output and binary payloads are not code), never a fourth one. Three answers:
//   'yes'      the stored file list shows code lines;
//   'no'       the stored file list is complete and shows none (a docs-only or lockfile-only PR);
//   'unknown'  nothing stored, or a truncated list summing to zero — the pipeline decides from the
//              diff it reads anyway (`diffHasCode`).

export type CodeAnswer = 'yes' | 'no' | 'unknown';

export function storedCodeAnswer(pr: {
  files: StoredPrFile[] | null | undefined;
  additions: number;
  deletions: number;
  changedFiles: number;
}): CodeAnswer {
  const { codeLoc, codeLocIsLowerBound } = codeLocFor(pr);
  if (codeLoc == null) return 'unknown';
  if (codeLoc > 0) return 'yes';
  return codeLocIsLowerBound ? 'unknown' : 'no';
}

/** The diff's changed paths (noise-stripped) include at least one code file. */
export function diffHasCode(changedFiles: readonly string[]): boolean {
  return changedFiles.some((p) => !isNonCodeFile(p));
}

// ---- the trigger rule ----

export type DiagramSkip = 'no_code' | 'drawn' | 'in_flight' | 'daily_cap' | 'too_few_prs';

/**
 * Should a finished review queue this diagram? Null = yes. Order matters only for the reason
 * reported: no code beats everything (nothing to draw, ever, at this head).
 */
export function diagramSkipReason(a: {
  code: CodeAnswer;
  // A row already exists at this fingerprint (any status — a failure is redrawn by a click).
  drawnAtFingerprint: boolean;
  inFlight: boolean;
  usedToday: number;
  dailyCap: number;
  // Story diagrams only: open + merged members right now.
  memberCount?: number;
}): DiagramSkip | null {
  if (a.memberCount != null && a.memberCount < 2) return 'too_few_prs';
  if (a.code === 'no') return 'no_code';
  if (a.drawnAtFingerprint) return 'drawn';
  if (a.inFlight) return 'in_flight';
  if (a.usedToday >= a.dailyCap) return 'daily_cap';
  return null;
}
