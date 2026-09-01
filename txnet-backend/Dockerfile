# ==========================================
# Stage 1: Base
# ==========================================
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/node:20-alpine AS base
WORKDIR /app
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

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
ENV NODE_ENV=development
ENV NX_DAEMON=false
EXPOSE 3000
RUN npx nx build ${APP_NAME}
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy=""
CMD node dist/${APP_NAME}/main.js

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
