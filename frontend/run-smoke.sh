#!/usr/bin/env bash
# 纯 Node 冒烟：tsc 编译领域/服务层 + 场景脚本，再用 loader 解析 @/ 别名执行。
set -e
cd "$(dirname "$0")"
OUT=/tmp/tscout
rm -rf "$OUT"
node_modules/.bin/tsc -p tsconfig.smoke.json
echo '{"type":"module"}' > "$OUT/package.json"
node --no-warnings --experimental-loader ./smoke-loader.mjs "$OUT/smoke-entry.js"
