// Copilot code-review adapter — a prose.ts instance over `.github/copilot-instructions.md`.
// Copilot enforces a HARD ~4,000-character budget on the instructions file, computed against
// the WHOLE file (existing head-branch content + our managed block), so the budget handed to
// the block renderer is what remains after the user's own text — over budget, the renderer
// drops lowest-priority slots deterministically and the plan reports exactly which.
//
// SUPPRESS_PATH degrades to a path-scoped instruction file
// (.github/instructions/limn-advisor.instructions.md with `applyTo` frontmatter) — Copilot's
// own mechanism for per-path rules — leaving the main file's budget for the global slots.
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
import { renderManagedBlock, sentenceFor, upsertManagedBlock } from './prose.js';

export const COPILOT_PATH = '.github/copilot-instructions.md';
export const COPILOT_SCOPED_PATH = '.github/instructions/limn-advisor.instructions.md';
export const COPILOT_CHAR_BUDGET = 4000;

export interface CopilotConfig {
  mainText: string | null;
  scopedText: string | null;
}

interface PlanState {
  files: AdapterOutputFile[];
  changed: boolean;
}

const CAPABILITIES: Record<AdvisorIntentKind, IntentSupport> = {
  SUPPRESS_PATH: {
    level: 'degraded',
    alternative:
      'Copilot has no path filter — emitted as a path-scoped instructions file (applyTo frontmatter).',
  },
  QUIET_PATH_NITS: { level: 'expressible' },
  SUPPRESS_CATEGORY: { level: 'expressible' },
  LOWER_VERBOSITY: { level: 'expressible' },
  SCOPE_OFF: {
    level: 'degraded',
    alternative: 'No pair-level key exists — emitted as a prose instruction.',
  },
  AMPLIFY_PATH: { level: 'expressible' },
  ESCALATE: { level: 'expressible' },
  PROMOTE_TO_LINT: { level: 'unsupported' },
  BOOTSTRAP_CONFIG: { level: 'expressible' },
};

export const copilotProseAdapter: BotAdapter<CopilotConfig, PlanState> = {
  key: 'copilot',
  displayName: 'Copilot code review',
  capabilities: CAPABILITIES,
  configTargets: [
    { path: COPILOT_PATH, format: 'prose' },
    { path: COPILOT_SCOPED_PATH, format: 'prose' },
  ],

  parse(files: AdapterFileInput[]): ParseResult<CopilotConfig> {
    const main = files.find((f) => f.path === COPILOT_PATH)?.text ?? null;
    const scoped = files.find((f) => f.path === COPILOT_SCOPED_PATH)?.text ?? null;
    for (const [path, text] of [
      [COPILOT_PATH, main],
      [COPILOT_SCOPED_PATH, scoped],
    ] as const) {
      if (text != null && text.length > MAX_CONFIG_BYTES) {
        return {
          ok: false,
          reason: `${path} exceeds ${MAX_CONFIG_BYTES} bytes — refusing to edit`,
          config: { mainText: null, scopedText: null },
        };
      }
    }
    return { ok: true, config: { mainText: main, scopedText: scoped } };
  },

  plan(intents: AdvisorIntentWire[], current: CopilotConfig): AdapterPlan<PlanState> {
    const items: AdapterPlanItem[] = [];
    const item = (
      intent: AdvisorIntentWire,
      status: AdapterPlanItem['status'],
      note?: string,
    ): void => {
      items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status, note });
    };

    const pathIntents = intents.filter((i) => i.kind === 'SUPPRESS_PATH');
    const globalIntents = intents.filter(
      (i) => i.kind !== 'SUPPRESS_PATH' && i.kind !== 'PROMOTE_TO_LINT',
    );
    for (const intent of intents.filter((i) => i.kind === 'PROMOTE_TO_LINT')) {
      item(intent, 'unsupported', 'a lint rule is not Copilot configuration');
    }

    const files: AdapterOutputFile[] = [];
    let changed = false;

    // ── Main instructions file: the 4,000-char budget is over the WHOLE file. ───────────
    if (globalIntents.length > 0) {
      const userText = current.mainText ?? '';
      const overhead = userText.length === 0 ? 1 : userText.length + 2; // upsert separators
      const blockBudget = Math.max(0, COPILOT_CHAR_BUDGET - overhead);
      const render = renderManagedBlock(globalIntents, blockBudget);
      const upserted = upsertManagedBlock(current.mainText, render.block);
      if (!upserted.ok) {
        for (const intent of globalIntents) item(intent, 'unsupported', upserted.reason);
      } else {
        for (const intent of render.included) {
          const cap = CAPABILITIES[intent.kind];
          item(
            intent,
            cap.level === 'degraded' ? 'degraded' : 'applied',
            cap.level === 'degraded' ? cap.alternative : undefined,
          );
        }
        for (const intent of render.dropped) {
          item(
            intent,
            'unsupported',
            `dropped: over the ${COPILOT_CHAR_BUDGET}-char Copilot budget (file has ${userText.length} chars of existing content)`,
          );
        }
        if (render.included.length > 0 && upserted.content !== current.mainText) {
          files.push({ path: COPILOT_PATH, content: upserted.content });
          changed = true;
        }
      }
    }

    // ── Path suppressions → the scoped instructions file. ───────────────────────────────
    if (pathIntents.length > 0) {
      const globs = pathIntents.map((i) => i.targetKey);
      const body = [
        '---',
        `applyTo: "${globs.join(',')}"`,
        '---',
        ...pathIntents.map((i) => `- ${sentenceFor(i)}`),
      ].join('\n');
      const upserted = upsertManagedBlock(null, body);
      if (upserted.ok && upserted.content !== (current.scopedText ?? undefined)) {
        files.push({ path: COPILOT_SCOPED_PATH, content: upserted.content });
        changed = true;
      }
      for (const intent of pathIntents) {
        item(intent, 'degraded', (CAPABILITIES.SUPPRESS_PATH as { alternative: string }).alternative);
      }
    }

    return { items, state: { files, changed } };
  },

  serialize(plan: AdapterPlan<PlanState>): AdapterOutputFile[] {
    return plan.state.changed ? plan.state.files : [];
  },

  validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const f of files) {
      if (f.path === COPILOT_PATH && f.content.length > COPILOT_CHAR_BUDGET) {
        errors.push(
          `${f.path}: ${f.content.length} chars exceeds Copilot's ${COPILOT_CHAR_BUDGET}-char budget`,
        );
      }
    }
    return { ok: errors.length === 0, errors };
  },
};
