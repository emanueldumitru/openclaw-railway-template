#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

# Seed bundled skills into the workspace skills directory
SKILLS_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}/skills"
mkdir -p "$SKILLS_DIR"
if [ -d /app/skills ]; then
  for skill_dir in /app/skills/*/; do
    skill_name="$(basename "$skill_dir")"
    target="$SKILLS_DIR/$skill_name"
    if [ ! -d "$target" ]; then
      cp -a "$skill_dir" "$target"
    fi
  done
fi
chown -R openclaw:openclaw "$SKILLS_DIR"
# Ensure mcporter config never bakes literal OAuth placeholders.
mkdir -p /home/openclaw/.mcporter /root/.mcporter
cat > /home/openclaw/.mcporter/mcporter.json <<'JSON'
{
  "mcpServers": {
    "google-workspace": {
      "command": "npx",
      "args": ["-y", "google-workspace-mcp-server"]
    }
  },
  "imports": []
}
JSON
cp /home/openclaw/.mcporter/mcporter.json /root/.mcporter/mcporter.json
chown openclaw:openclaw /home/openclaw/.mcporter/mcporter.json

# Keep Control UI instance identity stable across refreshes.
node /app/src/patch-control-ui-instance.js || true

exec gosu openclaw node src/server.js
