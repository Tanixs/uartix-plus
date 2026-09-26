#!/usr/bin/env node
/**
 * P104-B11 默认页文字预算门：面板/浮窗/模态的**空态文案**汉字数不得超预算。
 *
 * 为什么要有这把门：B11 的本体是"把 1252 汉字的说明墙砍到 361"，
 * 而**没有锁的清理等于没做**——下一批人往空态里再塞两句解释，谁都不会发现。
 * 这轮已经在边框数（G）、字号刻度（E）、圆角（F）、锚点存在性上各装了一把，这条同理。
 *
 * 三条判据（每条都能被反驳）：
 *   1. 扫全 `src/**\/*.tsx`（不手写清单），按下面的空态识别式抽块、数汉字；
 *   2. 抽到字却**不在预算表里**的文件 ⇒ 红（新空态默认 0 预算，要写文字就得进来登记）；
 *   3. 表里有、文件却没了或已归零 ⇒ 红（守卫自己的账不许留尸）。
 *
 * 天花板只许降：每改干净一个面板，就把那一行的数字改小，不许改大。
 *
 * 识别式（宁窄勿宽，误报会让人来改脚本，漏报只是少管一处）：
 *   - `<EmptyState ... />` 整段；
 *   - `className="…empty…"` 的开标签到最近的 `</div>` / `</p>` / `</span>`。
 * 只数汉字：按钮 label 与 tooltip 正文不计入——前者是动作、后者是点了才看的，
 * 两条都不是"挡在第一次打开的人面前的墙"。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src");

/** 每个文件的汉字预算。数值一律取"登记时的实测值"，此后只降。
 *  2026-09-25 B11 第一轮：1063 → 615（对 HEAD 复测，同一套 measure()），
 *  下面全部降到当轮实测值。 */
const BUDGETS = {
  "src/features/ai/AiChat.tsx": 87,
  "src/features/xray/XRayPanel.tsx": 80,
  "src/features/sentinel/SentinelPanel.tsx": 67,
  "src/features/plot/Plot2D.tsx": 48,
  "src/features/framecanvas/FrameCanvas.tsx": 44,
  "src/features/orchestrator/OrchestratorPanel.tsx": 33,
  "src/features/video/VideoLink.tsx": 32,
  "src/features/modbus/ModbusWorkbench.tsx": 29,
  "src/features/table/DataTable.tsx": 24,
  "src/features/plot/SpectrumPanel.tsx": 23,
  "src/features/protocol/TemplatesPanel.tsx": 21,
  "src/features/controls/CardViews.tsx": 18,
  "src/features/plot/FieldLegend.tsx": 18,
  "src/features/sequencer/SequencerPanel.tsx": 18,
  "src/features/console/CodecEditorModal.tsx": 17,
  "src/features/controls/ControlCanvas.tsx": 17,
  "src/features/protocol/PropertiesPanel.tsx": 13,
  "src/features/console/QuickCommandBar.tsx": 11,
  "src/features/vdev/VdevPanel.tsx": 8,
  "src/features/plugins/PluginLibraryDialog.tsx": 7,
  /* B9 命令面板：这 7 个汉字是"搜不到东西"的反馈，不是说明墙 ——
     没有它，输入一个错拼的词之后界面会**静默变空**，用户分不清"没匹配"和"卡住了"。
     与其余条目同性质：功能性的空态回执。 */
  "src/shell/CommandPalette.tsx": 7,
};

const cjk = (s) => (s.match(/[一-鿿]/g) || []).length;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

