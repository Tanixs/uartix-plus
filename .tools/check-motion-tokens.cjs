#!/usr/bin/env node
/**
 * P149 · 第 16 道门：交互时长不许写死。P154-B 扩出缓动半边：字面缓动曲线不许写死。
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
 *  - （P154-B）同一片种群里的**字面缓动** ⇒ 抓：`ease / ease-in / ease-out / ease-in-out /
 *    linear / cubic-bezier(` 都算。49 次 120ms 旁边跟的就是字面 `ease`——fluent 的曲线
 *    之前只落在 14 条上，主题改得了时长改不了"手感怎么弯"。`var(--ease, <回退>)` 不判：
 *    句柄在，回退值是死的。`steps()` 不判：离散闪烁是形状不是曲线。
 * 不判什么（写清楚，别偷偷放行）：
 *  - `animation:` 里 ≥200ms 的时长与曲线。实测 24 条里 23 条落在这段，值从 300ms 到 2s，
 *    它们是**某个效果自己的周期**（抖动 .3s、呼吸 1.6s、录制闪 1s、扫光 .55s…），
 *    不是全局节奏。把它们收成一枚 `--dur-pulse` 等于让抖动和呼吸同速——那是行为变更，不是补覆盖。
 *    （详设 P147 §3.1 原本写的是"64 条归槽 + 新增 --dur-pulse"，这条按实测收窄；
 *    缓动半边沿用同一条种群线，呼吸的 ease-in-out 是效果自己的形状，不跟主题曲线。）
 *  - `--dur-*` / `--ease` 自己的定义（那是值的出处）、`0s`（那是"关掉"）。
 * 豁免：`motion-token-exempt: <理由>`（时长）与 `ease-token-exempt: <理由>`（缓动）注释
 *       + `.tools/motion-token-exemptions.json` 台账（v2 起两张表），预算只降不升。
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
const EASE_KW = /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])|(?<![\w-])cubic-bezier\(/g;
const EXEMPT = /motion-token-exempt:\s*(\S.*)/;
const EASE_EXEMPT = /ease-token-exempt:\s*(\S.*)/;

function durations(code) {
  const after = code.slice(code.indexOf(":") + 1);
  return [...after.matchAll(DURATION)]
    .map((m) => parseFloat(m[0]) * (m[1] === "s" ? 1000 : 1))
    .filter((v) => v !== 0);
}

/** 字面缓动关键词。var(...) 先剥（含嵌套）：`var(--ease, ease)` 的句柄在，回退是死的。 */
function easings(code) {
  let after = code.slice(code.indexOf(":") + 1);
  while (/var\([^()]*\)/.test(after)) after = after.replace(/var\([^()]*\)/g, " ");
  return [...after.matchAll(EASE_KW)].map((m) => m[0]);
}

const norm = (code) => code.trim().replace(/\s+/g, " ");

