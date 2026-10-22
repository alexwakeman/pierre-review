// Adapter emitters — round-trip fidelity, golden per-intent outputs, the Copilot char
// budget, the prose managed block, the manifest interpreter and the lint normalizer. Pure
// (no DB, no ctx). The property that matters most: bytes the user wrote SURVIVE — comments,
// anchors, key order, indentation.
import { describe, expect, it } from 'vitest';
import type { AdvisorIntentWire, AdvisorIntentKind } from '@pierre-review/shared';
import { coderabbitAdapter, CODERABBIT_PATH } from '../../advisor/emitters/coderabbit.js';
import { greptileAdapter, GREPTILE_PATH } from '../../advisor/emitters/greptile.js';
import {
  copilotProseAdapter,
  COPILOT_PATH,
  COPILOT_CHAR_BUDGET,
} from '../../advisor/emitters/copilot-prose.js';
import {
  extractManagedBlock,
  MARKER_END,
  MARKER_START,
  renderManagedBlock,
  upsertManagedBlock,
} from '../../advisor/emitters/prose.js';
import { manifestAdapter, parseManifest, validateManifest } from '../../advisor/emitters/manifest.js';
import { extractLintTemplates, titleTemplate } from '../../advisor/emitters/lint.js';

const intent = (
  kind: AdvisorIntentKind,
  targetKey: string,
  over: Partial<AdvisorIntentWire> = {},
): AdvisorIntentWire => ({
  kind,
  botUserId: 1,
  botKey: 'u1',
  botLabel: 'CodeRabbit',
  botKind: 'coderabbit',
  target:
    kind === 'SUPPRESS_PATH' || kind === 'AMPLIFY_PATH' || kind === 'QUIET_PATH_NITS'
      ? { kind: 'path', pathBucket: targetKey }
      : kind === 'SUPPRESS_CATEGORY' || kind === 'ESCALATE'
        ? { kind: 'category', category: targetKey as 'documentation' }
        : kind === 'SCOPE_OFF'
          ? { kind: 'partner', partnerUserId: 2, partnerLabel: 'Greptile' }
          : kind === 'PROMOTE_TO_LINT'
            ? { kind: 'lint', template: targetKey }
            : kind === 'BOOTSTRAP_CONFIG'
              ? { kind: 'bootstrap' }
              : { kind: 'severity' },
  targetKey,
  dedupeKey: `${kind}|1|${targetKey}|rolling_30`,
  rationale: 'test',
  evidence: {
    windowKind: 'rolling_30',
    from: '2026-07-10T00:00:00.000Z',
    to: '2026-08-09T00:00:00.000Z',
    volume: 10,
    actedOn: 2,
    actedOnPct: 20,
    untouched: 8,
    untouchedPct: 80,
    mergedUntouched: 5,
    overdueUntouched: 6,
    dissent: 0,
    actedOnHigh: 1,
    samplePrIds: [101],
    pathCoveragePct: 41,
  },
  retro: {
    applicable: true,
    computable: true,
    wouldHideActedOn: 2,
    wouldHideActedOnHigh: 1,
    wouldHideTotal: 10,
    disclosure: 'test',
  },
  ...over,
});

// A deliberately gnarly hand-written config: comments, an anchor/alias pair, odd indent,
// a block scalar, a user-chosen profile.
const GNARLY_CODERABBIT = `# my config — do not touch
language: en-US   # locale
x-shared: &shared
  drafts: true
reviews:
  profile: assertive  # the team likes it loud
  auto_review: *shared
  path_filters:
    - "!dist/**"    # build output
  path_instructions:
    - path: "src/legacy/**"
      instructions: >-
        Be gentle here.
`;

