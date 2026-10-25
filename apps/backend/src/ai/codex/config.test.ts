// THE CODEX ARGV (ai/codex/config.ts) — ONE TEST PER KEY, because each one closes a leak the spike
// measured (docs/CODEX-SPIKE.md § 1–5) and a dropped key fails silently: the run still works, it just
// reads AGENTS.md, or the user's skills, or writes to /tmp.
//
//   pnpm --filter @pierre-review/backend test ai/codex/config
import { describe, expect, it } from 'vitest';
import {
  buildExecArgs,
  codexBaseEnv,
  codexChildEnv,
  hookConfig,
  mcpConfig,
  toResumeArgs,
  tomlString,
  tomlValue,
  type CodexExecContext,
} from './config.js';
import type { CodexHookConfig, CodexMcpConfig } from './types.js';

const MCP: CodexMcpConfig = {
  id: 'workspace',
  command: '/usr/bin/node',
  args: ['/limn/workspace-mcp.js', '--read', '/wt'],
  env: {},
  default_tools_approval_mode: 'approve',
};
const HOOK_OVERRIDE =
  'hooks.PreToolUse=[{matcher="apply_patch|mcp__workspace__.*", hooks=[{type="command", command="/limn/guard.sh", timeout=30}]}]';
const HOOK: CodexHookConfig = {
  override: HOOK_OVERRIDE,
  matcher: 'apply_patch|mcp__workspace__.*',
  command: '/limn/guard.sh',
  timeoutSec: 30,
  trustKey: '/<session-flags>/config.toml:pre_tool_use:0:0',
  trustedHash: 'sha256:abc',
  env: { LIMN_CODEX_GUARD: 'roots' },
};
const CTX: CodexExecContext = {
  home: '/home/.limn/codex',
  mcp: MCP,
  hook: HOOK,
  schemaPath: '/tmp/s/schema.json',
  model: 'gpt-6-luna',
  effort: 'low',
};

const readArgs = (over: Partial<CodexExecContext> = {}, system?: string): string[] =>
  buildExecArgs({ cwd: '/wt', writeRoots: [], ...(system !== undefined ? { system } : {}) }, { ...CTX, ...over });
const writeArgs = (): string[] => buildExecArgs({ cwd: '/wt', writeRoots: ['/wt'] }, CTX);

/** Every `-c` value, by key. */
function cfg(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c') {
      const kv = args[i + 1]!;
      const eq = kv.indexOf('=');
      m.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  }
  return m;
}

