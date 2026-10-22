// T3 manifest interpreter — executes a CONFIRMED `.limn/bot-adapter.yml`-shaped manifest
// ({format, configPath, per-intent keyPath + valueTemplate + listMode}) against an unknown
// bot's config file. Inference lives discovery-side; this module only EXECUTES manifests the
// user confirmed — an unconfirmed (inferred) manifest is advisory-only, and the config-PR
// route enforces that upstream. Never open a PR for a guessed schema.
//
// Validation is a hand-rolled structural validator — deliberately NOT ajv: the settings-body
// precedent's `removeAdditional: true` trap (a validator that silently REWRITES its input)
// is impossible when the validator can only accept or reject. Unknown keys are rejected.
import type { AdvisorIntentKind, AdvisorIntentWire } from '@pierre-review/shared';
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
  setScalar,
} from './yaml-doc.js';
import { sentenceFor } from './prose.js';
import type { Document } from 'yaml';

const INTENT_KINDS: AdvisorIntentKind[] = [
  'SUPPRESS_PATH',
  'QUIET_PATH_NITS',
  'SUPPRESS_CATEGORY',
  'LOWER_VERBOSITY',
  'SCOPE_OFF',
  'AMPLIFY_PATH',
  'ESCALATE',
  'PROMOTE_TO_LINT',
  'BOOTSTRAP_CONFIG',
];

export interface ManifestRule {
  keyPath: string[]; // where in the config the value goes
  // '{target}' expands to the intent's targetKey; '{sentence}' to the templated phrasing.
  valueTemplate: string;
  listMode: 'append' | 'set';
}

export interface AdapterManifest {
  format: 'yaml' | 'json' | 'prose';
  configPath: string;
  intents: Partial<Record<AdvisorIntentKind, ManifestRule>>;
}

const MANIFEST_KEYS = new Set(['format', 'configPath', 'intents']);
const RULE_KEYS = new Set(['keyPath', 'valueTemplate', 'listMode']);

