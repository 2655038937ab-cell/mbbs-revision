#!/usr/bin/env bash
# 在已经跑着 Caddy 的服务器上，为一个新项目准备好目录、网络、反向代理与防火墙；
# 也可以把加过的站点再干净地撤掉。
#
#   bash new-project.sh <name> <domain> <container-port>   # 准备新项目
#   bash new-project.sh --remove <domain>                  # 撤掉某个域名的站点块
#   bash new-project.sh --remove <name> --by-name          # 按容器名/项目名撤掉
#
#   <name>            项目名，小写字母数字（容器名、目录名都用它）
#   <domain>          对外域名，例如 myapp.duckdns.org 或 203-0-113-7.sslip.io
#   <container-port>  容器内监听端口（不对外暴露，Caddy 用容器名直连）
#   --static          纯静态站点：不做反代，直接由 Caddy 发文件
#
# 幂等：重复执行只会补齐缺失的部分；Caddyfile 改动前先校验，失败自动回滚。
set -euo pipefail

CADDY_DIR="${CADDY_DIR:-/opt/mbbs}"
COMPOSE_NAME="${COMPOSE_NAME:-mbbs}"          # 现有 Caddy 所在的 compose 工程名
NETWORK="${NETWORK:-${COMPOSE_NAME}_default}"
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

caddy_ctrl() { docker ps --filter "publish=443" --format '{{.Names}}' | head -1; }
reload_caddy() {
  local ctrl; ctrl=$(caddy_ctrl)
  [ -n "$ctrl" ] || die "找不到占用 443 的容器（Caddy）"
  if ! docker exec "$ctrl" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    [ -n "${BAK:-}" ] && cp "$BAK" "$CADDY_DIR/Caddyfile" && warn "Caddyfile 校验失败，已回滚到 $BAK"
    die "Caddyfile 有语法错误，未生效"
  fi
  docker exec "$ctrl" caddy reload --config /etc/caddy/Caddyfile >/dev/null
}

# 按"大括号配对"删除一个站点块。直接用 sed/备份回滚都不可靠：
# 备份可能已经含有更早的改动，而块里还有嵌套块（request_body { ... }）。
remove_block() {   # $1 = 站点地址行开头的字符串
  python3 - "$CADDY_DIR/Caddyfile" "$1" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
src = open(path).read().split("\n")
out, depth, skipping, removed = [], 0, False, 0
for line in src:
    if not skipping and re.match(r"^\s*" + re.escape(key) + r"\s*[,{]", line):
        skipping = True
    if skipping:
        depth += line.count("{") - line.count("}")
        removed += 1
        if depth <= 0:
            skipping = False
        continue
    out.append(line)
open(path, "w").write("\n".join(out).rstrip() + "\n")
print(removed)
PY
}

# ---------------------------------------------------------------- --remove
if [ "${1:-}" = "--remove" ]; then
  KEY="${2:-}"; [ -n "$KEY" ] || die "--remove 后面要给域名或项目名"
  MODE="${3:-}"
  [ "$MODE" = "--by-name" ] && KEY="$(grep -oE '^[^#[:space:]]*'"$KEY"'[^[:space:]]*' "$CADDY_DIR/Caddyfile" 2>/dev/null | head -1 || true)"
  [ -n "$KEY" ] || die "在 Caddyfile 里找不到对应站点"
  BAK="$CADDY_DIR/Caddyfile.bak-remove-$(date +%Y%m%d-%H%M%S)"
  cp "$CADDY_DIR/Caddyfile" "$BAK"
  lines=$(remove_block "$KEY")
  [ "$lines" -gt 0 ] || { warn "没有匹配到 $KEY 的站点块"; exit 0; }
  reload_caddy
  ok "已移除 $KEY 的站点块（$lines 行），备份留在 $BAK"
  exit 0
fi

