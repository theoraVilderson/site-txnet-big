ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/node:22 AS base
WORKDIR /app

FROM base AS deps

# The proxy `npm install` goes through, if any (F-088).
#
# This baked `http://193.228.169.47:47723` into the image — one developer's
# machine, in a file every build of this app reads. Every other Dockerfile in
# the repo sets these to `""` (`txnet-backend/Dockerfile`, `coinsite/Dockerfile`,
# `auth-handler/Dockerfile`), so the panel was the one image whose network
# behaviour depended on a host that may not exist. An empty default keeps that
# shape; whoever needs a proxy passes `--build-arg BUILD_HTTP_PROXY=...` or sets
# `BUILD_HTTP_PROXY` in `.env`, which compose forwards.
ARG BUILD_HTTP_PROXY=""
ARG BUILD_HTTPS_PROXY=""
ARG BUILD_NO_PROXY=""
ENV HTTP_PROXY="${BUILD_HTTP_PROXY}" \
    HTTPS_PROXY="${BUILD_HTTPS_PROXY}" \
    NO_PROXY="${BUILD_NO_PROXY}" \
    http_proxy="${BUILD_HTTP_PROXY}" \
    https_proxy="${BUILD_HTTPS_PROXY}" \
    no_proxy="${BUILD_NO_PROXY}"
COPY package.json package-lock.json ./
# vendored tarball of the shared @txnet/locale-client (file: dependency)
COPY vendor ./vendor
RUN npm install --legacy-peer-deps

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=development
EXPOSE 8181
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy=""
CMD ["sh", "-c", "rm -rf /app/.next/dev /app/.next/cache && exec npm run dev"]

FROM base AS prod
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
RUN mkdir .next && chown nextjs:nodejs .next
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 82
ENV PORT=82
ENV HOSTNAME="0.0.0.0"
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy="" \
    NODE_EXTRA_CA_CERTS="" \
    npm_config_registry=""
CMD ["node", "server.js"]
