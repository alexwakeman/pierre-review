// Greptile adapter — `greptile.json` (hand-maintained: Greptile publishes NO schema, the
// asymmetry the brief flags; the key vocabulary below is from their docs and verified
// against real-world configs, not a spec). JSON merge preserves KEY ORDER and the file's
// detected indent; validation is re-parse + the round-trip fixtures.
//
//   SUPPRESS_PATH      → ignorePatterns[] gains the glob (gitignore syntax)  (expressible)
//   PROMOTE_TO_LINT    → ignoreKeywords[] gains the template's leading words (degraded)
//   LOWER_VERBOSITY /
//   SUPPRESS_CATEGORY /
//   ESCALATE / SCOPE_OFF / AMPLIFY_PATH → `instructions` prose (the managed marker block —
//     Greptile's own docs route behavioral tuning through instructions text)
//   BOOTSTRAP_CONFIG   → minimal file from template
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
import { renderManagedBlock, upsertManagedBlock } from './prose.js';

export const GREPTILE_PATH = 'greptile.json';

export interface GreptileConfig {
  present: boolean;
  // The parsed object with key order preserved (JSON.parse insertion order).
  data: Record<string, unknown>;
  // Detected indentation of the original file ('  ' default).
  indent: string;
  trailingNewline: boolean;
}

interface PlanState {
  config: GreptileConfig;
  proseIntents: AdvisorIntentWire[];
  changed: boolean;
}

const CAPABILITIES: Record<AdvisorIntentKind, IntentSupport> = {
  SUPPRESS_PATH: { level: 'expressible' },
  QUIET_PATH_NITS: {
    level: 'degraded',
    alternative: 'No per-path severity key exists — emitted into the instructions text.',
  },
  SUPPRESS_CATEGORY: {
    level: 'degraded',
    alternative: 'No category key exists — emitted into the instructions text.',
  },
  LOWER_VERBOSITY: {
    level: 'degraded',
    alternative: 'No severity-floor key exists — emitted into the instructions text.',
  },
  SCOPE_OFF: {
    level: 'degraded',
    alternative: 'No pair-level key exists — emitted into the instructions text.',
  },
  AMPLIFY_PATH: {
    level: 'degraded',
    alternative: 'No per-path emphasis key exists — emitted into the instructions text.',
  },
  ESCALATE: {
    level: 'degraded',
    alternative: 'No ranking key exists — emitted into the instructions text.',
  },
  PROMOTE_TO_LINT: {
    level: 'degraded',
    alternative: 'The rule template joins ignoreKeywords so Greptile stops repeating it.',
  },
  BOOTSTRAP_CONFIG: { level: 'expressible' },
};

function detectIndent(text: string): string {
  const m = /\n([ \t]+)"/.exec(text);
  return m?.[1] ?? '  ';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export const greptileAdapter: BotAdapter<GreptileConfig, PlanState> = {
  key: 'greptile',
  displayName: 'Greptile',
  capabilities: CAPABILITIES,
  configTargets: [{ path: GREPTILE_PATH, format: 'json' }],

  parse(files: AdapterFileInput[]): ParseResult<GreptileConfig> {
    const empty: GreptileConfig = { present: false, data: {}, indent: '  ', trailingNewline: true };
    const file = files.find((f) => f.path === GREPTILE_PATH);
    if (!file || file.text == null) return { ok: true, config: empty };
    if (file.text.length > MAX_CONFIG_BYTES) {
      return { ok: false, reason: `greptile.json exceeds ${MAX_CONFIG_BYTES} bytes`, config: empty };
    }
    try {
      const data: unknown = JSON.parse(file.text);
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, reason: 'greptile.json top level must be an object', config: empty };
      }
      return {
        ok: true,
        config: {
          present: true,
          data: data as Record<string, unknown>,
          indent: detectIndent(file.text),
          trailingNewline: file.text.endsWith('\n'),
        },
      };
    } catch (err) {
      return {
        ok: false,
        reason: `greptile.json parse error: ${err instanceof Error ? err.message : String(err)}`,
        config: empty,
      };
    }
  },

  plan(intents: AdvisorIntentWire[], current: GreptileConfig): AdapterPlan<PlanState> {
    // Shallow-clone so parse() results stay reusable; key order carries over.
    const data: Record<string, unknown> = { ...current.data };
    const items: AdapterPlanItem[] = [];
    const proseIntents: AdvisorIntentWire[] = [];
    let changed = !current.present;
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
          const patterns = stringArray(data.ignorePatterns);
          if (patterns.includes(intent.targetKey)) {
            item(intent, 'noop', 'pattern already present');
          } else {
            data.ignorePatterns = [...patterns, intent.targetKey];
            changed = true;
            item(intent, 'applied');
          }
          break;
        }
        case 'PROMOTE_TO_LINT': {
          const keywords = stringArray(data.ignoreKeywords);
          const keyword = intent.targetKey.trim();
          if (keywords.includes(keyword)) {
            item(intent, 'noop', 'keyword already present');
          } else {
            data.ignoreKeywords = [...keywords, keyword];
            changed = true;
            item(intent, 'degraded', (CAPABILITIES.PROMOTE_TO_LINT as { alternative: string }).alternative);
          }
          break;
        }
        case 'BOOTSTRAP_CONFIG':
          item(intent, current.present ? 'noop' : 'applied', current.present ? 'config already exists' : undefined);
          break;
        default: {
          // Everything else routes through the instructions prose (managed marker block).
          proseIntents.push(intent);
          const cap = CAPABILITIES[intent.kind];
          item(
            intent,
            'degraded',
            cap.level === 'degraded' ? cap.alternative : 'emitted into the instructions text',
          );
          break;
        }
      }
    }

    if (proseIntents.length > 0) {
      const existing = typeof data.instructions === 'string' ? data.instructions : null;
      const render = renderManagedBlock(proseIntents);
      const upserted = upsertManagedBlock(existing, render.block);
      if (upserted.ok) {
        if (upserted.content !== existing) {
          data.instructions = upserted.content;
          changed = true;
        }
      } else {
        // A malformed marker block is a refusal for the prose half only — mark those
        // intents unsupported rather than eating user text.
        for (const it of items) {
          if (proseIntents.some((p) => p.kind === it.intentKind && p.targetKey === it.targetKey)) {
            it.status = 'unsupported';
            it.note = upserted.reason;
          }
        }
      }
    }

    return {
      items,
      state: { config: { ...current, data }, proseIntents, changed },
    };
  },

  serialize(plan: AdapterPlan<PlanState>): AdapterOutputFile[] {
    if (!plan.state.changed) return [];
    const { data, indent, trailingNewline } = plan.state.config;
    const text = JSON.stringify(data, null, indent) + (trailingNewline ? '\n' : '');
    return [{ path: GREPTILE_PATH, content: text }];
  },

  validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const f of files) {
      try {
        const parsed: unknown = JSON.parse(f.content);
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          errors.push(`${f.path}: top level must be an object`);
        }
      } catch (err) {
        errors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { ok: errors.length === 0, errors };
  },
};
