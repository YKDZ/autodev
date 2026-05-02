#!/usr/bin/env bash
set -euo pipefail

echo "[auto-dev] Starting container..."

# Configure SSH password if provided
if [ -n "${SSH_PASSWORD:-}" ]; then
  echo "root:${SSH_PASSWORD}" | chpasswd
  echo "[auto-dev] SSH password set."
fi

# Configure SSH public key if provided
if [ -n "${SSH_PUBLIC_KEY:-}" ]; then
  mkdir -p /root/.ssh
  echo "${SSH_PUBLIC_KEY}" >> /root/.ssh/authorized_keys
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/authorized_keys
  echo "[auto-dev] SSH public key installed."
fi

echo "[auto-dev] Starting SSH daemon..."
mkdir -p /var/run/sshd
/usr/sbin/sshd -D -e &

# If GITHUB_APP_PRIVATE_KEY_PATH is provided, read key from file
if [ -n "${GITHUB_APP_PRIVATE_KEY_PATH:-}" ] && [ -z "${GITHUB_APP_PRIVATE_KEY:-}" ]; then
  GITHUB_APP_PRIVATE_KEY="$(cat "${GITHUB_APP_PRIVATE_KEY_PATH}")"
  export GITHUB_APP_PRIVATE_KEY
  echo "[auto-dev] GitHub App private key loaded from ${GITHUB_APP_PRIVATE_KEY_PATH}"
fi

# Fail-fast: ensure required GitHub App credentials are present
: "${GITHUB_APP_ID:?GITHUB_APP_ID is required}"
: "${GITHUB_APP_PRIVATE_KEY:?GITHUB_APP_PRIVATE_KEY is required}"
: "${GITHUB_APP_INSTALLATION_ID:?GITHUB_APP_INSTALLATION_ID is required}"

REPO_FULL_NAME="${GITHUB_REPOSITORY:-owner/repo}"
DIST="/opt/auto-dev/dist/cli.js"
export WORKSPACE_ROOT="${AUTO_DEV_WORKSPACE_ROOT:-/opt/repo}"

echo "[auto-dev] Starting coordinator for $REPO_FULL_NAME..."
exec node "${DIST}" start --repo "$REPO_FULL_NAME"
