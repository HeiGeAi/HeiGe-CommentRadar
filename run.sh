#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# playwright 装在项目内 node_modules，node 自动解析，无需全局安装浏览器。
exec node "$SCRIPT_DIR/run-monitor.mjs" "$@"
