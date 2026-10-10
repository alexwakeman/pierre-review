import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isForeignMcpTool, mcpServerOf, ownToolsOnlyHook } from './agent-isolation.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('agent isolation', () => {
  it('names the server of an MCP tool, and nothing for a built-in', () => {
    expect(mcpServerOf('mcp__claude_ai_Claude_Docs__delete')).toBe('claude_ai_Claude_Docs');
    expect(mcpServerOf('mcp__review__submit_review')).toBe('review');
    expect(mcpServerOf('Read')).toBeNull();
  });

  it('refuses a connector tool and allows the run’s own tools and built-ins', async () => {
    expect(isForeignMcpTool('mcp__claude_ai_Claude_Docs__create', ['review'])).toBe(true);
    expect(isForeignMcpTool('mcp__review__submit_review', ['review'])).toBe(false);
    expect(isForeignMcpTool('Grep', [])).toBe(false);
    const [hook] = ownToolsOnlyHook(['fix']).hooks;
    const denied = await hook!({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Gmail__send' });
    expect(denied).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await hook!({ hook_event_name: 'PreToolUse', tool_name: 'mcp__fix__submit_fix' })).toEqual({ continue: true });
  });

  it('every Agent SDK query() call site is isolated', () => {
    const sites = sourceFiles(SRC).filter(
      (f) => !f.endsWith('agent-isolation.ts') && /(?:const|await)\s+\w*\s*=?\s*query\(\{/.test(readFileSync(f, 'utf8')),
    );
    expect(sites.length).toBeGreaterThanOrEqual(7);
    for (const f of sites) {
      const src = readFileSync(f, 'utf8');
      const where = relative(SRC, f);
      expect(src, `${where} must spread ISOLATED_MCP`).toMatch(/\.\.\.ISOLATED_MCP/);
      expect(src, `${where} must add ownToolsOnlyHook to PreToolUse`).toMatch(/ownToolsOnlyHook\(/);
    }
  });
});
