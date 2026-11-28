#!/usr/bin/env bash
set -euo pipefail

PORT="$1"
E2E_HOME="${SUKUNA_E2E_HOME:-}"
cleanup_home="${SUKUNA_E2E_CREATED_HOME:-}"
if [[ -z "$E2E_HOME" ]]; then
  E2E_HOME="$(mktemp -d)"
  cleanup_home="$E2E_HOME"
fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
SUKUNA_RUNNER_SOCKET="$E2E_HOME/runner.sock"
SUKUNA_AGENT="fake"
SUKUNA_AGENT_SCRIPT="$E2E_HOME/agent.json"
SUKUNA_GH="$E2E_HOME/gh.json"
CLAUDE_CONFIG_DIR="$E2E_HOME/claude-config"
SHELL="$E2E_HOME/terminal-shell"
cat > "$SHELL" <<'TERMINAL_SHELL'
#!/bin/sh
exec /usr/bin/env -i PATH=/usr/bin:/bin TERM=xterm-256color /bin/sh -i
TERMINAL_SHELL
chmod 700 "$SHELL"
export SHELL
vite_plus_data="$HOME/.local/share"
[[ "${XDG_DATA_HOME:-}" == /* ]] && vite_plus_data="$XDG_DATA_HOME"
vite_plus_cache="$HOME/.cache"
[[ "${XDG_CACHE_HOME:-}" == /* ]] && vite_plus_cache="$XDG_CACHE_HOME"
VP_DATA_DIR="${VP_DATA_DIR:-$vite_plus_data/vite-plus}"
VP_BIN_DIR="${VP_BIN_DIR:-$VP_DATA_DIR/bin}"
VP_CACHE_DIR="${VP_CACHE_DIR:-$vite_plus_cache/vite-plus}"
export VP_DATA_DIR VP_BIN_DIR VP_CACHE_DIR
XDG_DATA_HOME="$E2E_HOME/data"
XDG_STATE_HOME="$E2E_HOME/state"
XDG_RUNTIME_DIR="$E2E_HOME/runtime"
export XDG_DATA_HOME XDG_STATE_HOME XDG_RUNTIME_DIR SUKUNA_RUNNER_SOCKET
export SUKUNA_AGENT SUKUNA_AGENT_SCRIPT SUKUNA_GH CLAUDE_CONFIG_DIR

runner_pid=""
cleanup() {
  if [[ -n "$runner_pid" ]]; then
    kill "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" || true
  fi
  if [[ "$E2E_HOME" == "$cleanup_home" ]]; then
    rm -rf "${E2E_HOME:?}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node e2e/seed-pr-review.mjs "$E2E_HOME" "$PWD/e2e/agent-scripts/conversation.json"
runner_node="$(vp exec node -p 'process.execPath')"
"$runner_node" src/runner/dev.mjs &
runner_pid=$!
node e2e/seed-project.mjs "$E2E_HOME" "$SUKUNA_RUNNER_SOCKET"
node e2e/seed-work-monitor.mjs "$E2E_HOME" "$SUKUNA_RUNNER_SOCKET" "$CLAUDE_CONFIG_DIR"
vp dev --port "$PORT" --strictPort
