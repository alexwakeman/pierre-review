// ONE SHARED CONTRACT PER AGENT RESULT (docs/CODEX-PLAN.md § 3.4; CODEX-SPIKE.md "Plan changes").
//
// Every agent hands its answer back through a result tool (`submit_review`, `submit_fix`, …). Claude
// calls it as an in-process MCP tool whose input schema is a zod RAW SHAPE; a provider without such
// tools (Codex: `--output-schema`) needs a JSON Schema in STRICT form instead — `additionalProperties:
// false` on every object, EVERY key required, and an optional key made NULLABLE. This module derives
// that strict schema from the SAME zod shape the Claude tool uses (the shape builders in each agent's
// schema module, built from the AI runtime's zod), so the two can never drift:
//
//   resultToolShape(name)        the raw zod shape the Claude tool is registered with;
//   resultJsonSchemas(name)      { tool: the plain JSON Schema of that shape, strict: its strict form };
//   toStrictJsonSchema(schema)   the strict transform (pure);
//   strictAnswerToToolArgs(...)  an answer in strict form → the arguments the Claude tool's handler
//                                takes (a null on a key the tool marks optional-but-not-nullable is
//                                dropped, so the SAME handler validates and keeps it).
//
// ⚠ Every server-side check stays where it is (`validateDesign`, the fix's shown-ref check, the docs
// quote check, the digit gate): a provider swap must not move a single guard. Strict form is
// deliberately STRICTER than the Claude tool in exactly two ways (an absent key, an unknown key);
// result-schemas.test.ts pins that, and that both accept and reject the same samples otherwise.
//
// Phase 1: nothing sends a strict schema yet (Claude keeps its tools). Exported for Phase 2.
import type { z as Zod } from 'zod';
import { loadZod } from './runtime.js';

type ZodNs = typeof Zod;

/** The result tools, by tool name. */
export const RESULT_TOOL_NAMES = [
  'submit_review',
  'submit_fix',
  'submit_plan',
  'submit_resolution',
  'submit_ticket_review',
  'submit_pr_card',
  'submit_ci_review',
  'submit_threads',
  // The replies pass (review/claude-review/replies-check.ts): judgements of replies on Limn's findings.
  'submit_replies',
  'submit_design',
  'submit_paths',
  'submit_alignment',
  // The story docs read's BUILD mode ("Implement story" → docs consideration).
  'submit_build_docs',
  'submit_explanations',
  'record_sections',
  // The docs build's closing call (beside record_sections): a result too.
  'finish_document',
  // The docs build on CODEX: record_sections + finish_document as ONE final answer (Phase 3).
  'submit_document',
] as const;
export type ResultToolName = (typeof RESULT_TOOL_NAMES)[number];

/** Options a shape depends on: the reference library adds fields to the two review results. */
export interface ResultShapeOptions {
  docs?: boolean;
}

type ShapeBuilder = (z: ZodNs, opts: ResultShapeOptions) => Promise<Record<string, unknown>>;

// Each builder is imported LAZILY: an agent's schema module is reached only when its schema is asked
// for, never at import time of this registry.
const BUILDERS: Record<ResultToolName, ShapeBuilder> = {
  submit_review: async (z, o) => (await import('../review/schema.js')).buildSubmitReviewShape(z, o),
  submit_fix: async (z) => (await import('../coding/schema.js')).buildSubmitFixShape(z),
  submit_plan: async (z) => (await import('../coding/schema.js')).buildSubmitPlanShape(z),
  submit_resolution: async (z) => (await import('../coding/ai-resolve/schema.js')).buildSubmitResolutionShape(z),
  submit_ticket_review: async (z, o) => (await import('../review/ticket-review/schema.js')).buildSubmitTicketReviewShape(z, o),
  submit_pr_card: async (z) => (await import('../review/ticket-review/schema.js')).buildSubmitPrCardShape(z),
  submit_ci_review: async (z) => (await import('../review/ci-review/schema.js')).buildSubmitCiReviewShape(z),
  submit_threads: async (z) => (await import('../review/claude-review/thread-check-schema.js')).buildSubmitThreadsShape(z),
  submit_replies: async (z) => (await import('../review/claude-review/replies-check-schema.js')).buildSubmitRepliesShape(z),
  submit_design: async (z) => (await import('../review/diagrams/schema.js')).buildSubmitDesignShape(z),
  submit_paths: async (z) => (await import('../review/sprint-paths/schema.js')).buildSubmitPathsShape(z),
  submit_alignment: async (z) => (await import('../review/story-docs/schema.js')).buildSubmitAlignmentShape(z),
  submit_build_docs: async (z) => (await import('../review/story-docs/schema.js')).buildSubmitBuildDocsShape(z),
  submit_explanations: async (z) => (await import('../review/claude-review/chat-explain.js')).buildSubmitExplanationsShape(z),
  record_sections: async (z) => (await import('../reference-docs/schema.js')).buildRecordSectionsShape(z),
  finish_document: async (z) => (await import('../reference-docs/schema.js')).buildFinishShape(z),
  submit_document: async (z) => (await import('../reference-docs/schema.js')).buildSubmitDocumentShape(z),
};

