FROM node:24-bookworm-slim

ARG OPENCLAW_VERSION=latest
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
    procps \
    awscli \
    build-essential \
    libsecret-1-0 \
    libsecret-1-dev \
  && rm -rf /var/lib/apt/lists/*

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

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY src ./src
COPY skills ./skills
COPY entrypoint.sh ./entrypoint.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && mkdir -p /home/linuxbrew/.linuxbrew && chown -R openclaw:openclaw /home/linuxbrew

# Create mcporter config directories for both users
RUN mkdir -p /home/openclaw/.mcporter \
  && mkdir -p /root/.mcporter \
  && mkdir -p /root/.config/google-workspace-mcp \
  && mkdir -p /home/openclaw/.config/google-workspace-mcp \
  && chown -R openclaw:openclaw /home/openclaw/.mcporter \
  && chown -R openclaw:openclaw /home/openclaw/.config

# mcporter config for google-workspace MCP.
# Do not inline OAuth secrets at build-time; runtime env vars are inherited.
RUN cat > /home/openclaw/.mcporter/mcporter.json <<'JSON'
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
RUN cp /home/openclaw/.mcporter/mcporter.json /root/.mcporter/mcporter.json \
  && chown openclaw:openclaw /home/openclaw/.mcporter/mcporter.json

# ffmpeg — static binary from johnvansickle (no deps needed)
RUN mkdir -p /tmp/ffmpeg \
    && curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
       | tar -xJ --strip-components=1 -C /tmp/ffmpeg \
    && mv /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
    && mv /tmp/ffmpeg/ffprobe /usr/local/bin/ffprobe \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf /tmp/ffmpeg

# gh (GitHub CLI) — official release binary
RUN GH_VERSION=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep -oP '"tag_name":\s*"v\K[^"]+') \
    && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
       | tar -xz --strip-components=1 -C /tmp \
    && mv /tmp/bin/gh /usr/local/bin/gh \
    && chmod +x /usr/local/bin/gh \
    && rm -rf /tmp/bin /tmp/share

# gogcli — Go binary from steipete's tap
RUN GOGCLI_VERSION=$(curl -fsSL https://api.github.com/repos/steipete/gogcli/releases/latest | grep -oP '"tag_name":\s*"v?\K[^"]+') \
    && curl -fsSL "https://github.com/steipete/gogcli/releases/download/v${GOGCLI_VERSION}/gogcli_linux_amd64.tar.gz" \
       | tar -xz -C /tmp \
    && mv /tmp/gogcli /usr/local/bin/gogcli \
    && chmod +x /usr/local/bin/gogcli \
    && rm -rf /tmp/gogcli*

USER openclaw

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1


USER root
ENTRYPOINT ["./entrypoint.sh"]
