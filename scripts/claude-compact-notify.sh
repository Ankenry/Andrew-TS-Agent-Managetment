#!/bin/sh
# Claude Code PostCompact hook: tells the user that a session finished compacting its context.
# Wired through "hooks.PostCompact" in .claude/settings.local.json; Claude Code pipes the hook JSON on stdin.
# Shows a desktop notification and appends one line to runtime/claude-compact.log. Never blocks the session: every step is best-effort.
payload=$(cat)
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

field() { printf '%s' "$payload" | jq -r "$1 // empty" 2>/dev/null; }
session=$(field '.session_id')
trigger=$(field '.trigger')
case "$trigger" in
  auto) kind='tự động' ;;
  manual) kind='thủ công' ;;
  *) kind='không rõ kiểu' ;;
esac
short=${session%%-*}

mkdir -p "$root/runtime" 2>/dev/null
printf '%s\tsession=%s\ttrigger=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "${session:-unknown}" "${trigger:-unknown}" >>"$root/runtime/claude-compact.log" 2>/dev/null

if command -v notify-send >/dev/null 2>&1; then
  notify-send -a 'Claude Code' 'Compact xong' "Phiên ${short:-?} đã nén context (${kind})." >/dev/null 2>&1 &
fi
exit 0
