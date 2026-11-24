// THE TEAM POLICY (docs/TEAM-POLICY.md): a file a team commits to a repository's default branch,
// `.ensemble/policy.json`, that sets rules for the PRs of THAT repository on every copy of Ensemble.
//
// ⚠ A POLICY CAN ONLY RESTRICT. Every rule switches something OFF, narrows a list or lowers a cap.
//   Nothing in a policy can switch an automation ON, widen what a reader chose, or spend more on a
//   reader's machine. A missing rule means "no restriction": the reader's own settings stand.
// ⚠ STRICT. An unknown key, a wrong type or an unknown value makes the WHOLE file invalid, so a
//   typo never silently drops a rule. An invalid file is not applied, and the app says why.
// ⚠ AN ORGANISATION FEATURE. A copy of Ensemble applies a policy only while it holds a valid
//   licence key or is in its 30-day evaluation (`orgFeaturesUnlocked`). Without one it applies
//   nothing and SAYS SO, in Settings → Team policy and in the licence reminder.
//
// Pure: no I/O. The backend reads the file during sync; both sides read this module.

import type { LicenceStatusResponse } from './licence.js';

/** Where the file lives, on the repository's default branch. */
export const TEAM_POLICY_PATH = '.ensemble/policy.json';

/** The only format version so far. */
export const TEAM_POLICY_VERSION = 1;

/** A file larger than this is refused unread (a policy is a few hundred bytes). */
export const TEAM_POLICY_MAX_BYTES = 16 * 1024;

/** Automations a policy may switch off. Each defaults to "no restriction". */
export const TEAM_POLICY_AUTOMATIONS = ['auto_review', 'auto_post', 'auto_fix', 'auto_push', 'auto_resolve', 'dependencies'] as const;
export type TeamPolicyAutomation = (typeof TEAM_POLICY_AUTOMATIONS)[number];

/** The parsed, validated policy. Every field is optional: absent = no restriction. */
export interface TeamPolicy {
  version: 1;
  /** `false` switches that automation off for the repository's PRs. `true` restricts nothing. */
  automation: Partial<Record<TeamPolicyAutomation, boolean>>;
  ai: {
    /** `false`: an AI review never approves a PR here; an approval is posted as a comment. */
    approve?: boolean;
  };
  // ⚠ NOT YET: allowed AI providers and a per-run spend cap. A run's provider and cap are decided in
  //   many places, so a rule enforced in only some of them would promise more than it does. They
  //   come when every run kind passes one check (docs/TEAM-POLICY.md § Not yet).
  dependencies: {
    /** Only these bots' PRs may be approved, merged or fixed automatically (logins, e.g.
     *  `dependabot[bot]`). Narrows the reader's trusted list; never adds to it. */
    trustedBots?: string[];
  };
  /** Free text from the team: why these rules exist. Shown in Settings, never interpreted. */
  note?: string;
}

export type TeamPolicyParse = { ok: true; policy: TeamPolicy } | { ok: false; errors: string[] };

const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKeys(where: string, obj: Record<string, unknown>, allowed: readonly string[], errors: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}". Allowed: ${allowed.join(', ')}.`);
  }
}

/**
 * Parse and validate a policy file's text. Strict: any problem makes the whole file invalid, with
 * every problem listed (in plain English, for Settings). Pure.
 */
