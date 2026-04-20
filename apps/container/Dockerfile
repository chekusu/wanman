FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# System packages
RUN apt-get update && apt-get install -y \
    curl \
    git \
    sqlite3 \
    jq \
    wget \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official APT source)
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Codex CLI
RUN npm install -g @openai/codex@latest \
    && ARCH=$(uname -m) \
    && if [ "$ARCH" = "aarch64" ]; then npm install -g @openai/codex-linux-arm64 2>/dev/null || true; fi \
    && if [ "$ARCH" = "x86_64" ]; then npm install -g @openai/codex-linux-x64 2>/dev/null || true; fi

# Copy built runtime
COPY packages/runtime/dist/entrypoint.js /opt/wanman/runtime/entrypoint.js

# Install native dependencies externalized by esbuild
RUN cd /opt/wanman/runtime && npm install better-sqlite3

# Copy built CLI
COPY packages/cli/dist/index.js /usr/local/bin/wanman
RUN chmod +x /usr/local/bin/wanman

# Copy agent config
COPY apps/container/agents.example.json /opt/wanman/agents.json

# Copy shared skills (SKILL.md for agent runtime auto-discovery)
COPY packages/core/skills/ /opt/wanman/shared-skills/

# Create directories
RUN mkdir -p /workspace/agents /data

WORKDIR /workspace

EXPOSE 3120

ENTRYPOINT ["node", "/opt/wanman/runtime/entrypoint.js"]
