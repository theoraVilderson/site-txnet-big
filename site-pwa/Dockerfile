ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/node:22 AS base
WORKDIR /app

FROM base AS deps
ENV HTTP_PROXY="http://193.228.169.47:47723" \
    HTTPS_PROXY="http://193.228.169.47:47723" \
    NO_PROXY="" \
    http_proxy="http://193.228.169.47:47723" \
    https_proxy="http://193.228.169.47:47723" \
    no_proxy=""
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
