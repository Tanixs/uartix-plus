#!/bin/bash
cd /var/www/uartix/v0.2.0 || exit 1
base="https://github.com/Tanixs/uartix-plus/releases/download/v0.2.0"
for f in Uartix-Plus_0.2.0_x64-setup.exe Uartix-Plus_0.2.0_x64-setup.exe.sig Uartix-Plus_0.2.0_amd64.AppImage Uartix-Plus_0.2.0_amd64.AppImage.sig Uartix-Plus_0.2.0_amd64.deb latest.json; do
  curl -fSL --retry 3 --connect-timeout 20 -o "$f" "$base/$f" && echo "DONE-$f" || echo "FAIL-$f"
done
sed -i 's|https://github.com/Tanixs/uartix-plus/releases/download/v0.2.0/|https://larix.teuioe.cn/dl/|g' latest.json
echo "----- FILES -----"
ls -la
echo "----- latest.json -----"
cat latest.json