/** 扫一份 CSS：返回逐条违规（kind: duration | ease；豁免标记由台账核对） */
function scanCss(text, label) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const isTransition = /(^|[;{\s-])transition\s*:/.test(code);
    const isAnimation = /(^|[;{\s-])animation\s*:/.test(code);
    if (!isTransition && !isAnimation) continue;
    const allDurs = durations(code);
    const ex = EXEMPT.exec(raw) || (i > 0 ? EXEMPT.exec(lines[i - 1]) : null);
    const easeEx = EASE_EXEMPT.exec(raw) || (i > 0 ? EASE_EXEMPT.exec(lines[i - 1]) : null);
    let lits = isAnimation && !isTransition ? allDurs.filter((v) => v < EFFECT_CYCLE_MS) : allDurs;
    if (lits.length) {
      found.push({ kind: "duration", file: label, line: i + 1, decl: norm(code), detail: lits.join(" "), exempt: ex ? ex[1].trim() : null });
    }
    const inPop = !isAnimation || isTransition || !allDurs.length || Math.max(...allDurs) < EFFECT_CYCLE_MS;
    if (inPop) {
      const easeLits = easings(code);
      if (easeLits.length) {
        found.push({ kind: "ease", file: label, line: i + 1, decl: norm(code), detail: easeLits.join(" "), exempt: easeEx ? easeEx[1].trim() : null });
      }
    }
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
    ["  transition: background .15s;", { duration: 1, ease: 0 }, "字面 .15s 的 transition 要抓"],
    ["  transition: background var(--dur-fast);", { duration: 0, ease: 0 }, "走令牌的不算违规"],
    ["  transition: all 0s;", { duration: 0, ease: 0 }, "0s 是『关掉动效』"],
    ["  animation: pop .18s ease;", { duration: 1, ease: 1 }, "短于一个周期的 animation 仍是反馈，时长与曲线都要抓"],
    ["  animation: shake .3s ease;", { duration: 0, ease: 0 }, "≥200ms 是效果自己的周期，按规则不抓（时长与曲线同一条种群线，见文件头）"],
    ["  animation: rec-blink 1s infinite;", { duration: 0, ease: 0 }, "呼吸/闪烁同理：收成一档会让抖动和呼吸同速"],
    ["  animation: none;", { duration: 0, ease: 0 }, "关掉没有时长"],
    ["  transition: background var(--dur-fast) var(--ease);", { duration: 0, ease: 0 }, "槽+槽 全过"],
    ["  transition: width var(--dur-fast, 120ms) var(--ease, ease);", { duration: 1, ease: 0 }, "var() 回退里的字面时长仍抓（保守）；--ease 的回退不判（句柄在）"],
    ["  animation: pop .18s steps(2);", { duration: 1, ease: 0 }, "steps() 是离散形状不是曲线，缓动半边不判"],
    ["  transition: transform .12s cubic-bezier(.2,0,0,1);", { duration: 1, ease: 1 }, "字面贝塞尔也抓"],
    ["  transition: width var(--dur-base) linear;", { duration: 0, ease: 1 }, "linear 是曲线字面，要抓（恒速语义走豁免台账）"],
    ["  animation: pulse 1.6s ease-in-out infinite;", { duration: 0, ease: 0 }, "呼吸的 ease-in-out 是效果自己的形状，不跟主题曲线"],
    ["  background: linear-gradient(90deg, a, b);", { duration: 0, ease: 0 }, "linear-gradient 不是缓动（且这条根本不是 transition/animation）"],
  ];
  for (const [css, want, why] of cases) {
    const got = scanCss(css, "fixture");
    const d = got.filter((x) => x.kind === "duration").length;
    const e = got.filter((x) => x.kind === "ease").length;
    if (d !== want.duration || e !== want.ease) {
      console.log(`FAIL: 判据自证没过 —— ${why}（期望 duration ${want.duration}/ease ${want.ease}，实得 ${d}/${e}）`);
      process.exit(1);
    }
  }
  /** 行号会漂：同一份声明上面多插十行，豁免必须仍然认得它（按声明文本认，不按行号认）。
   *  两张豁免表都要过这一关。 */
  const NL = String.fromCharCode(10);
  const pad = Array.from({ length: 10 }, (_, i) => "/* 第 " + i + " 行注释 */").join(NL);
  const durFixture = "  /* motion-token-exempt: 这一档是 X 专用反馈 */\n  transition: transform .08s;";
  const easeFixture = "  /* ease-token-exempt: 恒速是语义 */\n  transition: width var(--dur-base) linear;";
  for (const [fx, kind] of [[durFixture, "duration"], [easeFixture, "ease"]]) {
    const shifted = scanCss(pad + NL + NL + fx, "fixture");
    const base = scanCss(fx, "fixture").filter((x) => x.kind === kind);
    const got = shifted.filter((x) => x.kind === kind);
    if (!base.length || got.length !== base.length || got[0].decl !== base[0].decl) {
      console.log(`FAIL: 判据自证没过 —— ${kind} 豁免声明换了行号就不认得了，台账会在别人插注释时自己判红`);
      process.exit(1);
    }
    if (!got[0].exempt) {
      console.log(`FAIL: 判据自证没过 —— ${kind} 豁免注释没被认出来，台账会形同虚设`);
      process.exit(1);
    }
  }
  console.log(`OK: 判据对 ${cases.length} 条夹具全部命中（含 0s、var() 回退、200ms 边界、steps/贝塞尔/linear 与两张豁免表）`);
}

