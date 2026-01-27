# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS production
ARG CFR_VERSION=0.152
WORKDIR /app
RUN apk add --no-cache git python3 py3-pip patch openjdk21-jdk maven ripgrep curl \
  && cat <<'EOF' >/usr/local/bin/apply_patch
#!/bin/sh
set -euo pipefail

TMPFILE=$(mktemp)
cleanup() {
  rm -f "$TMPFILE" "${TMPFILE}.patch"
}
trap cleanup EXIT

cat >"$TMPFILE"

if grep -q '^*** Begin Patch' "$TMPFILE"; then
  sed -n '/^*** Begin Patch/,/^*** End Patch/p' "$TMPFILE" | sed '1d;$d' >"${TMPFILE}.patch"
else
  cp "$TMPFILE" "${TMPFILE}.patch"
fi

PATCH_BIN="$(command -v gpatch || true)"
if [ -z "$PATCH_BIN" ]; then
  PATCH_BIN="$(command -v patch || true)"
fi

if [ -z "$PATCH_BIN" ]; then
  echo 'Nenhum comando patch encontrado no contêiner.' >&2
  exit 1
fi

"$PATCH_BIN" -p0 -u -N --no-backup-if-mismatch <"${TMPFILE}.patch"
EOF
RUN chmod +x /usr/local/bin/apply_patch
RUN mkdir -p /opt/tools \
  && curl -sSL -o /opt/tools/cfr-${CFR_VERSION}.jar https://github.com/leibnitz27/cfr/releases/download/${CFR_VERSION}/cfr-${CFR_VERSION}.jar \
  && ln -sf /opt/tools/cfr-${CFR_VERSION}.jar /opt/tools/cfr.jar \
  && printf '#!/bin/sh\nexec java -jar /opt/tools/cfr.jar "$@"\n' >/usr/local/bin/cfr \
  && chmod +x /usr/local/bin/cfr
RUN npm install -g typescript
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
