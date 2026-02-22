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

exec gosu openclaw node src/server.js
