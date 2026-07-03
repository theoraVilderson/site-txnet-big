# ==========================================
# Stage 1: Base (پایه - دانلود وابستگی‌ها)
# ==========================================
ARG DOCKER_REGISTRY=docker.arvancloud.ir
FROM ${DOCKER_REGISTRY}/golang:1.22-alpine AS base
WORKDIR /app
# تنظیم پروکسی برای دور زدن تحریم‌ها و سرعت بالا
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off
# فقط فایل‌های mod کپی می‌شوند تا لایه دانلود پکیج‌ها کش شود
COPY go.mod ./
RUN go mod download

# ==========================================
# Stage 2: Development (محیط توسعه با Hot-Reload)
# ==========================================
FROM base AS dev
# نصب git برای کارکرد صحیح برخی پکیج‌های Go و ابزار Air
RUN apk add --no-cache git
RUN go install github.com/air-verse/air@v1.52.3
# سورس کد کپی می‌شود (هرچند در داکر کامپوز با Volume اورراید می‌شود)
COPY . .
CMD ["air"]

# ==========================================
# Stage 3: Builder (کامپایل کد برای پروداکشن)
# ==========================================
FROM base AS builder
COPY . .
# نکته حیاتی: غیرفعال کردن CGO برای ساخت فایل باینری ایزوله و سبک
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/authorization-handler .

# ==========================================
# Stage 4: Production (ایمیج نهایی و فوق سبک)
# ==========================================
FROM ${DOCKER_REGISTRY}/alpine:latest AS prod
# نصب گواهینامه‌های امنیتی برای ارتباطات HTTPS (اختیاری اما به شدت توصیه شده)
RUN apk --no-cache add ca-certificates
WORKDIR /root/
# کپی کردن فایل باینری کامپایل شده از مرحله builder
COPY --from=builder /app/authorization-handler .
# در محیط پروداکشن فقط همین فایل اجرایی ران می‌شود
CMD ["./authorization-handler"]