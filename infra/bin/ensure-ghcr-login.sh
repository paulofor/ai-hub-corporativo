#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_DIR}/.env"

log() {
  echo "[ensure-ghcr-login] $*"
}

trim() {
  local value="$1"
  value="${value##[[:space:]]*}"
  value="${value%%[[:space:]]*}"
  printf '%s' "${value}"
}

expand_path() {
  local path="$1"
  if [[ -z "${path}" ]]; then
    printf '%s' ""
    return
  fi
  if [[ "${path}" == ~* ]]; then
    printf '%s' "${path/#\~/${HOME}}"
  else
    printf '%s' "${path}"
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  log "Docker não está instalado no sistema."
  exit 1
fi

if [ -f "${ENV_FILE}" ]; then
  # shellcheck disable=SC1090
  set -a
  source "${ENV_FILE}"
  set +a
fi

GHCR_REGISTRY="${GHCR_REGISTRY:-ghcr.io}"
GHCR_USERNAME="$(trim "${GHCR_USERNAME:-}")"
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_TOKEN_FILE="$(expand_path "${GHCR_TOKEN_FILE:-}")"

if [[ -z "${GHCR_TOKEN}" && -n "${GHCR_TOKEN_FILE}" && -r "${GHCR_TOKEN_FILE}" ]]; then
  GHCR_TOKEN="$(<"${GHCR_TOKEN_FILE}")"
fi

GHCR_TOKEN="$(trim "${GHCR_TOKEN}")"

if [[ -z "${GHCR_USERNAME}" || -z "${GHCR_TOKEN}" ]]; then
  log "GHCR_USERNAME ou GHCR_TOKEN não encontrados; pulando autenticação."
  exit 0
fi

if printf '%s' "${GHCR_TOKEN}" | docker login "${GHCR_REGISTRY}" -u "${GHCR_USERNAME}" --password-stdin >/dev/null 2>&1; then
  log "Autenticado em ${GHCR_REGISTRY} como ${GHCR_USERNAME}."
else
  log "Falha ao autenticar em ${GHCR_REGISTRY}." >&2
  exit 1
fi
