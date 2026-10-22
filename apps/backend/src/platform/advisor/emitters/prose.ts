// The general PROSE emitter (T4) — for any bot whose configuration is an instruction file
// (Copilot instructions, an in-house agent's prompt md, an LLM-in-a-workflow bot's system
// file). Owns ONE managed marker block and never touches a byte outside it:
//
//   <!-- limn:advisor:start -->
//   <!-- limn:advisor:intents: SUPPRESS_PATH|src/** LOWER_VERBOSITY|nit -->
//   …templated sentences (taxonomy slots)…
//   <!-- limn:advisor:end -->
//
// The intents header line is VERBATIM-structured (the diff-guard re-parses it after a
// refine), and the sentences are the taxonomy's canonical phrasings — deterministic in,
// deterministic out. An optional char budget drops the LOWEST-priority slots
// deterministically and reports exactly which were dropped.
import type { AdvisorIntentKind, AdvisorIntentWire } from '@pierre-review/shared';
import { CATEGORY_PHRASING, SEVERITY_FLOOR_PHRASING } from '../taxonomy.js';
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

export const MARKER_START = '<!-- limn:advisor:start -->';
export const MARKER_END = '<!-- limn:advisor:end -->';
export const INTENTS_HEADER_PREFIX = '<!-- limn:advisor:intents:';

// Priority for budget drops: suppressions first (they are why the user is here), the
// severity floor next, then escalations/amplifications, then the pair/lint advisories.
const PRIORITY: AdvisorIntentKind[] = [
  'SUPPRESS_PATH',
  'QUIET_PATH_NITS',
  'SUPPRESS_CATEGORY',
  'LOWER_VERBOSITY',
  'ESCALATE',
  'AMPLIFY_PATH',
  'SCOPE_OFF',
  'PROMOTE_TO_LINT',
  'BOOTSTRAP_CONFIG',
];

export function sentenceFor(intent: AdvisorIntentWire): string {
  switch (intent.kind) {
    case 'SUPPRESS_PATH':
      return `Do not review files under \`${intent.targetKey}\` — findings there consistently go unaddressed here.`;
    case 'QUIET_PATH_NITS':
      return `In \`${intent.targetKey}\`, do not post nitpick-level comments — raise only findings of minor severity and above there.`;
    case 'SUPPRESS_CATEGORY': {
      const t = intent.target;
      const neg =
        t.kind === 'category' ? CATEGORY_PHRASING[t.category].negative : undefined;
      return neg ?? `Do not raise ${intent.targetKey} findings.`;
    }
    case 'LOWER_VERBOSITY':
      return SEVERITY_FLOOR_PHRASING.negative;
    case 'ESCALATE': {
      const t = intent.target;
      const pos =
        t.kind === 'category' ? CATEGORY_PHRASING[t.category].positive : undefined;
      return pos ?? `Prioritize ${intent.targetKey} findings.`;
    }
    case 'AMPLIFY_PATH':
      return `Review files under \`${intent.targetKey}\` with extra depth — findings there are consistently acted on.`;
    case 'SCOPE_OFF': {
      const partner =
        intent.target.kind === 'partner' ? intent.target.partnerLabel : 'another reviewer';
      return `Skip findings that ${partner} also raises (overlapping line coverage); focus where you are the only reviewer.`;
    }
    case 'PROMOTE_TO_LINT':
      return `Do not flag "${intent.targetKey}" — it is being promoted to a deterministic lint rule.`;
    case 'BOOTSTRAP_CONFIG':
      return 'This instruction block was bootstrapped by Limn; tune the sentences above as the evidence changes.';
  }
}

export interface ProseRender {
  block: string;
  included: AdvisorIntentWire[];
  dropped: AdvisorIntentWire[]; // lowest-priority first — report these, never silently cap
}

const headerLine = (intents: AdvisorIntentWire[]): string =>
  `${INTENTS_HEADER_PREFIX} ${intents.map((i) => `${i.kind}|${i.targetKey}`).join(' ')} -->`;

const assemble = (intents: AdvisorIntentWire[]): string =>
  [
    MARKER_START,
    headerLine(intents),
    '',
    ...intents.map((i) => `- ${sentenceFor(i)}`),
    '',
    MARKER_END,
  ].join('\n');

// Render the managed block. `budget` is the max length of the BLOCK (the caller subtracts
// whatever else shares the file's budget); over budget ⇒ drop lowest-priority intents one
// at a time, deterministically.
export function renderManagedBlock(
  intents: AdvisorIntentWire[],
  budget?: number,
): ProseRender {
  const ordered = [...intents].sort(
    (a, b) =>
      PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) ||
      a.targetKey.localeCompare(b.targetKey),
  );
  const included = [...ordered];
  const dropped: AdvisorIntentWire[] = [];
  let block = assemble(included);
  if (budget != null) {
    while (included.length > 0 && block.length > budget) {
      dropped.unshift(included.pop()!);
      block = assemble(included);
    }
  }
  return { block, included, dropped };
}

