// THE PROVIDER SEAM (ai/provider.ts): the registry and what the Claude provider puts on a run.
//   1. `LIMN_AI_PROVIDER`: unset / empty / 'claude' / 'auto' / garbage ⇒ Claude; 'codex' resolves to
//      the Codex provider (Phase 2), whose `runAgent` answers "not available yet" for every kind
//      outside the allow-list (each Phase 3 stream fills its own kinds file), and whose `detect()` reports the install / sign-in facts but
//      never `available` (agents cannot run). Its `complete()` is tested in providers/codex.test.ts.
//      `auto` never picks Codex while it cannot run.
//   2. Roles resolve to Claude's models, and an explicit id ALWAYS wins (no call site's model moves).
//   3. The Claude provider's `runAgent` builds the SAME query() options each runner used to build:
//      the isolation, the path guard FIRST then the own-tools hook then the run's extras, the result
//      tools as ONE in-process server, `additionalDirectories` only when there are roots, the base
//      tool set / system prompt / agents only when given, and every message reaches the Claude-only
//      `claude.onMessage` escape hatch.
//   4. THE NEUTRAL STREAM: per assistant message ONE `step` (the de-duplicated live usage, the activity
//      lines in the run's vocabulary, the text), the result message as the `outcome` (also returned),
//      a specialist's steps prefixed only on a review run, and the escape hatch BEFORE the step.
//
//   pnpm --filter @pierre-review/backend test ai/provider
import { afterEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */

let captured: { prompt: unknown; options: any } | null = null;
let replies: unknown[] = [];
// A test may replace the SDK's message stream (null: one empty assistant message, then the result).
let stream: unknown[] | null = null;

// Codex's home lives under the data directory: point it at an empty temp folder, never ~/.limn.
process.env.LIMN_DATA_DIR = (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'limn-provider-test-'),
);
delete process.env.OPENAI_API_KEY;

