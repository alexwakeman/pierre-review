#!/bin/bash
# Runs ONE ACP session against the fixture and prints the transcript.
# Usage: SPIKE_DIR=<from setup.sh> ./run.sh <prompt name|-> [policy] [locked|open]
#   prompt name: a file in $SPIKE_DIR/prompts without .txt (review, bash, outside, inject), or - for the handshake only
#   policy: ensemble (allow only the workspace MCP tools) | deny-all | allow-all
#   locked (default): Ensemble's lockdown environment; open: OpenCode's defaults (to compare)
# Optional: SPIKE_LOG_PROXY=1 puts log-proxy.mjs in front and prints every host contacted.
#           SPIKE_IDLE_MS=30000 waits after the turn (network check). The child gets ANTHROPIC_API_KEY /
#           OPENROUTER_API_KEY only when set here.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=${SPIKE_DIR:?run setup.sh first and set SPIKE_DIR}
H=$S/home
OC=$HERE/node_modules/.bin/opencode
PROMPT=${1:--}; POLICY=${2:-ensemble}; MODE=${3:-locked}
[ "$PROMPT" != "-" ] && PROMPT="$S/prompts/$PROMPT.txt"

PROXY=${HTTPS_PROXY:-}
if [ "${SPIKE_LOG_PROXY:-}" = 1 ]; then
  : > "$S/proxy.log"
  UPSTREAM=${HTTPS_PROXY:?the log proxy chains to HTTPS_PROXY} PROXY_LOG=$S/proxy.log node "$HERE/log-proxy.mjs" 39999 & PP=$!
  sleep 1; PROXY=http://127.0.0.1:39999
fi

# The ALLOW-list environment (never the caller's whole environment).
CE=$(MODE=$MODE H=$H PROXY=$PROXY python3 -I - <<'EOF'
import json, os
H = os.environ['H']
e = {'PATH': '/usr/bin:/bin', 'HOME': H, 'XDG_CONFIG_HOME': f'{H}/config', 'XDG_DATA_HOME': f'{H}/data',
     'XDG_CACHE_HOME': f'{H}/cache', 'XDG_STATE_HOME': f'{H}/state', 'NO_PROXY': '127.0.0.1,localhost'}
if os.environ['PROXY']: e['HTTPS_PROXY'] = e['HTTP_PROXY'] = os.environ['PROXY']
for k in ('NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'):
    if os.environ.get(k): e[k] = os.environ[k]
if os.path.exists('/root/.ccr/ca-bundle.crt'):
    e.setdefault('NODE_EXTRA_CA_CERTS', '/root/.ccr/ca-bundle.crt'); e.setdefault('SSL_CERT_FILE', '/root/.ccr/ca-bundle.crt')
if os.environ['MODE'] == 'locked':
    e.update({k: '1' for k in ('OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_EXTERNAL_SKILLS',
             'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_LSP_DOWNLOAD',
             'OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_PURE')})
print(json.dumps(e))
EOF
)

rm -f "$S/acp.log" "$S/mcp.log" "$S/result.json" "$S"/PLUGIN_RAN_*
SPIKE_LOG=$S/acp.log SPIKE_MCP_LOG=$S/mcp.log SPIKE_RESULT_FILE=$S/result.json SPIKE_OPENCODE=$OC \
  SPIKE_CHILD_ENV="$CE" node "$HERE/acp-client.mjs" "$S/proj" "$PROMPT" "$POLICY"
echo "client exit $?"
[ -n "${PP:-}" ] && kill $PP

python3 -I - "$S/acp.log" <<'EOF'
import json, os, sys
w = int(os.environ.get('W', '600'))
for line in open(sys.argv[1]):
    r = json.loads(line)
    print(r['ms'], r['kind'], json.dumps(r['data'])[:w])
EOF
echo "--- mcp log"; cat "$S/mcp.log" 2>/dev/null
echo "--- result"; cat "$S/result.json" 2>/dev/null || echo "(no result tool call)"
echo "--- planted plugin"; ls "$S" | grep PLUGIN_RAN || echo "did not run"
if [ "${SPIKE_LOG_PROXY:-}" = 1 ]; then echo "--- hosts"; grep -v listening "$S/proxy.log" | awk '{print $2,$3}' | sort | uniq -c; fi
