# ---------- Base ----------
ARG DOCKER_REGISTRY
# Pinned to the patch, not the line: a floating tag stays on whatever was cached
# (Node security release 2026-10-21: Brotli RCE, TLS hostname bypass). Bump on the next one.
FROM ${DOCKER_REGISTRY}/node:22.23.4-alpine AS base
# پکیج libc6-compat برای سازگاری بهتر برخی ماژول‌های سیستمی C/C++ در آلپاین بسیار توصیه می‌شود
# APK_MIRROR (.env): an Alpine mirror every server we build on reaches; dl-cdn
# stalls mid-TLS from Iranian datacenters (OPS-1-af). Empty keeps dl-cdn.
ARG APK_MIRROR
RUN if [ -n "$APK_MIRROR" ]; then sed -i "s#https\?://dl-cdn.alpinelinux.org/alpine#$APK_MIRROR#" /etc/apk/repositories; fi \
 && apk add --no-cache libc6-compat
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
WORKDIR /app
COPY package*.json ./
# استفاده از npm ci به جای npm install برای نصب دقیق و پایدار وابستگی‌ها
RUN npm ci

# ---------- Development ----------
FROM base AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 8080
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy=""

CMD ["npm", "run", "dev"]

# ---------- Builder ----------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build
# حذف پکیج‌های توسعه (dev dependencies) تا ایمیج نهایی پروداکشن سبک‌تر شود
RUN npm prune --omit=dev

# ---------- Production ----------
FROM base AS prod
WORKDIR /app
ENV NODE_ENV=production

# مسائل امنیتی: ساخت کاربر غیر-روت (Best Practice)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodeuser

# کپی کل پروژه (شامل فایل‌های بیلد شده و ماژول‌های سبک شده) از لایه‌ی builder
COPY --from=builder --chown=nodeuser:nodejs /app ./

# سوئیچ کردن به کاربر محدود
USER nodeuser

# The port Traefik's label calls (compose/frontends.yml); `next start` reads
# PORT, and a non-root user may not bind below 1024 on k3s (OPS-1-o-s).
EXPOSE 8080
ENV PORT=8080

# =====================================================================
# خالی کردن متغیرهای پروکسی و تنظیمات npm برای زمان اجرای کانتینر (Runtime)
# =====================================================================
ENV HTTP_PROXY="" \
    HTTPS_PROXY="" \
    NO_PROXY="" \
    http_proxy="" \
    https_proxy="" \
    no_proxy="" \
    NODE_EXTRA_CA_CERTS="" \
    npm_config_registry=""

CMD ["npm", "start"]