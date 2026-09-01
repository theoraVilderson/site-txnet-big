# ==========================================
# مرحله اول: بیلد کردن برنامه (Builder Stage)
# ==========================================
FROM registry.mytxnet.ir/golang:1.22-alpine AS builder
WORKDIR /app

# کپی کردن کل سورس‌کدها
COPY . .
RUN [ ! -f go.mod ] && go mod init 3eora-mit-proxy || true
RUN CGO_ENABLED=0 go build -ldflags="-w -s" -o 3eora-mit-proxy .

# ==========================================
# مرحله دوم: ساخت ایمیج نهایی
# ==========================================
FROM registry.mytxnet.ir/alpine:3.24.1
WORKDIR /app

# ۱. کپی کلید مخازن داخلی (یک بار کافیست)
COPY ./pki/alpine-signing-key.pub /etc/apk/keys/key-35ef9ba0.rsa.pub

# ۲. کپی کردن فایل‌های گواهینامه MITM 
# کپی در مسیر برنامه برای خوانده شدن توسط خود پروکسی
COPY ./pki/ca.crt .
COPY ./pki/ca.key .
# کپی در مسیر سیستم‌عامل برای شناخته شدن به عنوان CA معتبر (Root Trust)
COPY ./pki/ca.crt /usr/local/share/ca-certificates/3eora-mitm-proxy-ca.crt

# ۳. تنظیم مخازن داخلی
RUN ALPINE_VER=$(cut -d'.' -f1,2 /etc/alpine-release) && \
    echo "Detected Alpine version: v${ALPINE_VER}" && \
    echo "http://packages.mytxnet.ir/repository/alpine-mirror/v${ALPINE_VER}/main" > /etc/apk/repositories && \
    echo "http://packages.mytxnet.ir/repository/alpine-mirror/v${ALPINE_VER}/community" >> /etc/apk/repositories

# ۴. نصب پکیج‌ها و آپدیت گواهینامه‌ها 
# چون در این مرحله هنوز Root هستیم، CA شما بدون خطای پرمیشن در سیستم نصب می‌شود
RUN apk add --no-cache ca-certificates && update-ca-certificates

# ۵. ایجاد کاربر محدود و کپی فایل اجرایی
RUN adduser -D -H -u 10001 mitmproxy
COPY --from=builder /app/3eora-mit-proxy .

# ۶. تنظیم دسترسی‌ها
# باعث می‌شود کاربر mitmproxy بتواند فایل‌های اجرایی و کلیدها (ca.key) را بخواند
RUN chown -R mitmproxy:mitmproxy /app

# ۷. اجرای برنامه
USER mitmproxy
CMD ["./3eora-mit-proxy"]