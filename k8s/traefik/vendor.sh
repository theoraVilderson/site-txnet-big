#!/usr/bin/env bash
# Re-vendor Traefik's CRDs and RBAC at TRAEFIK_CRD_VERSION (hosting K9).
# Run after bumping k8s/versions.env; commit the two files it rewrites.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../versions.env
. "$here/../versions.env"
base="https://raw.githubusercontent.com/traefik/traefik/${TRAEFIK_CRD_VERSION}/docs/content/reference/dynamic-configuration"
curl -fsSL --max-time 60 "$base/kubernetes-crd-definition-v1.yml" -o "$here/crds.yaml"
curl -fsSL --max-time 60 "$base/kubernetes-crd-rbac.yml" -o "$here/rbac.yaml"
echo "vendored Traefik ${TRAEFIK_CRD_VERSION} into $here"
