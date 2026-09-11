# ==========================================
# Stage 1: Base
# ==========================================
ARG DOCKER_REGISTRY
# Egress proxy for the build's network steps only (npm, Prisma engines). A
# global default here; each stage that downloads re-declares it, because a
# build arg does not cross into another stage by itself. `--build-arg` still
# overrides it. The dev and prod stages clear the ENV proxies, so a running
# container is never proxied.
ARG http_proxy="http://193.228.169.47:47723"
ARG https_proxy="http://193.228.169.47:47723"
ARG HTTP_PROXY="http://193.228.169.47:47723"
ARG HTTPS_PROXY="http://193.228.169.47:47723"
ARG no_proxy="localhost,127.0.0.1,khamooshi.maztozi.ir"
ARG NO_PROXY="localhost,127.0.0.1,khamooshi.maztozi.ir"
# Node 24, as on the host and in CI (`.github/workflows/ci.yml`). Its npm 11 is
# the npm that writes package-lock.json; npm 10 (node:20) rejected that lockfile
# in `npm ci`, and some dependencies (undici 8) require Node >= 22.19.
FROM ${DOCKER_REGISTRY}/node:24-alpine AS base
WORKDIR /app
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# ==========================================
# Stage 2: Dependencies
# ==========================================
FROM base AS dependencies
ARG http_proxy
ARG https_proxy
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG no_proxy
ARG NO_PROXY
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
ENV NX_DAEMON=false
RUN npx nx build ${APP_NAME} --prod --generatePackageJson

# ==========================================
# Stage 5: Production
# ==========================================
FROM base AS prod
ARG http_proxy
ARG https_proxy
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG no_proxy
ARG NO_PROXY
ENV NODE_ENV=production
EXPOSE 3000
COPY --from=builder /app/dist/apps/${APP_NAME} ./
RUN npm install --production --ignore-scripts
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