describe('coderabbit adapter', () => {
  it('identity: no intents → no output files (the file is never rewritten for nothing)', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: GNARLY_CODERABBIT }]);
    expect(parsed.ok).toBe(true);
    const plan = coderabbitAdapter.plan([], parsed.config);
    expect(coderabbitAdapter.serialize(plan)).toEqual([]);
  });

  it('SUPPRESS_PATH appends a negated path filter; every user byte survives', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: GNARLY_CODERABBIT }]);
    const plan = coderabbitAdapter.plan([intent('SUPPRESS_PATH', 'src/**')], parsed.config);
    expect(plan.items).toEqual([
      { intentKind: 'SUPPRESS_PATH', targetKey: 'src/**', status: 'applied', note: undefined },
    ]);
    const [out] = coderabbitAdapter.serialize(plan);
    expect(out!.path).toBe(CODERABBIT_PATH);
    // The addition…
    expect(out!.content).toContain('"!src/**"');
    // …and the user's own bytes: comments, anchor + alias, existing filter, block scalar.
    for (const survivor of [
      '# my config — do not touch',
      '# locale',
      '&shared',
      '*shared',
      '# the team likes it loud',
      '"!dist/**"', // yaml lib may re-fence, but the value must survive
      'Be gentle here.',
    ]) {
      expect(out!.content, survivor).toContain(survivor);
    }
    expect(coderabbitAdapter.validate([out!]).ok).toBe(true);
  });

  it('QUIET_PATH_NITS appends a path-scoped instructions entry (path kept, nits quieted)', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: GNARLY_CODERABBIT }]);
    const plan = coderabbitAdapter.plan([intent('QUIET_PATH_NITS', 'apps/web/**')], parsed.config);
    expect(plan.items).toEqual([
      { intentKind: 'QUIET_PATH_NITS', targetKey: 'apps/web/**', status: 'applied', note: undefined },
    ]);
    const [out] = coderabbitAdapter.serialize(plan);
    // A path_instructions entry for the glob — NOT a path_filters suppression.
    expect(out!.content).toContain('apps/web/**');
    expect(out!.content).toContain('nitpick-level');
    expect(out!.content).not.toContain('"!apps/web/**"');
    // The user's existing instruction survives.
    expect(out!.content).toContain('Be gentle here.');
    expect(coderabbitAdapter.validate([out!]).ok).toBe(true);
  });

  it('re-running the same intent against the emitted config is a noop (idempotent)', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: GNARLY_CODERABBIT }]);
    const first = coderabbitAdapter.plan([intent('SUPPRESS_PATH', 'src/**')], parsed.config);
    const [out] = coderabbitAdapter.serialize(first);
    const reparsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: out!.content }]);
    const second = coderabbitAdapter.plan([intent('SUPPRESS_PATH', 'src/**')], reparsed.config);
    expect(second.items[0]!.status).toBe('noop');
    expect(coderabbitAdapter.serialize(second)).toEqual([]);
  });

  it('LOWER_VERBOSITY never overwrites a user-set profile — degrades to an instruction', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: GNARLY_CODERABBIT }]);
    const plan = coderabbitAdapter.plan([intent('LOWER_VERBOSITY', 'nit')], parsed.config);
    expect(plan.items[0]!.status).toBe('degraded');
    const [out] = coderabbitAdapter.serialize(plan);
    expect(out!.content).toContain('profile: assertive'); // untouched
    expect(out!.content).toContain('severity floor'); // the degraded instruction landed
  });

  it('an absent file bootstraps from the template', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: null }]);
    const plan = coderabbitAdapter.plan(
      [intent('BOOTSTRAP_CONFIG', 'config'), intent('SUPPRESS_PATH', 'src/**')],
      parsed.config,
    );
    const [out] = coderabbitAdapter.serialize(plan);
    expect(out!.content).toContain('profile: chill');
    expect(out!.content).toContain('"!src/**"');
  });

  it('a broken YAML file is a refusal, not a best-effort edit', () => {
    const parsed = coderabbitAdapter.parse([{ path: CODERABBIT_PATH, text: 'a: [unclosed' }]);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('YAML');
  });
});

const GREPTILE_FIXTURE = `{
    "name": "my-repo",
    "ignorePatterns": ["dist/**"],
    "commentTypes": ["logic", "syntax"]
}
`;

