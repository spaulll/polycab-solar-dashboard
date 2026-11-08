#!/usr/bin/env bash
# Trading Journal — DB backup: nightly snapshot + interactive setup wizard.
#
# Usage:
#   ./backup.sh             interactive setup wizard when run in a terminal;
#                           otherwise (cron/systemd) runs one backup silently
#   ./backup.sh --backup    run a single backup now (never prompts)
#   ./backup.sh --setup     force the interactive wizard
#   ./backup.sh --yes       wizard, accepting every default without asking
#   ./backup.sh --help      this help
#
# Settings are stored in .backup.env next to this script and can be
# overridden with environment variables: JOURNAL_DB, BACKUP_DIR,
# RETENTION_DAYS (and BACKUP_TIME / BACKUP_FREQ / INSTALL_SYSTEMD).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="${BACKUP_CONF:-$ROOT/.backup.env}"
PREFIX="${BACKUP_PREFIX:-solar}"

MODE=auto
YES=0

usage() {
  cat <<'EOF'
Usage:
  ./backup.sh             interactive wizard in a terminal; otherwise backup
  ./backup.sh --backup    run a single backup now (never prompts)
  ./backup.sh --setup     force the interactive setup wizard
  ./backup.sh --yes       wizard with all defaults, no questions
  ./backup.sh --help      show this help
EOF
}

# ---------- config ----------

default_db() {
  local p
  for p in "$ROOT/backend/journal.db" "$ROOT/solar_data.db" "$ROOT/data.db"; do
    if [[ -f "$p" ]]; then echo "$p"; return 0; fi
  done
  echo "$ROOT/backend/journal.db"
}

load_conf() {
  [[ -f "$CONF" ]] && source "$CONF" || true
  SYSTEM_TZ="${SYSTEM_TZ:-$(system_tz)}"
  JOURNAL_DB="${JOURNAL_DB:-$(default_db)}"
  BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
  RETENTION_DAYS="${RETENTION_DAYS:-14}"
  BACKUP_TIME="${BACKUP_TIME:-03:30}"
  BACKUP_FREQ="${BACKUP_FREQ:-daily}"
  INSTALL_SYSTEMD="${INSTALL_SYSTEMD:-n}"
}

save_conf() {
  umask 077
  cat >"$CONF" <<EOF
SYSTEM_TZ=$SYSTEM_TZ
JOURNAL_DB=$JOURNAL_DB
BACKUP_DIR=$BACKUP_DIR
RETENTION_DAYS=$RETENTION_DAYS
BACKUP_TIME=$BACKUP_TIME
BACKUP_FREQ=$BACKUP_FREQ
INSTALL_SYSTEMD=$INSTALL_SYSTEMD
EOF
  chmod 644 "$CONF"
}

# ---------- prompting ----------

ask() { # $1 prompt, $2 default -> $REPLY
  local default="${2:-}" reply
  if (( YES )); then REPLY="$default"; return; fi
  if [[ -n "$default" ]]; then
    read -r -p "$1 [$default]: " reply || true
    REPLY="${reply:-$default}"
  else
    read -r -p "$1: " REPLY || true
  fi
}

ask_yn() { # $1 prompt, $2 default (y|n) -> $REPLY
  local default="${2:-n}" reply
  if (( YES )); then REPLY="$default"; return; fi
  read -r -p "$1 [y/N]: " reply || true
  case "${reply,,}" in
    y|yes) REPLY=y ;;
    n|no|"") REPLY="$default" ;;
    *) REPLY="$default" ;;
  esac
}

valid_time() { [[ "$1" =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]]; }
valid_freq() { case "$1" in daily|weekly|monthly) return 0 ;; esac; return 1; }

# ---------- timezone ----------

system_tz() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then
    tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  [[ -z "$tz" && -f /etc/timezone ]] && tz="$(tr -d '[:space:]' </etc/timezone 2>/dev/null || true)"
  if [[ -z "$tz" ]]; then
    tz="$(readlink /etc/localtime 2>/dev/null | sed 's#^.*/zoneinfo/##' || true)"
  fi
  printf '%s' "${tz:-UTC}"
}

utc_to_local() { # $1 HH:MM (UTC), $2 TZ -> HH:MM in that TZ
  local out
  out="$(TZ="$2" date -d "today $1 UTC" +%H:%M 2>/dev/null || true)"
  printf '%s' "${out:-$1}"
}

# ---------- backup ----------

