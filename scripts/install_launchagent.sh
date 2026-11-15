#!/usr/bin/env bash
set -euo pipefail

LABEL="com.supervisely.qc.daemon"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_PY="${REPO_ROOT}/backend/.venv/bin/python"
BACKEND_ENTRY="${REPO_ROOT}/backend/main.py"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${PLIST_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/supervisely-qc"

DRY_RUN=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    --uninstall)
      UNINSTALL=1
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [--dry-run] [--uninstall]

Installs and loads the macOS LaunchAgent (${LABEL}) for the local
Supervisely Hybrid QC Assistant daemon on http://127.0.0.1:8765.

Options:
  --dry-run     Print the generated plist and commands without modifying ~/Library/LaunchAgents
  --uninstall   Unload and remove ${PLIST_PATH}
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

UID_VAL="$(id -u)"

if [[ "$UNINSTALL" -eq 1 ]]; then
  echo "Uninstalling ${LABEL}..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] launchctl bootout gui/${UID_VAL}/${LABEL} || true"
    echo "[dry-run] rm -f ${PLIST_PATH}"
    exit 0
  fi
  launchctl bootout "gui/${UID_VAL}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "${PLIST_PATH}"
  echo "Removed ${PLIST_PATH}"
  exit 0
fi

if [[ ! -x "${VENV_PY}" ]]; then
  echo "Missing Python venv at ${VENV_PY}. Run 'make bootstrap' first." >&2
  exit 1
fi

if [[ ! -f "${BACKEND_ENTRY}" ]]; then
  echo "Missing backend entrypoint at ${BACKEND_ENTRY}." >&2
  exit 1
fi

PLIST_CONTENT=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${VENV_PY}</string>
    <string>${BACKEND_ENTRY}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key>
    <string>1</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
EOF
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s\n' "${PLIST_CONTENT}"
  echo "[dry-run] Would write ${PLIST_PATH} and bootstrap gui/${UID_VAL}/${LABEL}"
  exit 0
fi

mkdir -p "${PLIST_DIR}" "${LOG_DIR}"
printf '%s\n' "${PLIST_CONTENT}" > "${PLIST_PATH}"

if command -v plutil >/dev/null 2>&1; then
  plutil -lint "${PLIST_PATH}"
fi

DOMAIN_TARGET="gui/${UID_VAL}"
SERVICE_TARGET="${DOMAIN_TARGET}/${LABEL}"

if launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
  launchctl bootout "${SERVICE_TARGET}" >/dev/null 2>&1 || true
  # launchctl bootout tears down running services asynchronously; wait until unregistered.
  for _ in $(seq 1 50); do
    if ! launchctl print "${SERVICE_TARGET}" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
fi

if command -v lsof >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if ! lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  if lsof -nP -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port 127.0.0.1:8765 is still in use:" >&2
    lsof -nP -iTCP:8765 -sTCP:LISTEN >&2 || true
    exit 1
  fi
fi

launchctl enable "${SERVICE_TARGET}" >/dev/null 2>&1 || true

BOOTSTRAPPED=0
BOOTSTRAP_ERR=""
for attempt in $(seq 1 20); do
  if BOOTSTRAP_ERR="$(launchctl bootstrap "${DOMAIN_TARGET}" "${PLIST_PATH}" 2>&1)"; then
    BOOTSTRAPPED=1
    break
  fi
  # Error 5 (EIO) occurs briefly while launchd finalizes teardown of the prior job.
  if [[ "${attempt}" -lt 20 ]]; then
    sleep 0.25
  fi
done

if [[ "${BOOTSTRAPPED}" -ne 1 ]]; then
  echo "${BOOTSTRAP_ERR}" >&2
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:8765/api/v1/health" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

echo "Installed and started ${LABEL} -> ${PLIST_PATH}"
echo "Logs: ${LOG_DIR}/stdout.log and ${LOG_DIR}/stderr.log"
echo "Bridge token file: ${HOME}/.config/supervisely-qc/bridge_token"
