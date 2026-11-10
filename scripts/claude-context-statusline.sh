#!/bin/sh
# Claude Code status line: shows how full this session's context window is.
# Wired through "statusLine" in .claude/settings.local.json; Claude Code pipes the session JSON on stdin.
# The payload is also forwarded to Orca's own status line hook, which this project-level setting would otherwise replace.
payload=$(cat)

orca_hook="${HOME}/.orca/agent-hooks/claude-statusline.sh"
if [ -x "$orca_hook" ]; then
  printf '%s' "$payload" | /bin/sh "$orca_hook" >/dev/null 2>&1 &
fi

printf '%s' "$payload" | jq -r '
  def num: if type == "number" then . else 0 end;
  def short: if . >= 1000000 then ((. / 100000 | floor) / 10 | tostring) + "M"
             elif . >= 1000 then (. / 1000 | floor | tostring) + "k"
             else (floor | tostring) end;
  def cells($n): if $n > 0 then . * $n else "" end;
  (.context_window // {}) as $c
  | ($c.context_window_size | num) as $size
  | ($c.current_usage // {}) as $u
  | (($u.input_tokens | num) + ($u.cache_creation_input_tokens | num) + ($u.cache_read_input_tokens | num)) as $tokens
  | (if ($c.used_percentage | type) == "number" then $c.used_percentage
     elif $size > 0 and $tokens > 0 then $tokens * 100 / $size
     else null end) as $pct
  | (.model.display_name // "Claude") as $model
  | if $pct == null then "\($model) │ context " + ("░" | cells(20)) + " --"
    else
      ([[$pct, 0] | max, 100] | min) as $p
      | (if $p > 0 then ([($p / 5 | floor), 1] | max) else 0 end) as $filled
      | (if $p >= 85 then "\u001b[31m" elif $p >= 60 then "\u001b[33m" else "\u001b[32m" end) as $color
      | (if $tokens > 0 then $tokens else $p * $size / 100 end) as $used
      | "\($model) │ context \($color)" + ("█" | cells($filled)) + "\u001b[2m" + ("░" | cells(20 - $filled)) + "\u001b[0m"
        + " \($color)\($p | floor)%\u001b[0m"
        + (if $size > 0 then " (\($used | short)/\($size | short))" else "" end)
    end
' 2>/dev/null || printf 'context --'