describe('greptile adapter', () => {
  it('identity: no intents → no output', () => {
    const parsed = greptileAdapter.parse([{ path: GREPTILE_PATH, text: GREPTILE_FIXTURE }]);
    const plan = greptileAdapter.plan([], parsed.config);
    expect(greptileAdapter.serialize(plan)).toEqual([]);
  });

  it('SUPPRESS_PATH appends to ignorePatterns preserving key order and 4-space indent', () => {
    const parsed = greptileAdapter.parse([{ path: GREPTILE_PATH, text: GREPTILE_FIXTURE }]);
    const plan = greptileAdapter.plan([intent('SUPPRESS_PATH', 'src/**')], parsed.config);
    const [out] = greptileAdapter.serialize(plan);
    const json = JSON.parse(out!.content) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(['name', 'ignorePatterns', 'commentTypes']);
    expect(json.ignorePatterns).toEqual(['dist/**', 'src/**']);
    expect(out!.content).toContain('\n    "name"'); // detected 4-space indent kept
    expect(out!.content.endsWith('\n')).toBe(true);
  });

  it('LOWER_VERBOSITY degrades into a managed instructions block', () => {
    const parsed = greptileAdapter.parse([{ path: GREPTILE_PATH, text: GREPTILE_FIXTURE }]);
    const plan = greptileAdapter.plan([intent('LOWER_VERBOSITY', 'nit')], parsed.config);
    expect(plan.items[0]!.status).toBe('degraded');
    const [out] = greptileAdapter.serialize(plan);
    const json = JSON.parse(out!.content) as { instructions?: string };
    expect(json.instructions).toContain(MARKER_START);
    expect(json.instructions).toContain('severity floor');
  });
});

describe('copilot adapter (the 4,000-char budget)', () => {
  it('fits under the budget → applied; the whole-file length is validated', () => {
    const user = 'Existing instructions.\n';
    const parsed = copilotProseAdapter.parse([{ path: COPILOT_PATH, text: user }]);
    const plan = copilotProseAdapter.plan(
      [intent('LOWER_VERBOSITY', 'nit'), intent('SUPPRESS_CATEGORY', 'documentation')],
      parsed.config,
    );
    const applied = plan.items.filter((i) => i.status === 'applied');
    expect(applied).toHaveLength(2);
    const files = copilotProseAdapter.serialize(plan);
    expect(files[0]!.content).toContain('Existing instructions.');
    expect(files[0]!.content.length).toBeLessThanOrEqual(COPILOT_CHAR_BUDGET);
    expect(copilotProseAdapter.validate(files).ok).toBe(true);
  });

  it('over budget → lowest-priority slots dropped DETERMINISTICALLY and reported', () => {
    // 3,900 chars of user content leaves ~100 for the block — not enough for both slots.
    const user = 'x'.repeat(3900);
    const parsed = copilotProseAdapter.parse([{ path: COPILOT_PATH, text: user }]);
    const plan = copilotProseAdapter.plan(
      [intent('SUPPRESS_CATEGORY', 'documentation'), intent('AMPLIFY_PATH', 'lib/**')],
      parsed.config,
    );
    const dropped = plan.items.filter((i) => i.status === 'unsupported');
    expect(dropped.length).toBeGreaterThan(0);
    // AMPLIFY is lower priority than SUPPRESS — it must drop first.
    expect(dropped.map((d) => d.intentKind)).toContain('AMPLIFY_PATH');
    for (const d of dropped) expect(d.note).toContain('budget');
    for (const f of copilotProseAdapter.serialize(plan)) {
      expect(f.content.length).toBeLessThanOrEqual(COPILOT_CHAR_BUDGET);
    }
  });

  it('SUPPRESS_PATH degrades to the applyTo-scoped instructions file', () => {
    const parsed = copilotProseAdapter.parse([{ path: COPILOT_PATH, text: null }]);
    const plan = copilotProseAdapter.plan([intent('SUPPRESS_PATH', 'src/**')], parsed.config);
    expect(plan.items[0]!.status).toBe('degraded');
    const files = copilotProseAdapter.serialize(plan);
    const scoped = files.find((f) => f.path.includes('instructions/'));
    expect(scoped!.content).toContain('applyTo: "src/**"');
  });
});

