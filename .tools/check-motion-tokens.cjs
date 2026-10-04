#!/usr/bin/env node
/**
 * P149 · 第 16 道门：交互时长不许写死。
 *
 * 为什么要这么晚才补：`--dur-*` 三枚令牌从 P103 就在，主题也能覆写它们——但实测
 * `theme.css` 的 85 条 `transition`/`animation` 声明里只有 14 条真的读令牌（16.5%）。
 * 后果是"这枚主题动起来是什么样"主题只能改到一成半（流利蓝按提示词把时长改成 150/200ms，
 * 屏幕上一大半控件根本没跟着变——用户说的"动效没覆盖到"就是这条）。
 *
 * 判什么（**这一版比详设里写的窄，是量出来的**）：
 *  - `transition:` 里的字面时长 ⇒ 全部要抓。实测 52 条 transition 里 40 条写死，
 *    值只有 60/80/120/150/180ms 五种——这就是"交互反馈节奏"，属于主题的签名。
 *  - `animation:` 里 **< 200ms** 的字面时长 ⇒ 也抓（那是短促反馈，实测只有 1 条 180ms）。
 * 不判什么（写清楚，别偷偷放行）：
 *  - `animation:` 里 ≥200ms 的时长。实测 24 条里 23 条落在这段，值从 300ms 到 2s，
 *    它们是**某个效果自己的周期**（抖动 .3s、呼吸 1.6s、录制闪 1s、扫光 .55s…），
 *    不是全局节奏。把它们收成一枚 `--dur-pulse` 等于让抖动和呼吸同速——那是行为变更，不是补覆盖。
 *    （详设 P147 §3.1 原本写的是"64 条归槽 + 新增 --dur-pulse"，这条按实测收窄。）
 *  - `--dur-*` 自己的定义（那是值的出处）、`0s`（那是"关掉"）。
 * 豁免：`motion-token-exempt: <理由>` 注释 + `.tools/motion-token-exemptions.json` 台账，预算只降不升。
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LEDGER = path.join(__dirname, "motion-token-exemptions.json");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SCAN = ["src/styles/theme.css", "src/styles/builtinStyles/fluent.css"];
const THEME_DIR = "src/styles/themes";

/** `animation:` 的这一段不算主题节奏：≥200ms 是效果自己的周期（见文件头那条实测理由） */
const EFFECT_CYCLE_MS = 200;
const DURATION = /(?<![\w.-])(?:\d+(?:\.\d+)?|\.\d+)(ms|s)\b/g;
const EXEMPT = /motion-token-exempt:\s*(\S.*)/;

function durations(code) {
  const after = code.slice(code.indexOf(":") + 1);
  return [...after.matchAll(DURATION)]
    .map((m) => parseFloat(m[0]) * (m[1] === "s" ? 1000 : 1))
    .filter((v) => v !== 0);
}

/** 扫一份 CSS：返回逐条违规（含豁免标记，豁免由台账核对） */
function scanCss(text, label) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const isTransition = /(^|[;{\s-])transition\s*:/.test(code);
    const isAnimation = /(^|[;{\s-])animation\s*:/.test(code);
    if (!isTransition && !isAnimation) continue;
    let lits = durations(code);
    if (isAnimation && !isTransition) lits = lits.filter((v) => v < EFFECT_CYCLE_MS);
    if (!lits.length) continue;
    const ex = EXEMPT.exec(raw) || (i > 0 ? EXEMPT.exec(lines[i - 1]) : null);
    found.push({ file: label, line: i + 1, decl: code.trim().replace(/s+/g, " "), lits, exempt: ex ? ex[1].trim() : null });
  }
  return found;
}

function filesToScan() {
  const out = [...SCAN];
  for (const f of fs.readdirSync(path.join(ROOT, THEME_DIR))) if (f.endsWith(".css")) out.push(`${THEME_DIR}/${f}`);
  return out;
}
const scanAll = () => filesToScan().flatMap((f) => scanCss(read(f), f));

