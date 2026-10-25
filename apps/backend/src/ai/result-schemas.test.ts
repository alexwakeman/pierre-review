// ONE CONTRACT PER RESULT (ai/result-schemas.ts; docs/CODEX-PLAN.md § 3.4). For every result tool:
//   1. the strict schema IS strict: every object has `additionalProperties: false` and lists every
//      key in `required`; a key the tool marks optional is nullable;
//   2. PARITY: over generated samples (a minimal and a full answer, then one mutation at a time at
//      every key — a wrong type, a non-member of an enum, null where the tool takes none, a missing
//      required key, a string or array over its cap, a number out of range), the strict schema and
//      the Claude tool's own zod schema ACCEPT AND REJECT THE SAME SAMPLES — the tool reading each
//      answer after `strictAnswerToToolArgs`, exactly as Phase 2 will hand a Codex answer to the
//      same handler;
//   3. strict form is stricter in exactly the two designed ways: an absent optional key and an
//      unknown key are refused by the strict schema, while the tool takes the first and strips the
//      second.
// The strict schema is checked by a small validator below, limited to the keywords the strict
// schemas use — and the first test asserts they use no other, so the validator is complete for them.
//
//   pnpm --filter @pierre-review/backend test ai/result-schemas
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  RESULT_TOOL_NAMES,
  acceptsNull,
  resultJsonSchemas,
  resultToolShape,
  strictAnswerToToolArgs,
  toStrictJsonSchema,
  type ResultToolName,
} from './result-schemas.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Loosely typed on purpose: the walkers below read arbitrary schema keywords.
type JsonSchema = Record<string, any>;

const KNOWN_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'enum',
  'description',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function keywordsOf(schema: JsonSchema, out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(schema)) {
    out.add(k);
    if (k === 'properties' && isObj(v)) for (const s of Object.values(v)) keywordsOf(s as JsonSchema, out);
    else if (k === 'items' && isObj(v)) keywordsOf(v, out);
    else if (k === 'anyOf' && Array.isArray(v)) for (const s of v) keywordsOf(s, out);
  }
  return out;
}

/** A validator for exactly the keywords above (JSON Schema semantics). */
function valid(schema: JsonSchema, v: unknown): boolean {
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s: JsonSchema) => valid(s, v))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => e === v)) return false;
  const t = schema.type;
  if (t !== undefined) {
    const ok =
      t === 'null'
        ? v === null
        : t === 'string'
          ? typeof v === 'string'
          : t === 'integer'
            ? typeof v === 'number' && Number.isInteger(v)
            : t === 'number'
              ? typeof v === 'number' && Number.isFinite(v)
              : t === 'boolean'
                ? typeof v === 'boolean'
                : t === 'array'
                  ? Array.isArray(v)
                  : t === 'object'
                    ? isObj(v)
                    : false;
    if (!ok) return false;
  }
  if (typeof v === 'string') {
    if (typeof schema.minLength === 'number' && [...v].length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && [...v].length > schema.maxLength) return false;
  }
  if (typeof v === 'number') {
    if (typeof schema.minimum === 'number' && v < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && v > schema.maximum) return false;
  }
  if (Array.isArray(v)) {
    if (typeof schema.minItems === 'number' && v.length < schema.minItems) return false;
    if (typeof schema.maxItems === 'number' && v.length > schema.maxItems) return false;
    if (isObj(schema.items) && !v.every((x) => valid(schema.items, x))) return false;
  }
  if (isObj(v) && isObj(schema.properties)) {
    for (const k of (schema.required as string[] | undefined) ?? []) if (!(k in v)) return false;
    for (const [k, x] of Object.entries(v)) {
      const sub = schema.properties[k];
      if (sub === undefined) {
        if (schema.additionalProperties === false) return false;
        continue;
      }
      if (!valid(sub, x)) return false;
    }
  }
  return true;
}

/** The non-null branch of a schema (strict wraps an optional key as anyOf [schema, null]). */
function nonNull(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.anyOf)) {
    const rest = schema.anyOf.filter((s: JsonSchema) => !(s.type === 'null'));
    if (rest.length === 1) return rest[0];
  }
  return schema;
}

