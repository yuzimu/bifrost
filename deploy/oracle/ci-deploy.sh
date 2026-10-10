#!/usr/bin/env bash
set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

# 专用 SSH key 只能请求固定仓库的 digest 部署，不能执行 shell。
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ (ghcr\.io/yuzimu/bifrost@sha256:[a-f0-9]{64})$ ]]; then
  exec /opt/bifrost/deploy.sh "${BASH_REMATCH[1]}"
fi
echo "Only immutable Bifrost deployments are permitted" >&2
exit 64
