#!/bin/sh
set -e

VERSION="${1:-v1}"

# آدرس رجیستری رو اینجا یک بار برای همیشه درست می‌نویسیم
# (من mytxnet.ir گذاشتم، اگر myxnet.ir درسته همینجا عوضش کن)
REGISTRY="3eora-harbor.mytxnet.ir"

# for name in node-20-alpine; do
for name in golang-1.22-alpine node-20-alpine node-22-alpine alpine-3.24.1; do
# for name in golang-1.22-alpine; do
# for name in alpine-3.24.1; do
  echo "==> building $name:$VERSION"
  
  # بیلد و تگ کردن (با متغیر REGISTRY)
  docker build -f Dockerfile.$name -t ${REGISTRY}/3eora-public-images/${name}-proxy:${VERSION} .
  
  # پوش کردن (دقیقاً با همون متغیر)
  docker push "${REGISTRY}/3eora-public-images/${name}-proxy:${VERSION}"
done

echo "==> done. update your Dockerfiles' FROM line to use tag :${VERSION}"