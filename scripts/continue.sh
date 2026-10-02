#!/usr/bin/env bash
# QRBit remote nudge — fire a "." (or any text) into the agy pane after a delay.
#
# The failure this script exists to prevent is a timer that fires into the wrong
# terminal, or fires at all after the pane is gone: herdr pane ids (w7:p1) are
# reassigned every server run, so a delay scheduled at 2am and fired at 4am cannot
# trust the id it resolved at schedule time. So we resolve the pane lazily at FIRE
# time by stable coordinates instead — workspace label + tab index + agent name —
# and refuse to send anything if those coordinates no longer resolve.
#
# The timer also detaches (setsid + nohup), so you can close the tab it was started
# in and it still fires.
#
# Usage:
#   scripts/continue.sh +120              fire after 120 minutes (bare number = minutes)
#   scripts/continue.sh +90s              seconds / minutes / hours: 90s, 45m, 2h
#   scripts/continue.sh now               fire immediately
#   scripts/continue.sh --at 07:30        fire at today's wall-clock time (or tomorrow if past)
#   scripts/continue.sh --text "push it" +10m
#   scripts/continue.sh --tab 2 --agent agy +30m
#   scripts/continue.sh --dry-run +5s     wait, then log what it WOULD send
#   scripts/continue.sh --status          list pending timers + remaining time
#   scripts/continue.sh --cancel all      kill pending timers (or --cancel <id>)
#   scripts/continue.sh --logs            show the newest fire log
set -euo pipefail

# ---------------------------------------------------------------- configuration
WORKSPACE_LABEL="${HERDR_WORKSPACE:-QRBit}"   # herdr workspace label, not its id
TAB_INDEX="${HERDR_TAB:-1}"                    # tab number within the workspace
AGENT="${HERDR_AGENT:-agy}"                    # preferred agent inside that tab
SEND_TEXT="."                                  # default payload
DELAY=""                                       # raw delay spec
AT_TIME=""                                     # --at HH:MM
DRY=0
STATE_DIR="${HERDR_CONTINUE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr-continue}"

usage() { sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; }

die() { echo "continue: $*" >&2; exit 1; }

need_herdr() { command -v herdr >/dev/null || die "herdr not on PATH"; }

# ------------------------------------------------------------------- pane lookup
# Resolve a pane id from stable coordinates. Prints "<pane_id>\t<agent_status>".
resolve_pane() {
  local ws_id
  ws_id="$(herdr workspace list 2>/dev/null | jq -r --arg l "$WORKSPACE_LABEL" \
    '.result.workspaces[]? | select(((.label // "") | ascii_downcase) == ($l | ascii_downcase))
     | .workspace_id' | head -n1)"
  [[ -n "$ws_id" && "$ws_id" != "null" ]] || { echo "" ; return 0; }

  herdr pane list 2>/dev/null | jq -r --arg w "$ws_id" --arg t "${ws_id}:t${TAB_INDEX}" --arg a "$AGENT" '
    [ .result.panes[]? | select(.workspace_id == $w and .tab_id == $t) ] as $p
    | if ($p | length) == 0 then ""
      else
        ( [ $p[] | select(.agent == $a) ] | if length > 0 then .[0] else $p[0] end )
        | "\(.pane_id)\t\(.agent_status // "unknown")"
      end' | head -n1
}

# ------------------------------------------------------------------ delay parse
# Bare number = minutes, matching the "+120" convention. Returns whole seconds.
parse_delay() {
  local spec="$1"
  if [[ "$spec" == "now" || "$spec" == "+0" || "$spec" == "0" ]]; then echo 0; return; fi
  [[ "$spec" =~ ^\+?([0-9]+([.][0-9]+)?)([smh]?)$ ]] || die "bad delay '$spec' (try +120, +90s, +45m, +2h, now)"
  local qty="${BASH_REMATCH[1]}" unit="${BASH_REMATCH[3]:-m}" mult
  case "$unit" in
    s) mult=1 ;;
    m) mult=60 ;;
    h) mult=3600 ;;
  esac
  awk -v q="$qty" -v m="$mult" 'BEGIN { printf "%d", q*m + 0.5 }'
}

parse_at() {
  local t="$1" target now diff
  target="$(date -d "today $t" +%s 2>/dev/null)" || die "bad time '$t' (expect HH:MM)"
  now="$(date +%s)"; diff=$(( target - now ))
  (( diff < 0 )) && diff=$(( diff + 86400 ))    # already passed today -> tomorrow
  echo "$diff"
}

# -------------------------------------------------------------------- state i/o
new_id() { printf 't%s-%s' "$(date +%Y%m%d-%H%M%S)" "$$"; }

