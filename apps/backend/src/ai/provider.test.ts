// THE PROVIDER SEAM (ai/provider.ts): the registry and what the Claude provider puts on a run.
//   1. `LIMN_AI_PROVIDER`: unset / empty / 'claude' / 'auto' / garbage ⇒ Claude; 'codex' resolves to
//      the Codex provider (Phase 2), whose `runAgent` answers "not available yet" for every kind
//      outside the (empty) allow-list. Its `complete()` is tested in providers/codex.test.ts.
//   2. Roles resolve to Claude's models, and an explicit id ALWAYS wins (no call site's model moves).
//   3. The Claude provider's `runAgent` builds the SAME query() options each runner used to build:
//      the isolation, the path guard FIRST then the own-tools hook then the run's extras, the result
//      tools as ONE in-process server, `additionalDirectories` only when there are roots, the base
//      tool set / system prompt / agents only when given, and every message reaches `onMessage`.
//
//   pnpm --filter @pierre-review/backend test ai/provider
import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

let captured: { prompt: unknown; options: any } | null = null;
let replies: unknown[] = [];

vi.mock('./runtime.js', () => ({
  claudeExecutableOptions: () => ({ pathToClaudeCodeExecutable: '/x/claude' }),
  getAiRuntimeStatus: () => ({ runtime: 'ready', runtimeMessage: null }),
  loadAnthropicSdk: async () => {
    throw new Error('not in this test');
  },
  loadAgentSdk: async () => ({
    tool: (name: string, description: string, shape: unknown, handler: (a: unknown) => Promise<unknown>) => ({
      name,
      description,
      shape,
      handler,
    }),
    createSdkMcpServer: (o: unknown) => ({ server: o }),
    query: ({ prompt, options }: { prompt: unknown; options: any }) => {
      captured = { prompt, options };
      return (async function* () {
        const server = options.mcpServers ? Object.values(options.mcpServers)[0] : null;
        for (const t of (server as any)?.server?.tools ?? []) replies.push(await t.handler({ x: 1 }));
        yield { type: 'assistant', message: { content: [] } };
        yield { type: 'result', subtype: 'success', total_cost_usd: 0.5, num_turns: 2 };
      })();
    },
  }),
}));

const P = await import('./provider.js');
const { claudeProvider, CLAUDE_MODEL_FOR_ROLE } = await import('./providers/claude.js');
const { ISOLATED_MCP } = await import('./agent-isolation.js');

afterEach(() => {
  captured = null;
  replies = [];
});

describe('the registry (LIMN_AI_PROVIDER)', () => {
  it('reads the setting: unset, empty and unknown values are auto', () => {
    expect(P.aiProviderSetting({})).toBe('auto');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: '' })).toBe('auto');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: 'gemini' })).toBe('auto');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: ' Claude ' })).toBe('claude');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: 'auto' })).toBe('auto');
    expect(P.aiProviderSetting({ LIMN_AI_PROVIDER: 'CODEX' })).toBe('codex');
  });

  it('claude and auto (and anything unknown) are Claude', () => {
    for (const v of [undefined, '', 'claude', 'auto', 'openai']) {
      const env = v === undefined ? {} : { LIMN_AI_PROVIDER: v };
      expect(P.getActiveProvider(env).id).toBe('claude');
      expect(P.getActiveProvider(env)).toBe(claudeProvider);
    }
    expect(P.getProvider('claude')).toBe(claudeProvider);
  });

  it("codex resolves to the Codex provider; every agent kind still answers 'not available yet'", async () => {
    const codex = P.getActiveProvider({ LIMN_AI_PROVIDER: 'codex' });
    expect(codex.id).toBe('codex');
    expect(P.getProvider('codex')).toBe(codex);
    // Phase 2: the allow-list is EMPTY, so no agent runs on Codex — each kind says so in one sentence.
    expect(P.CODEX_AGENT_KINDS.size).toBe(0);
    for (const kind of ['review', 'fix', 'ci_review', 'docs_build'] as const) {
      await expect(
        codex.runAgent({ kind } as Parameters<typeof codex.runAgent>[0]),
      ).rejects.toThrow(P.codexKindNotAvailableMessage(kind));
    }
    expect(P.codexKindNotAvailableMessage('review')).toBe(
      'Codex cannot run pull request reviews in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.',
    );
    // The allow-list is the mechanism Phase 3 fills.
    expect(P.codexKindReady('review')).toBe(false);
    expect(P.codexKindReady('review', new Set(['review']))).toBe(true);
    // No rate-limit data rides a run's messages (the app-server reads the windows).
    expect(codex.usage.readingFromMessage({ type: 'rate_limit_event' }, 0)).toBeNull();
  });
});

describe('models are roles, and an explicit id always wins', () => {
  it('resolves each role to its Claude model', () => {
    expect(claudeProvider.resolveModel({ role: 'deep' })).toBe(CLAUDE_MODEL_FOR_ROLE.deep);
    expect(CLAUDE_MODEL_FOR_ROLE).toEqual({ deep: 'claude-opus-5-5', standard: 'claude-sonnet-5', fast: 'claude-haiku-5-5' });
  });

  it('keeps every call site’s exact model', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-some-future-model']) {
      const choice = P.claudeModelChoice(id);
      expect(choice.id).toBe(id);
      expect(claudeProvider.resolveModel(choice)).toBe(id);
    }
    expect(P.claudeModelChoice('claude-opus-5-5').role).toBe('deep');
    expect(P.claudeModelChoice('claude-sonnet-5').role).toBe('standard');
    expect(P.claudeModelChoice('claude-haiku-5-5').role).toBe('fast');
  });
});

