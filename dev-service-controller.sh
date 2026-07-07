#!/usr/bin/env bash

# توقف اسکریپت در صورت بروز هرگونه خطا
set -e

echo "🚀 Starting TXNet Development Environment..."

# 1. اطمینان از ساخته شدن شبکه‌های داکر قبل از اجرای سرویس‌ها
echo "🌐 Checking Docker networks..."
docker network ls | grep -q 'private_backend_network' || docker network create private_backend_network
docker network ls | grep -q 'public_gateway_network' || docker network create public_gateway_network

# 2. اجرای سرویس‌های اصلی (دیتابیس‌ها، بک‌اند، فرانت‌اند و Traefik)
echo "📦 Starting Main Services..."
docker compose -p devtxnet --env-file ./.env --env-file ./.env.dev -f ./compose.yml -f ./docker-compose.dev.yml "$@"

# 3. اجرای سرویس‌های مانیتورینگ (Loki, Prometheus, Grafana, Promtail)
echo "📊 Starting System Monitor (sys-monitor)..."
cd monitoring-tower/sys-monitor
./dev.compose.sh "$@"
cd ../../
# 4. اجرای باگ ترکر
echo "🐛 Starting Bug Tracker..."
cd monitoring-tower/bug-tracker
./dev.compose.sh "$@"
cd ../../
