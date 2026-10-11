#!/usr/bin/env bash
# Spike only: the orchestrator's hands. A thin wrapper over the daemon's room
# API (docs/CLIENT-API.md, "Rooms"). It is the prototype of the Phase 1 CLI,
# so every rough edge it has is spike data.
#
# Needs: ROOM (the room id) in the environment; curl and jq on PATH.
#
#   room.sh info                          the roster: name id harness role status
#   room.sh hire <name> <harness> [role] [base]   add a worker (mode auto)
#   room.sh send <name> < text            send stdin as one message; prints seq queued
#   room.sh wait <name> <seq> [queued] [secs]     wait for that answer; prints it
#   room.sh ask  <name> [secs] < text     send + wait
#   room.sh ff   <target> <source>        fast-forward target to source's commit
#   room.sh diff <name> [head|base]       the worker's changes (text)
#   room.sh fire <name>                   remove a worker; its work stays
#
# wait exits 3 when the turn is still running after <secs> (default 540).
# Call wait again with the same seq and queued.
set -euo pipefail

: "${ROOM:?set ROOM to the room id}"
dj="${XDG_RUNTIME_DIR:-/tmp/kapelle-$(id -u)}/kapelle/daemon.json"

api() { # method path [json-body]
  local port token
  port=$(jq -r .port "$dj") token=$(jq -r .token "$dj")
  curl -sS -X "$1" "http://127.0.0.1:$port$2" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    ${3:+--data-binary "$3"}
}

idof() { # name -> participant id
  api GET "/rooms/$ROOM" | jq -er --arg n "$1" \
    '.participants[] | select(.name | ascii_downcase == ($n | ascii_downcase)) | .id' ||
    { echo "no participant named $1" >&2; exit 1; }
}

since() { # seq -> the room's lines after seq, up to now, one JSON per line
  local now port token
  now=$(api GET "/rooms/$ROOM" | jq .seq)
  [ "$now" -gt "$1" ] || return 0
  port=$(jq -r .port "$dj") token=$(jq -r .token "$dj")
  # The stream never ends by itself: take the lines that exist now, then stop
  # curl. grep -m exits at the last one; mawk would wait for more input.
  local fd cpid
  exec {fd}< <(curl -sN "http://127.0.0.1:$port/rooms/$ROOM/events" \
    -H "Authorization: Bearer $token" -H "Last-Event-ID: $1" 2>/dev/null)
  cpid=$!
  grep -m $((now - $1)) '^data: ' <&"$fd" | cut -c7- || true
  exec {fd}<&-
  kill "$cpid" 2>/dev/null || true
}

answer() { # pid seq queued -> prints the answer, or exits 3 if not ended yet
  since "$2" | jq -rs --arg p "$1" --argjson q "$3" '
    [ .[] | select(.participantId == $p) ] as $e
    | [ $e | to_entries[] | select(.value.update.sessionUpdate == "_client_turn_ended") | .key ] as $ends
    | if ($ends | length) <= $q then "__RUNNING__" else
        $ends[$q] as $end
        | ([ $e[:$end] | to_entries[] | select(.value.update.sessionUpdate == "_client_user_message") | .key ] | last // -1) as $start
        | $e[$start + 1 : $end] as $turn
        | ([ $turn | to_entries[] | select(.value.update.sessionUpdate == "tool_call") | .key ] | last // -1) as $lt
        | ([ $turn[$lt + 1:][] | select(.update.sessionUpdate == "agent_message_chunk") | .update.content.text // "" ] | join("")) as $final
        | ([ $turn[] | select(.update.sessionUpdate == "agent_message_chunk") | .update.content.text // "" ] | join("")) as $all
        | $e[$end].update as $u
        | "[turn ended: \($u.stopReason // "?")\(if $u.error then ", error: \($u.error)" else "" end); tool calls: \([ $turn[] | select(.update.sessionUpdate == "tool_call") ] | length)]\n"
          + (if ($final | test("\\S")) then $final else $all end)
      end'
}

case "${1:-}" in
info)
  api GET "/rooms/$ROOM" | jq -r '.participants[] | "\(.name)\t\(.id)\t\(.harness)\t\(.role // "-")\t\(.status)\t\(.branch // "-")"'
  ;;
hire)
  body=$(jq -n --arg n "$2" --arg a "$3" --arg r "${4:-}" --arg b "${5:-}" \
    '{agent: $a, name: $n, mode: "auto"} + (if $r != "" then {role: $r} else {} end) + (if $b != "" then {base: $b} else {} end)')
  api POST "/rooms/$ROOM/agents" "$body" | jq -r 'if .error then "refused: \(.error.code // .error): \(.error.message // "")" else "hired \(.name) \(.id) on \(.branch // "-") in \(.worktree)" end'
  ;;
send)
  pid=$(idof "$2")
  body=$(jq -Rs '{text: .}')
  api POST "/rooms/$ROOM/agents/$pid/messages" "$body" | jq -r 'if .error then "refused: \(.error.code // .error)" else "\(.seq) \(.queued)" end'
  ;;
wait)
  pid=$(idof "$2") seq=$3 q=${4:-0} until=$((SECONDS + ${5:-540}))
  while :; do
    out=$(answer "$pid" "$seq" "$q")
    [ "$out" != "__RUNNING__" ] && { printf '%s\n' "$out"; exit 0; }
    [ $SECONDS -ge $until ] && { echo "still working: call 'room.sh wait $2 $seq $q' again"; exit 3; }
    sleep 10
  done
  ;;
ask)
  read -r seq q < <("$0" send "$2")
  [[ "$seq" =~ ^[0-9]+$ ]] || { echo "$seq $q"; exit 1; }
  exec "$0" wait "$2" "$seq" "$q" "${3:-540}"
  ;;
ff)
  pid=$(idof "$2")
  from=$(idof "$3")
  api POST "/rooms/$ROOM/agents/$pid/fast-forward" "$(jq -n --arg f "$from" '{from: $f}')" |
    jq -r 'if .error then "refused: \(.error.code // .error): \(.error.message // "")" else "moved \(.name) to \(.branch)" end'
  ;;
diff)
  pid=$(idof "$2")
  api GET "/rooms/$ROOM/agents/$pid/diff?against=${3:-head}" | jq -r '.text // .'
  ;;
fire)
  pid=$(idof "$2")
  api DELETE "/rooms/$ROOM/agents/$pid" | jq -r 'if .error then "refused: \(.error.code // .error)" else "removed \($n)" end' --arg n "$2"
  ;;
*)
  sed -n '6,17p' "$0"
  exit 1
  ;;
esac
