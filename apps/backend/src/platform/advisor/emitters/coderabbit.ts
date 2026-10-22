// CodeRabbit adapter — `.coderabbit.yaml` via the eemeli Document API (comments / ordering /
// anchors preserved: the hard requirement for editing a hand-written config). Key mapping:
//   SUPPRESS_PATH      → reviews.path_filters  gains "!<glob>"          (expressible)
//   QUIET_PATH_NITS    → reviews.path_instructions[] entry for the glob (expressible)
//   SUPPRESS_CATEGORY  → reviews.path_instructions[] entry, path '**'   (expressible)
//   AMPLIFY_PATH       → reviews.path_instructions[] entry for the glob (expressible)
//   ESCALATE           → reviews.path_instructions[] entry, path '**'   (expressible)
//   LOWER_VERBOSITY    → reviews.profile: 'chill' when UNSET; a user-set profile is never
//                        overwritten — degrade to a path_instructions sentence instead
//   SCOPE_OFF          → degraded (no pair-level key exists) — prose instruction
//   BOOTSTRAP_CONFIG   → minimal file from template
//   PROMOTE_TO_LINT    → unsupported (a lint rule is not CodeRabbit config)
//
// Validation is structural (top-level map, our entries present after a re-parse). The
// vendored-JSON-schema/ajv pass the plan sketched is deliberately not implemented: our edits
// are additive into the USER'S file, whose validity is not ours to adjudicate, and the
// round-trip fixtures pin the property that actually protects them (bytes we didn't touch
// survive). Revisit if a real config PR is ever rejected by CodeRabbit's own validator.
import type { AdvisorIntentKind, AdvisorIntentWire } from '@pierre-review/shared';
import type { Document } from 'yaml';
import type {
  AdapterFileInput,
  AdapterOutputFile,
  AdapterPlan,
  AdapterPlanItem,
  BotAdapter,
  IntentSupport,
  ParseResult,
} from './adapter.js';
import { MAX_CONFIG_BYTES } from './adapter.js';
import {
  appendUniqueString,
  docToString,
  emptyYamlDoc,
  ensureSeqAt,
  parseYamlConfig,
  scalarAt,
  setScalar,
} from './yaml-doc.js';
import { sentenceFor } from './prose.js';

export const CODERABBIT_PATH = '.coderabbit.yaml';

const BOOTSTRAP_TEMPLATE = `# CodeRabbit configuration — bootstrapped by Limn's Bot Tuning Advisor.
# Reference: https://docs.coderabbit.ai/reference/configuration
language: en-US
reviews:
  profile: chill
  path_filters: []
  path_instructions: []
`;

export interface CodeRabbitConfig {
  present: boolean;
  doc: Document;
}

interface PlanState {
  doc: Document;
  changed: boolean;
}

const CAPABILITIES: Record<AdvisorIntentKind, IntentSupport> = {
  SUPPRESS_PATH: { level: 'expressible' },
  QUIET_PATH_NITS: { level: 'expressible' },
  SUPPRESS_CATEGORY: { level: 'expressible' },
  LOWER_VERBOSITY: { level: 'expressible' },
  SCOPE_OFF: {
    level: 'degraded',
    alternative: 'No pair-level scope key exists — emitted as a review instruction.',
  },
  AMPLIFY_PATH: { level: 'expressible' },
  ESCALATE: { level: 'expressible' },
  PROMOTE_TO_LINT: { level: 'unsupported' },
  BOOTSTRAP_CONFIG: { level: 'expressible' },
};

// Append a {path, instructions} entry to reviews.path_instructions unless an identical
// instructions string is already present (idempotent re-runs report 'noop').
function appendPathInstruction(
  doc: Document,
  path: string,
  instructions: string,
): 'applied' | 'noop' | null {
  const seq = ensureSeqAt(doc, ['reviews'], 'path_instructions');
  if (!seq) return null;
  for (const item of seq.items) {
    const json = (item as { toJSON?: () => unknown }).toJSON?.();
    if (
      json &&
      typeof json === 'object' &&
      (json as { instructions?: unknown }).instructions === instructions
    )
      return 'noop';
  }
  // Same rule as appendUniqueString: an empty `[]` unflows before the first entry (flow
  // maps render as an unreadable one-liner; nothing existing is reformatted).
  if (seq.items.length === 0) seq.flow = false;
  seq.add(doc.createNode({ path, instructions }));
  return 'applied';
}

