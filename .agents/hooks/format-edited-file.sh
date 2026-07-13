#!/usr/bin/env bash
# Claude Code PostToolUse 钩子：每次 Edit/Write 后用 oxfmt 就地格式化该文件，
# 使文件在 git commit 前已合规——避免 prek 的 format 步骤反复重排（尤以 markdown 表格、
# 长行折叠最频繁）导致「files modified by this hook」中止、需重新 add+commit。
#
# 非阻塞：任何情况都 exit 0。oxfmt 作为子进程改文件，不会再触发 PostToolUse（无死循环）。
set -u

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
[ -n "$file" ] || exit 0

proj="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# 仅处理本仓内的文件。
case "$file" in
  "$proj"/*) ;;
  *) exit 0 ;;
esac

# 仅处理 oxfmt 支持的类型（确认过：ts/tsx/js/jsx/json/md/css 等）。
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.md | *.css) ;;
  *) exit 0 ;;
esac

[ -f "$file" ] || exit 0
[ -x "$proj/node_modules/.bin/oxfmt" ] || exit 0

"$proj/node_modules/.bin/oxfmt" "$file" >/dev/null 2>&1 || true
exit 0
