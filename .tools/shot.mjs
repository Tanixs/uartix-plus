#!/usr/bin/env node
/**
 * P111-A1：通用无头截图（界面取证的地基）。
 *
 * 为什么现在才有一个能拍任意状态的：仓库里本来就有 `.tools/gen-welcome-shot.mjs`，
 * 但它把"拍哪一张"钉死在欢迎卡上。P110-B3/B4 交付时我说"浏览器自动化看不了"，
 * 事实是**看不了的那部分只是内置浏览器面板没开**（viewport 0×0），而无头 Chrome 这条路一直通着。
 * 界面改判的验收证据不该等用户实拍 —— 这条命令就是为了让"我自己看一眼"成为可能。
 *
 * 用法：
 *   npm run dev 或 npx vite --port 1421 先起着，然后
 *   node .tools/shot.mjs out.png "http://[::1]:1421/?welcome=0&open=settings/model" 1440,900
 * 位置参数：<输出 png> <url> [宽,高] [额外 query 由 url 自带]
 *
 * 三条刻意的规矩：
 *  1. **拒拍 1420**：那是用户 `tauri dev` 的端口，抢它等于把用户的开发窗换成我的取证窗（端口纪律）。
 *  2. 产物体积下限：无头截图失败时常常是"看起来成功"地写出一张白图，所以按字节数判，
 *     而不是按退出码 —— `gen-welcome-shot.mjs` 当年就是被这张白图骗过一次（15000ms 那条注释）。
 *  3. 浏览器探测与 spawn 逻辑**只有这一份**：`gen-welcome-shot.mjs` 现在 import 它，
 *     两处各抄一份候选路径表 = 装在不同盘的浏览器只有一处能找到。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** 找可用的 Chromium 系浏览器；`LARIX_BROWSER` 优先（装在非默认盘的人不必改这张表） */
export function browserPath() {
  const fromEnv = process.env.LARIX_BROWSER;
  for (const p of fromEnv ? [fromEnv, ...CANDIDATES] : CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * 拍一张。**同步** spawn：调用方是脚本，不是服务，异步只会让"截完接着比对"多一层回调。
 * @returns {{ok:boolean, bytes:number, note:string}}
 */
export function shoot({ url, out, size = "1440,900", wait = 15000, profile }) {
  const exe = browserPath();
  if (!exe) return { ok: false, bytes: 0, note: "找不到 Edge/Chrome，设 LARIX_BROWSER=<绝对路径> 再试" };
  if (/[:/]1420\b/.test(url)) return { ok: false, bytes: 0, note: "拒拍 1420：那是用户 tauri dev 的端口，取证一律用 1421" };
  const abs = path.resolve(out);
  mkdirSync(path.dirname(abs), { recursive: true });
  const own = !profile;
  const dir = profile ?? mkdtempSync(path.join(tmpdir(), "larix-shot-"));
  const r = spawnSync(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      // 等 React 挂载 + dockview 布局落定。9000 实测截出过全白图（不是失败，是"看起来成功"的坏证据）。
      `--virtual-time-budget=${wait}`,
      `--window-size=${size}`,
      `--user-data-dir=${dir}`,
      `--screenshot=${abs}`,
      url,
    ],
    { encoding: "utf8" },
  );
  if (own) rmSync(dir, { recursive: true, force: true });
  // **必须轮询等文件**：机器上已有 Edge/Chrome 实例在跑时，这次调用会把活儿移交给那个
  // 常驻进程然后自己退出（status 0、文件还没写）。按退出码判成败会当场误报一次"白屏"，
  // 而过一会儿文件又出现了——这正是 P111-A 首跑撞上的形态。
  const deadline = Date.now() + 20000;
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let bytes = existsSync(abs) ? statSync(abs).size : 0;
  while (bytes === 0 && Date.now() < deadline) {
    sleepSync(200);
    bytes = existsSync(abs) ? statSync(abs).size : 0;
  }
  const ok = bytes > 20000;
  return { ok, bytes, note: ok ? "" : `${r.stderr?.slice(0, 160) || `产物只有 ${(bytes / 1024).toFixed(0)}KB，多半是白屏`}` };
}

/* 只有被当命令跑时才解析 argv —— 被 import 时不能顺手把调用方的参数吃了 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [out, url, size] = process.argv.slice(2);
  if (!out || !url) {
    console.error("用法：node .tools/shot.mjs <out.png> <url> [宽,高]");
    process.exit(2);
  }
  const r = shoot({ url, out, size });
  if (!r.ok) {
    console.error(`FAIL: ${r.note}`);
    process.exit(1);
  }
  console.log(`✓ ${out}  ${(r.bytes / 1024).toFixed(0)} KB  ← ${url}  ${size ?? "1440,900"}`);
}
