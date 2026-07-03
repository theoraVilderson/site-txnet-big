# ==========================================
# Stage 1: Base (تنظیمات پایه مشترک)
# ==========================================
ARG DOCKER_REGISTRY=docker.arvancloud.ir
FROM ${DOCKER_REGISTRY}/node:20-alpine AS base
WORKDIR /app
# تعریف متغیر برای نام اپلیکیشن تا فایل داینامیک باشد
ARG APP_NAME
ENV APP_NAME=${APP_NAME}

# ==========================================
# Stage 2: Dependencies (نصب وابستگی‌ها)
# ==========================================
FROM base AS dependencies
COPY package*.json ./
# نصب تمام پکیج‌ها (شامل devDependencies) برای بیلد و توسعه
RUN npm ci
COPY . .

# ==========================================
# Stage 3: Development (محیط توسعه)
# ==========================================
FROM dependencies AS dev
ENV NODE_ENV=development
EXPOSE 3000
# build اولیه سپس اجرای node (بدون nx serve برای جلوگیری از recursive loop)
WORKDIR /app
RUN npx nx build ${APP_NAME}
CMD node dist/${APP_NAME}/main.js

# ==========================================
# Stage 4: Builder (بیلد کردن برای پروداکشن)
# ==========================================
FROM dependencies AS builder
# بیلد کردن اپلیکیشن مد نظر همراه با تولید package.json اختصاصی
RUN npx nx build ${APP_NAME} --prod --generatePackageJson

# ==========================================
# Stage 5: Production (محیط عملیاتی و نهایی)
# ==========================================
FROM base AS prod
ENV NODE_ENV=production
EXPOSE 3000

# کپی کردن خروجی بیلد و package.json مینیمال از استیج builder
COPY --from=builder /app/dist/apps/${APP_NAME} ./

# نصب پکیج‌ها فقط برای حالت پروداکشن (سبک‌سازی ایمیج)
RUN npm install --production --ignore-scripts

# اجرای کانتینر با یوزر غیر دسترسی روت برای امنیت بیشتر
USER node

CMD ["node", "main.js"]