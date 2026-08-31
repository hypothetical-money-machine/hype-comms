# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_update_notifier=false

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    ca-certificates \
    dbus-x11 \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libudev1 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    procps \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN chown node:node /workspace \
  && install -d -o node -g node /home/node/.cache/electron /home/node/.cache/ms-playwright

COPY --chown=node:node .npmrc package.json package-lock.json tsconfig.base.json ./
COPY --chown=node:node apps/desktop/package.json ./apps/desktop/package.json
COPY --chown=node:node apps/server/package.json ./apps/server/package.json
COPY --chown=node:node packages/cli/package.json ./packages/cli/package.json
COPY --chown=node:node packages/contracts/package.json ./packages/contracts/package.json

USER node

RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 \
  npm ci --no-audit --include-workspace-root \
    --workspace @hype-comms/contracts \
    --workspace @hype-comms/server \
    --workspace @hype-comms/desktop

RUN --mount=type=cache,target=/home/node/.cache/electron,uid=1000,gid=1000 \
  node_modules/.bin/install-electron --no \
  && node_modules/.bin/playwright install ffmpeg

COPY --chown=node:node . .

ENTRYPOINT ["dbus-run-session", "--", "xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x800x24 -nolisten tcp -noreset"]
