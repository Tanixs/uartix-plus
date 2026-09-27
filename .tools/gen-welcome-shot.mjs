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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// 浏览器探测与无头截图只有 `.tools/shot.mjs` 一份（P111-A1）：
// 两处各抄一份候选路径表，装在非默认盘的那个浏览器就只有一处能找到。
import { browserPath, shoot } from "./shot.mjs";

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

const SHOTS = [
  { file: "proto-light.png", theme: "light" },
  { file: "proto-dark.png", theme: "dark" },
];

if (!browserPath()) {
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
  const r = shoot({ url, out, size: VIEWPORT, profile });
  if (!r.ok) {
    bad++;
    console.error(`FAIL ${s.file}: ${r.note}`);
  } else {
    console.log(`  ✓ ${s.file}  ${(r.bytes / 1024).toFixed(0)} KB  ← ${url}`);
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
