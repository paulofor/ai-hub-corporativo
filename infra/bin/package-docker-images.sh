#!/usr/bin/env bash
set -euo pipefail

OUTPUT_PATH=${1:-infra/downloads/ai-hub-images.tar}

IMAGES=()
append_image() {
  local var_name="$1"
  local value="${!var_name-}"
  if [[ -n "${value}" ]]; then
    IMAGES+=("${value}")
  fi
}

append_image BACKEND_IMAGE
append_image FRONTEND_IMAGE
append_image SANDBOX_ORCHESTRATOR_IMAGE

if [[ ${#IMAGES[@]} -eq 0 ]]; then
  echo "[package-docker-images] Nenhuma imagem informada. Defina as variáveis BACKEND_IMAGE, FRONTEND_IMAGE e SANDBOX_ORCHESTRATOR_IMAGE antes de executar." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[package-docker-images] Docker não está disponível no PATH." >&2
  exit 1
fi

bundle_dir="$(dirname "${OUTPUT_PATH}")"
mkdir -p "${bundle_dir}"

tmp_tar="${OUTPUT_PATH}.tmp.$$"
trap 'rm -f "${tmp_tar}" "${tmp_tar}.sha256"' EXIT

echo "[package-docker-images] Exportando ${#IMAGES[@]} imagem(ns) para ${OUTPUT_PATH}" >&2
if ! docker image inspect "${IMAGES[@]}" >/dev/null 2>&1; then
  echo "[package-docker-images] Pelo menos uma das imagens informadas não está disponível localmente." >&2
  exit 1
fi

docker save "${IMAGES[@]}" -o "${tmp_tar}"

mv "${tmp_tar}" "${OUTPUT_PATH}"
chmod 644 "${OUTPUT_PATH}" 2>/dev/null || true

sha256sum "${OUTPUT_PATH}" > "${tmp_tar}.sha256"
mv "${tmp_tar}.sha256" "${OUTPUT_PATH}.sha256"
chmod 644 "${OUTPUT_PATH}.sha256" 2>/dev/null || true

trap - EXIT

echo "[package-docker-images] Pacote gerado em ${OUTPUT_PATH} (checksum em ${OUTPUT_PATH}.sha256)." >&2
