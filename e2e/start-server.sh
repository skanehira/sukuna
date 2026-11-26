#!/usr/bin/env bash
set -euo pipefail

PORT="$1"
SUKUNA_HOME="$(mktemp -d)"
export SUKUNA_HOME
trap 'rm -rf "${SUKUNA_HOME}"' EXIT

cd "$(dirname "${BASH_SOURCE[0]}")/.."
vp dev --port "$PORT" --strictPort
