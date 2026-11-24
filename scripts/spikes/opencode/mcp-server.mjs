// Spike stand-in for Ensemble's workspace MCP server + one result tool.
// read_file is path-guarded to ROOT; submit_review records its answer to RESULT_FILE.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = fs.realpathSync(process.env.SPIKE_ROOT);
const RESULT_FILE = process.env.SPIKE_RESULT_FILE;
const log = (m) => fs.appendFileSync(process.env.SPIKE_MCP_LOG, `${new Date().toISOString()} ${m}\n`);

const server = new McpServer({ name: 'workspace', version: '0.0.1' });

server.tool('read_file', 'Read a file in the workspace, by path relative to the workspace root.', { path: z.string() }, async ({ path: p }) => {
  const abs = path.resolve(ROOT, p);
  let real;
  try { real = fs.realpathSync(abs); } catch { log(`read_file MISSING ${p}`); return { content: [{ type: 'text', text: 'No such file.' }], isError: true }; }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) { log(`read_file DENIED ${p}`); return { content: [{ type: 'text', text: 'Outside the workspace.' }], isError: true }; }
  log(`read_file OK ${p}`);
  return { content: [{ type: 'text', text: fs.readFileSync(real, 'utf8') }] };
});

server.tool('list_files', 'List the files in the workspace.', {}, async () => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git') continue; const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(path.relative(ROOT, f)); } };
  walk(ROOT);
  log(`list_files ${out.length}`);
  return { content: [{ type: 'text', text: out.join('\n') }] };
});

server.tool('submit_review', 'Submit the final review. Call exactly once, at the end.', {
  summary: z.string(),
  findings: z.array(z.object({ file: z.string(), line: z.number().int(), severity: z.enum(['nit', 'minor', 'major', 'critical']), body: z.string() })),
}, async (args) => {
  log(`submit_review ${JSON.stringify(args).length} bytes`);
  fs.writeFileSync(RESULT_FILE, JSON.stringify(args, null, 2));
  return { content: [{ type: 'text', text: 'Review received.' }] };
});

await server.connect(new StdioServerTransport());
log('started');