describe('the exec flags', () => {
  it('starts with `exec --json --strict-config` (an unknown -c key is an error, never ignored)', () => {
    const a = readArgs();
    expect(a.slice(0, 3)).toEqual(['exec', '--json', '--strict-config']);
  });
  it('skips the git repo check', () => expect(readArgs()).toContain('--skip-git-repo-check'));
  it('sets the working root with -C', () => {
    const a = readArgs();
    expect(a[a.indexOf('-C') + 1]).toBe('/wt');
  });
  it('passes the result schema with --output-schema, and omits it for free text', () => {
    const a = readArgs();
    expect(a[a.indexOf('--output-schema') + 1]).toBe('/tmp/s/schema.json');
    expect(readArgs({ schemaPath: null })).not.toContain('--output-schema');
  });
  it('sets the model with -m and the effort with model_reasoning_effort', () => {
    const a = readArgs();
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-6-luna');
    expect(cfg(a).get('model_reasoning_effort')).toBe('"low"');
  });
  it('reads the prompt from stdin: the LAST argument is `-`, and the prompt is never in argv', () => {
    expect(readArgs().at(-1)).toBe('-');
  });
  it('is NOT ephemeral (a validation retry resumes the session), and never ignores Limn’s own config', () => {
    const a = readArgs();
    expect(a).not.toContain('--ephemeral');
    expect(a).not.toContain('--ignore-user-config');
    expect(a).not.toContain('--dangerously-bypass-hook-trust');
    expect(a).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

describe('the locked keys (one test each)', () => {
  const c = cfg(readArgs());
  it('approval_policy = never', () => expect(c.get('approval_policy')).toBe('"never"'));
  it('features.shell_tool = false (NO SHELL)', () => expect(c.get('features.shell_tool')).toBe('false'));
  it('features.view_image = false', () => expect(c.get('features.view_image')).toBe('false'));
  it('web_search = disabled', () => expect(c.get('web_search')).toBe('"disabled"'));
  it('history.persistence = none', () => expect(c.get('history.persistence')).toBe('"none"'));
  it('analytics.enabled = false', () => expect(c.get('analytics.enabled')).toBe('false'));
  it('agents.enabled = false', () => expect(c.get('agents.enabled')).toBe('false'));
  it('project_doc_max_bytes = 0 (keeps a PR’s AGENTS.md out of the prompt)', () =>
    expect(c.get('project_doc_max_bytes')).toBe('0'));
  it('skills.include_instructions = false (user skills arrive through HOME)', () =>
    expect(c.get('skills.include_instructions')).toBe('false'));
  it('features.image_generation = false', () => expect(c.get('features.image_generation')).toBe('false'));
  it('features.goals = false', () => expect(c.get('features.goals')).toBe('false'));
  it('features.apps = false (ChatGPT apps / connectors: codex_apps)', () => expect(c.get('features.apps')).toBe('false'));
  it('features.plugins = false', () => expect(c.get('features.plugins')).toBe('false'));
  it('features.remote_plugin = false', () => expect(c.get('features.remote_plugin')).toBe('false'));
  it('features.tool_suggest = false (no plugin / connector install suggested mid-run)', () =>
    expect(c.get('features.tool_suggest')).toBe('false'));
  it('features.skill_mcp_dependency_install = false', () =>
    expect(c.get('features.skill_mcp_dependency_install')).toBe('false'));
  it('features.memories = false', () => expect(c.get('features.memories')).toBe('false'));
  it('memories.generate_memories = false', () => expect(c.get('memories.generate_memories')).toBe('false'));
  it('memories.use_memories = false', () => expect(c.get('memories.use_memories')).toBe('false'));
  it('the working root is an UNTRUSTED project — as ONE inline table (Codex splits -c keys on every dot)', () => {
    expect(c.get('projects')).toBe('{"/wt" = {"trust_level" = "untrusted"}}');
    const dotted = cfg(buildExecArgs({ cwd: '/a/.claude/wt.x', writeRoots: [] }, CTX));
    expect(dotted.get('projects')).toBe('{"/a/.claude/wt.x" = {"trust_level" = "untrusted"}}');
    expect([...dotted.keys()].some((k) => k.startsWith('projects.'))).toBe(false);
  });
});

describe('the sandbox', () => {
  it('a run with no write roots is read-only, with no workspace-write keys', () => {
    const c = cfg(readArgs());
    expect(c.get('sandbox_mode')).toBe('"read-only"');
    expect([...c.keys()].some((k) => k.startsWith('sandbox_workspace_write.'))).toBe(false);
  });
  it('a write run is workspace-write', () => expect(cfg(writeArgs()).get('sandbox_mode')).toBe('"workspace-write"'));
  it('writable_roots = the write roots', () =>
    expect(cfg(writeArgs()).get('sandbox_workspace_write.writable_roots')).toBe('["/wt"]'));
  it('network_access = false', () => expect(cfg(writeArgs()).get('sandbox_workspace_write.network_access')).toBe('false'));
  it('exclude_slash_tmp = true (/tmp is writable by default — spike run 7 wrote outside)', () =>
    expect(cfg(writeArgs()).get('sandbox_workspace_write.exclude_slash_tmp')).toBe('true'));
  it('exclude_tmpdir_env_var = true ($TMPDIR likewise)', () =>
    expect(cfg(writeArgs()).get('sandbox_workspace_write.exclude_tmpdir_env_var')).toBe('true'));
  it('refuses a write run whose working root is not a write root (workspace-write always opens the cwd)', () => {
    expect(() => buildExecArgs({ cwd: '/elsewhere', writeRoots: ['/wt'] }, CTX)).toThrow(/write roots/);
  });
});

describe('the system prompt', () => {
  it('rides developer_instructions, escaped as a TOML string', () => {
    expect(cfg(readArgs({}, 'Be "careful"\nline two')).get('developer_instructions')).toBe('"Be \\"careful\\"\\nline two"');
  });
  it('is absent when the run has none (or an empty one)', () => {
    expect(cfg(readArgs()).has('developer_instructions')).toBe(false);
    expect(cfg(readArgs({}, '')).has('developer_instructions')).toBe(false);
  });
});

describe('the workspace MCP server', () => {
  const c = cfg(readArgs());
  it('mcp_servers.workspace.command', () => expect(c.get('mcp_servers.workspace.command')).toBe('"/usr/bin/node"'));
  it('mcp_servers.workspace.args', () =>
    expect(c.get('mcp_servers.workspace.args')).toBe('["/limn/workspace-mcp.js", "--read", "/wt"]'));
  it('mcp_servers.workspace.default_tools_approval_mode = approve (else every call fails under never)', () =>
    expect(c.get('mcp_servers.workspace.default_tools_approval_mode')).toBe('"approve"'));
  it('mcp_servers.workspace.env only when given', () => {
    expect(c.has('mcp_servers.workspace.env')).toBe(false);
    expect(cfg(mcpConfig({ ...MCP, env: { LOG: '/x' } })).get('mcp_servers.workspace.env')).toBe('{"LOG" = "/x"}');
    expect(cfg(mcpConfig({ ...MCP, env: {} })).has('mcp_servers.workspace.env')).toBe(false);
  });
  it('is absent when the run has none (the one-shot completion)', () => {
    expect([...cfg(readArgs({ mcp: null })).keys()].some((k) => k.startsWith('mcp_servers'))).toBe(false);
  });
});

describe('the path-guard hook', () => {
  it("hooks.PreToolUse = hook.ts's own override, VERBATIM (the text Codex hashes and hooks/list read)", () => {
    expect(hookConfig(HOOK)).toEqual(['-c', HOOK_OVERRIDE]);
    const a = readArgs();
    expect(a.filter((x) => x.startsWith('hooks.'))).toEqual([HOOK_OVERRIDE]);
  });
  it("the hook's environment never reaches the argv (it rides the process env)", () => {
    expect(readArgs().join(' ')).not.toContain('LIMN_CODEX_GUARD');
  });
  it('is absent when null', () => expect(cfg(readArgs({ hook: null })).has('hooks.PreToolUse')).toBe(false));
});

describe('resume, env and TOML', () => {
  it('resume keeps every option and puts `resume <id>` before the stdin marker', () => {
    const a = writeArgs();
    const r = toResumeArgs(a, '01a17353-4f89-7731-94fb-b3fbedcacd20');
    expect(r.slice(0, -3)).toEqual(a.slice(0, -1));
    expect(r.slice(-3)).toEqual(['resume', '01a17353-4f89-7731-94fb-b3fbedcacd20', '-']);
    expect(() => toResumeArgs(a, '--last')).toThrow();
    expect(() => toResumeArgs(['exec', 'x'], 'abc')).toThrow();
  });
  it('the child env is the minimum: CODEX_HOME, PATH, HOME — never Limn’s secrets', () => {
    const env = codexChildEnv('/h', { PATH: '/bin', HOME: '/u', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g', OPENAI_API_KEY: 'o' });
    expect(env).toEqual({ CODEX_HOME: '/h', PATH: '/bin', HOME: '/u' });
    expect(codexChildEnv('/h', {}, 'sk-x')).toEqual({ CODEX_HOME: '/h', CODEX_API_KEY: 'sk-x' });
    expect(codexBaseEnv({ PATH: '/bin', OPENAI_API_KEY: 'o', SESSION_SECRET: 's', LANG: 'C' })).toEqual({ PATH: '/bin', LANG: 'C' });
  });
  it('TOML strings are valid for every input: lone surrogates and DEL are escaped', () => {
    expect(tomlString('a\ud800b')).toBe('"a�b"');
    expect(tomlString('\u{1F600}')).toBe('"\u{1F600}"');
    expect(tomlString('x\u007fy')).toBe('"x\\u007fy"');
    expect(tomlString('tab\tq"\\')).toBe('"tab\\tq\\"\\\\"');
    expect(tomlValue({ 'a.b': [1, true, 's'] })).toBe('{"a.b" = [1, true, "s"]}');
    expect(() => tomlValue(Number.NaN)).toThrow();
  });
});
