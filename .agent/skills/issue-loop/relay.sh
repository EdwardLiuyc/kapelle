#!/usr/bin/env bash
# Spike only: the wake-up the daemon does not have yet. It follows the room's
# stream. When a worker's turn ends, it sends that turn's answer to the
# orchestrator as a new message, which starts with "[relay]". So the
# orchestrator can end its turn after each send, and the person can talk to it
# between steps.
#
#   ROOM=<room id> relay.sh        runs until the room's stream ends
#
# It starts at the end of the log: it relays only turns that end after it starts.
set -euo pipefail

: "${ROOM:?set ROOM to the room id}"
here=$(cd "$(dirname "$0")" && pwd)
R="$here/room.sh"
dj="${XDG_RUNTIME_DIR:-/tmp/kapelle-$(id -u)}/kapelle/daemon.json"
port() { jq -r .port "$dj"; }
token() { jq -r .token "$dj"; }
room() { curl -sS "http://127.0.0.1:$(port)/rooms/$ROOM" -H "Authorization: Bearer $(token)"; }
log() { echo "$(date +%T) $*"; }

orch=$(room | jq -er '.participants[] | select(.role == "orchestrator") | .id')
last=$(room | jq -er .seq)
declare -A start # participant id -> the seq just before its live turn's message
log "relay for $ROOM, orchestrator $orch, from seq $last"

while :; do
  # The stream replays from Last-Event-ID and then follows. Only two kinds of
  # line matter, so skip the rest before jq sees them.
  while IFS= read -r line; do
    case "$line" in
    "id: "*) last=${line#id: } ;;
    *'"sessionUpdate":"_client_user_message"'* | *'"sessionUpdate":"_client_turn_ended"'*)
      ev=${line#data: }
      pid=$(jq -r .participantId <<<"$ev")
      [ "$pid" = "$orch" ] && continue
      seq=$(jq -r .seq <<<"$ev")
      if [[ $ev == *'_client_user_message'* ]]; then
        start[$pid]=$((seq - 1))
        continue
      fi
      name=$(room | jq -r --arg p "$pid" '.participants[] | select(.id == $p) | .name')
      [ -n "$name" ] || { log "turn end from a removed participant $pid, skipped"; continue; }
      [ -n "${start[$pid]:-}" ] || { log "turn end from $name with no start seen, skipped"; continue; }
      body=$(ROOM=$ROOM "$R" wait "$name" "${start[$pid]}" 0 60) || true
      unset "start[$pid]"
      printf '[relay] %s finished a turn.\n%s\n' "$name" "$body" | ROOM=$ROOM "$R" send "$(room | jq -r --arg p "$orch" '.participants[] | select(.id == $p) | .name')" >/dev/null &&
        log "relayed $name's answer (seq $seq)" || log "could not relay $name's answer (seq $seq)"
      ;;
    esac
  done < <(curl -sN "http://127.0.0.1:$(port)/rooms/$ROOM/events" \
    -H "Authorization: Bearer $(token)" -H "Last-Event-ID: $last" 2>/dev/null || true)
  status=$(room | jq -r '.status // "gone"' 2>/dev/null || echo gone)
  [ "$status" = "active" ] || { log "room is $status, relay ends"; exit 0; }
  log "stream cut at seq $last, reconnecting"
  sleep 2
done
