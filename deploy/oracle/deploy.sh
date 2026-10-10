#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# 串行更新固定服务，只接收不可变镜像，不覆盖业务配置和数据。
if [[ $EUID != 0 || $# != 1 ]]; then
  echo "Usage: deploy.sh ghcr.io/yuzimu/bifrost@sha256:DIGEST (root required)" >&2
  exit 64
fi
image=$1
[[ $image =~ ^ghcr\.io/yuzimu/bifrost@sha256:[a-f0-9]{64}$ ]] || exit 64

cd /opt/bifrost
exec 9>/opt/bifrost/deploy.lock
flock -n 9 || { echo "Bifrost deployment already running" >&2; exit 75; }
[[ -f compose.yaml && -f /etc/bifrost/config.json && -f /etc/bifrost/bifrost.env ]]
[[ -d /opt/bifrost/data ]]

# CI 的短期 registry token 只进入临时 Docker 配置，退出时删除。
IFS= read -r registry_user
IFS= read -r registry_token
[[ $registry_user =~ ^[A-Za-z0-9_-]+$ && -n $registry_token ]] || exit 64
DOCKER_CONFIG=$(mktemp -d /opt/bifrost/.registry.XXXXXX)
export DOCKER_CONFIG
trap 'rm -rf -- "$DOCKER_CONFIG"' EXIT
printf '%s' "$registry_token" | docker login ghcr.io -u "$registry_user" --password-stdin >/dev/null
unset registry_token
docker pull --platform linux/arm64 "$image"

[[ $(docker image inspect "$image" --format '{{.Architecture}}') == arm64 ]] || {
  echo "Image must be ARM64" >&2
  exit 65
}
export BIFROST_IMAGE=$image
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml up -d --no-deps --pull never --wait --wait-timeout 180 bifrost
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8088/health >/dev/null
candidate=$(mktemp /opt/bifrost/.deployment.XXXXXX)
printf 'BIFROST_IMAGE=%s\n' "$image" >"$candidate"
mv -f -- "$candidate" /opt/bifrost/.env
printf 'Deployed %s\n' "$image"