vi.mock('./runtime.js', () => ({
  claudeExecutableOptions: () => ({ pathToClaudeCodeExecutable: '/x/claude' }),
  getAiRuntimeStatus: () => ({ runtime: 'ready', runtimeMessage: null }),
  // Codex is not installed in this test.
  codexBinaryPath: () => null,
  getCodexRuntimeStatus: () => ({ runtime: 'absent', runtimeMessage: null }),
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
        if (stream) {
          for (const m of stream) yield m;
          return;
        }
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
  stream = null;
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

  it("codex resolves to the Codex provider; every kind not yet ported answers 'not available yet'", async () => {
    const codex = P.getActiveProvider({ LIMN_AI_PROVIDER: 'codex' });
    expect(codex.id).toBe('codex');
    expect(P.getProvider('codex')).toBe(codex);
    // Phase 3: each stream adds the kinds it ported to its own file; every OTHER kind says so in one
    // sentence, and a ported kind passes the allow-list and stops at the sign-in (none in this test).
    expect(P.codexRunnable()).toBe(P.ALL_AGENT_KINDS.every((k) => P.CODEX_AGENT_KINDS.has(k)));
    // Phase 3 complete: every kind is ported (`plan` last, after its live runs passed), so Codex is
    // runnable; `auto` still picks it only when Claude is not signed in (pickAutoProvider below).
    expect(P.ALL_AGENT_KINDS.filter((k) => !P.CODEX_AGENT_KINDS.has(k))).toEqual([]);
    expect(P.CODEX_RUNNABLE).toBe(true);
    for (const kind of P.ALL_AGENT_KINDS.filter((k) => !P.CODEX_AGENT_KINDS.has(k))) {
      await expect(
        codex.runAgent({ kind } as Parameters<typeof codex.runAgent>[0]),
      ).rejects.toThrow(P.codexKindNotAvailableMessage(kind));
    }
    for (const kind of P.CODEX_AGENT_KINDS) {
      await expect(codex.runAgent({ kind } as Parameters<typeof codex.runAgent>[0])).rejects.toThrow('Codex is not signed in');
    }
    expect(P.codexKindNotAvailableMessage('review')).toBe(
      'Codex cannot run pull request reviews in this version of Limn yet. Choose Claude in Settings → AI.',
    );
    // The allow-list is the mechanism Phase 3 fills.
    expect(P.codexKindReady('review', new Set())).toBe(false);
    expect(P.codexKindReady('review', new Set(['review']))).toBe(true);
    // No rate-limit data rides a run's messages (the app-server reads the windows).
    expect(codex.usage.readingFromMessage({ type: 'rate_limit_event' }, 0)).toBeNull();
    // Phase 2: detect() reports the install and the sign-in truthfully, but never `available`.
    expect(await codex.detect()).toEqual({
      id: 'codex',
      available: false,
      route: 'none',
      // The install sentence first (as /api/me), else CODEX_NOT_AVAILABLE_MESSAGE.
      message: 'Codex is not set up yet. Run: limn ai install codex',
      installed: false,
      signedIn: false,
      plan: null,
    });
    expect(codex.credentialRoute()).toBe('none');
    expect(codex.usage.probeReady()).toBe(false);
    await expect(codex.usage.probe()).rejects.toThrow(/Codex is not set up yet/);
  });

  it('with OPENAI_API_KEY set, Codex reports the API-key rung — and still runs no agent', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const codex = P.getProvider('codex');
      expect(codex.credentialRoute()).toBe('api_key');
      expect((await codex.detect()).available).toBe(false);
      // A ported kind passes the allow-list, then the key route is refused (unpriced).
      await expect(codex.runAgent({ kind: 'review' } as Parameters<typeof codex.runAgent>[0])).rejects.toThrow(
        'Codex with an OpenAI API key is not available yet',
      );
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('Codex is runnable (every kind ported), yet an API key alone still never makes auto pick it', () => {
    expect(P.CODEX_RUNNABLE).toBe(true);
    expect(P.codexRunnable()).toBe(true);
    // Runnable means EVERY kind is ported, never just one.
    expect(P.codexRunnable(new Set(['review']))).toBe(false);
    expect(P.codexRunnable(new Set(P.ALL_AGENT_KINDS))).toBe(true);
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      expect(P.getActiveProvider({ OPENAI_API_KEY: 'sk-test' }).id).toBe('claude');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('the kinds (Phase 3 foundation)', () => {
  it('CODEX_AGENT_KINDS is the union of the four streams’ files, each holding only its own stream’s kinds', async () => {
    const files = await Promise.all([
      import('./codex/kinds/review.js').then((m) => m.CODEX_REVIEW_KINDS),
      import('./codex/kinds/fix.js').then((m) => m.CODEX_FIX_KINDS),
      import('./codex/kinds/tickets.js').then((m) => m.CODEX_TICKETS_KINDS),
      import('./codex/kinds/docs.js').then((m) => m.CODEX_DOCS_KINDS),
    ]);
    // Each stream adds a kind to ITS file only in the commit that ports it (docs/CODEX-PLAN.md § 5).
    const own: string[][] = [
      ['review', 'review_chat', 'thread_check'],
      ['fix', 'plan', 'resolve'],
      ['ticket_review', 'pr_card', 'ci_review', 'story_docs'],
      ['diagram', 'sprint_paths', 'docs_build', 'docs_chat'],
    ];
    files.forEach((f, i) => expect(f.every((k) => own[i]!.includes(k)), String(i)).toBe(true));
    const all = files.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...P.CODEX_AGENT_KINDS]).toEqual(all);
  });

  it('the backend’s kind list is the shared one, and every run kind adds the one-shot `complete`', async () => {
    const { AI_AGENT_KINDS, AI_RUN_KINDS } = await import('@pierre-review/shared');
    expect([...P.ALL_AGENT_KINDS].sort()).toEqual([...AI_AGENT_KINDS].sort());
    expect([...P.ALL_RUN_KINDS].sort()).toEqual([...AI_RUN_KINDS].sort());
    expect(P.ALL_RUN_KINDS.at(-1)).toBe('complete');
    // `complete` runs on Codex now; an agent kind only once its stream ports it.
    expect(P.codexRunKindReady('complete')).toBe(true);
    expect(P.codexRunKindReady('review', new Set())).toBe(false);
    expect(P.codexRunKindReady('review', new Set(['review']))).toBe(true);
  });

  it('the active provider is one question, asked by the registry and the pre-flight alike', () => {
    for (const v of [undefined, '', 'claude', 'auto']) {
      const env = v === undefined ? {} : { LIMN_AI_PROVIDER: v };
      expect(P.activeProviderId(env)).toBe('claude');
    }
    expect(P.activeProviderId({ LIMN_AI_PROVIDER: 'codex' })).toBe('codex');
  });
});

describe('the auto rule (decided: Claude when both are signed in)', () => {
  const pick = P.pickAutoProvider;
  it('both signed in ⇒ Claude; neither ⇒ Claude; Claude alone ⇒ Claude', () => {
    expect(pick({ claudeReady: true, codexReady: true, codexRunnable: true })).toBe('claude');
    expect(pick({ claudeReady: false, codexReady: false, codexRunnable: true })).toBe('claude');
    expect(pick({ claudeReady: true, codexReady: false, codexRunnable: true })).toBe('claude');
  });
  it('an OpenAI API key ALONE never makes Codex ready (the key route is refused): auto stays Claude', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: 'sk-test-only-key' };
    delete env.CODEX_API_KEY;
    const r = P.autoReadiness(env);
    expect(r.codexReady).toBe(false);
    // Even with no Claude credential and a Codex able to run, auto does not pick a refused route.
    expect(pick({ ...r, claudeReady: false, codexRunnable: true })).toBe('claude');
    expect(P.getActiveProvider({ ...env, LIMN_AI_PROVIDER: 'auto' }).id).toBe('claude');
  });
  it('Codex alone ⇒ Codex, but only once Codex can run', () => {
    expect(pick({ claudeReady: false, codexReady: true, codexRunnable: true })).toBe('codex');
    expect(pick({ claudeReady: false, codexReady: true, codexRunnable: false })).toBe('claude');
  });
});

describe('Codex models are roles (docs/CODEX-SPIKE.md § 8)', () => {
  it('deep / standard / fast resolve to the pinned Codex models; a Claude id never reaches Codex', () => {
    const codex = P.getProvider('codex');
    expect(P.CODEX_MODEL_FOR_ROLE).toEqual({ deep: 'gpt-6.1-sol', standard: 'gpt-6.1-terra', fast: 'gpt-6-luna' });
    expect(codex.resolveModel({ role: 'fast' })).toBe('gpt-6-luna');
    expect(codex.resolveModel(P.claudeModelChoice('claude-opus-5-5'))).toBe('gpt-6.1-sol');
    expect(codex.resolveModel({ role: 'standard', id: 'gpt-6-sol' })).toBe('gpt-6-sol');
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
        onMessage: (m) => seen.push(m.type),
      },
    });
    expect(seen).toEqual(['assistant', 'result']);
    expect(out.outcome).toEqual({ subtype: 'success', text: null, costUsd: 0.5, numTurns: 2, usage: null });
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
        claude: {
          ...baseSpec().claude,
          onMessage: () => {
            throw new Error('boom');
          },
        },
      }),
    ).rejects.toThrow('boom');
  });

  it('a throw from onProgress ends the run the same way', async () => {
    await expect(
      claudeProvider.runAgent({
        ...baseSpec(),
        onProgress: () => {
          throw new Error('bang');
        },
      }),
    ).rejects.toThrow('bang');
  });
});

