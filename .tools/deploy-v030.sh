#!/bin/bash
# v0.3.0 服务器部署（在服务器上执行；复用 v0.2.0 的 GitHub 拉取模式）
# 用法：把固定名资产拉到 /var/www/uartix/stable/，latest.json 的 URL 改写为域名固定地址
# 结果：以下地址永久生效（发新版只需覆盖本目录同名文件）：
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-windows-x64-Setup.exe
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.AppImage
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.deb
#   https://larix.teuioe.cn/dl/stable/latest.json

set -x
V="v0.3.0"
BASE="https://github.com/Tanixs/uartix-plus/releases/download/${V}"
DEST="/var/www/uartix/stable"

mkdir -p "$DEST" || exit 1
cd "$DEST" || exit 1

# GitHub 固定名资产（CI 已上传的 stable 副本；若 Publish 前执行会 404，需在 Publish 后跑）
for f in \
  Uartix-Plus-windows-x64-Setup.exe \
  Uartix-Plus-linux-x64.AppImage \
  Uartix-Plus-linux-x64.deb \
  latest.json; do
  curl -fSL --retry 3 --connect-timeout 20 -o "$f" "${BASE}/${f}" && echo "DONE-$f" || echo "FAIL-$f"
done

# latest.json 内部下载 URL 全部改写为域名固定地址（客户端更新不依赖 GitHub 下载速度）
sed -i 's|https://github.com/Tanixs/uartix-plus/releases/download/[^"]*|https://larix.teuioe.cn/dl/stable/|g' latest.json

# 保持 /dl/latest.json 惯例（与 v0.2.0 一致的根清单位置）
cp -f latest.json /var/www/uartix/latest.json

echo "----- FILES -----"
ls -la
echo "----- latest.json -----"
cat latest.json
