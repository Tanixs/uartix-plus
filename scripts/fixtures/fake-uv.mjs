#!/usr/bin/env node
/**
 * P178-B：假安装器（测试夹具，不是产物）。
 *
 * 为什么要它：环境安装器的四条路（成功 / 某步失败 / 取消 / 续装）都要判，
 * 但真装一次是 4.5 GB + 十几分钟。这里把 `uv` 换成一段 60 行的脚本，
 * 每条路都能精确制造，且**不碰网络、不碰用户机器**。
 *
 * 插件侧只在 `UARTIX_YOLO_UV_TEST=1` 且给了 `UARTIX_YOLO_UV_CMD` 时才用它；
 * 生产路径永远走真下载的 uv.exe（见 main.mjs 的 ensureUv）。
 *
 * 环境变量：
 *   FAKE_UV_PY_DIR   venv 的 `Scripts` 目录用 junction 指到这个真 python 环境（默认取工作区那套 conda）
 *   FAKE_UV_FAIL     `torch` / `ultralytics` / `venv` / `first-install`：让对应步骤退出 1
 *   FAKE_UV_BADDEPS  1 = `pip check` 报不一致（验"只记不拦"）
 *   FAKE_UV_LOG      每次调用的 jsonl 落这里，测试据此断言"哪几步被跳过"
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_UV_LOG || "";
function note(extra) {
  if (!logPath) return;
  try {
    fs.appendFileSync(
      logPath,
      JSON.stringify({ at: Date.now(), argv, ...(extra || {}) }) + "\n",
      "utf8",
    );
  } catch {
    /* 记不上不影响判定 */
  }
}

const fail = String(process.env.FAKE_UV_FAIL || "");
const cmd = argv[0] || "";

// 夹具自己崩了要留证据：否则插件那边只看到"退出码 1 + 一段没有上下文的栈"，
// 排查会从"是不是 uv 镜像挂了"开始，方向一开始就错。
process.on("uncaughtException", (e) => {
  note({ kind: "crash", err: String((e && e.stack) || e).slice(0, 800) });
  console.error("fake-uv 崩了：" + String((e && e.message) || e));
  process.exit(1);
});

if (argv.includes("--version") || cmd === "--version") {
  note({ kind: "version" });
  console.log("uv 9.9.9-fake (uartix test)");
  process.exit(0);
}

if (cmd === "venv") {
  note({ kind: "venv" });
  if (fail === "venv") {
    console.error("fake-uv: 假装建 venv 失败（FAKE_UV_FAIL=venv）");
    process.exit(1);
  }
  const dir = argv[argv.length - 1];
  const scripts = path.join(dir, "Scripts");
  fs.mkdirSync(scripts, { recursive: true });
  // 注意：**不要在这里建 junction**。插件进程跑在 Node 权限模型下（`--permission`），
  // 子进程会继承这层限制，`fs.symlink` 会直接抛
  // "fs.symlink API requires full fs.read and fs.write permissions"。
  // 真 uv 是原生 exe，不受影响；夹具要验的是"状态机走没走对"，不是"能不能建软链"。
  // 需要"venv 里真能 import torch"的用例，由测试自己在调用前把 Scripts 布置好。
  console.log("fake-uv: 建好空 venv（需要真 python 的用例请预置 Scripts）");
  process.exit(0);
}

if (cmd === "pip" && argv[1] === "install") {
  const isTorch = argv.some((a) => /^torch==/.test(a));
  const isUltra = argv.some((a) => /^ultralytics==/.test(a));
  const which = isTorch ? "torch" : isUltra ? "ultralytics" : "other";
  // 必须在 note() 之前读：note 会把这一次也写进去，之后判"是不是第一次"就永远是 false
  const logText = logPath && fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const firstEver = !logText.includes('"kind":"install"');
  note({ kind: "install", which, firstEver });
  if (fail === which || (fail === "first-install" && firstEver)) {
    console.error(`fake-uv: 假装装 ${which} 失败（FAKE_UV_FAIL=${fail}）`);
    process.exit(1);
  }
  console.log(`fake-uv: 装好 ${which}`);
  process.exit(0);
}

if (cmd === "pip" && argv[1] === "check") {
  note({ kind: "check" });
  if (process.env.FAKE_UV_BADDEPS === "1") {
    console.log("opencv-python 4.9.0 requires numpy<2, but numpy 2.1.0 is installed");
    process.exit(1);
  }
  console.log("All installed packages are compatible");
  process.exit(0);
}

note({ kind: "other" });
console.error("fake-uv: 不认识这个子命令：" + argv.join(" "));
process.exit(2);
