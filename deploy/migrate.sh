#!/usr/bin/env bash
# Move the app and its data from this machine to a new server.
#
#   bash deploy/migrate.sh root@203.0.113.7
#
# Copies the code (small) and the data directories (MBBS ~2.7 GB, PKU ~0.2 GB),
# then builds and starts both instances. Uses rsync when the server has it and
# falls back to a tar stream — the Alibaba box had no rsync, so assuming it is a
# mistake worth avoiding.
set -euo pipefail

TARGET=${1:?usage: bash deploy/migrate.sh user@host}
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP_DIR=${APP_DIR:-/opt/mbbs}
DATA_DIR=${DATA_DIR:-/srv}
SSH="ssh -o ConnectTimeout=15 $TARGET"

echo "==> checking $TARGET"
$SSH 'command -v docker >/dev/null || { echo "docker missing — run deploy/provision.sh first"; exit 1; }' \
  || { echo "provision the server first: scp -r deploy $TARGET:/root/ && $SSH 'bash /root/deploy/provision.sh'"; exit 1; }
$SSH "mkdir -p $APP_DIR $DATA_DIR/mbbs-data $DATA_DIR/pku-data"

echo "==> code -> $APP_DIR"
tar -C "$HERE" -czf - \
  --exclude .git --exclude '.venv*' --exclude data --exclude data-pku \
  --exclude '*.bak-*' --exclude 'textbook_parts' --exclude '__pycache__' \
  . | $SSH "tar -xzf - -C $APP_DIR"

copy_dir() {   # local dir, remote dir
  local src=$1 dst=$2
  local size
  size=$(du -sh "$src" 2>/dev/null | cut -f1)
  echo "==> data $src ($size) -> $dst"
  if $SSH 'command -v rsync >/dev/null'; then
    rsync -az --info=progress2 -e "ssh -o ConnectTimeout=15" "$src/" "$TARGET:$dst/"
  else
    echo "    (no rsync on the server, streaming a tar archive)"
    tar -C "$src" -czf - . | $SSH "tar -xzf - -C $dst"
  fi
}

copy_dir "$HERE/data" "$DATA_DIR/mbbs-data"
copy_dir "$HERE/data-pku" "$DATA_DIR/pku-data"

echo "==> hostnames"
echo "    edit $APP_DIR/deploy/Caddyfile (or the copy you keep next to compose) before starting:"
$SSH "grep -n '{' $APP_DIR/deploy/Caddyfile | head -4" || true

cat <<EOF

==> next
  1. on the server:  cd $APP_DIR && cp deploy/docker-compose.yml . && cp deploy/Caddyfile .
                     printf 'MBBS_PASSWORD=%s\n' '<your-password>' > .env
                     edit Caddyfile hostnames
  2. docker compose up -d --build
  3. verify:         curl -s https://<hostname>/api/health
  4. switch DNS (DuckDNS A record -> new IP; sslip.io hostnames follow the IP automatically)
  5. keep the old instance until the new one has served a day, then cancel it
EOF