// Replace an existing managed block in `text`, or append one (blank-line separated). Never
// touches a byte outside the markers; a malformed half-block (start without end) is a
// refusal — overwriting it could eat user content.
export function upsertManagedBlock(
  text: string | null,
  block: string,
): { ok: true; content: string } | { ok: false; reason: string } {
  if (text == null || text.trim() === '') return { ok: true, content: `${block}\n` };
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start === -1 && end === -1) {
    const sep = text.endsWith('\n') ? '\n' : '\n\n';
    return { ok: true, content: `${text}${sep}${block}\n` };
  }
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, reason: 'malformed limn:advisor marker block — refusing to edit' };
  }
  return {
    ok: true,
    content: text.slice(0, start) + block + text.slice(end + MARKER_END.length),
  };
}

export function extractManagedBlock(text: string): string | null {
  const start = text.indexOf(MARKER_START);
  const end = text.indexOf(MARKER_END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start, end + MARKER_END.length);
}

// ── The generic prose ADAPTER factory (T4) ──────────────────────────────────────────────────
// For a bot whose profile names a prose configPath (an in-house agent's prompt md, an
// LLM-in-a-workflow bot's instruction file): every intent lands in the managed block; no
// budget unless the caller supplies one. Copilot gets its own specialised instance
// (copilot-prose.ts) — this is everyone else.

interface ProseParsed {
  text: string | null;
}

interface ProsePlanState {
  files: AdapterOutputFile[];
  changed: boolean;
}

export function genericProseAdapter(
  configPath: string,
  opts?: { charBudget?: number },
): BotAdapter<ProseParsed, ProsePlanState> {
  const degraded = (alternative: string): IntentSupport => ({ level: 'degraded', alternative });
  const proseNote = 'expressed as a prose instruction in the managed block';
  return {
    key: `prose:${configPath}`,
    displayName: `Instructions (${configPath})`,
    capabilities: {
      SUPPRESS_PATH: degraded(proseNote),
      QUIET_PATH_NITS: { level: 'expressible' },
      SUPPRESS_CATEGORY: { level: 'expressible' },
      LOWER_VERBOSITY: { level: 'expressible' },
      SCOPE_OFF: degraded(proseNote),
      AMPLIFY_PATH: { level: 'expressible' },
      ESCALATE: { level: 'expressible' },
      PROMOTE_TO_LINT: degraded(proseNote),
      BOOTSTRAP_CONFIG: { level: 'expressible' },
    },
    configTargets: [{ path: configPath, format: 'prose' }],
    parse(files: AdapterFileInput[]): ParseResult<ProseParsed> {
      const file = files.find((f) => f.path === configPath);
      const text = file?.text ?? null;
      if (text != null && text.length > MAX_CONFIG_BYTES) {
        return {
          ok: false,
          reason: `${configPath} exceeds ${MAX_CONFIG_BYTES} bytes — refusing to edit`,
          config: { text: null },
        };
      }
      return { ok: true, config: { text } };
    },
    plan(intents: AdvisorIntentWire[], current: ProseParsed): AdapterPlan<ProsePlanState> {
      const items: AdapterPlanItem[] = [];
      const render = renderManagedBlock(intents, opts?.charBudget);
      const upserted = upsertManagedBlock(current.text, render.block);
      if (!upserted.ok) {
        for (const intent of intents) {
          items.push({
            intentKind: intent.kind,
            targetKey: intent.targetKey,
            status: 'unsupported',
            note: upserted.reason,
          });
        }
        return { items, state: { files: [], changed: false } };
      }
      for (const intent of render.included) {
        items.push({ intentKind: intent.kind, targetKey: intent.targetKey, status: 'applied' });
      }
      for (const intent of render.dropped) {
        items.push({
          intentKind: intent.kind,
          targetKey: intent.targetKey,
          status: 'unsupported',
          note: 'dropped: over the char budget',
        });
      }
      const changed = render.included.length > 0 && upserted.content !== current.text;
      return {
        items,
        state: {
          files: changed ? [{ path: configPath, content: upserted.content }] : [],
          changed,
        },
      };
    },
    serialize(plan: AdapterPlan<ProsePlanState>): AdapterOutputFile[] {
      return plan.state.changed ? plan.state.files : [];
    },
    validate(files: AdapterOutputFile[]): { ok: boolean; errors: string[] } {
      const errors: string[] = [];
      if (opts?.charBudget != null) {
        for (const f of files) {
          if (f.content.length > opts.charBudget) {
            errors.push(`${f.path}: over the ${opts.charBudget}-char budget`);
          }
        }
      }
      return { ok: errors.length === 0, errors };
    },
  };
}
