// The time-zone list behind Settings → Working hours and budgets, as pure functions so
// `apps/frontend/test/timeZones.test.ts` can pin them without a renderer.
//
// ⚠ THE ENGINE LISTS OLD NAMES. V8's `Intl.supportedValuesOf('timeZone')` (measured on Node 24:
// 418 zones) still spells Kyiv "Europe/Kiev" and Kolkata "Asia/Calcutta", and it omits "UTC"
// altogether — while ACCEPTING every modern name. So the list is the engine's zones mapped to the
// names people type, with the old name kept as a searchable alias, plus UTC. The modern name is
// what gets stored, and it passes the server's `isValidTimeZone`.
//
// ⚠ A STORED OLD NAME IS NEVER REWRITTEN. `findZone` matches a stored "Europe/Kiev" to the Kyiv
// option so the combobox can show it, but nothing here writes a value: the form keeps what is
// stored until someone picks a zone.

export interface ZoneOption {
  /** What is stored — the modern IANA name. */
  value: string;
  /** Older names for the same zone: searchable, and matched against a stored value. */
  aliases: string[];
  /** Today's offset, e.g. "UTC+1", "UTC+5:30", "UTC-3", "UTC+0"; '' when the engine cannot say. */
  offset: string;
  offsetMinutes: number | null;
}

/** Legacy name the engine may list → the modern name people type. */
export const ZONE_ALIASES: Readonly<Record<string, string>> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Catamarca': 'America/Argentina/Catamarca',
  'America/Cordoba': 'America/Argentina/Cordoba',
  'America/Jujuy': 'America/Argentina/Jujuy',
  'America/Mendoza': 'America/Argentina/Mendoza',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'America/Louisville': 'America/Kentucky/Louisville',
  'America/Coral_Harbour': 'America/Atikokan',
  'Africa/Asmera': 'Africa/Asmara',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
};

const UTC = 'UTC';
/** The spellings of UTC itself — merged into the one "UTC" option wherever the engine lists them. */
const UTC_ALIASES: readonly string[] = ['Etc/UTC', 'GMT'];

/** The name a zone is listed under: the modern spelling of an old name, "UTC" for its aliases. */
export function modernZoneName(zone: string): string {
  if (zone === UTC || UTC_ALIASES.includes(zone)) return UTC;
  return ZONE_ALIASES[zone] ?? zone;
}

/**
 * The zone's offset from UTC at `at`, e.g. `{ minutes: 330, label: 'UTC+5:30' }`. Null when the
 * zone is unknown or the engine has no `longOffset` (Safari before 15.4) — the list then shows no
 * offsets rather than wrong ones.
 */
export function offsetOf(zone: string, at: Date): { minutes: number; label: string } | null {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (part == null) return null;
    // "GMT" alone is UTC itself; otherwise "GMT+05:30" / "GMT-02:30" / "GMT+00:00".
    if (part === 'GMT') return { minutes: 0, label: 'UTC+0' };
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part);
    if (m == null) return null;
    const hours = Number(m[2]);
    const mins = Number(m[3]);
    const minutes = (m[1] === '-' ? -1 : 1) * (hours * 60 + mins);
    return { minutes, label: offsetLabel(minutes) };
  } catch {
    return null;
  }
}

/** 330 → "UTC+5:30", -300 → "UTC-5", 0 → "UTC+0". */
function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`}`;
}

/**
 * The options for a list of engine zone names: each mapped to its modern name (the old one kept as
 * an alias), deduplicated, with UTC added. UTC first, then alphabetical by name.
 */
