#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
pnpm build
docker build -t wanman:dev -f apps/container/Dockerfile .
