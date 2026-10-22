// T3 discovery — the structural-tells manifest PROPOSER. Pure over fetched config text:
// filename + top-level-key heuristics (glob-shaped string arrays; ignore/exclude/skip/
// filter/path/severity/threshold/rules/disabled keys; a $schema marker), producing an
// AdapterManifest PROPOSAL plus the tells that motivated it. The proposal is NEVER executed
// unconfirmed — the confirm flow persists it to advisor_bot_profiles.manifestJson, and only
// a confirmed manifest reaches manifestAdapter (never open a PR for a guessed schema).
import type { AdapterManifest } from '../emitters/manifest.js';
import { parseYamlConfig } from '../emitters/yaml-doc.js';

const SUPPRESS_KEY_RE = /^(ignore|exclude|skip|filter)/i;
const SEVERITY_KEY_RE = /^(severity|threshold|level|min[_-]?severity)/i;

export interface ManifestInference {
  proposal: AdapterManifest | null;
  tells: string[];
}

const looksLikeGlob = (s: string): boolean => s.includes('*') || s.includes('/');

export function inferManifest(configPath: string, text: string): ManifestInference {
  const tells: string[] = [];
  const format: 'yaml' | 'json' | null = configPath.endsWith('.json')
    ? 'json'
    : /\.ya?ml$/.test(configPath)
      ? 'yaml'
      : null;
  if (!format) return { proposal: null, tells: ['unrecognized config extension'] };

  let data: unknown = null;
  if (format === 'json') {
    try {
      data = JSON.parse(text);
    } catch {
      return { proposal: null, tells: ['file does not parse as JSON'] };
    }
  } else {
    const parsed = parseYamlConfig(text);
    if (!parsed.ok) return { proposal: null, tells: ['file does not parse as YAML'] };
    data = parsed.doc.toJSON();
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return { proposal: null, tells: ['top level is not a mapping'] };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.$schema === 'string') tells.push(`$schema: ${obj.$schema}`);

  const intents: AdapterManifest['intents'] = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string') &&
      (value as string[]).some(looksLikeGlob) &&
      SUPPRESS_KEY_RE.test(key)
    ) {
      tells.push(`glob-shaped string array under a suppress-shaped key: ${key}`);
      intents.SUPPRESS_PATH ??= { keyPath: [key], valueTemplate: '{target}', listMode: 'append' };
      continue;
    }
    if (SEVERITY_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
      tells.push(`severity-shaped scalar key: ${key}`);
      intents.LOWER_VERBOSITY ??= { keyPath: [key], valueTemplate: 'minor', listMode: 'set' };
    }
    if (/^(rules|disabled)$/i.test(key)) tells.push(`rule-table key: ${key}`);
  }
  if (Object.keys(intents).length === 0) {
    return { proposal: null, tells: tells.length > 0 ? tells : ['no structural tells found'] };
  }
  return { proposal: { format, configPath, intents }, tells };
}
