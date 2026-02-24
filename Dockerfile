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
    }
  },
  "imports": []
}
JSON
RUN cp /home/openclaw/.mcporter/mcporter.json /root/.mcporter/mcporter.json \
  && chown openclaw:openclaw /home/openclaw/.mcporter/mcporter.json

USER openclaw
RUN NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"
ENV HOMEBREW_PREFIX="/home/linuxbrew/.linuxbrew"
ENV HOMEBREW_CELLAR="/home/linuxbrew/.linuxbrew/Cellar"
ENV HOMEBREW_REPOSITORY="/home/linuxbrew/.linuxbrew/Homebrew"
ENV DBUS_SESSION_BUS_ADDRESS="disabled:"

# Install CLI tools needed by skills
RUN brew install steipete/tap/gogcli \
  && brew install ffmpeg \
  && brew install gh \
  && brew cleanup -s \
  && rm -rf /home/openclaw/Library/Caches/Homebrew

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1


RUN clawdhub install agent-browser --force \
  && clawdhub install gog --force \
  && clawdhub install find-skills --force \
  && clawdhub install tavily-search --force \
  && clawdhub install supermemory --force \
  && clawdhub install github --force


USER root
ENTRYPOINT ["./entrypoint.sh"]
