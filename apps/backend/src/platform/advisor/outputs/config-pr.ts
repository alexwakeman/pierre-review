// The config-PR assembly — PURE (§B.1: routes execute the seam call; this module only
// builds it). Gate chain, in order:
//   1. every suppress-shaped intent must carry a COMPUTABLE retro-check (422 otherwise —
//      the brief mandate: an unsimulatable suppression never ships as a PR);
//   2. the fetched config must parse (a broken file is a refusal, not a best-effort edit);
//   3. adapter plan → serialize → validate;
//   4. the additive assert: the diff against the fetched originals must be ADDITIVE outside
//      our managed blocks — every value the user wrote must still be reachable in the
//      output (deep containment for yaml/json; text-outside-markers equality for prose);
//   5. refined prose (client-supplied, NEVER trusted) re-passes the deterministic
//      diff-guard against OUR templated block before it may replace it.
// Workflow-path refusal is enforced again in core's commitFilesAndOpenPr — two layers, on
// purpose.
import type { AdvisorIntentWire } from '@pierre-review/shared';
import type { AdapterFileInput, AdapterOutputFile, AdapterPlanItem } from '../emitters/adapter.js';
import type { AnyBotAdapter } from '../emitters/registry.js';
import { extractManagedBlock } from '../emitters/prose.js';
import { parseYamlConfig } from '../emitters/yaml-doc.js';
import { COPILOT_CHAR_BUDGET, COPILOT_PATH } from '../emitters/copilot-prose.js';

// The deterministic diff-guard's shape, INJECTED by routes.ts rather than imported: the
// llm-isolation rule forbids outputs/ from importing refine/ (where diff-guard lives beside
// the one LLM module), and an injected pure function keeps the dependency direction visible.
export type RefinedGuard = (
  templated: string,
  refined: string,
  opts?: { charBudget?: number },
) => { ok: true; content: string } | { ok: false; reason: string };

export interface ConfigPrBuild {
  ok: true;
  files: AdapterOutputFile[];
  branch: string;
  title: string;
  body: string;
  applied: AdapterPlanItem[];
}

export interface ConfigPrRefusal {
  ok: false;
  status: number; // HTTP status the route surfaces
  error: string;
}

