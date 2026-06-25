#!/bin/bash
# dc.sh - run shell inside a docker-compose service

# پیش‌فرض‌ها
DEFAULT_PROJECT="devtxnet"
DEFAULT_SERVICE="txnetsite"

# گرفتن آرگومان‌ها
PROJECT_NAME="${2:-$DEFAULT_PROJECT}"
SERVICE_NAME="${1:-$DEFAULT_SERVICE}"

echo "Opening shell in container for project '$PROJECT_NAME', service '$SERVICE_NAME'..."

# اجرای docker compose exec
docker compose -p "$PROJECT_NAME" exec "$SERVICE_NAME" sh
