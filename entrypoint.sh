#!/bin/bash
set -euo pipefail

mkdir -p /data
DATA_OWNER_EXPECTED="$(id -u openclaw):$(id -g openclaw)"
DATA_OWNER_CURRENT="$(stat -c '%u:%g' /data 2>/dev/null || true)"
if [ "$DATA_OWNER_CURRENT" != "$DATA_OWNER_EXPECTED" ]; then
  chown openclaw:openclaw /data
fi
if [ "${FORCE_DATA_RECURSIVE_CHOWN:-false}" = "true" ]; then
  chown -R openclaw:openclaw /data
fi
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew
chown -h openclaw:openclaw /home/linuxbrew/.linuxbrew

# Seed bundled skills into the workspace skills directory
SKILLS_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}/skills"
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
# Pull gogcli config from Railway bucket (if bucket credentials are set)
if [ -n "$AWS_ENDPOINT_URL" ] && [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "[gog] syncing gogcli config from bucket..."
  GOG_CONFIG_DIR="/home/openclaw/.config/gogcli"
  mkdir -p "$GOG_CONFIG_DIR/keyring"

  AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  aws s3 sync "s3://${AWS_S3_BUCKET_NAME}/gogcli/" "$GOG_CONFIG_DIR/" \
    --endpoint-url "$AWS_ENDPOINT_URL" \
    --region "${AWS_DEFAULT_REGION:-us-east-1}" \
    --no-sign-request 2>/dev/null || \
  AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  aws s3 sync "s3://${AWS_S3_BUCKET_NAME}/gogcli/" "$GOG_CONFIG_DIR/" \
    --endpoint-url "$AWS_ENDPOINT_URL" \
    --region "${AWS_DEFAULT_REGION:-us-east-1}" || true

  chown -R openclaw:openclaw "$GOG_CONFIG_DIR"
  echo "[gog] gogcli config synced to $GOG_CONFIG_DIR"
fi

# Ensure mcporter config never bakes literal OAuth placeholders.
mkdir -p /home/openclaw/.mcporter /root/.mcporter
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
cp /home/openclaw/.mcporter/mcporter.json /root/.mcporter/mcporter.json
chown openclaw:openclaw /home/openclaw/.mcporter/mcporter.json

# Keep Control UI instance identity stable across refreshes.
node /app/src/patch-control-ui-instance.js || true

if [ "${ENABLE_OLLAMA:-false}" = "true" ]; then
  OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
  OLLAMA_HOST="${OLLAMA_HOST#http://}"
  OLLAMA_HOST="${OLLAMA_HOST#https://}"
  export OLLAMA_HOST
  export OLLAMA_MODELS="${OLLAMA_MODELS:-/data/ollama/models}"
  export OLLAMA_API_KEY="${OLLAMA_API_KEY:-ollama-local}"
  export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://$OLLAMA_HOST/api}"

  mkdir -p "$OLLAMA_MODELS"
  chown -R openclaw:openclaw "$OLLAMA_MODELS"

  echo "[ollama] starting ollama serve on $OLLAMA_HOST"
  gosu openclaw env \
    OLLAMA_HOST="$OLLAMA_HOST" \
    OLLAMA_MODELS="$OLLAMA_MODELS" \
    OLLAMA_API_KEY="$OLLAMA_API_KEY" \
    ollama serve >/tmp/ollama.log 2>&1 &

  for _ in $(seq 1 30); do
    if curl -fsS "http://$OLLAMA_HOST/api/tags" >/dev/null 2>&1; then
      echo "[ollama] runtime ready"
      break
    fi
    sleep 1
  done

  if [ -n "${OLLAMA_PULL_MODELS:-}" ]; then
    OLDIFS="$IFS"
    IFS=','
    read -ra OLLAMA_MODELS_TO_PULL <<< "$OLLAMA_PULL_MODELS"
    IFS="$OLDIFS"
    for model in "${OLLAMA_MODELS_TO_PULL[@]}"; do
      model="$(echo "$model" | xargs)"
      if [ -z "$model" ]; then
        continue
      fi
      echo "[ollama] pulling model: $model"
      gosu openclaw env \
        OLLAMA_HOST="$OLLAMA_HOST" \
        OLLAMA_MODELS="$OLLAMA_MODELS" \
        OLLAMA_API_KEY="$OLLAMA_API_KEY" \
        ollama pull "$model" || echo "[ollama] failed to pull model: $model"
    done
  fi
fi

exec gosu openclaw node src/server.js
