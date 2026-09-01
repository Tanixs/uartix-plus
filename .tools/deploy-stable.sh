#!/bin/bash
# Uartix+ stable 镜像部署（通用版，永不过时：自动对齐 GitHub 最新已发布版本）
# 在服务器上执行。发新版后 CI Publish 完跑一次本脚本即可，无需修改任何内容。
# 维护的永久地址（网站/外链一次配置）：
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-windows-x64-Setup.exe
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.AppImage
#   https://larix.teuioe.cn/dl/stable/Uartix-Plus-linux-x64.deb
#   https://larix.teuioe.cn/dl/stable/latest.json   ← 网站动态显示版本号的数据源
# 说明：自动更新链路维持 GitHub 直连（updater endpoint = GitHub），服务器仅作下载镜像。

set -x
DEST="/var/www/uartix/stable"
# releases/latest/download 永久 302 到最新已发布版本 → 脚本无需知道版本号
BASE="https://github.com/Tanixs/uartix-plus/releases/latest/download"

mkdir -p "$DEST" || exit 1
cd "$DEST" || exit 1

for f in \
  Uartix-Plus-windows-x64-Setup.exe \
  Uartix-Plus-linux-x64.AppImage \
  Uartix-Plus-linux-x64.deb \
  latest.json; do
  curl -fSL --retry 3 --connect-timeout 20 -o "$f" "${BASE}/${f}" && echo "DONE-$f" || echo "FAIL-$f"
done

echo "----- deployed version -----"
grep -o '"version": *"[^"]*"' latest.json | head -1
ls -la
