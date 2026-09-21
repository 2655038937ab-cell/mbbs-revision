#!/usr/bin/env bash
# Post-migration verification: run this after the stack is up on the new server.
#
#   bash deploy/verify.sh mbbs.example.duckdns.org 203-0-113-7.sslip.io
#
# Checks what actually broke in past deploys: HTTPS reachable at all, the app in the
# right auth mode, the static assets still gzipped (a proxy that re-compresses or
# strips headers costs seconds per visit), the data present in full, and the ports
# open from the outside (a cloud console firewall that only allows 22 is the most
# common reason a fresh box serves nothing).
set -uo pipefail

# Override for a plain-HTTP instance (pre-migration self-check):
#   SCHEME=http PORT=8756 bash deploy/verify.sh 127.0.0.1
SCHEME=${SCHEME:-https}
PORT=${PORT:-}
PORTSUF=${PORT:+:$PORT}

fail=0
ok()   { printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
bad()  { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; fail=$((fail + 1)); }
note() { printf "        %s\n" "$1"; }

check_host() {
  local host=$1
  echo
  echo "=== $host ==="

  local t0 code
  t0=$(date +%s.%N)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$SCHEME://$host$PORTSUF/" || echo 000)
  local dt
  dt=$(echo "$(date +%s.%N) - $t0" | bc 2>/dev/null || echo "?")
  if [ "$code" = "200" ]; then ok "首页 200（${dt}s）"; else bad "首页 $code"; fi

  local health
  health=$(curl -s --max-time 20 "$SCHEME://$host$PORTSUF/api/health" || echo "")
  case "$health" in
    *'"ok": true'*|*'"ok":true'*) ok "/api/health: $health" ;;
    *) bad "/api/health: ${health:-无响应}" ;;
  esac

  local me
  me=$(curl -s --max-time 20 "$SCHEME://$host$PORTSUF/api/auth/me" || echo "")
  case "$me" in
    *'"trial": true'*|*'"trial":true'*) note "auth: 试用模式（访客可浏览，写入需密码）" ;;
    *'"open": true'*|*'"open":true'*)   note "auth: 免密模式（任何人可写——仅本机/内网可接受）" ;;
    *unauthorized*)                      note "auth: 密码模式" ;;
    *) bad "/api/auth/me: ${me:-无响应}" ;;
  esac

  # GET with -D - rather than -sI: some servers (this app's included, before HEAD
  # support) answer HEAD with 501, which made every header check report a failure.
  local hdr
  hdr=$(curl -s -o /dev/null -D - --max-time 25 -H 'Accept-Encoding: gzip' "$SCHEME://$host$PORTSUF/js/app.js" | tr 'A-Z' 'a-z' || echo "")
  case "$hdr" in
    *"content-encoding: gzip"*) ok "app.js 压缩传输" ;;
    *) bad "app.js 没有压缩（首屏会慢好几秒）" ;;
  esac
  case "$hdr" in
    *"cache-control: no-cache"*|*"cache-control: public"*) ok "缓存头正常（回访走 304）" ;;
    *) bad "缓存头异常，回访会重下全部 JS" ;;
  esac

  local lite
  lite=$(curl -s --max-time 60 "$SCHEME://$host$PORTSUF/api/store/lessons?lite=1" || echo "")
  local n
  n=$(printf '%s' "$lite" | grep -o '"id"' | wc -l | tr -d ' ')
  if [ "${n:-0}" -gt 0 ]; then ok "课程列表 $n 门"; else bad "课程列表为空（数据没迁过来？）"; fi

  local counts
  counts=$(curl -s --max-time 60 "$SCHEME://$host$PORTSUF/api/store/cards?lite=1" | grep -o '"id"' | wc -l | tr -d ' ')
  if [ "${counts:-0}" -gt 0 ]; then note "闪卡 $counts 张"; fi

  if [ "$SCHEME" = "https" ]; then
    local issuer
    # -v, not -D -: the certificate issuer only appears in the TLS handshake output.
    issuer=$(curl -sIv --max-time 20 "https://$host$PORTSUF/" 2>&1 | grep -i 'issuer:' | head -1 | tr -d '\r' | sed 's/.*issuer: //')
    if [ -n "$issuer" ]; then ok "证书签发者: $issuer"; else bad "拿不到证书信息（HTTPS 可能没生效）"; fi
  else
    note "SCHEME=$SCHEME，跳过证书检查"
  fi
}

for h in "$@"; do check_host "$h"; done

echo
echo "=== 从外面看端口（云控制台防火墙最常见的问题）==="
for h in "$@"; do
  ip=$(dig +short "$h" A 2>/dev/null | head -1)
  [ -z "$ip" ] && ip="$h"
  case "$h" in 127.0.0.1|localhost) ip=$h;; esac
  if [ -n "$PORT" ]; then ports="$PORT"; else ports="80 443 22"; fi
  for p in $ports; do
    if nc -z -G 5 "$ip" "$p" 2>/dev/null; then ok "$ip:$p 可达"; else
      [ "$p" = "22" ] && note "$ip:22 不可达（若你用密钥+非标端口属正常）" || bad "$ip:$p 不可达 —— 去云控制台防火墙放行"
    fi
  done
done

echo
[ "$fail" -eq 0 ] && echo "全部通过 ✓" || echo "$fail 项失败"
exit $((fail > 0))