const baseSpec = (over: Partial<Parameters<typeof claudeProvider.runAgent>[0]> = {}) => ({
  kind: 'ci_review' as const,
  model: P.claudeModelChoice('claude-sonnet-5'),
  effort: 'worktree' as const,
  prompt: 'PROMPT',
  system: 'SYS',
  cwd: '/tmp',
  roots: [] as string[],
  readOnlyRoots: [] as string[],
  writeRoots: [] as string[],
  budget: { usd: 2, turns: 9 },
  abortController: new AbortController(),
  claude: { allowedTools: ['Read', 'mcp__ci__submit_ci_review'], disallowedTools: ['Bash'] },
  ...over,
});

describe('the Claude provider builds the same query() options the runners did', () => {
  it('a run with result tools and roots', async () => {
    const seen: string[] = [];
    const extra = { hooks: [async () => ({ continue: true })] };
    const out = await claudeProvider.runAgent({
      ...baseSpec({
        roots: ['/tmp'],
        readOnlyRoots: ['/var'],
        tools: {
          server: 'ci',
          tools: [
            { name: 'submit_ci_review', description: 'D', shape: { s: 1 }, handle: () => ({ text: 'ok' }) },
            { name: 'other', description: 'E', shape: {}, handle: async () => ({ text: 'no', isError: true }) },
          ],
        },
      }),
      claude: {
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        extraPreToolUse: [extra],
        agents: { design: {} },
        builtinTools: ['Read'],
      },
      onMessage: (m) => seen.push(m.type),
    });
    expect(seen).toEqual(['assistant', 'result']);
    expect(out.result).toMatchObject({ type: 'result', total_cost_usd: 0.5 });
    const o = captured!.options;
    expect(captured!.prompt).toBe('PROMPT');
    expect(o).toMatchObject({
      model: 'claude-sonnet-5',
      systemPrompt: 'SYS',
      cwd: '/tmp',
      additionalDirectories: ['/tmp', '/var'],
      permissionMode: 'bypassPermissions',
      tools: ['Read'],
      allowedTools: ['Read'],
      disallowedTools: ['Bash'],
      maxTurns: 9,
      maxBudgetUsd: 2,
      agents: { design: {} },
      settingSources: [],
      ...ISOLATED_MCP,
      pathToClaudeCodeExecutable: '/x/claude',
    });
    expect(o.env).toBeTypeOf('object');
    expect(o.abortController).toBeInstanceOf(AbortController);
    // The ONE in-process server, its tools in order, each reply one text block (+ isError only when set).
    expect(Object.keys(o.mcpServers)).toEqual(['ci']);
    expect(o.mcpServers.ci.server).toMatchObject({ name: 'ci', version: '1.0.0' });
    expect(o.mcpServers.ci.server.tools.map((t: any) => [t.name, t.description, t.shape])).toEqual([
      ['submit_ci_review', 'D', { s: 1 }],
      ['other', 'E', {}],
    ]);
    expect(replies).toEqual([
      { content: [{ type: 'text', text: 'ok' }] },
      { content: [{ type: 'text', text: 'no' }], isError: true },
    ]);
    // ⚠ The path guard FIRST, then own-tools-only, then the run's extras.
    const pre = o.hooks.PreToolUse;
    expect(pre).toHaveLength(3);
    expect(pre[2]).toBe(extra);
    const [guard] = pre[0].hooks;
    expect(await guard({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(await guard({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/tmp/x' } })).toEqual({ continue: true });
    // /var is READ-ONLY: Read passes, Write is refused.
    expect(await guard({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/var/x' } })).toEqual({ continue: true });
    expect(await guard({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/var/x' } })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    const [own] = pre[1].hooks;
    expect(await own({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ci__submit_ci_review' })).toEqual({ continue: true });
    expect(await own({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Gmail__send' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('a run with no tools, no roots, no system prompt sends none of them', async () => {
    await claudeProvider.runAgent({ ...baseSpec({ system: undefined }) });
    const o = captured!.options;
    for (const k of ['mcpServers', 'additionalDirectories', 'systemPrompt', 'tools', 'agents']) expect(o).not.toHaveProperty(k);
    expect(o.hooks.PreToolUse).toHaveLength(2);
    const [own] = o.hooks.PreToolUse[1].hooks;
    // No server registered ⇒ every MCP tool is foreign.
    expect(await own({ hook_event_name: 'PreToolUse', tool_name: 'mcp__ci__submit_ci_review' })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('per-model effort comes from the run’s effort profile (review/model-options.ts)', async () => {
    await claudeProvider.runAgent({ ...baseSpec({ model: P.claudeModelChoice('claude-opus-5-5'), effort: 'diff_only' }) });
    expect(captured!.options).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', thinking: { type: 'adaptive' } });
  });

  it('a throw from onMessage ends the run like a throw in the loop body did', async () => {
    await expect(
      claudeProvider.runAgent({
        ...baseSpec(),
        onMessage: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
  });
});