describe('prose managed block', () => {
  it('upsert replaces ONLY the marker block; user text above and below survives', () => {
    const original = `Above.\n${MARKER_START}\nold\n${MARKER_END}\nBelow.\n`;
    const render = renderManagedBlock([intent('LOWER_VERBOSITY', 'nit')]);
    const upserted = upsertManagedBlock(original, render.block);
    expect(upserted.ok).toBe(true);
    if (upserted.ok) {
      expect(upserted.content).toContain('Above.');
      expect(upserted.content).toContain('Below.');
      expect(upserted.content).not.toContain('\nold\n');
      expect(extractManagedBlock(upserted.content)).toContain('severity floor');
    }
  });

  it('a malformed half-block is a refusal, never an overwrite', () => {
    const broken = `text\n${MARKER_START}\nno end marker`;
    const render = renderManagedBlock([intent('LOWER_VERBOSITY', 'nit')]);
    const upserted = upsertManagedBlock(broken, render.block);
    expect(upserted.ok).toBe(false);
  });

  it('the intents header line is verbatim-structured', () => {
    const render = renderManagedBlock([
      intent('SUPPRESS_PATH', 'src/**'),
      intent('LOWER_VERBOSITY', 'nit'),
    ]);
    expect(render.block).toContain(
      '<!-- limn:advisor:intents: SUPPRESS_PATH|src/** LOWER_VERBOSITY|nit -->',
    );
  });
});

describe('manifest interpreter', () => {
  const MANIFEST = JSON.stringify({
    format: 'yaml',
    configPath: 'bot.yaml',
    intents: {
      SUPPRESS_PATH: { keyPath: ['ignore'], valueTemplate: '{target}', listMode: 'append' },
      LOWER_VERBOSITY: { keyPath: ['minSeverity'], valueTemplate: 'minor', listMode: 'set' },
    },
  });

  it('validates structurally — unknown keys and traversal paths are rejections', () => {
    expect(validateManifest(JSON.parse(MANIFEST)).ok).toBe(true);
    expect(validateManifest({ format: 'yaml', configPath: 'a.yml', intents: {}, extra: 1 }).ok).toBe(false);
    expect(
      validateManifest({ format: 'yaml', configPath: '../evil.yml', intents: {} }).ok,
    ).toBe(false);
    expect(
      validateManifest({ format: 'yaml', configPath: '.github/workflows/x.yml', intents: {} }).ok,
    ).toBe(false);
  });

  it('executes a confirmed manifest: append + set against YAML, unmapped → unsupported', () => {
    const parsed = parseManifest(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const adapter = manifestAdapter(parsed.manifest);
    const current = adapter.parse([{ path: 'bot.yaml', text: 'ignore:\n  - dist/**\n' }]);
    const plan = adapter.plan(
      [intent('SUPPRESS_PATH', 'src/**'), intent('LOWER_VERBOSITY', 'nit'), intent('ESCALATE', 'security')],
      current.config,
    );
    expect(plan.items.map((i) => i.status)).toEqual(['applied', 'applied', 'unsupported']);
    const [out] = adapter.serialize(plan);
    expect(out!.content).toContain('src/**');
    expect(out!.content).toContain('minSeverity: minor');
    expect(out!.content).toContain('dist/**'); // user entry survives
  });
});

describe('lint template extraction (DeepSource normalizer)', () => {
  it('truncates at the first backtick and aggregates fires/acted-on', () => {
    expect(titleTemplate('Unused variable `foo` found')).toBe('Unused variable');
    expect(titleTemplate('### Doc comment missing for `bar`')).toBe('Doc comment missing for');
    expect(titleTemplate('short')).toBeNull();
    const stats = extractLintTemplates([
      { botUserId: 9, body: 'Unused variable `a` found', actedOn: false },
      { botUserId: 9, body: 'Unused variable `b` found\ndetail', actedOn: true },
      { botUserId: 9, body: 'Doc comment missing for `x`', actedOn: false },
    ]);
    expect(stats[0]).toEqual({ botUserId: 9, template: 'Unused variable', fires: 2, actedOn: 1 });
    expect(stats).toHaveLength(2);
  });
});