/** 判据自证：真例、反例、边界例都齐了才继续跑（门自己瞎了比不跑更坏）。 */
function selfTest() {
  const cases = [
    ["  transition: background .15s;", 1, "字面 .15s 的 transition 要抓"],
    ["  transition: background var(--dur-fast);", 0, "走令牌的不算违规"],
    ["  transition: all 0s;", 0, "0s 是『关掉动效』"],
    ["  animation: pop .18s ease;", 1, "短于一个周期的 animation 仍是反馈，要抓"],
    ["  animation: shake .3s ease;", 0, "≥200ms 是效果自己的周期，按规则不抓（见文件头）"],
    ["  animation: rec-blink 1s infinite;", 0, "呼吸/闪烁同理：收成一档会让抖动和呼吸同速"],
    ["  animation: none;", 0, "关掉没有时长"],
    ["  /* motion-token-exempt: 这一档是 X 专用反馈 */\n  transition: transform .08s;", 1, "带豁免注释仍然被计数（exempt 非空，交给台账核）"],
  ];
  for (const [css, want, why] of cases) {
    const got = scanCss(css, "fixture");
    if (got.length !== want) {
      console.log(`FAIL: 判据自证没过 —— ${why}（期望 ${want} 条，实得 ${got.length} 条）`);
      process.exit(1);
    }
  }
  /** 行号会漂：同一份声明上面多插十行，豁免必须仍然认得它（按声明文本认，不按行号认） */
  const NL = String.fromCharCode(10);
  const pad = Array.from({ length: 10 }, (_, i) => "/* 第 " + i + " 行注释 */").join(NL);
  const shifted = scanCss(pad + NL + NL + cases[7][0], "fixture");
  if (shifted[0]?.decl !== scanCss(cases[7][0], "fixture")[0]?.decl) {
    console.log("FAIL: 判据自证没过 —— 同一条声明换了行号就不认得了，豁免台账会在别人插注释时自己判红");
    process.exit(1);
  }
  const ex = scanCss(cases[7][0], "fixture");
  if (!ex[0] || !ex[0].exempt) {
    console.log("FAIL: 判据自证没过 —— 豁免注释没被认出来，台账会形同虚设");
    process.exit(1);
  }
  console.log(`OK: 判据对 ${cases.length} 条夹具全部命中（含 0s、var()、200ms 边界与豁免识别）`);
}

function main() {
  selfTest();
  const all = scanAll();
  const open = all.filter((x) => !x.exempt);
  const exempt = all.filter((x) => x.exempt);

  if (!fs.existsSync(LEDGER)) {
    console.log(`尚无台账。当前实测：交互时长写死 ${all.length} 条（未豁免 ${open.length}、带理由豁免 ${exempt.length}）`);
    console.log("写台账：node .tools/check-motion-tokens.cjs --write");
    return;
  }
  const led = JSON.parse(read(".tools/motion-token-exemptions.json"));
  if (open.length > led.budget.literals) {
    console.log(`FAIL: 写死的交互时长从 ${led.budget.literals} 涨到 ${open.length} 条 —— 这条账只降不升。`);
    for (const x of open.slice(0, 12)) console.log(`  - ${x.file}:${x.line}  ${x.lits.join(" ")}`);
    process.exit(1);
  }
  for (const x of exempt) {
    /** 按**声明文本**认豁免，不按行号：样式表上面插一行注释就把行号挪了，
     *  那等于今天这条判据会自己判自己红（P149 第一次跑 check:all 就是这么抓出来的）。 */
    if (!(led.exemptions || []).some((e) => e.file === x.file && e.decl === x.decl)) {
      console.log(`FAIL: ${x.file}:${x.line} 挂着豁免注释却没在台账里登记（豁免不是免检）`);
      process.exit(1);
    }
  }
  if (open.length < led.budget.literals) {
    console.log(`FAIL: 债少了（登记 ${led.budget.literals}，实测 ${open.length}）—— 把预算改小或整条删掉，留着等于假装还有债`);
    process.exit(1);
  }
  console.log(`OK: 交互时长账通过 —— 全库 ${all.length} 条字面时长，未豁免 ${open.length}（预算 ${led.budget.literals}），带理由豁免 ${exempt.length}`);
}

if (require.main === module) {
  if (process.argv.includes("--write")) {
    const all = scanAll();
    const body = {
      version: 1,
      judge: "transition 的字面时长 + animation 里 <200ms 的字面时长；≥200ms 的 animation 是效果自己的周期（不判），0s 与 var(--dur-*) 不判；豁免须带 motion-token-exempt 理由并在此登记",
      effect_cycle_floor_ms: EFFECT_CYCLE_MS,
      budget: { literals: all.filter((x) => !x.exempt).length },
      exemptions: all.filter((x) => x.exempt).map((x) => ({ file: x.file, decl: x.decl, lits: x.lits, reason: x.exempt })),
    };
    fs.writeFileSync(LEDGER, JSON.stringify(body, null, 2) + "\n");
    console.log(`写出 .tools/motion-token-exemptions.json：未豁免 ${body.budget.literals} 条 / 登记豁免 ${body.exemptions.length} 条`);
    process.exit(0);
  }
  main();
}

module.exports = { scanCss, EFFECT_CYCLE_MS };
