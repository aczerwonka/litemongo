# syntax=docker/dockerfile:1.7
#
# LiteMongo — single stateless container serving the Fastify API (/api),
# the embedded MCP server (/mcp) and the compiled React PWA from one port.
#
# Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 -t litemongo:latest --push .
#
# The build stage runs on the BUILDER's native platform (its output is plain
# JS/CSS, identical for every target), so no QEMU emulation is needed for the
# slow Vite/TypeScript build. Only the small runtime stage is per-architecture.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Stage 1: build client (Vite + PWA) and compile server (tsc)
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# The client imports litemongo.config.example.json (default workspace) and
# server/src/lib/config.ts (shared types), so both trees are needed here.
COPY litemongo.config.example.json ./
COPY server/ server/
COPY client/ client/
RUN npm run build -w client && npm run build -w server

# ---------------------------------------------------------------------------
# Stage 2: production runtime (per target architecture)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    LOG_LEVEL=info \
    FORCE_READ_ONLY=false

# Production dependencies of the server workspace only (pure JS, no native addons).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace server --no-audit --no-fund \
 && rm -rf client

COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
# Shipped as reference only; mount your own and set LITEMONGO_CONFIG to feed /mcp.
COPY litemongo.config.example.json ./

# Stateless by design: nothing is written at runtime, so run unprivileged and
# the container works with a read-only root filesystem (docker run --read-only).
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

WORKDIR /app/server
CMD ["node", "dist/index.js"]