describe('the neutral stream (Claude): steps and the outcome, derived from the SDK messages', () => {
  const assistant = (over: Record<string, unknown>, content: unknown[], usage: Record<string, number> = {}) => ({
    type: 'assistant',
    message: { content, usage },
    ...over,
  });

  it('one step per assistant message: de-duplicated live usage, the activity lines, the text; then the outcome', async () => {
    stream = [
      assistant({ request_id: 'r1', uuid: 'u1' }, [{ type: 'text', text: 'Looking  at\nthe code' }], { input_tokens: 10, output_tokens: 1 }),
      // The SAME request re-emitted (a thinking + a tool message): counted once, by per-field max.
      assistant({ request_id: 'r1', uuid: 'u2' }, [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }], { input_tokens: 10, output_tokens: 5 }),
      assistant({ request_id: 'r2', uuid: 'u3' }, [{ type: 'tool_use', id: 't2', name: 'mcp__review__submit_review', input: {} }], { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 7 }),
      { type: 'user', message: { content: [] } },
      {
        type: 'result',
        subtype: 'success',
        result: 'All done.',
        total_cost_usd: 0.25,
        num_turns: 3,
        modelUsage: { 'claude-opus-5-5': { inputTokens: 13, outputTokens: 7, cacheReadInputTokens: 7, cacheCreationInputTokens: 0 } },
      },
    ];
    const progress: any[] = [];
    const out = await claudeProvider.runAgent({ ...baseSpec(), kind: 'review', onProgress: (p) => progress.push(p) });
    expect(progress.map((p) => p.kind)).toEqual(['step', 'step', 'step', 'outcome']);
    expect(progress[0]).toEqual({
      kind: 'step',
      lines: ['Looking at the code'],
      text: 'Looking  at\nthe code',
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    expect(progress[1]).toMatchObject({ lines: ['Read /w/a.ts'], text: '', usage: { inputTokens: 10, outputTokens: 5 } });
    expect(progress[2]).toMatchObject({ lines: ['Submitting review…'], usage: { inputTokens: 13, outputTokens: 7, cacheReadTokens: 7 } });
    const outcome = {
      subtype: 'success',
      text: 'All done.',
      costUsd: 0.25,
      numTurns: 3,
      usage: { inputTokens: 13, outputTokens: 7, cacheReadTokens: 7, cacheCreationTokens: 0 },
    };
    expect(progress[3]).toEqual({ kind: 'outcome', outcome });
    expect(out.outcome).toEqual(outcome);
  });

  it("an error result keeps Claude's subtype and no text; a missing cost or turn count is null", async () => {
    stream = [{ type: 'result', subtype: 'error_max_turns', result: 'partial' }];
    const out = await claudeProvider.runAgent({ ...baseSpec() });
    expect(out.outcome).toEqual({ subtype: 'error_max_turns', text: null, costUsd: null, numTurns: null, usage: null });
  });

  it("the fixer's vocabulary names the write tools", async () => {
    stream = [assistant({ uuid: 'a' }, [{ type: 'tool_use', id: 'x', name: 'mcp__fix__submit_fix', input: {} }])];
    const fix: any[] = [];
    await claudeProvider.runAgent({ ...baseSpec(), kind: 'fix', activity: 'fix', onProgress: (p) => fix.push(p) });
    expect(fix[0].lines).toEqual(['Recording fix summary…']);
    const read: any[] = [];
    await claudeProvider.runAgent({ ...baseSpec(), onProgress: (p) => read.push(p) });
    expect(read[0].lines).toEqual(['mcp__fix__submit_fix …']);
  });

  it("a specialist's own steps carry its name, on a review run only", async () => {
    stream = [
      assistant({ uuid: 'a' }, [{ type: 'tool_use', id: 'd1', name: 'Agent', input: { subagent_type: 'security' } }]),
      assistant({ uuid: 'b', parent_tool_use_id: 'd1' }, [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/w/x.ts' } }]),
    ];
    const review: any[] = [];
    await claudeProvider.runAgent({ ...baseSpec(), kind: 'review', onProgress: (p) => review.push(p) });
    expect(review.map((p) => p.lines)).toEqual([['Asking the security specialist'], ['security: Read /w/x.ts']]);
    const other: any[] = [];
    await claudeProvider.runAgent({ ...baseSpec(), kind: 'ci_review', onProgress: (p) => other.push(p) });
    expect(other[1].lines).toEqual(['Read /w/x.ts']);
  });

  it('the escape hatch sees each raw message BEFORE its step', async () => {
    stream = [assistant({ uuid: 'a' }, [{ type: 'text', text: 'hi' }])];
    const order: string[] = [];
    await claudeProvider.runAgent({
      ...baseSpec(),
      claude: { ...baseSpec().claude, onMessage: (m) => order.push(`raw:${m.type}`) },
      onProgress: (p) => order.push(p.kind),
    });
    expect(order).toEqual(['raw:assistant', 'step']);
  });
});
