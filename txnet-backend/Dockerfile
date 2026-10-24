# ==========================================
# Stage 1: Base
# ==========================================
ARG DOCKER_REGISTRY
# Node 24, as on the host and in CI (`.github/workflows/ci.yml`). Its npm 11 is
# the npm that writes package-lock.json; npm 10 (node:20) rejected that lockfile
# in `npm ci`, and some dependencies (undici 8) require Node >= 22.19.
# Pinned to the patch, not the line: a floating tag stays on whatever was cached
# (Node security release 2026-10-21: Brotli RCE, TLS hostname bypass). Bump on the next one.
FROM ${DOCKER_REGISTRY}/node:24.22.1-alpine AS base
WORKDIR /app
# APP_NAME is declared per stage, after the shared ones: an ENV here would make
# every app's `npm ci` a different layer, eleven installs instead of one (K8).

# ==========================================
# Stage 2: Dependencies
# ==========================================
FROM base AS dependencies
COPY package.json package-lock.json ./
# vendored tarball of the shared @txnet/locale-client (file: dependency)
COPY vendor ./vendor
RUN npm ci
COPY . .
# Prisma Client must be (re)generated AFTER the schema is in the image.
RUN npx prisma generate

# ==========================================
# Stage 3: Development
# ==========================================

FROM dependencies AS dev
ARG APP_NAME
ENV APP_NAME=${APP_NAME}
ENV NODE_ENV=development
ENV NX_DAEMON=true
EXPOSE 3000

ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy=""

# حذف RUN npx nx build
# جایگزینی CMD برای اجرای حالت توسعه و Watch
# `nx serve` re-spawns webpack from scratch on every save (see scripts/dev-serve.js);
# this runner keeps one watching compiler alive and only restarts the app process.
CMD ["node", "scripts/dev-serve.js"]

# ==========================================
# Stage 4: Builder
# ==========================================
FROM dependencies AS builder
ARG APP_NAME
ENV NX_DAEMON=false
# webpack-cli with NODE_ENV=production (project.json `build`), into dist/<app>.
RUN npx nx build ${APP_NAME}

# ==========================================
# Stage 4b: Production dependencies (shared by every app)
# ==========================================
# webpack externalises every package in node_modules (webpack.config.js), so
# the bundle needs the workspace's production packages beside it. Pruned from
# the install above rather than installed again: argon2 is built natively
# there, and Prisma's generated client (node_modules/.prisma) is kept.
FROM dependencies AS prod-deps
RUN npm prune --omit=dev && npm cache clean --force

# ==========================================
# Stage 5: Production
# ==========================================
FROM base AS prod
ENV NODE_ENV=production
EXPOSE 3000
COPY --from=prod-deps /app/node_modules ./node_modules
ARG APP_NAME
ENV APP_NAME=${APP_NAME}
COPY --from=builder /app/dist/${APP_NAME}/ ./
USER node
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy="" \
    NODE_EXTRA_CA_CERTS="" \
    npm_config_registry=""
CMD ["node", "main.js"]
