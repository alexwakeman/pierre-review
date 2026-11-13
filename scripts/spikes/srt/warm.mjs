// Warm agent: one long-lived `claude` in stream-json input mode, started ahead of the question.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const chat = process.env.SPIKE_CHAT ?? (() => { const r = (process.env.SPIKE_ROOT ?? '/tmp/lq-srt') + '/chats'; return `${r}/${fs.readdirSync(r).pop()}`; })();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH_|GITHUB_|AWS_)/.test(k)));
env.TMPDIR = `${chat}/tmp`;
const s0 = performance.now();
const p = spawn('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--settings', `${chat}/settings.json`, '--append-system-prompt-file', `${chat}/seed.md`,
  '--allowedTools', 'Read,Grep,Glob,Bash'], { cwd: `${chat}/repo`, env });
let buf = ''; let asked = 0; const marks = {}; let n = 0;
const ask = (q) => { asked = performance.now(); marks[`q${++n}`] = {}; p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: q } }) + '\n'); };
p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); let e; try { e = JSON.parse(l); } catch { continue; }
  const m = marks[`q${n}`]; const at = Math.round(performance.now() - asked);
  if (e.type === 'system' && e.subtype === 'init') marks.initFromSpawn ??= Math.round(performance.now() - s0);
  if (m && e.type === 'assistant') for (const c of e.message.content) { if (c.type === 'text') m.firstText ??= at; if (c.type === 'tool_use') m.firstTool ??= at; }
  if (m && e.type === 'result') { m.result = at; m.text = e.result.slice(0, 160);
    if (n === 1) setTimeout(() => ask('In one sentence: which function builds the Jira comment body?'), 1000);
    else { console.log(JSON.stringify(marks, null, 1)); p.stdin.end(); } } } });
p.stderr.on('data', (d) => process.stderr.write(d));
// the process is "warm": wait 8s idle as if pre-started, then ask
setTimeout(() => ask('Reply with one word: ready?'), 8000);
