#!/bin/bash
# Uartix+ 发布镜像部署（版本无关：自动对齐 GitHub 最新**已发布**版本，发新版后跑一次即可，永不修改本文件）
# 在服务器上执行： bash deploy-stable.sh
#
# 维护两套目录：
#   1) 永久镜像  /var/www/uartix/stable/   → https://larix.teuioe.cn/dl/stable/<固定文件名>
#      官网/外链一次配置永不变：
#        Uartix-Plus-windows-x64-Setup.exe / Uartix-Plus-linux-x64.AppImage /
#        Uartix-Plus-linux-x64.deb / latest.json（网站动态显示版本号的数据源）
#   2) 版本归档  /var/www/uartix/v<版本>/  → https://larix.teuioe.cn/dl/v<版本>/<带版本号文件名>
#      全格式含 .sig / msi / rpm，供历史版本回溯与自洽镜像（其 latest.json 已改写为域名直链）
#
# 说明：应用内自动更新链路维持 GitHub 直连（updater endpoint = GitHub），服务器仅作下载镜像。

DEST_ROOT="/var/www/uartix"
STABLE="$DEST_ROOT/stable"
# releases/latest/download 永久 302 到最新已发布版本 → 脚本无需知道版本号
BASE="https://github.com/Tanixs/uartix-plus/releases/latest/download"
SITE="https://larix.teuioe.cn/dl"

pull() { # pull <url> <dest-dir> <name>
  curl -fSL --retry 3 --connect-timeout 20 -o "$2/$3" "$1" && echo "DONE-$3" || echo "FAIL-$3"
}

echo "===== 1/2 stable 永久镜像 ====="
mkdir -p "$STABLE" || exit 1
for f in \
  Uartix-Plus-windows-x64-Setup.exe \
  Uartix-Plus-linux-x64.AppImage \
  Uartix-Plus-linux-x64.deb \
  latest.json; do
  pull "${BASE}/${f}" "$STABLE" "$f"
done

# 从 stable/latest.json 读出当前发布版本，据此建版本归档目录
VER=$(grep -o '"version":[[:space:]]*"[^"]*"' "$STABLE/latest.json" | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
if [ -z "$VER" ]; then
  echo "!! 无法从 latest.json 解析版本号，跳过版本归档"
  exit 1
fi
TAG="v$VER"
VDIR="$DEST_ROOT/$TAG"
GHB="https://github.com/Tanixs/uartix-plus/releases/download/$TAG"

echo "===== 2/2 版本归档 $TAG ====="
mkdir -p "$VDIR" || exit 1
for f in \
  "Uartix-Plus_${VER}_x64-setup.exe" \
  "Uartix-Plus_${VER}_x64-setup.exe.sig" \
  "Uartix-Plus_${VER}_x64_en-US.msi" \
  "Uartix-Plus_${VER}_x64_en-US.msi.sig" \
  "Uartix-Plus_${VER}_amd64.AppImage" \
  "Uartix-Plus_${VER}_amd64.AppImage.sig" \
  "Uartix-Plus_${VER}_amd64.deb" \
  "Uartix-Plus_${VER}_amd64.deb.sig" \
  "Uartix-Plus-${VER}-1.x86_64.rpm" \
  "Uartix-Plus-${VER}-1.x86_64.rpm.sig" \
  "latest.json"; do
  pull "${GHB}/${f}" "$VDIR" "$f"
done

# 归档目录内 latest.json 的下载地址改写为本站域名 → 该目录成为自洽镜像
sed -i "s|${GHB}/|${SITE}/${TAG}/|g" "$VDIR/latest.json"

# nginx 可读
chmod -R a+rX "$DEST_ROOT" 2>/dev/null

echo "----- deployed version: $TAG -----"
echo "[stable]"; ls -la "$STABLE"
echo "[$TAG]";   ls -la "$VDIR"
echo "----- 归档 latest.json 平台 URL -----"
grep -o '"url": *"[^"]*"' "$VDIR/latest.json" | head -8
