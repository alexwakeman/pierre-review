// ── DEPENDENCY AUTOMATION: THE DECISIONS (CORE, pure, deterministic, no AI) ──────────────────
//
// docs/MERGE-CI-TRUNK.md § Dependency automation. Every "should the automation touch this PR?"
// question is answered HERE, from plain values, so each rule is unit-tested without a database or
// GitHub (dependency-rules.test.ts). `merge/dependency-automation.ts` gathers the values and acts.
//
//   • WHAT KIND OF UPDATE IS IT — `classifyDependencyUpdate`: the semver size (patch / minor /
//     major, the LARGEST over a grouped PR) and the ecosystems it touches. Unknown is NOT small: a
//     size nobody could read passes only a policy that admits majors.
//   • DOES THE POLICY ADMIT IT — `policyVerdict`: size, security-only, ecosystems.
//   • IS THE AUTHOR TRUSTED — `isTrustedDependencyBot`: the STORED bot row (automated, role
//     `dependency`, and the reader's trust mark). Never a login guess over the stored judgement.
//   • HOW TO ASK IT TO REBASE — `rebaseRequestFor`, by the STORED vendor kind.
//   • WHAT TO DO ABOUT A CONFLICT — `conflictStep`: ask the bot once per head, wait, then AI.
//   • CAN AN AI ANSWER BE COMMITTED — `aiResolutionCommit`: every decidable region decided, every
//     conflicted file supported, nothing Claude was unsure of.
import type {
  ConflictAiChoice,
  ConflictFileResolution,
  ConflictRegionKind,
  DependencyAutomationPolicy,
  DependencyEcosystem,
  DependencyUpdateLevel,
} from '@pierre-review/shared';
import { DEPENDENCY_UPDATE_LEVELS } from '@pierre-review/shared';

// ── The update's size ────────────────────────────────────────────────────────────────────────

const LEVEL_RANK: Record<DependencyUpdateLevel, number> = { patch: 0, minor: 1, major: 2 };

function versionParts(v: string): number[] | null {
  // A sentence's full stop is not part of the version ("…to 4.17.21.").
  const core = v.trim().replace(/[.,;]+$/, '').replace(/^[v=^~]+/i, '').split(/[-+]/)[0] ?? '';
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(Number(p));
  }
  while (nums.length < 3) nums.push(0);
  return nums;
}

/** The semver size of `from → to`, or null when either is not a version. A 0.x minor change is a
 *  MAJOR one (semver: anything may break before 1.0). */
export function semverLevel(from: string, to: string): DependencyUpdateLevel | null {
  const a = versionParts(from);
  const b = versionParts(to);
  if (!a || !b) return null;
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return a[0] === 0 ? 'major' : 'minor';
  return 'patch';
}

const maxLevel = (
  a: DependencyUpdateLevel | null,
  b: DependencyUpdateLevel | null,
): DependencyUpdateLevel | null => (a == null ? b : b == null ? a : LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b);

