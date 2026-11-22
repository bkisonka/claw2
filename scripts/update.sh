#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Vitaliy Bondar
#
# claw2 self-update driver (runs on the HOST, next to the compose stack).
#
#   ./scripts/update.sh            — one update right now
#   ./scripts/update.sh --watch    — watcher: serves "Update" clicks from the UI
#   ./scripts/update.sh --install  — install the watcher as a systemd user unit
#
# The watcher authenticates with CLAW2_GATEWAY_API_KEY from .env and reports
# progress steps to the gateway, so the web UI can show a progress bar.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_URL="${CLAW2_GATEWAY_URL:-http://127.0.0.1:8080}"
KEY="${CLAW2_GATEWAY_API_KEY:-}"
if [[ -z "$KEY" && -f "$ROOT/.env" ]]; then
  KEY="$(grep -E '^CLAW2_GATEWAY_API_KEY=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '\"'"'"' ' || true)"
fi
POLL_SEC="${CLAW2_UPDATE_POLL_SEC:-5}"

api() { # api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -m 10 -X "$method" "$GATEWAY_URL$path" \
      -H "Content-Type: application/json" -H "X-API-Key: $KEY" -d "$body" || true
  else
    curl -sS -m 10 -X "$method" "$GATEWAY_URL$path" -H "X-API-Key: $KEY" || true
  fi
}

report() { # report PERCENT STEP [MESSAGE] — extra JSON pairs via REPORT_EXTRA
  local body="{\"percent\": $1, \"step\": \"$2\""
  [[ -n "${3:-}" ]] && body="$body, \"message\": \"$3\""
  body="$body, \"listener\": true${REPORT_EXTRA:+, $REPORT_EXTRA}}"
  api POST /api/update/report "$body"
}

note() { echo "[claw2-update] $*" >&2; }

update_once() {
  report 5 start "git pull"
  if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
    REPORT_EXTRA='"error": true' report 0 error "working tree is dirty; stash or commit local changes"
    note "working tree is dirty — update aborted"
    exit 1
  fi
  if ! git -C "$ROOT" pull --ff-only 2> >(note); then
    REPORT_EXTRA='"error": true' report 0 error "git pull failed (see watcher log)"
    exit 1
  fi
  report 30 build "docker compose build"
  if ! docker compose -f "$ROOT/compose.yml" up -d --build > >(note) 2>&1; then
    REPORT_EXTRA='"error": true' report 0 error "docker compose up --build failed"
    exit 1
  fi
  report 80 prune "docker image prune"
  docker image prune -f > /dev/null 2>&1 || true
  report 95 health "waiting for the gateway"
  for _ in $(seq 1 60); do
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$GATEWAY_URL/health" || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "$code" == "200" ]]; then
    REPORT_EXTRA='"done": true' report 100 done "update complete"
    note "update complete"
  else
    report 90 error "gateway did not become healthy"
    exit 1
  fi
}

watch() {
  note "watcher started (gateway: $GATEWAY_URL, poll ${POLL_SEC}s)"
  local last_heartbeat=0
  while true; do
    local now status requested
    now=$(date +%s)
    if (( now - last_heartbeat >= 25 )); then
      api POST /api/update/report '{"percent": 0, "step": "idle", "listener": true}' > /dev/null
      last_heartbeat=$now
    fi
    status="$(api GET /api/update/status || true)"
    requested="$(printf '%s' "$status" | grep -o '"requested": *true' || true)"
    if [[ -n "$requested" ]]; then
      note "update requested from the UI"
      update_once || true
    fi
    sleep "$POLL_SEC"
  done
}

install_watcher() {
  local unit_dir="$HOME/.config/systemd/user" unit="$unit_dir/claw2-update.service"
  if ! command -v systemctl > /dev/null 2>&1; then
    note "systemctl not found; run the watcher manually:"
    note "  nohup $0 --watch >> $ROOT/.claw2/logs/update-watcher.log 2>&1 & disown"
    exit 1
  fi
  mkdir -p "$unit_dir"
  cat > "$unit" <<EOF
[Unit]
Description=claw2 update watcher (serves "Update" clicks from the web UI)

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/update.sh --watch
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now claw2-update.service
  loginctl enable-linger "$(id -un)" 2> /dev/null || note "enable-linger failed — the watcher stops on logout"
  note "installed: systemctl --user status claw2-update.service"
}

case "${1:---once}" in
  --watch)  watch ;;
  --install) install_watcher ;;
  *)        update_once ;;
esac