export interface BuildConfigPrArgs {
  intents: AdvisorIntentWire[]; // re-derived server-side ∩ the client's selected dedupeKeys
  adapter: AnyBotAdapter;
  files: AdapterFileInput[]; // fetched at the default-branch ref
  refinedByPath?: Record<string, string>;
  // Required whenever refinedByPath is given — see RefinedGuard above.
  guardRefined?: RefinedGuard;
  botLabel: string;
  repoFullName: string;
  // yyyymmdd, derived from the findings generatedAt (kept out of Date.now() so builds are
  // deterministic and testable).
  dateSlug: string;
  windowLabel: string;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Deep containment: every leaf the user wrote must still be reachable in the output —
// equal at the same path, or (strings) contained in the output's string there, or (arrays)
// each original element still present. This is what "additive outside our managed blocks"
// means for structured formats.
function containedIn(original: unknown, output: unknown): string | null {
  if (original == null) return null;
  if (Array.isArray(original)) {
    if (!Array.isArray(output)) return 'an array was replaced by a non-array';
    for (const item of original) {
      const found = output.some((o) => JSON.stringify(o) === JSON.stringify(item));
      if (!found) return `array entry ${JSON.stringify(item)} disappeared`;
    }
    return null;
  }
  if (typeof original === 'object') {
    if (output == null || typeof output !== 'object' || Array.isArray(output))
      return 'an object was replaced by a non-object';
    for (const [key, value] of Object.entries(original as Record<string, unknown>)) {
      const reason = containedIn(value, (output as Record<string, unknown>)[key]);
      if (reason) return `${key}: ${reason}`;
    }
    return null;
  }
  if (typeof original === 'string' && typeof output === 'string') {
    return output === original || output.includes(original)
      ? null
      : `string value ${JSON.stringify(original.slice(0, 60))} disappeared`;
  }
  return Object.is(original, output) || String(original) === String(output)
    ? null
    : `value ${String(original)} changed`;
}

function assertAdditive(
  original: AdapterFileInput | undefined,
  output: AdapterOutputFile,
  format: string,
): string | null {
  if (!original || original.text == null) return null; // a new file is additive by definition
  if (format === 'prose') {
    const stripBlock = (t: string): string => {
      const block = extractManagedBlock(t);
      return block ? t.replace(block, '') : t;
    };
    return stripBlock(original.text).trim() === stripBlock(output.content).trim()
      ? null
      : 'prose outside the managed block changed';
  }
  try {
    const parse = (text: string): unknown => {
      if (format === 'json') return JSON.parse(text);
      const doc = parseYamlConfig(text);
      return doc.ok ? doc.doc.toJSON() : null;
    };
    return containedIn(parse(original.text), parse(output.content));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export function buildConfigPr(args: BuildConfigPrArgs): ConfigPrBuild | ConfigPrRefusal {
  const { intents, adapter, files } = args;
  if (intents.length === 0) {
    return { ok: false, status: 422, error: 'no live intents match the selected keys' };
  }
  // 1. The mandatory retro gate.
  for (const intent of intents) {
    if (intent.retro.applicable && !intent.retro.computable) {
      return {
        ok: false,
        status: 422,
        error: `retro-check not computable for ${intent.kind} (${intent.targetKey}) — ${intent.retro.disclosure}`,
      };
    }
  }
  // 2. Parse.
  const parsed = adapter.parse(files);
  if (!parsed.ok) {
    return { ok: false, status: 422, error: parsed.reason ?? 'config unreadable' };
  }
  // 3. Plan → serialize → validate.
  const plan = adapter.plan(intents, parsed.config);
  let outputs = adapter.serialize(plan);
  if (outputs.length === 0) {
    return { ok: false, status: 422, error: 'nothing to change (every intent was a noop)' };
  }
  // 5. Refined prose (client-supplied) re-passes the deterministic guard against OUR block.
  if (args.refinedByPath && args.guardRefined) {
    const guard = args.guardRefined;
    outputs = outputs.map((out) => {
      const refined = args.refinedByPath?.[out.path];
      if (!refined) return out;
      const templatedBlock = extractManagedBlock(out.content);
      if (!templatedBlock) return out; // no managed block → nothing refinable on this file
      const budget = out.path === COPILOT_PATH ? COPILOT_CHAR_BUDGET : undefined;
      const guarded = guard(templatedBlock, refined, {
        charBudget: budget != null ? budget - (out.content.length - templatedBlock.length) : undefined,
      });
      if (!guarded.ok) return out; // rejected → templated version ships (never an error)
      return { ...out, content: out.content.replace(templatedBlock, guarded.content) };
    });
  }
  const validated = adapter.validate(outputs);
  if (!validated.ok) {
    return { ok: false, status: 422, error: `emitted config failed validation: ${validated.errors.join('; ')}` };
  }
  // 4. The additive assert (after refine so the guard's replacement is covered too).
  for (const out of outputs) {
    const original = files.find((f) => f.path === out.path);
    const format =
      adapter.configTargets.find((t) => t.path === out.path)?.format ??
      (out.path.endsWith('.json') ? 'json' : out.path.endsWith('.md') ? 'prose' : 'yaml');
    const reason = assertAdditive(original, out, format);
    if (reason) {
      return { ok: false, status: 422, error: `non-additive edit on ${out.path}: ${reason}` };
    }
  }

  const branch = `limn/advisor/${slug(args.botLabel)}-${args.dateSlug}`;
  const title = `Tune ${args.botLabel}: ${intents.map((i) => i.kind.toLowerCase().replaceAll('_', ' ')).join(', ')}`;
  const bodyLines: string[] = [
    `Limn's Bot Tuning Advisor proposes these evidence-backed changes to ${args.botLabel}'s configuration.`,
    '',
    `Evidence window: ${args.windowLabel}. Every number is deterministic (thread states + ML labels); the recommendation text is templated, not model-generated.`,
    '',
  ];
  for (const intent of intents) {
    const e = intent.evidence;
    bodyLines.push(`### ${intent.kind} — \`${intent.targetKey}\``, '', intent.rationale, '');
    bodyLines.push(
      `- Evidence: ${e.volume} ${intent.kind === 'SUPPRESS_CATEGORY' || intent.kind === 'ESCALATE' ? 'findings' : 'threads'}, ${e.actedOn} acted on, ${e.untouched} untouched (${e.overdueUntouched} overdue${e.mergedUntouched > 0 ? `; ${e.mergedUntouched} shipped in PRs that merged anyway` : ''}).`,
    );
    if (intent.retro.applicable && intent.retro.computable) {
      bodyLines.push(
        `- Retro-check: this filter would also have hidden ${intent.retro.wouldHideActedOn} acted-on finding(s) (${intent.retro.wouldHideActedOnHigh} high-severity) of ${intent.retro.wouldHideTotal} matched. ${intent.retro.disclosure}`,
      );
    }
    if (e.pathCoveragePct != null) {
      bodyLines.push(
        `- Path coverage: ${e.pathCoveragePct}% of this bot's scored output carries a file path — path-keyed evidence describes only that share.`,
      );
    }
    bodyLines.push('');
  }
  const applied = plan.items as AdapterPlanItem[];
  const degraded = applied.filter((i) => i.status === 'degraded');
  if (degraded.length > 0) {
    bodyLines.push('#### Degraded expressions', '');
    for (const d of degraded) bodyLines.push(`- ${d.intentKind} (\`${d.targetKey}\`): ${d.note ?? 'emitted as prose'}`);
    bodyLines.push('');
  }
  bodyLines.push('---', `Opened by Limn against \`${args.repoFullName}\`. Review before merging — nothing auto-applies.`);

  return { ok: true, files: outputs, branch, title, body: bodyLines.join('\n'), applied };
}
