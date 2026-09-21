# 换服务器 / 首次部署（Contabo、Oracle、Vultr、腾讯云…都适用）

目标：一台新机器上跑起两个站（MBBS + PKU），数据从本机搬过去，**不停机切换**。

## 0. 买之前确认（别踩的坑）

| 项 | 要求 | 为什么 |
|---|---|---|
| 内存 | **≥4 GB** | 2 GB 已经被一次维护脚本拖死过（主机失联、要进控制台重启） |
| 系统盘 | **≥40 GB** | 数据 2.9 GB + 备份 2.9 GB + Docker 镜像约 1 GB |
| 带宽/流量 | 3 Mbps 起步，流量包 ≥500 GB/月 | 首屏 1.4 MB：3 Mbps ≈ 4 秒，1 Mbps ≈ 11 秒（现在这台就是 1 Mbps） |
| 续费价 | 看清**第二年**价格 | 首年特惠常见 1.4 折，次年按原价 |
| 备案 | 大陆节点用域名+80/443 需 ICP 备案 | 境外机器（Contabo 新加坡）**不需要备案** |

## 1. 铺设新机器（一次性）

```bash
scp -r deploy root@NEW_IP:/root/
ssh root@NEW_IP 'bash /root/deploy/provision.sh'
```

它会装 Docker、建数据目录、加 **4 GB swap**、只放行 22/80/443。加 swap 就是针对上面那次事故：
以后再写出吃内存的脚本，最坏是"卡一分钟"，不是"整机失联"。

## 2. 搬代码和数据

```bash
bash deploy/migrate.sh root@NEW_IP
```

代码很小（几 MB）；数据 MBBS 约 2.7 GB、PKU 约 0.2 GB。服务器有 `rsync` 就用 rsync（可断点续传），
没有就退化成 `tar | ssh` 流式传输——不会像上次那样因为"服务器没装 rsync"而失败。

## 3. 起服务

```bash
ssh root@NEW_IP
cd /opt/mbbs
cp deploy/docker-compose.yml deploy/Caddyfile .
printf 'MBBS_PASSWORD=%s\n' '你的强密码' > .env     # 这个密码只用于站长登录，访客免密浏览
vim Caddyfile                                        # 改两处域名
docker compose up -d --build
```

Caddy 会自动申请 HTTPS 证书（**境外机器不需要备案**）。域名两种都行：
- 你已有的 DuckDNS 名字（把 A 记录指向新 IP）
- `203-0-113-7.sslip.io` 这种把 IP 写进域名的形式，**换机器时它自动跟着走**

## 4. 验证与切换

```bash
curl -s https://你的域名/api/health          # {"ok": true, ...}
curl -s https://你的域名/api/auth/me         # 试用站: {"ok":true,"trial":true,...}
curl -sI https://你的域名/js/app.js | grep -i cache-control   # no-cache + ETag
```

切换顺序：新机器验证通过 → 改 DNS → 观察一天 → 再退掉旧机器。旧机器留作回滚点。

## 5. 日常维护（小内存机器的纪律）

扫全库的脚本（去重、清理、重分类）先套内存上限，别裸跑：

```bash
systemd-run --scope -p MemoryMax=1500M python3 strip_template_images.py --data-dir /srv/mbbs-data --apply
```

`systemd-run -p MemoryMax` 会让超限只杀掉这个进程（cgroup OOM），主机不受影响。
本仓库的维护脚本都是**干跑优先**（不加 `--apply` 只预览），改动前都会写可回滚的记录。

## 附：这个包里各文件

| 文件 | 作用 |
|---|---|
| `provision.sh` | 新机器初始化（Docker / 目录 / swap / 防火墙） |
| `migrate.sh` | 把代码 + 两个数据目录搬到新机器 |
| `docker-compose.yml` | caddy + mbbs + pku 三个容器 |
| `Caddyfile` | 两个站点的自动 HTTPS 反代（含 zstd/gzip） |
| `.env.example` | 站长密码（compose 用） |
