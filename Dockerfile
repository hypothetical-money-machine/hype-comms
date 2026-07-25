# syntax=docker/dockerfile:1.7
#
# Production image for the HMM Chat Fastify service.
#
# Only the server and contracts workspaces are installed. The desktop workspace's manifest is
# copied so that `npm ci` sees the same workspace set the lockfile was generated against, but its
# dependencies (notably Electron) are never installed.

FROM node:24.18.0-alpine AS base
WORKDIR /app
ENV npm_config_update_notifier=false

# ---------------------------------------------------------------------------
# Build: install every dependency needed to compile, then emit dist output.
# ---------------------------------------------------------------------------
FROM base AS build
COPY .npmrc package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/server/package.json ./apps/server/
COPY apps/desktop/package.json ./apps/desktop/
RUN npm ci --include-workspace-root \
  --workspace @hmm-chat/contracts \
  --workspace @hmm-chat/server

COPY packages/contracts ./packages/contracts
COPY apps/server ./apps/server
RUN npm run build --workspace @hmm-chat/server

# ---------------------------------------------------------------------------
# Production dependencies: the same install without dev dependencies.
# ---------------------------------------------------------------------------
FROM base AS production-deps
COPY .npmrc package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/server/package.json ./apps/server/
COPY apps/desktop/package.json ./apps/desktop/
RUN npm ci --omit=dev --include-workspace-root \
  --workspace @hmm-chat/contracts \
  --workspace @hmm-chat/server

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    HMM_HOST=0.0.0.0 \
    HMM_PORT=3000

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/package.json ./package.json
COPY --from=build /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/livez || exit 1

WORKDIR /app/apps/server
CMD ["node", "dist/main.js"]