/** The raw zod shape the Claude tool `name` is registered with. `z` defaults to the AI runtime's. */
export async function resultToolShape(
  name: ResultToolName,
  opts: ResultShapeOptions = {},
  z?: ZodNs,
): Promise<Record<string, unknown>> {
  return BUILDERS[name](z ?? (await loadZod()), opts);
}

export type JsonSchema = Record<string, unknown>;

/** The plain JSON Schema of a tool's raw shape — the input the tool validates (zod's own conversion). */
export function shapeToJsonSchema(z: ZodNs, shape: Record<string, unknown>): JsonSchema {
  const schema = z.toJSONSchema(z.object(shape as Zod.ZodRawShape), { io: 'input' }) as JsonSchema;
  const { $schema: _drop, ...rest } = schema;
  return rest;
}

/** Both forms of one result's schema: the tool's own, and the strict form (§ 3.4). */
export async function resultJsonSchemas(
  name: ResultToolName,
  opts: ResultShapeOptions = {},
  z?: ZodNs,
): Promise<{ name: ResultToolName; tool: JsonSchema; strict: JsonSchema }> {
  const zz = z ?? (await loadZod());
  const tool = shapeToJsonSchema(zz, await resultToolShape(name, opts, zz));
  return { name, tool, strict: toStrictJsonSchema(tool) };
}

const isObj = (v: unknown): v is JsonSchema => !!v && typeof v === 'object' && !Array.isArray(v);

/** Does this schema already accept `null`? */
export function acceptsNull(schema: JsonSchema): boolean {
  if (schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((s) => isObj(s) && acceptsNull(s));
  return false;
}

/** The schema, accepting `null` too (its description kept on the outside). */
function nullable(schema: JsonSchema): JsonSchema {
  if (acceptsNull(schema)) return schema;
  const { description, ...inner } = schema;
  return {
    ...(description !== undefined ? { description } : {}),
    anyOf: [inner, { type: 'null' }],
  };
}

/**
 * THE STRICT TRANSFORM (pure): every object gets `additionalProperties: false` and lists EVERY key in
 * `required`; a key that was optional becomes nullable (unless it already accepted null). Arrays and
 * `anyOf` branches are transformed recursively; everything else (enums, lengths, bounds,
 * descriptions) is kept as it is.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...schema };
  if (isObj(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    const props: Record<string, JsonSchema> = {};
    for (const [key, sub] of Object.entries(schema.properties)) {
      const strictSub = toStrictJsonSchema(isObj(sub) ? sub : {});
      props[key] = required.has(key) ? strictSub : nullable(strictSub);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (schema.type === 'object') {
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  if (isObj(schema.items)) out.items = toStrictJsonSchema(schema.items);
  if (Array.isArray(schema.anyOf)) {
    out.anyOf = schema.anyOf.map((s) => (isObj(s) ? toStrictJsonSchema(s) : s));
  }
  return out;
}

/**
 * An answer in STRICT form → the arguments the tool's handler takes. Walks the TOOL's own JSON
 * Schema beside the value: on an object, a key the tool marks optional whose value is `null` and
 * whose own schema does not accept null is DROPPED (strict form had to send it; the tool means
 * "absent"). Anything else is returned as it is — validation is the handler's (the same one the
 * Claude tool runs), never this function's.
 */
export function strictAnswerToToolArgs(toolSchema: JsonSchema, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = isObj(toolSchema.items) ? toolSchema.items : null;
    return items ? value.map((v) => strictAnswerToToolArgs(items, v)) : value;
  }
  if (!isObj(value)) return value;
  // An anyOf of objects (none today): use the first object branch.
  let schema = toolSchema;
  if (!isObj(schema.properties) && Array.isArray(schema.anyOf)) {
    const branch = schema.anyOf.find((s) => isObj(s) && isObj(s.properties));
    if (isObj(branch)) schema = branch;
  }
  if (!isObj(schema.properties)) return value;
  const props = schema.properties as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    const sub = isObj(props[key]) ? (props[key] as JsonSchema) : null;
    if (v === null && sub && !required.has(key) && !acceptsNull(sub)) continue;
    out[key] = sub ? strictAnswerToToolArgs(sub, v) : v;
  }
  return out;
}
