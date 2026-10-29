import { createHash } from 'node:crypto';
import {
  NOTION_MAPPING_VERSION,
  NOTION_NO_PREFIX_MESSAGE,
  NOTION_PREFIX_RE,
  notionGroupCategory,
  notionId,
  type JiraStatusCategory,
  type NotionPropRef,
  type NotionPropertyInfo,
  type NotionPropertyType,
  type NotionSprintDatabase,
  type NotionTrackerMapping,
} from '@pierre-review/shared';
import type { TrackerCall } from '../types.js';
import { richTextPlain, type NotionRichText } from './blocks.js';
import { notionRequest } from './client.js';

// A NOTION DATABASE'S SCHEMA (docs/TRACKERS.md § Notion) — `GET /v1/databases/{id}`. Read by the
// Settings mapping form (click-gated, `GET /api/workspaces/:id/tracker/notion-schema`), by the reader
// for a `status` property's groups (which option is To-do / In progress / Complete), and by the
// sprint list for the status ORDER. Cached in memory for `SCHEMA_TTL_MS` per (token, database), so a
// pass over many tickets reads it once.

export const SCHEMA_TTL_MS = 10 * 60_000;

/** The raw database object, narrowed to what Limn reads. */
export interface RawDatabase {
  id?: string;
  title?: NotionRichText[];
  url?: string;
  properties?: Record<
    string,
    {
      id?: string;
      name?: string;
      type?: string;
      unique_id?: { prefix?: string | null } | null;
      status?: {
        options?: Array<{ id?: string; name?: string }>;
        groups?: Array<{ id?: string; name?: string; option_ids?: string[] }>;
      } | null;
      select?: { options?: Array<{ id?: string; name?: string }> } | null;
      relation?: { database_id?: string } | null;
    }
  >;
}

const cache = new Map<string, { at: number; db: RawDatabase }>();
const cacheKey = (token: string, id: string): string => createHash('sha256').update(`notion-db\0${token}\0${id}`).digest('hex').slice(0, 24);

/** Test seam. */
export function __clearNotionSchemaCache(): void {
  cache.clear();
}

/** Read (or reuse) a database's schema. Throws `JiraFetchError`. */
export async function readNotionDatabase(call: TrackerCall, databaseId: string, opts: { fresh?: boolean; now?: number } = {}): Promise<RawDatabase> {
  const now = opts.now ?? Date.now();
  const k = cacheKey(call.credentials.token, databaseId);
  const hit = cache.get(k);
  if (!opts.fresh && hit != null && now - hit.at < SCHEMA_TTL_MS) return hit.db;
  const db = await notionRequest<RawDatabase>(call, 'GET', `/v1/databases/${encodeURIComponent(databaseId)}`);
  cache.set(k, { at: now, db });
  return db;
}

const KNOWN: ReadonlySet<string> = new Set(['title', 'unique_id', 'status', 'select', 'multi_select', 'people', 'relation', 'date', 'rich_text']);

/** The schema's properties, in Notion's order, as the SPA lists them. Pure. */
export function schemaProperties(db: RawDatabase): NotionPropertyInfo[] {
  const out: NotionPropertyInfo[] = [];
  for (const [key, p] of Object.entries(db.properties ?? {})) {
    const id = typeof p?.id === 'string' ? p.id : '';
    if (id === '') continue;
    const type = (KNOWN.has(p.type ?? '') ? p.type : 'other') as NotionPropertyType;
    const info: NotionPropertyInfo = { id, name: (p.name ?? key).slice(0, 200), type };
    if (type === 'unique_id') info.prefix = (p.unique_id?.prefix ?? '').trim();
    if (type === 'select') info.options = (p.select?.options ?? []).map((o) => o.name ?? '').filter((n) => n !== '');
    if (type === 'status') {
      info.options = statusOptionOrder(p.status).map((o) => o.name);
      info.optionCategory = Object.fromEntries(statusOptionOrder(p.status).map((o) => [o.name, o.category]));
    }
    if (type === 'relation') {
      const rid = notionId(p.relation?.database_id ?? '');
      if (rid != null) info.relationDatabaseId = rid;
    }
    out.push(info);
  }
  return out;
}

/** A `status` property's options in GROUP order (To-do, In progress, Complete), each with its
 *  category. An option no group lists comes last, as To-do. Pure. */
export function statusOptionOrder(
  status: NonNullable<NonNullable<RawDatabase['properties']>[string]>['status'],
): Array<{ id: string | null; name: string; category: JiraStatusCategory }> {
  const opts = status?.options ?? [];
  const byId = new Map(opts.map((o) => [o.id ?? '', o]));
  const out: Array<{ id: string | null; name: string; category: JiraStatusCategory }> = [];
  const seen = new Set<string>();
  const rank: Record<JiraStatusCategory, number> = { new: 0, indeterminate: 1, done: 2 };
  const groups = [...(status?.groups ?? [])].sort((a, b) => rank[notionGroupCategory(a.name ?? '')] - rank[notionGroupCategory(b.name ?? '')]);
  for (const g of groups) {
    const category = notionGroupCategory(g.name ?? '');
    for (const oid of g.option_ids ?? []) {
      const o = byId.get(oid);
      const name = (o?.name ?? '').trim();
      if (name === '' || seen.has(name)) continue;
      seen.add(name);
      out.push({ id: o?.id ?? null, name, category });
    }
  }
  for (const o of opts) {
    const name = (o.name ?? '').trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({ id: o.id ?? null, name, category: 'new' });
  }
  return out;
}