export function parseTeamPolicy(text: string): TeamPolicyParse {
  // Characters, not bytes: the shared package has no TextEncoder type, and the backend checks the
  // byte size before it calls this.
  if (text.length > TEAM_POLICY_MAX_BYTES) {
    return {
      ok: false,
      errors: [`The file is larger than ${TEAM_POLICY_MAX_BYTES / 1024} KB.`],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      errors: [`The file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['The file must hold one JSON object.'] };
  checkKeys('The file', raw, ['$schema', 'version', 'automation', 'ai', 'dependencies', 'note'], errors);
  if (raw.version !== TEAM_POLICY_VERSION) errors.push(`"version" must be ${TEAM_POLICY_VERSION}.`);

  const policy: TeamPolicy = {
    version: 1,
    automation: {},
    ai: {},
    dependencies: {},
  };

  if (raw.automation !== undefined) {
    if (!isObject(raw.automation)) errors.push('"automation" must be an object.');
    else {
      checkKeys('"automation"', raw.automation, TEAM_POLICY_AUTOMATIONS, errors);
      for (const k of TEAM_POLICY_AUTOMATIONS) {
        const v = raw.automation[k];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') errors.push(`"automation.${k}" must be true or false.`);
        else policy.automation[k] = v;
      }
    }
  }

  if (raw.ai !== undefined) {
    if (!isObject(raw.ai)) errors.push('"ai" must be an object.');
    else {
      checkKeys('"ai"', raw.ai, ['approve'], errors);
      const { approve } = raw.ai;
      if (approve !== undefined) {
        if (typeof approve !== 'boolean') errors.push('"ai.approve" must be true or false.');
        else policy.ai.approve = approve;
      }
    }
  }

  if (raw.dependencies !== undefined) {
    if (!isObject(raw.dependencies)) errors.push('"dependencies" must be an object.');
    else {
      checkKeys('"dependencies"', raw.dependencies, ['trusted_bots'], errors);
      const bots = raw.dependencies.trusted_bots;
      if (bots !== undefined) {
        if (!Array.isArray(bots) || bots.some((b) => typeof b !== 'string' || !LOGIN.test(b))) {
          errors.push('"dependencies.trusted_bots" must be a list of GitHub logins, for example ["dependabot[bot]"].');
        } else policy.dependencies.trustedBots = [...new Set((bots as string[]).map((b) => b.toLowerCase()))];
      }
    }
  }

  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length > 500) errors.push('"note" must be text of at most 500 characters.');
    else policy.note = raw.note;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, policy };
}

// ── Reading a policy (both sides) ───────────────────────────────────────────────────────────────

/** Is this automation allowed by the policy? No policy, or no rule, = allowed. */
export function policyAllowsAutomation(policy: TeamPolicy | null, automation: TeamPolicyAutomation): boolean {
  return policy?.automation[automation] !== false;
}

/** May an AI review approve here? */
export function policyAllowsAiApproval(policy: TeamPolicy | null): boolean {
  return policy?.ai.approve !== false;
}

/** The reader's trusted dependency bots after the policy: the intersection, never more. */
export function policyTrustedBots(policy: TeamPolicy | null, readerTrusted: readonly string[]): string[] {
  const list = policy?.dependencies.trustedBots;
  if (list == null) return [...readerTrusted];
  return readerTrusted.filter((b) => list.includes(b.toLowerCase()));
}

/** The rules in plain English, for Settings (one line each). Empty for a policy with no rules. */
export function describeTeamPolicy(policy: TeamPolicy): string[] {
  const out: string[] = [];
  const WORDS: Record<TeamPolicyAutomation, string> = {
    auto_review: 'Auto review is off.',
    auto_post: 'AI reviews are never posted automatically.',
    auto_fix: 'Auto fix is off.',
    auto_push: 'Nothing is pushed automatically.',
    auto_resolve: 'Ensemble never resolves threads automatically.',
    dependencies: 'Dependency automation is off.',
  };
  for (const a of TEAM_POLICY_AUTOMATIONS) if (policy.automation[a] === false) out.push(WORDS[a]);
  if (policy.ai.approve === false) out.push('An AI review never approves; an approval is posted as a comment.');
  const bots = policy.dependencies.trustedBots;
  if (bots != null) {
    out.push(bots.length === 0 ? 'No bot is trusted for dependency automation.' : `Dependency automation trusts only ${bots.join(', ')}.`);
  }
  return out;
}

// ── The licence gate for organisation features ──────────────────────────────────────────────────

/**
 * Organisation features (the team policy first) work while this copy holds a VALID licence key,
 * or during its one 30-day evaluation. Team size does not matter: a small team asks for a free key.
 */
export function orgFeaturesUnlocked(status: Pick<LicenceStatusResponse, 'licence' | 'reminder'>, nowMs: number): boolean {
  if (status.licence?.ok === true) return true;
  const ends = status.reminder.evaluationEndsAt;
  return ends != null && Date.parse(ends) > nowMs;
}

// ── The wire ────────────────────────────────────────────────────────────────────────────────────

/** One repository's policy, as this copy sees it. */
export interface RepoTeamPolicy {
  repoId: number;
  repo: string;
  /** none: no file on the default branch · invalid: the file has problems · ok: parsed. */
  state: 'none' | 'invalid' | 'ok';
  policy: TeamPolicy | null;
  /** The rules in words (`describeTeamPolicy`), when ok. */
  rules: string[];
  errors: string[];
  /** The default-branch commit the file was read at, and when (ISO). Null before the first read. */
  commitOid: string | null;
  readAt: string | null;
}

/** GET /api/team-policy?workspace=<id>. */
export interface TeamPolicyResponse {
  workspaceId: number;
  /** This copy applies policies (a valid key, or the evaluation). */
  applied: boolean;
  /** Why not, when not: no key or an invalid one, and the evaluation is not running. */
  notAppliedReason: 'no_licence' | null;
  repos: RepoTeamPolicy[];
  /**
   * WHEN REPOSITORIES' RULES DIFFER (work that spans repositories): the repo whose policy the workspace
   * ADDS to the strictest rule from each (it can only tighten). `repoId` null = nothing added. `usable` is false when the chosen repo no longer has a valid
   * policy in this workspace (the strictest rule applies until it does).
   */
  clash: { repoId: number | null; repo: string | null; usable: boolean };
}

// ── When repositories' rules differ (a workspace's choice) ─────────────────────────────────────

/** Two policies set the same rules (the note is ignored). Null = no policy. */
export function sameTeamPolicyRules(a: TeamPolicy | null, b: TeamPolicy | null): boolean {
  const rules = (p: TeamPolicy | null) =>
    p == null
      ? 'none'
      : JSON.stringify({
          automation: TEAM_POLICY_AUTOMATIONS.map((k) => p.automation[k] === false),
          approve: p.ai.approve === false,
          bots: p.dependencies.trustedBots == null ? null : [...p.dependencies.trustedBots].sort(),
        });
  return rules(a) === rules(b);
}

/**
 * The strictest combination: an automation is off if ANY policy switches it off, an AI approval is
 * held if any forbids it, and the trusted bots are the bots EVERY listing policy trusts. Pure.
 */
export function strictestTeamPolicy(policies: readonly TeamPolicy[]): TeamPolicy {
  const out: TeamPolicy = { version: 1, automation: {}, ai: {}, dependencies: {} };
  for (const p of policies) {
    for (const k of TEAM_POLICY_AUTOMATIONS) if (p.automation[k] === false) out.automation[k] = false;
    if (p.ai.approve === false) out.ai.approve = false;
    const bots = p.dependencies.trustedBots;
    if (bots != null) {
      const prev = out.dependencies.trustedBots;
      out.dependencies.trustedBots = prev == null ? [...bots] : prev.filter((b) => bots.includes(b));
    }
  }
  return out;
}

/** Where a multi-repo action's policy came from (for the line that explains a refusal). */
export type PolicyClashSource =
  /** Every repository involved sets the same rules (or only one is involved). */
  | 'agreed'
  /** They differ and the workspace added a repository's policy on top of the strictest rule. */
  | 'chosen'
  /** They differ and the workspace has no (usable) choice: the strictest rule from each. */
  | 'strictest';

/**
 * THE POLICY FOR WORK THAT SPANS REPOSITORIES (Implement story's push today). Each involved repo's
 * policy (null = none) is compared; when they agree that is the policy. When they differ, the
 * strictest rule from each applies, and the WORKSPACE'S CHOICE (a repo's policy) is ADDED on top.
 * ⚠ THE CHOICE CAN ONLY TIGHTEN: it never loosens a rule any involved repository sets. Pure.
 */
export function resolvePolicyClash(
  involved: readonly (TeamPolicy | null)[],
  chosen: TeamPolicy | null,
): { policy: TeamPolicy | null; source: PolicyClashSource } {
  const first = involved[0] ?? null;
  if (involved.every((p) => sameTeamPolicyRules(p, first))) return { policy: first, source: 'agreed' };
  const set = involved.filter((p): p is TeamPolicy => p != null);
  if (chosen != null) return { policy: strictestTeamPolicy([...set, chosen]), source: 'chosen' };
  return { policy: strictestTeamPolicy(set), source: 'strictest' };
}

/** PUT /api/team-policy/clash?workspace=<id>. `repoId: null` = the strictest rule from each, nothing added. */
export interface TeamPolicyClashChoiceBody {
  repoId: number | null;
}
