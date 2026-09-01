#!/bin/bash
# v0.3.0 服务器镜像部署（在服务器上执行）
# 拉取固定名资产到 /var/www/uartix/stable/，提供国内加速下载镜像。
# 自动更新链路维持 GitHub 直连（updater endpoint = GitHub latest.json），与 v0.2.0 一致。
# 执行后永久生效的镜像地址（发新版只需覆盖同名文件）：
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-windows-x64-Setup.exe
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.AppImage
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.deb

set -x
V="v0.3.0"
BASE="https://github.com/Tanixs/uartix-plus/releases/download/${V}"
DEST="/var/www/uartix/stable"

mkdir -p "$DEST" || exit 1
cd "$DEST" || exit 1

for f in \
  Uartix-Plus-windows-x64-Setup.exe \
  Uartix-Plus-linux-x64.AppImage \
  Uartix-Plus-linux-x64.deb \
  latest.json; do
  curl -fSL --retry 3 --connect-timeout 20 -o "$f" "${BASE}/${f}" && echo "DONE-$f" || echo "FAIL-$f"
done

# latest.json 原样存档（URL 保持 GitHub；仅作为未来切源备份）
echo "----- FILES -----"
ls -la
