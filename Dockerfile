###############################################################################
# Stage 1 — BUILD (throwaway: compiler, dev headers, caches)
###############################################################################
FROM node:24-bookworm-slim AS builder

ARG OPENCLAW_VERSION=latest
ENV NODE_ENV=production

# System deps needed ONLY for native module compilation
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    libsecret-1-dev \
    curl \
    git \
    ca-certificates \
    unzip \
    zstd \
  && rm -rf /var/lib/apt/lists/*

# Global npm packages — compiled with build-essential, copied to runtime
RUN npm install -g \
    "openclaw@${OPENCLAW_VERSION}" \
    mcporter \
    clawdhub \
    agent-browser \
    crawlee \
    @steipete/summarize \
    undici \
    @tobilu/qmd \
  && npm cache clean --force

# App dependencies
WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && pnpm install --frozen-lockfile --prod \
  && pnpm store prune

# Static binaries — download ALL in parallel into /opt/bin
RUN mkdir -p /opt/bin /tmp/{ffmpeg,gh} \
  && ( curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
         | tar -xJ --strip-components=1 -C /tmp/ffmpeg \
       && mv /tmp/ffmpeg/ffmpeg /tmp/ffmpeg/ffprobe /opt/bin/ ) & \
  && ( GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
         | grep -oP '"tag_name":\s*"v\K[^"]+') \
       && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
         | tar -xz --strip-components=1 -C /tmp/gh \
       && mv /tmp/gh/bin/gh /opt/bin/ ) & \
  && ( curl -fsSL "https://github.com/steipete/gogcli/releases/download/v0.11.0/gogcli_0.11.0_linux_amd64.tar.gz" \
         | tar -xz -C /tmp \
       && mv /tmp/gog /opt/bin/ ) & \
  && ( curl -fsSL "https://ollama.com/download/ollama-linux-amd64.tar.zst" \
         | tar -I zstd -xf - -C /tmp \
       && mv /tmp/bin/ollama /opt/bin/ ) & \
  && ( curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscli.zip \
       && unzip -q /tmp/awscli.zip -d /tmp/awscli \
       && /tmp/awscli/aws/install --install-dir /usr/local/aws-cli --bin-dir /opt/bin ) & \
  && wait \
  && chmod +x /opt/bin/* \
  && rm -rf /tmp/*


###############################################################################
# Stage 2 — RUNTIME (no compiler, no dev headers, no caches)
###############################################################################
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js

# Runtime-only packages (build-essential, *-dev, zstd all gone)
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    libsecret-1-0 \
    tini \
  && rm -rf /var/lib/apt/lists/*

# Compiled npm globals from builder
COPY --from=builder /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=builder /usr/local/bin              /usr/local/bin

# Static binaries from builder
COPY --from=builder /opt/bin/ /usr/local/bin/

# AWS CLI v2 (self-contained, no Python apt dependency)
COPY --from=builder /usr/local/aws-cli /usr/local/aws-cli

# User + directories — single layer
RUN useradd -m -s /bin/bash openclaw \
  && mkdir -p /app /data \
       /home/openclaw/.mcporter \
       /home/openclaw/.config/google-workspace-mcp

# Pre-compiled app dependencies
COPY --from=builder /build/node_modules /app/node_modules

# App source — COPY --chown avoids a separate chown layer
WORKDIR /app
COPY --chown=openclaw:openclaw package.json pnpm-lock.yaml ./
COPY --chown=openclaw:openclaw src          ./src
COPY --chown=openclaw:openclaw skills       ./skills
COPY --chown=openclaw:openclaw entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# mcporter config — heredoc COPY (BuildKit)
COPY <<'JSON' /home/openclaw/.mcporter/mcporter.json
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

# Final ownership pass
RUN chown -R openclaw:openclaw /app /data /home/openclaw

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8080/setup/healthz || exit 1

# tini → proper PID 1 (signal forwarding + zombie reaping)
# entrypoint.sh drops to openclaw via gosu
ENTRYPOINT ["tini", "--", "./entrypoint.sh"]