run_backup() {
  load_conf

  local db="$JOURNAL_DB" stamp snapshot dir size count verify
  stamp="$(date -u +%F)"
  snapshot="$BACKUP_DIR/journal-$stamp.db"

  if [[ ! -f "$db" ]]; then
    echo "ERROR: database not found: $db" >&2
    exit 1
  fi
  mkdir -p "$BACKUP_DIR"

  # 1. online, consistent snapshot (WAL-safe)
  python3 - "$db" "$snapshot" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
try:
    dst = sqlite3.connect(sys.argv[2])
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
finally:
    src.close()
PY

  # 2. verify + normalize to a single plain file (drop WAL sidecars)
  verify="$(python3 - "$snapshot" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
try:
    status = c.execute("PRAGMA integrity_check").fetchone()[0]
    c.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()
    c.execute("PRAGMA journal_mode=DELETE")
finally:
    c.close()
print(status)
PY
)"
  rm -f "$snapshot-wal" "$snapshot-shm"

  if [[ "$verify" != "ok" ]]; then
    echo "ERROR: integrity check failed for $snapshot: $verify" >&2
    exit 1
  fi

  # 3. prune old snapshots
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'journal-*.db' \
    -mtime "+${RETENTION_DAYS}" -delete

  size="$(stat -c %s "$snapshot")"
  count="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'journal-*.db' | wc -l)"

  echo "OK  stored backup at: $snapshot  (${size} bytes, integrity $verify, $count snapshots kept)"
  echo "TIP this file is the only copy of your journal on this host — consider backing it up"
  echo "    from there (offsite copy, e.g. Zerobyte / B2 / an external disk)."
}

# ---------- systemd ----------

calendar_for() {
  case "$1" in
    daily)   echo "*-*-* ${2}:00" ;;
    weekly)  echo "Mon *-*-* ${2}:00" ;;
    monthly) echo "*-*-01 ${2}:00" ;;
  esac
}

install_systemd() {
  local cal svc tm run
  cal="$(calendar_for "$BACKUP_FREQ" "$BACKUP_TIME")"
  svc="/etc/systemd/system/${PREFIX}-backup.service"
  tm="/etc/systemd/system/${PREFIX}-backup.timer"
  run=()
  if (( EUID != 0 )); then run=(sudo); fi

  "${run[@]}" tee "$svc" >/dev/null <<EOF
[Unit]
Description=${PREFIX} DB snapshot backup
After=network.target

[Service]
Type=oneshot
EnvironmentFile=$CONF
ExecStart=$ROOT/backup.sh --backup
EOF

  "${run[@]}" tee "$tm" >/dev/null <<EOF
[Unit]
Description=${PREFIX} DB snapshot backup timer

[Timer]
# Runs at $BACKUP_TIME in the system timezone ($SYSTEM_TZ)
OnCalendar=$cal
Persistent=true
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
EOF

  "${run[@]}" systemctl daemon-reload
  "${run[@]}" systemctl enable --now "${PREFIX}-backup.timer"
  echo "Installed + enabled systemd timer: systemctl list-timers ${PREFIX}-backup.timer"
}

# ---------- wizard ----------

wizard() {
  load_conf
  local dflt_time
  dflt_time="$(utc_to_local 03:30 "$SYSTEM_TZ")"
  cat <<EOF
${PREFIX^} backup setup
(Ctrl-C to cancel; Enter accepts the default shown in brackets.)

EOF

  ask "Database file" "$JOURNAL_DB"; JOURNAL_DB="$REPLY"
  ask "Backup directory" "$BACKUP_DIR"; BACKUP_DIR="$REPLY"
  ask "Keep snapshots for how many days?" "$RETENTION_DAYS"; RETENTION_DAYS="$REPLY"
  echo
  ask_yn "Install systemd timer (automatic backups)?" "$INSTALL_SYSTEMD"
  INSTALL_SYSTEMD="$REPLY"

  if [[ "$INSTALL_SYSTEMD" == y ]]; then
    ask "Backup time (24h, $SYSTEM_TZ)" "$dflt_time"
    while ! valid_time "$REPLY"; do
      ask "Backup time (24h, $SYSTEM_TZ, e.g. $dflt_time)" "$dflt_time"
    done
    BACKUP_TIME="$REPLY"

    ask "Frequency (daily/weekly/monthly)" "$BACKUP_FREQ"
    while ! valid_freq "$REPLY"; do
      ask "Frequency (daily/weekly/monthly)" "$BACKUP_FREQ"
    done
    BACKUP_FREQ="$REPLY"
  fi

  save_conf
  echo
  echo "Settings saved to $CONF"
  if [[ "$INSTALL_SYSTEMD" == y ]]; then
    install_systemd
  fi
  echo
  echo "Backups will be stored in: $BACKUP_DIR"
  echo "TIP that directory lives on this host — arrange an offsite copy of it"
  echo "    (e.g. Zerobyte / B2 / an external disk) so a lost server isn't a lost journal."
  echo "Run '$(basename "$0") --backup' anytime for a manual snapshot."
}

# ---------- main ----------

for arg in "$@"; do
  case "$arg" in
    --backup) MODE=backup ;;
    --setup)  MODE=setup ;;
    --yes)    YES=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

case "$MODE" in
  backup) run_backup ;;
  setup)  wizard ;;
  auto)
    if [[ -t 0 ]]; then
      if [[ -f "$CONF" ]]; then
        # second run: setup already done — don't re-open the wizard
        echo "Setup has already been done."
        echo "To re-configure, run '$(basename "$0") --setup'."
        ask_yn "Start a backup now?" n
        if [[ "$REPLY" == y ]]; then
          run_backup
        fi
      else
        wizard
      fi
    else
      run_backup
    fi
    ;;
esac