/** A sample answer in strict form. `full`: every nullable key filled and every array one item long. */
function sample(schema: JsonSchema, full: boolean): unknown {
  if (Array.isArray(schema.anyOf)) {
    if (!full && acceptsNull(schema)) return null;
    return sample(nonNull(schema), full);
  }
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) out[k] = sample(s, full);
      return out;
    }
    case 'array': {
      const n = Math.max(full ? 1 : 0, schema.minItems ?? 0);
      return Array.from({ length: n }, () => sample(schema.items ?? {}, full));
    }
    case 'string':
      return 'x'.repeat(Math.max(1, schema.minLength ?? 1));
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? Math.max(schema.minimum, Math.min(1, schema.maximum ?? 1)) : 1;
    case 'boolean':
      return true;
    default:
      return 'x';
  }
}

type Path = Array<string | number>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function setAt(root: any, path: Path, fn: (parent: any, key: string | number) => void): any {
  const copy = clone(root);
  let cur = copy;
  for (const p of path.slice(0, -1)) cur = cur[p];
  fn(cur, path[path.length - 1]!);
  return copy;
}

interface Mutation {
  label: string;
  value: unknown;
}

/** One mutation at a time, at every key of the FULL sample (walked beside the TOOL's schema). */
function mutations(tool: JsonSchema, root: unknown): Mutation[] {
  const out: Mutation[] = [];
  const walk = (schema: JsonSchema, value: unknown, path: Path): void => {
    const s = nonNull(schema);
    if (isObj(value) && isObj(s.properties)) {
      const required = new Set<string>((s.required as string[] | undefined) ?? []);
      for (const [k, sub] of Object.entries(s.properties as Record<string, JsonSchema>)) {
        const p = [...path, k];
        const at = (fn: (parent: any, key: string | number) => void) => setAt(root, p, fn);
        if (required.has(k)) out.push({ label: `${p.join('.')} missing`, value: at((o, key) => delete o[key]) });
        // (null on an OPTIONAL key is strict form's way to say "absent" — valid on both sides.)
        if (required.has(k) && !acceptsNull(sub)) out.push({ label: `${p.join('.')} null`, value: at((o, key) => (o[key] = null)) });
        const inner = nonNull(sub);
        if (inner.type === 'string' || Array.isArray(inner.enum)) out.push({ label: `${p.join('.')} a number`, value: at((o, key) => (o[key] = 7)) });
        if (Array.isArray(inner.enum)) out.push({ label: `${p.join('.')} not a member`, value: at((o, key) => (o[key] = 'not-a-member')) });
        if (inner.type === 'array') out.push({ label: `${p.join('.')} an object`, value: at((o, key) => (o[key] = {})) });
        if (inner.type === 'object') out.push({ label: `${p.join('.')} a string`, value: at((o, key) => (o[key] = 'x')) });
        if (typeof inner.maxLength === 'number') {
          out.push({ label: `${p.join('.')} over its length`, value: at((o, key) => (o[key] = 'y'.repeat(inner.maxLength + 1))) });
        }
        if (typeof inner.maxItems === 'number') {
          out.push({
            label: `${p.join('.')} over its count`,
            value: at((o, key) => (o[key] = Array.from({ length: inner.maxItems + 1 }, () => clone(o[key][0] ?? null)))),
          });
        }
        if (typeof inner.maximum === 'number' && inner.maximum < 1e9) {
          out.push({ label: `${p.join('.')} over its maximum`, value: at((o, key) => (o[key] = inner.maximum + 1)) });
        }
        if (typeof inner.minimum === 'number' && inner.minimum > -1e9) {
          out.push({ label: `${p.join('.')} under its minimum`, value: at((o, key) => (o[key] = inner.minimum - 1)) });
        }
        if (inner.type === 'integer') out.push({ label: `${p.join('.')} a fraction`, value: at((o, key) => (o[key] = 0.5)) });
        walk(sub, (value as Record<string, unknown>)[k], p);
      }
    } else if (Array.isArray(value) && isObj(s.items)) {
      value.forEach((v, i) => walk(s.items, v, [...path, i]));
    }
  };
  walk(tool, root, []);
  return out;
}

const CASES: Array<{ name: ResultToolName; docs?: boolean }> = [
  ...RESULT_TOOL_NAMES.map((name) => ({ name })),
  { name: 'submit_review', docs: true },
  { name: 'submit_ticket_review', docs: true },
];

