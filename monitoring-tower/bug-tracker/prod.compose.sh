#!/bin/bash

# خروج از اسکریپت در صورت بروز خطا در هر مرحله (به جز موارد مدیریت شده)
set -e

# ۱. دریافت نوع محیط به صورت داینامیک (پیش‌فرض: dev)
# اگر ورودی داده نشود، به صورت خودکار dev در نظر گرفته می‌شود
ENV_TYPE=prod
PROJECT_NAME="txnet_glitchtip_${ENV_TYPE}"
ENV_FILE=".env.${ENV_TYPE}"

echo "🚀 Initiating GlitchTip Setup for [$ENV_TYPE] environment..."

# ۲. بررسی وجود فایل تنظیمات قبل از شروع
if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Error: Environment file '$ENV_FILE' not found!"
    exit 1
fi

# ۳. لود کردن امن متغیرهای محیطی (حتی با وجود فاصله در مقادیر)
set -a
source "$ENV_FILE"
set +a

# ۴. تعریف یک Alias برای جلوگیری از تکرار دستورات داکر
DC_CMD="docker-compose --env-file $ENV_FILE -p $PROJECT_NAME -f docker-compose.bug-tracker.yml"

# ۵. روشن کردن دیتابیس و ردیس
echo "🗄️ Starting Database and Redis..."
$DC_CMD up -d postgres redis

# ۶. انتظار هوشمند و پویا برای آماده‌سازی دیتابیس (حداکثر ۳۰ ثانیه)
echo "⏳ Waiting for PostgreSQL to accept connections..."
for i in {1..30}; do
    if $DC_CMD exec -T postgres pg_isready -U "${POSTGRES_USER:-postgres}" > /dev/null 2>&1; then
        echo "✅ Database is ready!"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Error: Database timeout after 30 seconds!"
        exit 1
    fi
    echo -n "."
    sleep 1
done

# ۷. اجرای مایگریشن جداول
echo "🛠️ Running Database Migrations..."
$DC_CMD run --rm web ./manage.py migrate

# ۸. ساخت خودکار اکانت ادمین
echo "👤 Creating Superuser account automatically..."
$DC_CMD run --rm \
  -e DJANGO_SUPERUSER_EMAIL="$GLITCHTIP_ADMIN_EMAIL" \
  -e DJANGO_SUPERUSER_PASSWORD="$GLITCHTIP_ADMIN_PASS" \
  web ./manage.py createsuperuser --noinput || true

# ۹. روشن کردن سرویس‌های اصلی لاگ‌گیری
echo "🌐 Starting GlitchTip Web and Worker services..."
$DC_CMD up -d web worker

echo "--------------------------------------------------------"
echo "✅ [$ENV_TYPE] GlitchTip Successfully Deployed!"
echo "🌍 Access URL: https://$GLITCHTIP_ROUTER_HOST"
echo "📧 Admin Email: $GLITCHTIP_ADMIN_EMAIL"
echo "🔑 Password: (Defined in $ENV_FILE)"
echo "--------------------------------------------------------"