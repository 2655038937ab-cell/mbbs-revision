#!/usr/bin/env bash
# Provision a fresh Ubuntu/Debian server for the revision app.
#
#   scp -r deploy/ root@NEW_IP:/root/ && ssh root@NEW_IP 'bash /root/deploy/provision.sh'
#
# Installs Docker + compose plugin, creates the data directories, adds swap, and
# opens only SSH + HTTP(S). Safe to re-run.
#
# Why swap: the 2 GB Alibaba instance was taken down by a maintenance script that
# needed more memory than the box had. Swap turns that class of accident into "slow
# for a minute" instead of "unreachable, needs a console reboot".
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/mbbs}
DATA_DIR=${DATA_DIR:-/srv}
SWAP_GB=${SWAP_GB:-4}

echo "==> system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg rsync ufw >/dev/null

echo "==> docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

echo "==> swap ${SWAP_GB}G"
if [ ! -f /swapfile ]; then
  fallocate -l "${SWAP_GB}G" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((SWAP_GB * 1024))
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> directories"
mkdir -p "$APP_DIR" "$DATA_DIR/mbbs-data" "$DATA_DIR/pku-data" "$DATA_DIR/backups"

echo "==> firewall (22/80/443 only)"
ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
yes | ufw enable >/dev/null 2>&1 || true

echo
echo "Ready. Next:"
echo "  1) copy the app:        bash deploy/migrate.sh root@<this-host>"
echo "  2) edit Caddyfile hostnames in $APP_DIR/docker-compose.yml"
echo "  3) docker compose -f $APP_DIR/docker-compose.yml up -d --build"
echo
echo "Maintenance scripts on a small box: wrap them in a memory cap so a mistake"
echo "can only kill that process, never the host:"
echo "  systemd-run --scope -p MemoryMax=1500M python3 strip_template_images.py --data-dir $DATA_DIR/mbbs-data"
free -m | head -2
