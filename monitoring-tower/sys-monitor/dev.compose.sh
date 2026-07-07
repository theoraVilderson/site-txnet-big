#!/bin/bash


ENV_NAME=dev
PROJECT_NAME="txnet_monitor_${ENV_NAME}"
ENV_FILE=".env.${ENV_NAME}"

echo "🔄 Starting monitoring stack for [$ENV_TYPE] environment..."

# لود کردن متغیرهای مشترک از فایل .env در ترمینال فعلی
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# اجرای داکر کامپوز با نام پروژه مجزا و فایل تنظیمات مشخص
docker compose --env-file ./.env --env-file $ENV_FILE -p $PROJECT_NAME -f docker-compose.sys-monitor.yml "$@"

echo "✅ [$ENV_TYPE] monitoring stack is up and running!"
echo "📊 Grafana Port: $(grep GRAFANA_PORT $ENV_FILE | cut -d '=' -f2)"