fmt_remaining() { # seconds -> human
  local s=$1
  (( s < 0 )) && s=0
  if (( s >= 3600 )); then printf '%dh%02dm' $((s/3600)) $(((s%3600)/60))
  elif (( s >= 60 )); then printf '%dm%02ds' $((s/60)) $((s%60))
  else printf '%ds' "$s"; fi
}

# ------------------------------------------------------------------- commands
cmd_status() {
  [[ -d "$STATE_DIR" ]] || { echo "no pending timers"; return; }
  local found=0 pidfile pid line
  for pidfile in "$STATE_DIR"/*.pid; do
    [[ -e "$pidfile" ]] || continue
    pid="$(cat "$pidfile")"
    id="$(basename "$pidfile" .pid)"
    if [[ -d "/proc/$pid" ]]; then
      local fire_at; fire_at="$(awk -F= '/^fire_at/{print $2+0}' "$STATE_DIR/$id.meta" 2>/dev/null || echo 0)"
      printf '%s  pending  fires in %s  (log: %s)\n' "$id" "$(fmt_remaining $((fire_at - $(date +%s))))" "$STATE_DIR/$id.log"
    else
      printf '%s  finished/exited  (log: %s)\n' "$id" "$STATE_DIR/$id.log"
    fi
    found=1
  done
  (( found )) || echo "no pending timers"
}

cmd_cancel() {
  local target="$1" matched=0 pidfile pid id
  [[ -d "$STATE_DIR" ]] || die "nothing to cancel (no state dir)"
  for pidfile in "$STATE_DIR"/*.pid; do
    [[ -e "$pidfile" ]] || continue
    id="$(basename "$pidfile" .pid)"
    if [[ "$target" != "all" && "$target" != "$id" ]]; then continue; fi
    matched=1
    pid="$(cat "$pidfile")"
    if [[ -d "/proc/$pid" ]] && kill "$pid" 2>/dev/null; then
      echo "cancelled $id (pid $pid)"
    else
      echo "already gone: $id"
    fi
    rm -f "$STATE_DIR/$id.pid"
  done
  if (( matched == 0 )); then die "no timer matched '$target' (see --status)"; fi
}

cmd_logs() {
  local newest; newest="$(ls -1t "$STATE_DIR"/*.log 2>/dev/null | head -n1 || true)"
  [[ -n "$newest" ]] || die "no logs in $STATE_DIR"
  echo "--- $newest"; cat "$newest"
}

# ------------------------------------------------------------------- fire phase
# This is the detached half: sleep, resolve lazily, send text + Enter, verify.
cmd_fire() {
  local id="${HERDR_C_ID:?}" secs="${HERDR_C_DELAY:?}"
  local log="$STATE_DIR/$id.log"
  local ts; ts() { date '+%Y-%m-%d %H:%M:%S'; }

  echo "$$" > "$STATE_DIR/$id.pid"
  echo "$(ts) timer $id asleep: ${secs}s (fires $(date -d "+${secs} seconds" '+%H:%M:%S' 2>/dev/null || echo +${secs}s))" >> "$log"
  sleep "$secs"

  local line pane status
  line="$(resolve_pane)"
  pane="${line%%$'\t'*}"; status="${line##*$'\t'}"
  if [[ -z "$pane" ]]; then
    echo "$(ts) ABORT: workspace '$WORKSPACE_LABEL' tab $TAB_INDEX not found — nothing sent" >> "$log"
    rm -f "$STATE_DIR/$id.pid"; exit 1
  fi

  echo "$(ts) resolved $WORKSPACE_LABEL:t$TAB_INDEX [$AGENT] -> $pane (status: $status)" >> "$log"

  if [[ "${HERDR_C_DRY:-0}" == "1" ]]; then
    echo "$(ts) DRY RUN: would send text '$HERDR_C_TEXT' then Enter to $pane" >> "$log"
    rm -f "$STATE_DIR/$id.pid"; exit 0
  fi

  # Guard: a pane that is already 'working' usually means a turn is mid-flight and a
  # stray "." would queue behind it or interrupt it. Loud by default, not fatal.
  if [[ "$status" == "working" ]]; then
    echo "$(ts) NOTE: agent was 'working' at fire time; sending anyway" >> "$log"
  fi

  herdr pane send-text "$pane" "$HERDR_C_TEXT" >> "$log" 2>&1 \
    || { echo "$(ts) FAIL: send-text errored" >> "$log"; rm -f "$STATE_DIR/$id.pid"; exit 1; }
  herdr pane send-keys "$pane" Enter >> "$log" 2>&1 \
    || { echo "$(ts) FAIL: send-keys Enter errored (text may be sitting unsubmitted)" >> "$log"; rm -f "$STATE_DIR/$id.pid"; exit 1; }
  echo "$(ts) sent: '$HERDR_C_TEXT' + Enter -> $pane" >> "$log"

  # Cheap proof of receipt: the agent should leave 'idle' within a couple of seconds.
  sleep 2
  local after; after="$(resolve_pane)"; after="${after##*$'\t'}"
  echo "$(ts) post-send agent status: $after" >> "$log"
  rm -f "$STATE_DIR/$id.pid"
}

# ------------------------------------------------------------------------ main
need_herdr
command -v jq >/dev/null || die "jq required"

# internal detached invocation
if [[ "${1:-}" == "--fire" ]]; then cmd_fire; fi

while (( $# )); do
  case "$1" in
    --at)       AT_TIME="${2:?--at needs HH:MM}"; shift 2 ;;
    --text)     SEND_TEXT="${2:?--text needs a value}"; shift 2 ;;
    --tab)      TAB_INDEX="${2:?--tab needs a number}"; shift 2 ;;
    --agent)    AGENT="${2:?--agent needs a name}"; shift 2 ;;
    --workspace) WORKSPACE_LABEL="${2:?--workspace needs a label}"; shift 2 ;;
    --dry-run)  DRY=1; shift ;;
    --status)   cmd_status; exit 0 ;;
    --cancel)   cmd_cancel "${2:?--cancel needs an id or 'all'}"; exit 0 ;;
    --logs)     cmd_logs; exit 0 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         die "unknown flag '$1' (see --help)" ;;
    +*|now|[0-9]*) DELAY="$1"; shift ;;
    *)          die "unexpected argument '$1' (see --help)" ;;
  esac
done

if [[ -n "$AT_TIME" ]]; then
  if [[ -n "$DELAY" ]]; then die "use either +delay or --at, not both"; fi
  SECS="$(parse_at "$AT_TIME")"
  echo "firing at $AT_TIME (in $(fmt_remaining "$SECS"))"
else
  if [[ -z "$DELAY" ]]; then usage; exit 1; fi
  SECS="$(parse_delay "$DELAY")"
fi

# Resolve now too, purely so a mistyped workspace/tab fails fast instead of hours later.
PRE="$(resolve_pane)"
if [[ -z "$PRE" ]]; then
  echo "continue: warning — '$WORKSPACE_LABEL':t$TAB_INDEX [$AGENT] does not resolve right now; will retry at fire time" >&2
fi
if [[ -n "$PRE" ]]; then
  echo "payload : '$SEND_TEXT' + Enter"
  echo "target  : ${PRE%%$'\t'*} (${PRE##*$'\t'}) at $WORKSPACE_LABEL:t$TAB_INDEX [$AGENT]"
  echo "fires   : $(date -d "+$SECS seconds" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "in ${SECS}s")  (in $(fmt_remaining "$SECS"))"
fi

mkdir -p "$STATE_DIR"

if (( SECS == 0 )); then
  echo "delay is zero — firing in the foreground"
  NOW_ID="$(new_id)"
  HERDR_C_ID="$NOW_ID" HERDR_C_DELAY=0 HERDR_C_TEXT="$SEND_TEXT" \
    HERDR_C_DRY="$DRY" HERDR_WORKSPACE="$WORKSPACE_LABEL" HERDR_TAB="$TAB_INDEX" HERDR_AGENT="$AGENT" \
    STATE_DIR="$STATE_DIR" bash "$0" --fire
  echo "log: $STATE_DIR/$NOW_ID.log"
  exit 0
fi

ID="$(new_id)"
printf 'fire_at=%s\ndelay=%s\ntext=%s\tworkspace=%s\ttab=%s\tagent=%s\tdry=%s\n' \
  "$(( $(date +%s) + SECS ))" "$SECS" "$SEND_TEXT" "$WORKSPACE_LABEL" "$TAB_INDEX" "$AGENT" "$DRY" \
  > "$STATE_DIR/$ID.meta"

# Detached: survives this shell exiting and the tab being closed.
setsid nohup env \
  HERDR_C_ID="$ID" HERDR_C_DELAY="$SECS" HERDR_C_TEXT="$SEND_TEXT" HERDR_C_DRY="$DRY" \
  HERDR_WORKSPACE="$WORKSPACE_LABEL" HERDR_TAB="$TAB_INDEX" HERDR_AGENT="$AGENT" \
  STATE_DIR="$STATE_DIR" \
  bash "$0" --fire >/dev/null 2>&1 < /dev/null &
TIMER_PID=$!
echo "$TIMER_PID" > "$STATE_DIR/$ID.pid"
disown "$TIMER_PID" 2>/dev/null || true

echo "armed   : $ID (pid $TIMER_PID)"
echo "log     : $STATE_DIR/$ID.log"
echo "check   : $(cd "$(dirname "$0")" && pwd)/$(basename "$0") --status"
echo "kill it : $(cd "$(dirname "$0")" && pwd)/$(basename "$0") --cancel $ID"