describe.each(CASES)('$name (docs: $docs)', ({ name, docs }) => {
  const load = async () => {
    const opts = { docs: docs === true };
    const { tool, strict } = await resultJsonSchemas(name, opts, z);
    const zodSchema = z.object((await resultToolShape(name, opts, z)) as z.ZodRawShape);
    const toolAccepts = (v: unknown): boolean => zodSchema.safeParse(strictAnswerToToolArgs(tool, v)).success;
    return { tool, strict, toolAccepts };
  };

  it('is strict, and uses only the keywords the validator knows', async () => {
    const { strict } = await load();
    const check = (s: JsonSchema): void => {
      if (isObj(s.properties)) {
        expect(s.additionalProperties).toBe(false);
        expect([...(s.required as string[])].sort()).toEqual(Object.keys(s.properties).sort());
        for (const sub of Object.values(s.properties)) check(sub as JsonSchema);
      }
      if (isObj(s.items)) check(s.items);
      if (Array.isArray(s.anyOf)) s.anyOf.forEach(check);
    };
    check(strict);
    expect([...keywordsOf(strict)].filter((k) => !KNOWN_KEYWORDS.has(k))).toEqual([]);
    // The transform is idempotent.
    expect(toStrictJsonSchema(strict)).toEqual(strict);
  });

  it('the strict schema and the Claude tool accept and reject the same samples', async () => {
    const { tool, strict, toolAccepts } = await load();
    const min = sample(strict, false);
    const full = sample(strict, true);
    for (const [label, v] of [['minimal', min], ['full', full]] as const) {
      expect(valid(strict, v), `strict should accept the ${label} sample`).toBe(true);
      expect(toolAccepts(v), `the tool should accept the ${label} sample`).toBe(true);
    }
    const muts = mutations(tool, full);
    expect(muts.length).toBeGreaterThan(0);
    const disagree = muts
      .map((m) => ({ label: m.label, strict: valid(strict, m.value), tool: toolAccepts(m.value) }))
      .filter((r) => r.strict !== r.tool);
    expect(disagree).toEqual([]);
    // Every mutation above breaks the contract, so both refuse it.
    expect(muts.filter((m) => valid(strict, m.value)).map((m) => m.label)).toEqual([]);
  });

  it('is stricter in exactly the two designed ways', async () => {
    const { tool, strict, toolAccepts } = await load();
    const full = sample(strict, true) as Record<string, unknown>;
    // An unknown key: refused by strict form, stripped by the tool.
    expect(valid(strict, { ...full, unexpected: 1 })).toBe(false);
    expect(toolAccepts({ ...full, unexpected: 1 })).toBe(true);
    // An absent OPTIONAL key: refused by strict form (send null), taken by the tool.
    const required = new Set((tool.required as string[] | undefined) ?? []);
    for (const k of Object.keys(full).filter((key) => !required.has(key))) {
      const { [k]: _gone, ...rest } = full;
      expect(valid(strict, rest), `${k} absent`).toBe(false);
      expect(toolAccepts(rest), `${k} absent`).toBe(true);
    }
  });
});

describe('the strict transform', () => {
  it('makes optional keys nullable, keeps nullable ones, and closes every object', () => {
    const tool = z.toJSONSchema(
      z.object({
        a: z.string(),
        b: z.string().optional().describe('B'),
        c: z.number().nullable().optional(),
        d: z.array(z.object({ e: z.enum(['x', 'y']).optional() })),
      }),
      { io: 'input' },
    ) as JsonSchema;
    const { $schema: _s, ...plain } = tool;
    expect(toStrictJsonSchema(plain)).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { description: 'B', anyOf: [{ type: 'string' }, { type: 'null' }] },
        c: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        d: {
          type: 'array',
          items: {
            type: 'object',
            properties: { e: { anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] } },
            required: ['e'],
            additionalProperties: false,
          },
        },
      },
      required: ['a', 'b', 'c', 'd'],
      additionalProperties: false,
    });
  });

  it('turns a strict answer back into the tool’s arguments: null on an optional-only key is dropped', () => {
    const tool = z.toJSONSchema(
      z.object({ a: z.string(), b: z.string().optional(), c: z.string().nullable().optional(), d: z.array(z.object({ e: z.string().optional() })) }),
      { io: 'input' },
    ) as JsonSchema;
    expect(strictAnswerToToolArgs(tool, { a: 'x', b: null, c: null, d: [{ e: null }, { e: 'y' }] })).toEqual({
      a: 'x',
      c: null,
      d: [{}, { e: 'y' }],
    });
  });
});