function measure(text) {
  /**
   * 三处剔除，都是为了让"数的东西"等于"用户打开面板第一眼读到的东西"：
   *  - `<HelpHint/>`：B11 的**去处**就是它，搬进去的文字不该算还留在默认页上；
   *  - `title={...}`：hover 才出现的 tooltip，同理；
   *  - `<button>…</button>` 的内容：按钮 label 是动作不是说明。
   *    不剔的话「载入「温控炉」（PID 教学被控对象）」这种按钮名会被当成说明墙，
   *    于是"把文字删干净"的正确答案变成"把按钮也删了"——那是反着激励。
   *  括号按嵌套数剥：label 里常有 `tx(...)`、`loadBuiltin("…")`，非贪婪正则会从
   *  开标签一路吞到很远处的 `</button>`，把中间的说明文字一起漏掉。
   */
  const strip = (s) =>
    s
      .replace(/<HelpHint[\s\S]*?\/>/g, "")
      .replace(/\btitle=\{[\s\S]*?\}\s*(?=[\s/>])/g, " ")
      .replace(/<button\b[^>]*>/g, "\u0001")
      .replace(/<\/button>/g, "\u0002")
      .split("\u0001")
      .map((seg, i) => (i === 0 ? seg : seg.slice(seg.indexOf("\u0002") + 1)))
      .join("");
  /* 两条识别式会重叠：外层 `<div className="…-empty…">` 里往往就套着一个
     `<EmptyState/>`。按字符区间合并去重，否则同一段文字被数两遍
     （实测 AiChat 因此虚报 114，真值 87）。 */
  const spans = [];
  for (const m of text.matchAll(/<EmptyState[\s\S]{0,900}?\/>/g)) spans.push([m.index, m.index + m[0].length]);
  for (const m of text.matchAll(/className="[^"]*\bempty\b[^"]*"[\s\S]{0,900}?<\/(?:div|p|span)>/g))
    spans.push([m.index, m.index + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s < last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.reduce((acc, [s, e]) => acc + cjk(strip(text.slice(s, e))), 0);
}

const files = walk(SRC);
if (files.length < 40) {
  console.error(`FAIL: 只扫到 ${files.length} 个 tsx —— 走盘断了，这条报告没有意义`);
  process.exit(1);
}

const over = [];
const unregistered = [];
const measured = new Map();
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  const n = measure(fs.readFileSync(f, "utf8"));
  if (n === 0) continue;
  measured.set(rel, n);
  const budget = BUDGETS[rel];
  if (budget === undefined) unregistered.push([rel, n]);
  else if (n > budget) over.push([rel, n, budget]);
}

const ghosts = Object.keys(BUDGETS).filter((p) => !measured.has(p) && !fs.existsSync(path.join(ROOT, p)));
const zeroed = Object.keys(BUDGETS).filter((p) => !measured.has(p) && fs.existsSync(path.join(ROOT, p)));

const total = [...measured.values()].reduce((a, b) => a + b, 0);
for (const [rel, n] of [...measured].sort((a, b) => b[1] - a[1])) {
  const b = BUDGETS[rel];
  console.log(`  ${String(n).padStart(4)} / ${b === undefined ? "  ??" : String(b).padStart(4)}  ${rel}`);
}
console.log(`空态文案合计 ${total} 汉字，登记 ${Object.keys(BUDGETS).length} 个文件`);

let bad = false;
if (over.length) {
  bad = true;
  for (const [rel, n, b] of over) console.error(`FAIL: ${rel} 空态 ${n} 汉字 > 预算 ${b}（天花板只许降）`);
}
if (unregistered.length) {
  bad = true;
  for (const [rel, n] of unregistered)
    console.error(`FAIL: ${rel} 有空态文案 ${n} 汉字却没登记预算 —— 新空态默认 0，要写文字请进 BUDGETS 并写明理由`);
}
if (ghosts.length) {
  bad = true;
  for (const p of ghosts) console.error(`FAIL: 预算表里的 ${p} 已经不存在 —— 把那一行删掉，守卫不许留尸`);
}
if (zeroed.length) {
  bad = true;
  for (const p of zeroed) console.error(`FAIL: ${p} 已归零，预算行请一并删掉（留着一行 ?? 会让下一个读数的人误判）`);
}
if (bad) process.exit(1);
console.log("OK: 默认页文字预算通过");
