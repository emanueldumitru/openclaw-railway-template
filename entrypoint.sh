#!/usr/bin/env bash
set -euo pipefail

# ── Resolve runtime user ────────────────────────────────────────────
OC_UID="$(id -u openclaw)"
OC_GID="$(id -g openclaw)"

# ── /data volume setup (Railway persistent volume) ──────────────────
mkdir -p /data
DATA_OWNER="$(stat -c '%u:%g' /data 2>/dev/null || true)"
if [ "$DATA_OWNER" != "${OC_UID}:${OC_GID}" ]; then
  chown openclaw:openclaw /data
fi
if [ "${FORCE_DATA_RECURSIVE_CHOWN:-false}" = "true" ]; then
  chown -R openclaw:openclaw /data
fi
chmod 700 /data

# Pre-create state + workspace dirs so nothing runs as root creates them
STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-${STATE_DIR}/workspace}"
mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
chown -R openclaw:openclaw "$STATE_DIR"
chown openclaw:openclaw "$WORKSPACE_DIR"

# ── Seed bundled skills into workspace ───────────────────────────────
SKILLS_DIR="${WORKSPACE_DIR}/skills"
mkdir -p "$SKILLS_DIR"
if [ -d /app/skills ]; then
  shopt -s nullglob
  for skill_dir in /app/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_DIR/$skill_name"
    if [ ! -d "$target" ]; then
      cp -a "$skill_dir" "$target"
      chown -R openclaw:openclaw "$target"
    fi
  done
  shopt -u nullglob
fi
chown openclaw:openclaw "$SKILLS_DIR"

# ── gogcli config from Railway Object Storage ───────────────────────
if [ -n "${AWS_ENDPOINT_URL:-}" ] && [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
  echo "[gog] syncing gogcli config from bucket..."
  GOG_CONFIG_DIR="/home/openclaw/.config/gogcli"
  mkdir -p "$GOG_CONFIG_DIR/keyring"

  # Railway Object Storage uses signed requests — no --no-sign-request
  if aws s3 sync "s3://${AWS_S3_BUCKET_NAME}/gogcli/" "$GOG_CONFIG_DIR/" \
       --endpoint-url "$AWS_ENDPOINT_URL" \
       --region "${AWS_DEFAULT_REGION:-us-east-1}" 2>&1; then
    echo "[gog] gogcli config synced to $GOG_CONFIG_DIR"
  else
    echo "[gog] WARNING: failed to sync gogcli config (continuing anyway)"
  fi

  chown -R openclaw:openclaw "$GOG_CONFIG_DIR"
fi

# ── mcporter config (idempotent — always write fresh) ────────────────
# Only for openclaw user; root never runs mcporter.
mkdir -p /home/openclaw/.mcporter
cat > /home/openclaw/.mcporter/mcporter.json <<'JSON'
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp-server"]
    },
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"]
    }
  },
  "imports": []
}
JSON
chown openclaw:openclaw /home/openclaw/.mcporter/mcporter.json

# ── Patch control UI instance identity ───────────────────────────────
# Runs as root (writes to /usr/local/lib/node_modules/... which is root-owned)
node /app/src/patch-control-ui-instance.js 2>/dev/null || true

# ── Ollama (optional local model runtime) ────────────────────────────
if [ "${ENABLE_OLLAMA:-false}" = "true" ]; then
  OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
  OLLAMA_HOST="${OLLAMA_HOST#http://}"
  OLLAMA_HOST="${OLLAMA_HOST#https://}"
  export OLLAMA_HOST
  export OLLAMA_MODELS="${OLLAMA_MODELS:-/data/ollama/models}"
  export OLLAMA_API_KEY="${OLLAMA_API_KEY:-ollama-local}"
  export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://$OLLAMA_HOST/api}"

  mkdir -p "$OLLAMA_MODELS"
  chown openclaw:openclaw "$OLLAMA_MODELS"

  echo "[ollama] starting ollama serve on $OLLAMA_HOST"
  gosu openclaw env \
    OLLAMA_HOST="$OLLAMA_HOST" \
    OLLAMA_MODELS="$OLLAMA_MODELS" \
    OLLAMA_API_KEY="$OLLAMA_API_KEY" \
    ollama serve >>/tmp/ollama.log 2>&1 &
  OLLAMA_PID=$!

  # Wait up to 30s for ollama to be ready
  OLLAMA_READY=false
  for _ in $(seq 1 30); do
    if curl -fsS "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
      echo "[ollama] runtime ready (pid=$OLLAMA_PID)"
      OLLAMA_READY=true
      break
    fi
    sleep 1
  done
  if [ "$OLLAMA_READY" = "false" ]; then
    echo "[ollama] WARNING: runtime did not start within 30s — check /tmp/ollama.log"
  fi

  # Pull requested models
  if [ -n "${OLLAMA_PULL_MODELS:-}" ]; then
    IFS=',' read -ra MODELS_TO_PULL <<< "$OLLAMA_PULL_MODELS"
    for model in "${MODELS_TO_PULL[@]}"; do
      model="$(echo "$model" | xargs)"
      [ -z "$model" ] && continue
      echo "[ollama] pulling model: $model"
      gosu openclaw env \
        OLLAMA_HOST="$OLLAMA_HOST" \
        OLLAMA_MODELS="$OLLAMA_MODELS" \
        OLLAMA_API_KEY="$OLLAMA_API_KEY" \
        ollama pull "$model" || echo "[ollama] WARNING: failed to pull $model"
    done
  fi
fi

# ── Start OpenClaw ───────────────────────────────────────────────────
exec gosu openclaw node "${OPENCLAW_ENTRY:-src/server.js}" "$@"