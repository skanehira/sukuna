#!/usr/bin/env bash
set -euo pipefail

PORT="$1"
SUKUNA_HOME="${SUKUNA_E2E_HOME:-}"
cleanup_home="${SUKUNA_E2E_CREATED_HOME:-}"
if [[ -z "$SUKUNA_HOME" ]]; then
  SUKUNA_HOME="$(mktemp -d)"
  cleanup_home="$SUKUNA_HOME"
fi
SUKUNA_LOGIN="dev@example.com"
SUKUNA_DEV_IDENTITY="dev@example.com"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SUKUNA_RUNNER_SOCKET="$SUKUNA_HOME/runner.sock"
SUKUNA_AGENT="fake"
SUKUNA_AGENT_SCRIPT="$SUKUNA_HOME/agent.json"
SUKUNA_GH="$SUKUNA_HOME/gh.json"
CLAUDE_CONFIG_DIR="$SUKUNA_HOME/claude-config"
SHELL="$SUKUNA_HOME/terminal-shell"
cat > "$SHELL" <<'TERMINAL_SHELL'
#!/bin/sh
exec /usr/bin/env -i PATH=/usr/bin:/bin TERM=xterm-256color /bin/sh -i
TERMINAL_SHELL
chmod 700 "$SHELL"
export SHELL
export SUKUNA_HOME SUKUNA_LOGIN SUKUNA_DEV_IDENTITY SUKUNA_RUNNER_SOCKET
export SUKUNA_AGENT SUKUNA_AGENT_SCRIPT SUKUNA_GH CLAUDE_CONFIG_DIR

runner_pid=""
cleanup() {
  if [[ -n "$runner_pid" ]]; then
    kill "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" || true
  fi
  if [[ "$SUKUNA_HOME" == "$cleanup_home" ]]; then
    rm -rf "${SUKUNA_HOME:?}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node e2e/seed-pr-review.mjs "$SUKUNA_HOME" "$PWD/e2e/agent-scripts/conversation.json"
runner_node="$(vp exec node -p 'process.execPath')"
"$runner_node" src/runner/dev.mjs &
runner_pid=$!
node e2e/seed-project.mjs "$SUKUNA_HOME" "$SUKUNA_RUNNER_SOCKET"
node e2e/seed-work-monitor.mjs "$SUKUNA_HOME" "$SUKUNA_RUNNER_SOCKET" "$CLAUDE_CONFIG_DIR"
vp dev --port "$PORT" --strictPort