// Dependabot: "Bump lodash from 4.17.20 to 4.17.21", "Updates `x` from 1.0 to 2.0" (grouped).
const FROM_TO = /\bfrom\s+`?v?(\d[\w.+-]*)`?\s+to\s+`?v?(\d[\w.+-]*)/gi;
// Renovate's table: | `1.2.3` -> `1.2.4` | (also → and ⇒).
const ARROW = /`v?(\d[^`\s]*)`\s*(?:->|→|⇒)\s*`v?(\d[^`\s]*)`/g;
// Renovate's "Update" column: | major | minor | patch |.
const UPDATE_CELL = /\|\s*(major|minor|patch)\s*\|/gi;

export interface DependencyUpdateInput {
  title: string;
  /** The PR description, when known (live or hydrated). */
  body: string | null;
  headRefName: string | null;
  labels: readonly string[];
  /** Repo-relative paths the PR changes, when known. */
  filePaths: readonly string[];
}

export interface DependencyUpdateClass {
  /** The LARGEST size across every version change found; null = none could be read. */
  level: DependencyUpdateLevel | null;
  /** Every ecosystem the PR touches; empty = none could be told. */
  ecosystems: DependencyEcosystem[];
}

function levelOf(text: string): DependencyUpdateLevel | null {
  let level: DependencyUpdateLevel | null = null;
  for (const m of text.matchAll(FROM_TO)) level = maxLevel(level, semverLevel(m[1]!, m[2]!));
  for (const m of text.matchAll(ARROW)) level = maxLevel(level, semverLevel(m[1]!, m[2]!));
  if (level == null) {
    for (const m of text.matchAll(UPDATE_CELL)) {
      level = maxLevel(level, m[1]!.toLowerCase() as DependencyUpdateLevel);
    }
  }
  return level;
}

// Dependabot's ecosystem ids (the second segment of `dependabot/<id>/…`).
const DEPENDABOT_ECOSYSTEM: Record<string, DependencyEcosystem> = {
  npm_and_yarn: 'javascript',
  bun: 'javascript',
  pip: 'python',
  uv: 'python',
  go_modules: 'go',
  cargo: 'rust',
  bundler: 'ruby',
  maven: 'java',
  gradle: 'java',
  nuget: 'dotnet',
  dotnet_sdk: 'dotnet',
  composer: 'php',
  docker: 'docker',
  docker_compose: 'docker',
  github_actions: 'github_actions',
  terraform: 'terraform',
};

// Renovate's commit topics, as its titles spell them.
const RENOVATE_TOPIC: Array<[RegExp, DependencyEcosystem]> = [
  [/\bupdate rust crate\b/i, 'rust'],
  [/\bupdate module\b/i, 'go'],
  [/\bupdate [\w./-]+ action\b/i, 'github_actions'],
  [/\bdocker (?:tag|digest)\b/i, 'docker'],
  [/\bupdate terraform\b/i, 'terraform'],
];

// The manifest and lock files that name an ecosystem without doubt.
const FILE_ECOSYSTEM: Array<[RegExp, DependencyEcosystem]> = [
  [/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|npm-shrinkwrap\.json)$/, 'javascript'],
  [/(^|\/)(requirements[^/]*\.(txt|in)|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|uv\.lock|setup\.(py|cfg))$/, 'python'],
  [/(^|\/)go\.(mod|sum)$/, 'go'],
  [/(^|\/)Cargo\.(toml|lock)$/, 'rust'],
  [/(^|\/)(Gemfile(\.lock)?|[^/]+\.gemspec)$/, 'ruby'],
  [/(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.lockfile|libs\.versions\.toml)$/, 'java'],
  [/(^|\/)([^/]+\.(csproj|fsproj|vbproj)|packages\.config|Directory\.Packages\.props|global\.json|packages\.lock\.json)$/, 'dotnet'],
  [/(^|\/)composer\.(json|lock)$/, 'php'],
  [/(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/, 'docker'],
  [/^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+\/action\.ya?ml)$/, 'github_actions'],
  [/(^|\/)([^/]+\.tf|\.terraform\.lock\.hcl)$/, 'terraform'],
];

/** The update's size and ecosystems. Every source adds; none subtracts. */
export function classifyDependencyUpdate(input: DependencyUpdateInput): DependencyUpdateClass {
  const level = maxLevel(levelOf(input.title), input.body ? levelOf(input.body) : null);
  const eco = new Set<DependencyEcosystem>();
  const ref = input.headRefName ?? '';
  const dependabot = /^dependabot\/([^/]+)\//.exec(ref);
  if (dependabot) {
    const e = DEPENDABOT_ECOSYSTEM[dependabot[1]!.toLowerCase()];
    if (e) eco.add(e);
  }
  for (const [re, e] of RENOVATE_TOPIC) if (re.test(input.title)) eco.add(e);
  for (const p of input.filePaths) {
    for (const [re, e] of FILE_ECOSYSTEM) {
      if (re.test(p)) {
        eco.add(e);
        break;
      }
    }
  }
  return { level, ecosystems: [...eco].sort() };
}

// ── The policy ───────────────────────────────────────────────────────────────────────────────

export type PolicyRefusal = 'too_big' | 'size_unknown' | 'not_security' | 'ecosystem';

/** The plain sentence for each refusal — the automation log says it. */
export const POLICY_REFUSAL_TEXT: Record<PolicyRefusal, string> = {
  too_big: 'larger than this workspace allows',
  size_unknown: 'the update size couldn’t be read',
  not_security: 'not a security fix',
  ecosystem: 'not in an ecosystem this workspace allows',
};

/**
 * Does the workspace's policy admit this update? First refusal wins, in this order: security-only,
 * ecosystem, size. A policy of `major` admits every size, unknown included; anything narrower
 * refuses an unknown size (an update nobody could measure is not a small one). An ecosystem list
 * admits a PR only when it touches at least one ecosystem and EVERY one it touches is listed.
 */
export function policyVerdict(
  policy: DependencyAutomationPolicy,
  update: DependencyUpdateClass,
  securityFix: boolean,
): { ok: true } | { ok: false; refusal: PolicyRefusal } {
  if (policy.securityOnly && !securityFix) return { ok: false, refusal: 'not_security' };
  if (policy.ecosystems != null) {
    const allowed = new Set(policy.ecosystems);
    if (update.ecosystems.length === 0 || update.ecosystems.some((e) => !allowed.has(e))) {
      return { ok: false, refusal: 'ecosystem' };
    }
  }
  if (policy.maxLevel !== 'major') {
    if (update.level == null) return { ok: false, refusal: 'size_unknown' };
    if (LEVEL_RANK[update.level] > LEVEL_RANK[policy.maxLevel]) return { ok: false, refusal: 'too_big' };
  }
  return { ok: true };
}

/** Does the policy need to read the PR's size? (A `major` policy never does.) */
export const policyNeedsLevel = (policy: DependencyAutomationPolicy): boolean => policy.maxLevel !== 'major';

/** A stored level string → the level, else null. */
export function parseLevel(raw: unknown): DependencyUpdateLevel | null {
  return typeof raw === 'string' && (DEPENDENCY_UPDATE_LEVELS as readonly string[]).includes(raw)
    ? (raw as DependencyUpdateLevel)
    : null;
}

// ── Trust ────────────────────────────────────────────────────────────────────────────────────

export interface StoredBotRow {
  automated: boolean;
  role: string;
  /** The reader's mark (`workspace_reviewers.dependency_trusted`). */
  trusted: boolean | null;
}

/**
 * The ONE trust test behind approval and conflict resolution: the author's STORED row in this
 * workspace says automated, role `dependency`, and the reader marked it trusted. No row → not
 * trusted, whatever its login looks like — a person can open a PR from a fork under any login.
 */
export function isTrustedDependencyBot(row: StoredBotRow | null | undefined): boolean {
  return row != null && row.automated === true && row.role === 'dependency' && row.trusted === true;
}

// ── Asking the bot to rebase ─────────────────────────────────────────────────────────────────

/** Renovate's own rebase checkbox, unticked (its docs: tick it and Renovate rebases/retries). */
const RENOVATE_REBASE_UNTICKED = /- \[ \] (<!-- rebase-check -->)/;

export type RebaseRequest =
  | { method: 'comment'; body: string }
  | { method: 'tick_checkbox'; body: string };

/** Can a bot of this STORED kind be asked to rebase at all? (The settings panel says so.) */
export const botCanRebase = (kind: string | null): boolean => kind === 'dependabot' || kind === 'renovate';

/**
 * How to ask the PR's bot to rebase, by its STORED vendor kind — or null when it can't be asked
 * (another bot, or a Renovate PR whose body has no unticked rebase checkbox — already ticked, or
 * Renovate is set up without one). Dependabot takes the `@dependabot rebase` comment; Renovate has
 * no comment command, so its checkbox is ticked in the PR body (`prBody` is the LIVE body).
 */
export function rebaseRequestFor(kind: string | null, prBody: string | null): RebaseRequest | null {
  if (kind === 'dependabot') return { method: 'comment', body: '@dependabot rebase' };
  if (kind === 'renovate' && prBody != null && RENOVATE_REBASE_UNTICKED.test(prBody)) {
    return { method: 'tick_checkbox', body: prBody.replace(RENOVATE_REBASE_UNTICKED, '- [x] $1') };
  }
  return null;
}

// ── What to do about a conflict ──────────────────────────────────────────────────────────────

/** How long the bot gets to rebase before the AI fallback. */
export const REBASE_WAIT_MS = 30 * 60_000;

export interface ConflictHistory {
  /** This head's rebase request, if one was claimed. */
  rebase: { state: 'running' | 'done' | 'failed'; at: number } | null;
  /** This head's AI run, if one was claimed. */
  ai: { state: 'running' | 'done' | 'failed' } | null;
}

export type ConflictStep = 'ask_bot' | 'wait' | 'ai' | 'none';

/**
 * The next step for a conflicting PR at ONE head. Each step is taken at most once per head (the
 * caller claims a row before it writes, and never retries a failed one):
 *   • an AI run was already claimed at this head → none (done, failed or running: never twice);
 *   • the bot can be asked and has not been → ask_bot;
 *   • the request is out and younger than REBASE_WAIT_MS → wait (a rebase is a new head);
 *   • otherwise (asked and it didn't, the request failed, or the bot can't be asked) → ai.
 */
export function conflictStep(h: ConflictHistory, botCanBeAsked: boolean, now: number): ConflictStep {
  if (h.ai != null) return 'none';
  if (h.rebase == null) return botCanBeAsked ? 'ask_bot' : 'ai';
  if (h.rebase.state !== 'failed' && now - h.rebase.at < REBASE_WAIT_MS) return 'wait';
  return 'ai';
}

// ── Committing an AI answer unattended ───────────────────────────────────────────────────────

export interface CommitFile {
  index: number;
  path: string;
  unsupported: unknown | null;
  regions: ReadonlyArray<{ id: number; kind: ConflictRegionKind }>;
}

export type AiCommitRefusal = 'unsupported_files' | 'undecided' | 'unsure' | 'nothing';

export const AI_COMMIT_REFUSAL_TEXT: Record<AiCommitRefusal, string> = {
  unsupported_files: 'some conflicting files can’t be resolved here',
  undecided: 'the AI left some conflicts undecided',
  unsure: 'the AI wasn’t sure about some conflicts',
  nothing: 'there was nothing to resolve',
};

/**
 * The commit body's `files` for an unattended AI answer, or why it may not be committed. Stricter
 * than the reader's own commit on purpose — nobody is looking: EVERY conflicted file must be
 * supported (a partial commit would leave the PR conflicted with a push on the bot's branch), EVERY
 * decidable region must carry the AI's choice, and none of them may be `low` confidence. A
 * `'suggestion'` is never the AI's (validate.ts), so a choice is `{decision}` or `{decision, editId}`.
 */
export function aiResolutionCommit(
  files: readonly CommitFile[],
  choices: readonly ConflictAiChoice[],
): { ok: true; files: ConflictFileResolution[] } | { ok: false; refusal: AiCommitRefusal } {
  if (files.length === 0) return { ok: false, refusal: 'nothing' };
  if (files.some((f) => f.unsupported != null)) return { ok: false, refusal: 'unsupported_files' };
  const byKey = new Map(choices.map((c) => [`${c.fileIndex}:${c.regionId}`, c]));
  const out: ConflictFileResolution[] = [];
  for (const f of files) {
    const decisions: ConflictFileResolution['decisions'] = [];
    for (const r of f.regions) {
      if (r.kind === 'unchanged') continue;
      const c = byKey.get(`${f.index}:${r.id}`);
      if (!c || c.decision === 'suggestion') return { ok: false, refusal: 'undecided' };
      if (c.confidence === 'low') return { ok: false, refusal: 'unsure' };
      if (c.decision === 'edited') {
        if (c.editId == null) return { ok: false, refusal: 'undecided' };
        decisions.push({ id: r.id, decision: 'edited', editId: c.editId });
      } else {
        decisions.push({ id: r.id, decision: c.decision });
      }
    }
    out.push({ index: f.index, decisions });
  }
  return { ok: true, files: out };
}
