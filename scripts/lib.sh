#!/usr/bin/env bash
set -euo pipefail

LABEL="com.consumption-watch"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$ROOT/launchd/com.consumption-watch.plist.template"
PLIST_DEST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
PORT="${PORT:-3847}"
DOMAIN="gui/$(id -u)"
SERVICE="${DOMAIN}/${LABEL}"
ENTRY="${ROOT}/src/index.ts"

RUNTIME_KIND=""
RUNTIME_BIN=""

resolve_bun() {
  if [[ -n "${BUN:-}" && -x "${BUN}" ]]; then
    echo "${BUN}"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [[ -x "${HOME}/.bun/bin/bun" ]]; then
    echo "${HOME}/.bun/bin/bun"
    return 0
  fi
  return 1
}

resolve_node() {
  if [[ -n "${NODE:-}" && -x "${NODE}" ]]; then
    echo "${NODE}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

# Prefer RUNTIME=bun|node, else bun, else node (Node >= 22.5 for node:sqlite).
resolve_runtime() {
  local kind="${RUNTIME:-}"

  if [[ -z "${kind}" ]]; then
    if resolve_bun >/dev/null; then
      kind="bun"
    elif resolve_node >/dev/null; then
      kind="node"
    else
      echo "error: need bun or node (Node >= 22.5); set RUNTIME=bun|node" >&2
      exit 1
    fi
  fi

  case "${kind}" in
    bun)
      RUNTIME_BIN="$(resolve_bun)" || {
        echo "error: bun not found; install bun or set BUN=/path/to/bun" >&2
        exit 1
      }
      ;;
    node)
      RUNTIME_BIN="$(resolve_node)" || {
        echo "error: node not found; install Node >= 22.5 or set NODE=/path/to/node" >&2
        exit 1
      }
      ;;
    *)
      echo "error: RUNTIME must be bun or node (got: ${kind})" >&2
      exit 1
      ;;
  esac

  RUNTIME_KIND="${kind}"
}

write_program_arguments_xml() {
  local out="$1"
  local args=()
  case "${RUNTIME_KIND}" in
    bun)
      args=("${RUNTIME_BIN}" "run" "${ENTRY}")
      ;;
    node)
      args=("${RUNTIME_BIN}" "--experimental-strip-types" "${ENTRY}")
      ;;
  esac

  : >"${out}"
  local arg
  for arg in "${args[@]}"; do
    printf '      <string>%s</string>\n' "${arg}" >>"${out}"
  done
}

service_loaded() {
  launchctl print "${SERVICE}" >/dev/null 2>&1
}

render_plist() {
  resolve_runtime

  local bin_dir path_value args_file tmp
  bin_dir="$(dirname "${RUNTIME_BIN}")"
  path_value="${bin_dir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  args_file="$(mktemp)"
  tmp="$(mktemp)"
  write_program_arguments_xml "${args_file}"

  sed \
    -e "s|__ROOT__|${ROOT}|g" \
    -e "s|__PORT__|${PORT}|g" \
    -e "s|__PATH__|${path_value}|g" \
    "${TEMPLATE}" >"${tmp}"

  mkdir -p "$(dirname "${PLIST_DEST}")"
  awk -v argsfile="${args_file}" '
    /__PROGRAM_ARGUMENTS__/ {
      while ((getline line < argsfile) > 0) print line
      close(argsfile)
      next
    }
    { print }
  ' "${tmp}" >"${PLIST_DEST}"

  rm -f "${tmp}" "${args_file}"
  echo "runtime ${RUNTIME_KIND} (${RUNTIME_BIN})"
}

bootout_service() {
  if service_loaded; then
    launchctl bootout "${SERVICE}" >/dev/null 2>&1 || true
  fi
}

bootstrap_service() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "${DOMAIN}" "${PLIST_DEST}" 2>/tmp/cw-bootstrap.err; then
      return 0
    fi
    # launchd can return a transient I/O error right after bootout.
    sleep 0.4
  done
  cat /tmp/cw-bootstrap.err >&2 || true
  return 1
}

kickstart_service() {
  launchctl kickstart -k "${SERVICE}"
}