/** The database's Unique ID property WITH a prefix, or null (the Settings refusal). Pure. */
export function prefixedUniqueId(props: readonly NotionPropertyInfo[]): { property: NotionPropRef; prefix: string } | null {
  for (const p of props) {
    if (p.type !== 'unique_id') continue;
    const prefix = (p.prefix ?? '').trim();
    if (prefix !== '' && NOTION_PREFIX_RE.test(prefix)) return { property: { id: p.id, name: p.name }, prefix };
  }
  return null;
}

/** The refusal sentence for a database, or null. Pure. */
export function schemaRefusal(props: readonly NotionPropertyInfo[]): string | null {
  if (prefixedUniqueId(props) != null) return null;
  const odd = props.find((p) => p.type === 'unique_id' && (p.prefix ?? '') !== '');
  return odd != null ? 'The Unique ID prefix must be 2 to 10 letters or digits, starting with a letter. Change it in Notion, then read it again.' : NOTION_NO_PREFIX_MESSAGE;
}

const ref = (p: NotionPropertyInfo): NotionPropRef => ({ id: p.id, name: p.name });
const byName = (props: readonly NotionPropertyInfo[], type: NotionPropertyType, re: RegExp): NotionPropertyInfo | undefined =>
  props.find((p) => p.type === type && re.test(p.name)) ?? undefined;

/** A first guess at the mapping from the property names and types. Pure; null with a refusal. */
export function suggestMapping(
  databaseId: string,
  props: readonly NotionPropertyInfo[],
  sprintDbs: Readonly<Record<string, NotionSprintDatabase>>,
): NotionTrackerMapping | null {
  const uid = prefixedUniqueId(props);
  if (uid == null) return null;
  const status = props.find((p) => p.type === 'status') ?? byName(props, 'select', /status|state|stage/i);
  const assignee = byName(props, 'people', /assign|owner|who/i) ?? props.find((p) => p.type === 'people');
  const sprintRel = props.find((p) => p.type === 'relation' && /sprint|cycle|iteration/i.test(p.name) && sprintDbs[p.id] != null);
  const sprintSel = byName(props, 'select', /sprint|cycle|iteration/i);
  const sprintDate = byName(props, 'date', /sprint|cycle|iteration/i);
  const relDb = sprintRel != null ? sprintDbs[sprintRel.id] : undefined;
  return {
    version: NOTION_MAPPING_VERSION,
    databaseId,
    uniqueId: uid,
    status:
      status == null
        ? null
        : status.type === 'status'
          ? { type: 'status', property: ref(status) }
          : {
              type: 'select',
              property: ref(status),
              options: Object.fromEntries((status.options ?? []).map((o) => [o, guessCategory(o)])),
            },
    assignee: assignee != null ? ref(assignee) : null,
    sprint:
      sprintRel != null && relDb != null && relDb.dateProperties[0] != null
        ? { kind: 'relation', property: ref(sprintRel), sprintDatabaseId: relDb.databaseId, dateProperty: relDb.dateProperties[0] }
        : sprintSel != null && (sprintSel.options ?? []).length > 0
          ? { kind: 'select', property: ref(sprintSel), current: sprintSel.options![sprintSel.options!.length - 1]! }
          : sprintDate != null
            ? { kind: 'date', property: ref(sprintDate) }
            : null,
    issueType: (() => {
      const t = byName(props, 'select', /^(type|issue type|kind|category)$/i);
      return t != null ? ref(t) : null;
    })(),
    criteria: (() => {
      const c = byName(props, 'rich_text', /acceptance|criteria|definition of done/i);
      return c != null ? ref(c) : null;
    })(),
    blockedBy: (() => {
      const b = props.find((p) => p.type === 'relation' && /blocked|depends|waiting/i.test(p.name) && p.relationDatabaseId === databaseId);
      return b != null ? ref(b) : null;
    })(),
  };
}

/** A select option's category guessed from its name (the editor shows it for a person to fix). */
export function guessCategory(name: string): JiraStatusCategory {
  const n = name.toLowerCase();
  if (/done|complete|closed|shipped|released|won.?t|cancel/.test(n)) return 'done';
  if (/progress|doing|review|qa|test|started|active|blocked/.test(n)) return 'indeterminate';
  return 'new';
}

/** The relation properties' target databases with their date properties — read for the sprint
 *  choice (≤ 3 relations, one call each; a database the integration cannot see is left out). */
export async function readSprintDatabases(
  call: TrackerCall,
  props: readonly NotionPropertyInfo[],
): Promise<Record<string, NotionSprintDatabase>> {
  const out: Record<string, NotionSprintDatabase> = {};
  const rels = props.filter((p) => p.type === 'relation' && p.relationDatabaseId != null).slice(0, 3);
  for (const r of rels) {
    try {
      const db = await readNotionDatabase(call, r.relationDatabaseId!);
      const dates = schemaProperties(db).filter((p) => p.type === 'date');
      out[r.id] = {
        databaseId: r.relationDatabaseId!,
        title: richTextPlain(db.title).trim().slice(0, 200) || 'Untitled',
        dateProperties: dates.map(ref),
      };
    } catch {
      // Not shared with the integration, or gone: the relation is simply not offered as a sprint.
    }
  }
  return out;
}