function main() {
  selfTest();
  const all = scanAll();
  const byKind = (k) => all.filter((x) => x.kind === k);
  const openOf = (k) => byKind(k).filter((x) => !x.exempt);
  const exemptOf = (k) => byKind(k).filter((x) => x.exempt);

  if (!fs.existsSync(LEDGER)) {
    console.log(`尚无台账。当前实测：时长写死 ${byKind("duration").length} 条（未豁免 ${openOf("duration").length}）、缓动写死 ${byKind("ease").length} 条（未豁免 ${openOf("ease").length}）`);
    console.log("写台账：node .tools/check-motion-tokens.cjs --write");
    return;
  }
  const led = JSON.parse(read(".tools/motion-token-exemptions.json"));
  const tables = [
    ["duration", "budget.literals", led.budget.literals, led.exemptions || [], "写死的交互时长"],
    ["ease", "budget.easeLiterals", led.budget.easeLiterals, led.easeExemptions || [], "写死的缓动曲线"],
  ];
  for (const [kind, budgetName, budget, table, zh] of tables) {
    const open = openOf(kind);
    const exempt = exemptOf(kind);
    if (open.length > budget) {
      console.log(`FAIL: ${zh}从 ${budget} 涨到 ${open.length} 条 —— 这条账只降不升。`);
      for (const x of open.slice(0, 12)) console.log(`  - ${x.file}:${x.line}  ${x.detail}`);
      process.exit(1);
    }
    if (open.length < budget) {
      console.log(`FAIL: ${zh}的债少了（登记 ${budget}，实测 ${open.length}）—— 把预算改小或整条删掉，留着等于假装还有债`);
      process.exit(1);
    }
    for (const x of exempt) {
      /** 按**声明文本**认豁免，不按行号：样式表上面插一行注释就把行号挪了，
       *  那等于今天这条判据会自己判自己红（P149 第一次跑 check:all 就是这么抓出来的）。 */
      if (!table.some((e) => e.file === x.file && e.decl === x.decl)) {
        console.log(`FAIL: ${x.file}:${x.line} 挂着${kind === "ease" ? "ease-token" : "motion-token"}-exempt 却没在台账里登记（豁免不是免检）`);
        process.exit(1);
      }
    }
    console.log(`OK: ${zh}账通过 —— 未豁免 ${open.length}（预算 ${budget}，${budgetName}），带理由豁免 ${exempt.length}`);
  }
}

if (require.main === module) {
  if (process.argv.includes("--write")) {
    const all = scanAll();
    const body = {
      version: 2,
      judge: "时长：transition 的字面时长 + animation 里 <200ms 的字面时长；缓动：同一片种群里的 ease/ease-in/ease-out/ease-in-out/linear/cubic-bezier( 字面。≥200ms 的 animation 是效果自己的周期（时长与曲线都不判），0s 与 var(--dur-*)/var(--ease,…) 不判，steps() 不判；豁免须带 motion-token-exempt / ease-token-exempt 理由并在此登记",
      effect_cycle_floor_ms: EFFECT_CYCLE_MS,
      budget: {
        literals: all.filter((x) => x.kind === "duration" && !x.exempt).length,
        easeLiterals: all.filter((x) => x.kind === "ease" && !x.exempt).length,
      },
      exemptions: all.filter((x) => x.kind === "duration" && x.exempt).map((x) => ({ file: x.file, decl: x.decl, lits: x.detail, reason: x.exempt })),
      easeExemptions: all.filter((x) => x.kind === "ease" && x.exempt).map((x) => ({ file: x.file, decl: x.decl, lits: x.detail, reason: x.exempt })),
    };
    fs.writeFileSync(LEDGER, JSON.stringify(body, null, 2) + "\n");
    console.log(`写出 .tools/motion-token-exemptions.json(v2)：时长未豁免 ${body.budget.literals} / 豁免 ${body.exemptions.length}；缓动未豁免 ${body.budget.easeLiterals} / 豁免 ${body.easeExemptions.length}`);
    process.exit(0);
  }
  main();
}

module.exports = { scanCss, EFFECT_CYCLE_MS };