export function buildZoneOptions(engineZones: readonly string[], at: Date): ZoneOption[] {
  const aliases = new Map<string, Set<string>>([[UTC, new Set(UTC_ALIASES)]]);
  for (const zone of engineZones) {
    const value = modernZoneName(zone);
    const set = aliases.get(value) ?? new Set<string>();
    if (zone !== value) set.add(zone);
    aliases.set(value, set);
  }
  const values = [...aliases.keys()].filter((v) => v !== UTC).sort((a, b) => a.localeCompare(b));
  return [UTC, ...values].map((value) => {
    const off = offsetOf(value, at);
    return {
      value,
      aliases: [...(aliases.get(value) ?? [])],
      offset: off?.label ?? '',
      offsetMinutes: off?.minutes ?? null,
    };
  });
}

let memo: ZoneOption[] | null = null;

/**
 * Every zone this browser knows, with today's offsets. Formatting ~420 offsets costs ~50ms, so it
 * is built on first use (the combobox's first open) and kept. An engine without
 * `Intl.supportedValuesOf` still gets UTC.
 */
export function zoneOptions(): ZoneOption[] {
  if (memo != null) return memo;
  let engine: string[] = [];
  try {
    const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    engine = f ? f('timeZone') : [];
  } catch {
    engine = [];
  }
  memo = buildZoneOptions(engine, new Date());
  return memo;
}

/** The option a stored value names — by its modern name or any alias. Exact match only. */
export function findZone(options: readonly ZoneOption[], value: string): ZoneOption | null {
  return options.find((o) => o.value === value || o.aliases.includes(value)) ?? null;
}

/** Lowercase, with `_` read as a space — "new york" finds America/New_York. */
function norm(s: string): string {
  return s.toLowerCase().replace(/_/g, ' ');
}

const OFFSET_QUERY = /^(utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/;

/**
 * The options matching what someone typed. An offset ("+5:30", "utc-3") matches by today's
 * offset. Anything else matches a name or an old name containing it, ranked: the city (the last
 * part of the name) starts with it, then any part does, then it appears anywhere; ties
 * alphabetical. An empty query is every option.
 */
export function filterZones(options: readonly ZoneOption[], query: string): ZoneOption[] {
  const q = norm(query.trim());
  if (q === '') return [...options];

  const off = OFFSET_QUERY.exec(q);
  if (off != null) {
    const minutes = (off[2] === '-' ? -1 : 1) * (Number(off[3]) * 60 + Number(off[4] ?? 0));
    return options
      .filter((o) => o.offsetMinutes === minutes)
      .sort((a, b) => a.value.localeCompare(b.value));
  }

  const rankOf = (name: string): number | null => {
    const n = norm(name);
    if (!n.includes(q)) return null;
    const parts = n.split('/');
    if ((parts[parts.length - 1] ?? '').startsWith(q)) return 0;
    if (parts.some((p) => p.startsWith(q))) return 1;
    return 2;
  };
  const ranked: { o: ZoneOption; rank: number }[] = [];
  for (const o of options) {
    let best: number | null = null;
    for (const name of [o.value, ...o.aliases]) {
      const r = rankOf(name);
      if (r != null && (best == null || r < best)) best = r;
    }
    if (best != null) ranked.push({ o, rank: best });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.o.value.localeCompare(b.o.value))
    .map((r) => r.o);
}

/** One row of the combobox list. `value: ''` is the "Default (<zone>)" entry — a blank setting. */
export interface ZoneRow {
  value: string;
  label: string;
  offset: string;
}

/**
 * The combobox's rows for what is typed: "Default (<zone>)" first while nothing is typed (or while
 * what is typed is the start of "default"), then the matching zones. `defaultZone` is the
 * deployment's zone, shown under its modern name.
 */
export function zoneRows(options: readonly ZoneOption[], query: string, defaultZone: string): ZoneRow[] {
  const zones = filterZones(options, query).map((o) => ({ value: o.value, label: o.value, offset: o.offset }));
  const q = query.trim().toLowerCase();
  if (q !== '' && !'default'.startsWith(q)) return zones;
  const zone = findZone(options, defaultZone);
  const shown = zone?.value ?? modernZoneName(defaultZone);
  return [{ value: '', label: `Default (${shown})`, offset: zone?.offset ?? '' }, ...zones];
}
