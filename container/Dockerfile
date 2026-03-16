# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @googleworkspace/cli

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
#
# Compilation strategy: /app/dist is bind-mounted from the host (per-group).
# We hash /app/src on startup and skip tsc if the hash matches the last build.
# This means each group compiles exactly once; every subsequent run is instant.
RUN printf '#!/bin/bash\nset -e\nDIST=/app/dist\nSRC_HASH=$(find /app/src -name "*.ts" | sort | xargs md5sum 2>/dev/null | md5sum | cut -d" " -f1)\nif [ -f "$DIST/index.js" ] && [ -f "$DIST/.src-hash" ] && [ "$(cat $DIST/.src-hash)" = "$SRC_HASH" ]; then\n  : # dist is up to date, skip compilation\nelse\n  echo "[entrypoint] Compiling agent-runner..." >&2\n  cd /app && npx tsc --outDir "$DIST" 2>&1 >&2\n  ln -sf /app/node_modules "$DIST/node_modules"\n  echo "$SRC_HASH" > "$DIST/.src-hash"\nfi\ncat > /tmp/input.json\nnode "$DIST/index.js" < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