export const coderabbitAdapter: BotAdapter<CodeRabbitConfig, PlanState> = {
  key: 'coderabbit',
  displayName: 'CodeRabbit',
  capabilities: CAPABILITIES,
  configTargets: [{ path: CODERABBIT_PATH, format: 'yaml' }],

  parse(files: AdapterFileInput[]): ParseResult<CodeRabbitConfig> {
    const file = files.find((f) => f.path === CODERABBIT_PATH);
    if (!file || file.text == null) {
      return { ok: true, config: { present: false, doc: emptyYamlDoc() } };
    }
    if (file.text.length > MAX_CONFIG_BYTES) {
      return {
        ok: false,
        reason: `.coderabbit.yaml exceeds ${MAX_CONFIG_BYTES} bytes — refusing to edit`,
        config: { present: true, doc: emptyYamlDoc() },
      };
    }
    const parsed = parseYamlConfig(file.text);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason, config: { present: true, doc: emptyYamlDoc() } };
    }
    return { ok: true, config: { present: true, doc: parsed.doc } };
  },

  plan(intents: AdvisorIntentWire[], current: CodeRabbitConfig): AdapterPlan<PlanState> {
    // An absent file starts from the bootstrap template so every other intent lands in a
    // real document (BOOTSTRAP_CONFIG is implicit whenever the file is missing).
    let doc = current.doc;
    let changed = false;
    if (!current.present) {
      const boot = parseYamlConfig(BOOTSTRAP_TEMPLATE);
      doc = boot.ok ? boot.doc : emptyYamlDoc();
      changed = true;
    }
    const items: AdapterPlanItem[] = [];
    const item = (
      intent: AdvisorIntentWire,
      status: AdapterPlanItem['status'],
      note?: string,
    ): void => {
      items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status, note });
    };

    for (const intent of intents) {
      switch (intent.kind) {
        case 'SUPPRESS_PATH': {
          const seq = ensureSeqAt(doc, ['reviews'], 'path_filters');
          if (!seq) {
            item(intent, 'unsupported', 'reviews.path_filters is not a list in this config');
            break;
          }
          const added = appendUniqueString(doc, seq, `!${intent.targetKey}`);
          changed = changed || added;
          item(intent, added ? 'applied' : 'noop', added ? undefined : 'filter already present');
          break;
        }
        case 'SUPPRESS_CATEGORY':
        case 'ESCALATE': {
          const status = appendPathInstruction(doc, '**', sentenceFor(intent));
          if (status == null) {
            item(intent, 'unsupported', 'reviews.path_instructions is not a list in this config');
            break;
          }
          changed = changed || status === 'applied';
          item(intent, status);
          break;
        }
        case 'AMPLIFY_PATH':
        case 'QUIET_PATH_NITS': {
          const status = appendPathInstruction(doc, intent.targetKey, sentenceFor(intent));
          if (status == null) {
            item(intent, 'unsupported', 'reviews.path_instructions is not a list in this config');
            break;
          }
          changed = changed || status === 'applied';
          item(intent, status);
          break;
        }
        case 'LOWER_VERBOSITY': {
          const profile = scalarAt(doc, ['reviews'], 'profile');
          if (profile == null) {
            const set = setScalar(doc, ['reviews'], 'profile', 'chill');
            changed = changed || set;
            item(intent, set ? 'applied' : 'unsupported');
          } else if (profile === 'chill') {
            item(intent, 'noop', 'profile is already chill');
          } else {
            // The user chose a profile — never overwrite a user value; degrade to prose.
            const status = appendPathInstruction(doc, '**', sentenceFor(intent));
            changed = changed || status === 'applied';
            item(
              intent,
              'degraded',
              `profile is user-set to '${profile}' — added a severity-floor instruction instead`,
            );
          }
          break;
        }
        case 'SCOPE_OFF': {
          const status = appendPathInstruction(doc, '**', sentenceFor(intent));
          changed = changed || status === 'applied';
          item(intent, 'degraded', CAPABILITIES.SCOPE_OFF.level === 'degraded' ? (CAPABILITIES.SCOPE_OFF as { alternative: string }).alternative : undefined);
          break;
        }
        case 'BOOTSTRAP_CONFIG': {
          item(intent, current.present ? 'noop' : 'applied', current.present ? 'config already exists' : undefined);
          break;
        }
        case 'PROMOTE_TO_LINT':
          item(intent, 'unsupported', 'a lint rule is not CodeRabbit configuration');
          break;
      }
    }
    return { items, state: { doc, changed } };
  },

  serialize(plan: AdapterPlan<PlanState>): AdapterOutputFile[] {
    if (!plan.state.changed && plan.items.every((i) => i.status === 'noop')) return [];
    return [{ path: CODERABBIT_PATH, content: docToString(plan.state.doc) }];
  },

  validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const f of files) {
      const parsed = parseYamlConfig(f.content);
      if (!parsed.ok) {
        errors.push(`${f.path}: ${parsed.reason}`);
        continue;
      }
      const json = parsed.doc.toJSON() as unknown;
      if (json == null || typeof json !== 'object' || Array.isArray(json)) {
        errors.push(`${f.path}: top level must be a mapping`);
      }
    }
    return { ok: errors.length === 0, errors };
  },
};
