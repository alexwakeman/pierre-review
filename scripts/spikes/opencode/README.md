# OpenCode ACP spike

Spike scripts only; not part of the build. Plan: [docs/AGENT-CLI-PLAN.md](../../../docs/AGENT-CLI-PLAN.md).
Results: [docs/AGENT-CLI-SPIKE.md](../../../docs/AGENT-CLI-SPIKE.md).

- `setup.sh`: a fresh spike area — an isolated OpenCode home with Ensemble's lockdown config, and a HOSTILE
  fixture repository (planted plugin, agent, `opencode.json`, `AGENTS.md`) plus a secret outside it.
- `run.sh`: one ACP session (`opencode acp`) against the fixture, through `acp-client.mjs`; prints the
  transcript, the MCP server's log, the result tool's answer, whether the planted plugin ran, and (with
  `SPIKE_LOG_PROXY=1`) every host contacted.
- `acp-client.mjs`: raw JSON-RPC ACP client; answers `session/request_permission` from ONE rule.
- `mcp-server.mjs`: stand-in for Ensemble's workspace MCP server (`read_file` path-guarded,
  `list_files`) and one result tool (`submit_review`).
- `log-proxy.mjs`: a CONNECT proxy that logs every host and chains to `HTTPS_PROXY`.

```bash
npm install
```

```bash
export SPIKE_DIR=$(./setup.sh)
```

```bash
ANTHROPIC_API_KEY=... SPIKE_LOG_PROXY=1 ./run.sh review
```

Prompts: `review`, `bash`, `outside`, `inject`, or `-` for the handshake only. Policies: `ensemble`
(default), `deny-all`, `allow-all`. Add `open` as the third argument to run with OpenCode's defaults.
