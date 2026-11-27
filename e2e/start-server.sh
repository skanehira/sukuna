#!/usr/bin/env bash
set -euo pipefail

PORT="$1"
SUKUNA_HOME="$(mktemp -d)"
SUKUNA_LOGIN="dev@example.com"
SUKUNA_DEV_IDENTITY="dev@example.com"
export SUKUNA_HOME SUKUNA_LOGIN SUKUNA_DEV_IDENTITY
trap 'rm -rf "${SUKUNA_HOME}"' EXIT

cd "$(dirname "${BASH_SOURCE[0]}")/.."
vp dev --port "$PORT" --strictPort
