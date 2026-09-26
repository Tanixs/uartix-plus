#!/usr/bin/env node
/**
 * P104-B7：重拍首启欢迎卡的底图（`npm run welcome:snap`）。
 *
 * 为什么要有这条命令：欢迎卡第 2 张是**真实截图**，而截图不会跟着改名和改布局走，
 * 仓库里也没有任何门禁能看懂像素。防过期的办法不是"别放图"，是把重拍做到
 * 便宜到改完界面顺手跑一次——所以这里把窗口尺寸、预设、缩放、主题族全部钉死，
 * 与 `welcomeSlides.ts` 里的 `SHOT_W/SHOT_H` 同一份口径。
 *
 * 拦不住的仍然是"东西还在但挪了位置"：那条靠人眼（交付时实拍），
 * 改名/删元素那一类由 `src/shell/welcome.test.ts` 判红。
 *
 * 用法：先起 dev（`npm run dev`），再 `node .tools/gen-welcome-shot.mjs`。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "src", "assets", "welcome");
const DEV_URL = "http://[::1]:1420/";
/** 视口从 `welcomeSlides.ts` 派生，不在这里另写一遍数：
 *  徽标坐标是相对底图宽高的**比例**，两边口径一漂，标注就集体指错地方。 */
const slidesSrc = readFileSync(path.join(ROOT, "src", "shell", "welcomeSlides.ts"), "utf8");
const shotNum = (name) => {
  const m = new RegExp(`export const ${name} = (\\d+)`)
  const v = Number(m.exec(slidesSrc)?.[1]);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`FAIL: 从 welcomeSlides.ts 读不到 ${name} —— 换了写法就要改这个脚本，别让它静默截一张错尺寸的图`);
    process.exit(1);
  }
  return v;
};
const VIEWPORT = `${shotNum("SHOT_W")},${shotNum("SHOT_H")}`;

const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

function browser() {
  const fromEnv = process.env.LARIX_BROWSER;
  for (const p of fromEnv ? [fromEnv, ...CANDIDATES] : CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

const SHOTS = [
  { file: "proto-light.png", theme: "light" },
  { file: "proto-dark.png", theme: "dark" },
];

const exe = browser();
if (!exe) {
  console.error("FAIL: 找不到 Edge/Chrome。设 LARIX_BROWSER=<可执行文件绝对路径> 再试。");
  process.exit(1);
}

try {
  const probe = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) });
  if (!probe.ok) throw new Error(String(probe.status));
} catch {
  console.error(`FAIL: dev 服务没在 ${DEV_URL}（先 npm run dev）。注意它只听 IPv6，用 localhost 会连不上。`);
  process.exit(1);
}

const profile = mkdtempSync(path.join(tmpdir(), "larix-welcome-snap-"));
let bad = 0;
for (const s of SHOTS) {
  const out = path.join(OUT_DIR, s.file);
  // 无头截图只认 Windows 绝对路径；相对路径会被解析到浏览器的 cwd
  const url = `${DEV_URL}?welcome=0&preset=proto&theme=${s.theme}&zoom=100`;
  const r = spawnSync(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      // 等 React 挂载 + dockview 布局落定；给短了会截到空壳。
      // 9000 在 125% 档实测截出过一张全白图（不是失败，是"看起来成功"的坏证据），所以留到 15000。
      "--virtual-time-budget=15000",
      `--window-size=${VIEWPORT}`,
      `--user-data-dir=${profile}`,
      `--screenshot=${out}`,
      url,
    ],
    { encoding: "utf8" },
  );
  const ok = r.status === 0 && existsSync(out) && statSync(out).size > 20000;
  if (!ok) {
    bad++;
    console.error(`FAIL ${s.file}: ${r.stderr?.slice(0, 200) || "产物过小，多半是白屏"}`);
  } else {
    console.log(`  ✓ ${s.file}  ${(statSync(out).size / 1024).toFixed(0)} KB  ← ${url}`);
  }
}
rmSync(profile, { recursive: true, force: true });

if (bad) {
  console.error(`FAIL: ${bad}/${SHOTS.length} 张没截成`);
  process.exit(1);
}
console.log(
  "OK: 底图已重拍。徽标坐标在 welcomeSlides.ts（比例值）——如果这次改动挪动了被指的东西，" +
    "坐标要跟着改，welcome.test.ts 管不了位置。",
);