# ---------------------------------------------------------------- 新建
NAME="${1:-}"; DOMAIN="${2:-}"; PORT="${3:-}"; MODE="${4:-}"
[ -n "$NAME" ] && [ -n "$DOMAIN" ] && [ -n "$PORT" ] || { sed -n '2,16p' "$0"; exit 1; }
echo "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]*$' || die "项目名只能用小写字母、数字和横线"

echo "== 1/6 目录"
mkdir -p "/opt/$NAME" "/srv/$NAME-data"
[ "$MODE" = "--static" ] && mkdir -p "/srv/$NAME-static"
ok "/opt/$NAME 与 /srv/$NAME-data"

echo "== 2/6 网络（Caddy 所在的 $NETWORK）"
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "找不到网络 $NETWORK，确认 Caddy 所在的 compose 工程名"
ok "复用 $NETWORK，容器之间用容器名互访"

echo "== 3/6 反向代理配置"
if grep -qE "^[^#]*[[:space:],]?$DOMAIN([[:space:]]*[,{]|$)" "$CADDY_DIR/Caddyfile" 2>/dev/null; then
  ok "$DOMAIN 已在 Caddyfile 中，跳过"
else
  [ -f "$CADDY_DIR/Caddyfile" ] || die "找不到 $CADDY_DIR/Caddyfile"
  BAK="$CADDY_DIR/Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$CADDY_DIR/Caddyfile" "$BAK"
  if [ "$MODE" = "--static" ]; then
    cat >> "$CADDY_DIR/Caddyfile" <<EOF

$DOMAIN {
	root * /srv/$NAME-static
	file_server
	encode zstd gzip
}
EOF
  else
    cat >> "$CADDY_DIR/Caddyfile" <<EOF

$DOMAIN {
	encode zstd gzip
	request_body {
		max_size 200MB
	}
	reverse_proxy $NAME:$PORT
}
EOF
  fi
  reload_caddy || die "写入后校验失败"
  ok "已追加 $DOMAIN → $NAME:$PORT 并 reload（备份 $BAK）"
fi

echo "== 4/6 防火墙（ufw；腾讯云控制台也要放行，见 NEW-PROJECT.md §5.3）"
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ok "80/443 已放行（幂等）"

echo "== 5/6 compose 模板"
if [ -f "/opt/$NAME/docker-compose.yml" ]; then
  ok "已存在，保留不动"
elif [ "$MODE" = "--static" ]; then
  warn "静态站点不需要 compose，把文件放进 /srv/$NAME-static 即可"
else
  SRC="$(dirname "$0")/docker-compose.yml"
  if [ -f "$SRC" ]; then
    sed -e "s/<name>/$NAME/g" -e "s/PORT: \"3000\"/PORT: \"$PORT\"/" "$SRC" > "/opt/$NAME/docker-compose.yml"
    ok "已生成 /opt/$NAME/docker-compose.yml（请改镜像/build 与环境变量）"
  else
    warn "找不到模板 docker-compose.yml，请从仓库 deploy/new-project/ 拷一份"
  fi
fi
if [ ! -f "/opt/$NAME/.env" ]; then
  printf '# 密钥写在这里，权限 600，不要提交进 git\nDATABASE_URL=\nAPI_KEY=\n' > "/opt/$NAME/.env"
  chmod 600 "/opt/$NAME/.env"
  ok "已创建 /opt/$NAME/.env（权限 600，需你填）"
fi

echo "== 6/6 接下来"
cat <<EOF
  1) 放代码： tar czf - <你的文件> | ssh mbbs-seoul 'tar xzf - -C /opt/$NAME'
  2) 填密钥： vi /opt/$NAME/.env                     # 不要贴在聊天或 git 里
  3) 起服务： ssh mbbs-seoul 'cd /opt/$NAME && docker compose up -d --build'
  4) 验证：   curl -sS -o /dev/null -w '%{http_code}\\n' https://$DOMAIN/
  5) 看日志： docker logs -f $NAME
  6) 撤销：   bash new-project.sh --remove $DOMAIN   # 只撤站点块，目录自己删
  记住给它设资源上限（mem_limit / cpus），否则内存泄漏会拖垮同机的复习站点。
EOF
