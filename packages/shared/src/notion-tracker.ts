import type { JiraStatusCategory } from './types.js';

// ── NOTION AS AN ISSUE TRACKER (docs/TRACKERS.md § Notion) ───────────────────────────────────────────
//
// A team's tickets are the pages of ONE Notion database. Identity, the property mapping and the wire
// shapes live here, so the server and the SPA read them the same way.
//
//   IDENTITY  the site ROOT is the DATABASE: `https://www.notion.so/<32-hex database id>` (lower-case,
//             no dashes) — `notionDatabaseRoot`, the ONE fold, run on the URL pasted in Settings. The
//             KEY is the page's Unique ID with its prefix, upper-cased (`ENG-123`), so a key in a PR
//             title or branch is found exactly like a Jira or Linear key. ⚠ The database MUST have a
//             Unique ID property WITH a prefix: without one a page has no key anything can name.
//   LINK      `https://www.notion.so/<KEY>` — Notion opens a page by its prefixed Unique ID.
//
// (`notion.ts` is deliberately NOT this file's name: the Notion reference-docs source is a different
// feature with its own module.)

/** Where every Notion page and database lives. */
export const NOTION_APP_ORIGIN = 'https://www.notion.so';

/** A Notion tracker root: `https://www.notion.so/<database id>`. */
export const NOTION_ROOT_RE = /^https:\/\/www\.notion\.so\/[0-9a-f]{32}$/;

// The token's shape (`NOTION_TOKEN_RE`) is shared with the Notion wiki source: reference-docs-wiki.ts.

/** A Unique ID prefix Limn can find in a PR title or branch (the same shape as a Jira project key). */
export const NOTION_PREFIX_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/;

const ID32_RE = /([0-9a-f]{32})$/i;
const UUID_RE = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;

// `shared` compiles with no DOM or Node lib; the WHATWG URL both runtimes provide is declared here.
declare const URL: new (input: string) => { protocol: string; host: string; pathname: string };

function isNotionHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'notion.so' || h === 'www.notion.so' || h.endsWith('.notion.site');
}

/** A Notion object id (32 hex, or a dashed UUID) → 32 lower-case hex; null otherwise. */
export function notionId(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  const u = UUID_RE.exec(s);
  if (u != null && u.index + u[0].length === s.length && (u.index === 0 || /[^0-9a-f]/i.test(s[u.index - 1]!)))
    return u.slice(1).join('').toLowerCase();
  const m = ID32_RE.exec(s);
  if (m == null) return null;
  // The 32 hex must not be the tail of a longer hex run.
  if (m.index > 0 && /[0-9a-f]/i.test(s[m.index - 1]!)) return null;
  return m[1]!.toLowerCase();
}

/** The object id a Notion URL names (the last path segment's trailing id), or null. */
export function notionUrlId(url: string | null | undefined): string | null {
  if (url == null) return null;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isNotionHost(u.host)) return null;
  const segs = u.pathname.split('/').filter((s: string) => s !== '');
  const last = segs[segs.length - 1];
  return last == null ? null : notionId(last);
}

/** ⚠ THE ONE DERIVATION OF A NOTION ROOT: the database URL pasted in Settings → `https://www.notion.so/<id>`. */
export function notionDatabaseRoot(url: string | null | undefined): string | null {
  const id = notionUrlId(url);
  return id == null ? null : `${NOTION_APP_ORIGIN}/${id}`;
}

/** The database id of a Notion root, or null. */
export function notionRootDatabaseId(root: string | null | undefined): string | null {
  return root != null && NOTION_ROOT_RE.test(root) ? root.slice(NOTION_APP_ORIGIN.length + 1) : null;
}

/** A Notion link that names a page by its prefixed Unique ID (`notion.so/ENG-123`), or null. */
export function notionUniqueIdOfUrl(url: string | null | undefined): string | null {
  if (url == null) return null;
  let u: InstanceType<typeof URL>;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (!isNotionHost(u.host)) return null;
  const segs = u.pathname.split('/').filter((s: string) => s !== '');
  const last = segs[segs.length - 1] ?? '';
  const key = last.toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,19}-\d{1,9}$/.test(key) ? key : null;
}

/** The page link Notion opens by Unique ID. */
export const notionBrowseUrl = (key: string): string => `${NOTION_APP_ORIGIN}/${encodeURIComponent(key)}`;

// ── THE PROPERTY MAPPING (stored per workspace, `workspace_trackers.notion_config`) ────────────────────

/** A database property as stored: Notion's stable id (the filter key) and the name it had when saved. */
export interface NotionPropRef {
  id: string;
  name: string;
}

export type NotionStatusMapping =
  /** A `status` property: its groups To-do / In progress / Complete are the categories. */
  | { type: 'status'; property: NotionPropRef }
  /** A `select` property: each option's category, set by hand (an unlisted option is To do). */
  | { type: 'select'; property: NotionPropRef; options: Record<string, JiraStatusCategory> };

export type NotionSprintMapping =
  /** A relation to a Sprints database; the current sprint is the one whose date range holds today. */
  | { kind: 'relation'; property: NotionPropRef; sprintDatabaseId: string; dateProperty: NotionPropRef }
  /** A select; the current sprint is the option chosen here. */
  | { kind: 'select'; property: NotionPropRef; current: string }
  /** A date (range) on each page; the current sprint is every page whose range holds today. */
  | { kind: 'date'; property: NotionPropRef };