export function validateManifest(raw: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be an object'] };
  }
  const m = raw as Record<string, unknown>;
  for (const key of Object.keys(m)) {
    if (!MANIFEST_KEYS.has(key)) errors.push(`unknown key: ${key}`);
  }
  if (m.format !== 'yaml' && m.format !== 'json' && m.format !== 'prose') {
    errors.push("format must be 'yaml' | 'json' | 'prose'");
  }
  if (typeof m.configPath !== 'string' || m.configPath.length === 0) {
    errors.push('configPath must be a non-empty string');
  } else if (
    m.configPath.startsWith('/') ||
    m.configPath.split('/').some((s) => s === '' || s === '.' || s === '..') ||
    m.configPath.startsWith('.git/') ||
    m.configPath.startsWith('.github/workflows/')
  ) {
    errors.push('configPath must be repo-relative, no traversal, never under .github/workflows/');
  }
  if (m.intents == null || typeof m.intents !== 'object' || Array.isArray(m.intents)) {
    errors.push('intents must be an object');
  } else {
    for (const [kind, rule] of Object.entries(m.intents as Record<string, unknown>)) {
      if (!INTENT_KINDS.includes(kind as AdvisorIntentKind)) {
        errors.push(`intents.${kind}: unknown intent kind`);
        continue;
      }
      if (rule == null || typeof rule !== 'object' || Array.isArray(rule)) {
        errors.push(`intents.${kind}: must be an object`);
        continue;
      }
      const r = rule as Record<string, unknown>;
      for (const key of Object.keys(r)) {
        if (!RULE_KEYS.has(key)) errors.push(`intents.${kind}.${key}: unknown key`);
      }
      if (
        !Array.isArray(r.keyPath) ||
        r.keyPath.length === 0 ||
        r.keyPath.some((k) => typeof k !== 'string' || k.length === 0)
      ) {
        errors.push(`intents.${kind}.keyPath: must be a non-empty string array`);
      }
      if (typeof r.valueTemplate !== 'string' || r.valueTemplate.length === 0) {
        errors.push(`intents.${kind}.valueTemplate: must be a non-empty string`);
      }
      if (r.listMode !== 'append' && r.listMode !== 'set') {
        errors.push(`intents.${kind}.listMode: must be 'append' | 'set'`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function parseManifest(json: string): { ok: true; manifest: AdapterManifest } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const v = validateManifest(raw);
  if (!v.ok) return { ok: false, errors: v.errors };
  return { ok: true, manifest: raw as AdapterManifest };
}

const expand = (template: string, intent: AdvisorIntentWire): string =>
  template.replaceAll('{target}', intent.targetKey).replaceAll('{sentence}', sentenceFor(intent));

interface ManifestParsed {
  present: boolean;
  yamlDoc: Document | null; // format yaml
  jsonData: Record<string, unknown> | null; // format json
  proseText: string | null; // format prose
}

interface PlanState {
  manifest: AdapterManifest;
  parsed: ManifestParsed;
  changed: boolean;
}

// Build a one-bot adapter from a CONFIRMED manifest. `capabilities` derive from which
// intents the manifest maps; everything unmapped is unsupported.
export function manifestAdapter(manifest: AdapterManifest): BotAdapter<ManifestParsed, PlanState> {
  const capabilities = Object.fromEntries(
    INTENT_KINDS.map((kind) => [
      kind,
      manifest.intents[kind] ? { level: 'expressible' } : { level: 'unsupported' },
    ]),
  ) as Record<AdvisorIntentKind, IntentSupport>;

  return {
    key: `manifest:${manifest.configPath}`,
    displayName: `Manifest (${manifest.configPath})`,
    capabilities,
    configTargets: [{ path: manifest.configPath, format: manifest.format }],

    parse(files: AdapterFileInput[]): ParseResult<ManifestParsed> {
      const empty: ManifestParsed = { present: false, yamlDoc: null, jsonData: null, proseText: null };
      const file = files.find((f) => f.path === manifest.configPath);
      if (!file || file.text == null) return { ok: true, config: empty };
      if (file.text.length > MAX_CONFIG_BYTES) {
        return { ok: false, reason: `${manifest.configPath} exceeds ${MAX_CONFIG_BYTES} bytes`, config: empty };
      }
      if (manifest.format === 'yaml') {
        const parsed = parseYamlConfig(file.text);
        if (!parsed.ok) return { ok: false, reason: parsed.reason, config: empty };
        return { ok: true, config: { ...empty, present: true, yamlDoc: parsed.doc } };
      }
      if (manifest.format === 'json') {
        try {
          const data: unknown = JSON.parse(file.text);
          if (data == null || typeof data !== 'object' || Array.isArray(data)) {
            return { ok: false, reason: 'top level must be an object', config: empty };
          }
          return { ok: true, config: { ...empty, present: true, jsonData: data as Record<string, unknown> } };
        } catch (err) {
          return { ok: false, reason: err instanceof Error ? err.message : String(err), config: empty };
        }
      }
      return { ok: true, config: { ...empty, present: true, proseText: file.text } };
    },

    plan(intents: AdvisorIntentWire[], current: ManifestParsed): AdapterPlan<PlanState> {
      const items: AdapterPlanItem[] = [];
      const parsed: ManifestParsed = {
        present: current.present,
        yamlDoc: manifest.format === 'yaml' ? (current.yamlDoc ?? emptyYamlDoc()) : null,
        jsonData: manifest.format === 'json' ? { ...(current.jsonData ?? {}) } : null,
        proseText: current.proseText,
      };
      let changed = false;
      for (const intent of intents) {
        const rule = manifest.intents[intent.kind];
        if (!rule) {
          items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'unsupported', note: 'not mapped by the manifest' });
          continue;
        }
        const value = expand(rule.valueTemplate, intent);
        if (manifest.format === 'yaml' && parsed.yamlDoc) {
          const doc = parsed.yamlDoc;
          if (rule.listMode === 'append') {
            const seq = ensureSeqAt(doc, rule.keyPath.slice(0, -1), rule.keyPath[rule.keyPath.length - 1]!);
            if (!seq) {
              items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'unsupported', note: 'keyPath is not a list in this config' });
              continue;
            }
            const added = appendUniqueString(doc, seq, value);
            changed = changed || added;
            items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: added ? 'applied' : 'noop' });
          } else {
            const ok = setScalar(doc, rule.keyPath.slice(0, -1), rule.keyPath[rule.keyPath.length - 1]!, value);
            changed = changed || ok;
            items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: ok ? 'applied' : 'unsupported' });
          }
        } else if (manifest.format === 'json' && parsed.jsonData) {
          let node: Record<string, unknown> = parsed.jsonData;
          let broken = false;
          for (const key of rule.keyPath.slice(0, -1)) {
            const next = node[key];
            if (next == null) {
              const created: Record<string, unknown> = {};
              node[key] = created;
              node = created;
            } else if (typeof next === 'object' && !Array.isArray(next)) {
              node = next as Record<string, unknown>;
            } else {
              broken = true;
              break;
            }
          }
          const leaf = rule.keyPath[rule.keyPath.length - 1]!;
          if (broken) {
            items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'unsupported', note: 'keyPath collides with a non-object value' });
          } else if (rule.listMode === 'append') {
            const arr = Array.isArray(node[leaf]) ? (node[leaf] as unknown[]) : [];
            if (arr.includes(value)) {
              items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'noop' });
            } else {
              node[leaf] = [...arr, value];
              changed = true;
              items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'applied' });
            }
          } else {
            node[leaf] = value;
            changed = true;
            items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'applied' });
          }
        } else {
          // prose format → the caller should use prose.ts directly; mark degraded.
          items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'degraded', note: 'prose-format manifest — use the prose emitter' });
        }
      }
      return { items, state: { manifest, parsed, changed } };
    },

    serialize(plan: AdapterPlan<PlanState>): AdapterOutputFile[] {
      if (!plan.state.changed) return [];
      const { manifest: m, parsed } = plan.state;
      if (m.format === 'yaml' && parsed.yamlDoc) {
        return [{ path: m.configPath, content: docToString(parsed.yamlDoc) }];
      }
      if (m.format === 'json' && parsed.jsonData) {
        return [{ path: m.configPath, content: `${JSON.stringify(parsed.jsonData, null, 2)}\n` }];
      }
      return [];
    },

    validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] } {
      const errors: string[] = [];
      for (const f of files) {
        if (manifest.format === 'yaml') {
          const parsed = parseYamlConfig(f.content);
          if (!parsed.ok) errors.push(`${f.path}: ${parsed.reason}`);
        } else if (manifest.format === 'json') {
          try {
            JSON.parse(f.content);
          } catch (err) {
            errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      return { ok: errors.length === 0, errors };
    },
  };
}