export interface NotionTrackerMapping {
  version: 1;
  /** 32 lower-case hex — the database the mapping was read from. */
  databaseId: string;
  /** The Unique ID property and its prefix (required). */
  uniqueId: { property: NotionPropRef; prefix: string };
  status: NotionStatusMapping | null;
  /** A `people` property. */
  assignee: NotionPropRef | null;
  sprint: NotionSprintMapping | null;
  /** A `select` property. */
  issueType: NotionPropRef | null;
  /** A `rich_text` property holding the acceptance criteria; null = look in the page body. */
  criteria: NotionPropRef | null;
  /** A `relation` property (to the same database) naming what this page waits on. */
  blockedBy: NotionPropRef | null;
}

export const NOTION_MAPPING_VERSION = 1;
const PROP_ID_RE = /^[\x21-\x7e]{1,64}$/;
const CATEGORIES: readonly JiraStatusCategory[] = ['new', 'indeterminate', 'done'];

/** The sentence a database without a prefixed Unique ID is refused with. */
export const NOTION_NO_PREFIX_MESSAGE =
  'Limn needs a Unique ID property with a prefix (like ENG-123), because that is what branches and PR titles name. Add one to this database in Notion, then read it again.';

function propOk(p: unknown): p is NotionPropRef {
  const r = p as NotionPropRef | null;
  return (
    r != null &&
    typeof r === 'object' &&
    typeof r.id === 'string' &&
    PROP_ID_RE.test(r.id) &&
    typeof r.name === 'string' &&
    r.name.length <= 200
  );
}

/** One plain sentence for a mapping the server refuses, or null. Pure — the PUT and the editor run it. */
export function notionMappingProblem(m: unknown): string | null {
  const x = m as Partial<NotionTrackerMapping> | null;
  if (x == null || typeof x !== 'object' || x.version !== NOTION_MAPPING_VERSION) return 'This Notion mapping is not one Limn can read.';
  if (typeof x.databaseId !== 'string' || !/^[0-9a-f]{32}$/.test(x.databaseId)) return 'This Notion mapping names no database.';
  if (x.uniqueId == null || !propOk(x.uniqueId.property) || typeof x.uniqueId.prefix !== 'string' || x.uniqueId.prefix === '')
    return NOTION_NO_PREFIX_MESSAGE;
  if (!NOTION_PREFIX_RE.test(x.uniqueId.prefix))
    return 'The Unique ID prefix must be 2 to 10 letters or digits, starting with a letter.';
  if (x.status != null) {
    if (!propOk(x.status.property)) return 'The status property is not valid.';
    if (x.status.type === 'select') {
      const opts = x.status.options;
      if (opts == null || typeof opts !== 'object' || Object.keys(opts).length > 100) return 'The status options are not valid.';
      for (const [k, v] of Object.entries(opts)) if (k.length > 200 || !CATEGORIES.includes(v)) return 'The status options are not valid.';
    } else if (x.status.type !== 'status') return 'The status property must be a Status or a Select.';
  }
  for (const p of [x.assignee, x.issueType, x.criteria, x.blockedBy]) if (p != null && !propOk(p)) return 'A mapped property is not valid.';
  const s = x.sprint;
  if (s != null) {
    if (!propOk(s.property)) return 'The sprint property is not valid.';
    if (s.kind === 'relation') {
      if (typeof s.sprintDatabaseId !== 'string' || !/^[0-9a-f]{32}$/.test(s.sprintDatabaseId) || !propOk(s.dateProperty))
        return 'Pick the date property of the Sprints database.';
    } else if (s.kind === 'select') {
      if (typeof s.current !== 'string' || s.current.trim() === '' || s.current.length > 200) return 'Pick which option is the current sprint.';
    } else if (s.kind !== 'date') return 'The sprint property must be a relation, a select or a date.';
  }
  return null;
}

/** A stored mapping (JSON text) → the mapping, or null when absent or unreadable. */
export function parseNotionMapping(raw: string | null | undefined): NotionTrackerMapping | null {
  if (raw == null || raw === '') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return notionMappingProblem(v) == null ? (v as NotionTrackerMapping) : null;
  } catch {
    return null;
  }
}

// ── THE SCHEMA READ (GET /api/workspaces/:id/tracker/notion-schema; click-gated) ───────────────────────

export type NotionPropertyType =
  | 'title'
  | 'unique_id'
  | 'status'
  | 'select'
  | 'multi_select'
  | 'people'
  | 'relation'
  | 'date'
  | 'rich_text'
  | 'other';

export interface NotionPropertyInfo {
  id: string;
  name: string;
  type: NotionPropertyType;
  /** select / status options, in Notion's order. */
  options?: string[];
  /** status: the group each option sits in, mapped to a category. */
  optionCategory?: Record<string, JiraStatusCategory>;
  /** unique_id: its prefix ('' when none). */
  prefix?: string;
  /** relation: the related database. */
  relationDatabaseId?: string;
}

/** A related database the sprint relation may point at, with its date properties. */
export interface NotionSprintDatabase {
  databaseId: string;
  title: string;
  dateProperties: NotionPropRef[];
}

export interface NotionSchemaResponse {
  workspaceId: number;
  databaseId: string;
  title: string;
  properties: NotionPropertyInfo[];
  /** Keyed by relation property id; only relations whose database Limn could read. */
  sprintDatabases: Record<string, NotionSprintDatabase>;
  /** A plain sentence when this database cannot be a tracker (no prefixed Unique ID); else null. */
  refusal: string | null;
  /** A starting mapping (the saved one when it is for this database, else a guess); null with a refusal. */
  suggested: NotionTrackerMapping | null;
}

/** Notion's status group name → a category (To-do / In progress / Complete, any language-ish spelling). */
export function notionGroupCategory(groupName: string): JiraStatusCategory {
  const g = groupName.trim().toLowerCase();
  if (/complete|done|closed|finished/.test(g)) return 'done';
  if (/progress|doing|started|active/.test(g)) return 'indeterminate';
  return 'new';
}
