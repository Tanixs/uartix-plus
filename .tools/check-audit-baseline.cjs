/**
 * P132-C · 审计基线门（详设 §9.3 的第二道牙）。
 *
 * 采集得在真浏览器里（计算样式与祖先背景合成），CI 没有浏览器，所以这道门**不重跑审计**：
 * 它读 `.tools/audit-baseline.json`，判的是这份账本身合不合规矩、有没有被悄悄放宽。
 * 回退那一半由 `npm run audit:live` 自己判（它逐条与磁盘上这份比，变差即非零退出）。
 *
 * 五条规矩：
 *  1. 清单一致——每枚内置主题、每个面都得有记录；多出来的（主题下架了还留着账）也判红；
 *  2. 采样量下限——只扫三个节点交上来的基线是假基线；
 *  3. `severe`（比读写不出来那条线还低）**零自动放行**：每条都得在 `exemptions` 里带理由；
 *  4. 预算只降不升——`budget.total` 是记账条数上限，实测更低时门会提示收紧，但不会自己降；
 *  5. 陈旧豁免判红——问题修掉了豁免还留着，等于给下一个真问题预留了位置。
 *
 * 门自己带夹具（§8-43②）：一份故意做坏的账必须被逐条命中，不然"绿"只是它没看见。
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "audit-baseline.json");
const THEME_DIR = path.join(__dirname, "..", "src", "styles", "themes");
/** severe 那条线住在 `themeCore`（判据与门禁共用一个出处），不在门里抄数字 */
const CORE = path.join(__dirname, "..", "src", "styles", "themeCore.ts");

/** 每面至少要扫到多少个带字节点（实测最低是 362，这条线只管"根本没扫"那种假基线） */
const MIN_SAMPLED = 120;
/** 理由短于这个字数不算理由 */
const MIN_REASON = 8;

/** severe 那条线从生产判据的出处读，不在门里再抄一份数——抄了就会与 `auditContrast` 漂 */
function severeFloor() {
  const src = fs.readFileSync(CORE, "utf8");
  const m = /TEXT_CONTRAST_FLOOR\s*=\s*([\d.]+)/.exec(src);
  if (!m) return null;
  return Number.parseFloat(m[1]);
}

const builtinThemeIds = () =>
  fs
    .readdirSync(THEME_DIR)
    .filter((f) => f.endsWith(".css"))
    .map((f) => f.replace(/\.css$/, ""))
    .sort();

const key = (theme, surface, selector) => `${theme}|${surface}|${selector}`;

/** 纯函数：一份账 + 实际主题清单 + severe 线 → 问题清单。夹具自证也走这里 */
function checkBaseline(b, ids, floor) {
  const problems = [];
  if (!b || typeof b !== "object") return ["基线不是一个对象"];
  if (b.version !== 1) problems.push(`基线 version=${b.version}，门只认 1（换了形状就要同步改门）`);
  if (!Array.isArray(b.surfaces) || !b.surfaces.length) problems.push("基线里没有 surfaces 清单");
  if (!b.themes || typeof b.themes !== "object") return problems;

  const surfaces = Array.isArray(b.surfaces) && b.surfaces.length ? b.surfaces : [];
  const exempt = new Map();
  for (const e of b.exemptions ?? []) {
    if (typeof e?.reason !== "string" || e.reason.trim().length < MIN_REASON) {
      problems.push(`豁免条目 ${key(e?.theme ?? "?", e?.surface ?? "?", e?.selector ?? "?")} 没有理由（或短于 ${MIN_REASON} 字）`);
      continue;
    }
    exempt.set(key(e.theme, e.surface, e.selector), e.reason.trim());
  }

  let total = 0;
  let severe = 0;
  const seen = new Set();
  for (const id of ids) {
    const entry = b.themes[id];
    if (!entry) {
      problems.push(`${id}：内置主题没有基线（新加一枚就得重新采集，别让它悄悄没账）`);
      continue;
    }
    for (const s of surfaces) {
      const r = entry.surfaces?.[s];
      if (!r) {
        problems.push(`${id}/${s}：这一面没有记录`);
        continue;
      }
      seen.add(key(id, s, "*"));
      if (typeof r.sampled !== "number" || r.sampled < MIN_SAMPLED) {
        problems.push(`${id}/${s}：采样 ${r.sampled} 个节点，低于下限 ${MIN_SAMPLED}——这不叫覆盖`);
      }
      if (!Array.isArray(r.issues)) {
        problems.push(`${id}/${s}：issues 不是数组`);
        continue;
      }
      total += r.issues.length;
      let prevRatio = -1;
      for (const i of r.issues) {
        if (typeof i.ratio !== "number" || typeof i.need !== "number" || typeof i.selector !== "string") {
          problems.push(`${id}/${s}：有条目形状不对（缺 ratio/need/selector）`);
          continue;
        }
        if (/\d/.test(i.selector)) problems.push(`${id}/${s}：selector ${i.selector} 没归一化（带数字的链会随实例漂）`);
        if (i.ratio < prevRatio - 1e-9) {
          problems.push(`${id}/${s}：issues 没按比值升序（手改过？重新采集一次）`);
          break;
        }
        prevRatio = i.ratio;
        if (floor != null && i.ratio < floor) {
          severe++;
          if (!exempt.has(key(id, s, i.selector))) {
            problems.push(`${id}/${s}：${i.selector} 比值 ${i.ratio} 低于 ${floor}（读不出来那一档），没有豁免理由就是判红，不许记账放行`);
          }
        }
      }
    }
  }

  for (const id of Object.keys(b.themes)) {
    if (!ids.includes(id)) problems.push(`${id}：基线里有这枚主题，但内置表里没有（下架了就把账一起删）`);
  }
  for (const k of exempt.keys()) {
    const [theme, surface] = k.split("|");
    const entry = b.themes[theme];
    const stillThere = entry?.surfaces?.[surface]?.issues?.some((i) => key(theme, surface, i.selector) === k);
    if (!stillThere) problems.push(`豁免 ${k} 指向的条目已经不在了：修掉了就把这条豁免一起删`);
  }
  if (typeof b.budget?.total !== "number") {
    problems.push("基线没有 budget.total（记账条数上限），不许无预算地记着");
  } else if (total > b.budget.total) {
    problems.push(`记账 ${total} 条，超预算 ${b.budget.total} 条——只降不升，要放宽得说清为什么`);
  }
  return { problems, total, severe, budget: b.budget?.total };
}

/* ---------------- 跑 ---------------- */

const floor = severeFloor();
if (floor == null) {
  console.log("FAIL: 读不到 renderAudit.ts 里的 TEXT_CONTRAST_FLOOR（门与判据要同一条线）");
  process.exit(1);
}
if (!fs.existsSync(FILE)) {
  console.log(`FAIL: 没有 ${path.basename(FILE)}——跑 npm run audit:live -- --write 生成`);
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.log(`FAIL: 基线解析不了：${e.message}`);
  process.exit(1);
}

const ids = builtinThemeIds();
const res = checkBaseline(baseline, ids, floor);
if (res.problems?.length) {
  console.log(`FAIL: ${res.problems.length} problem(s)`);
  for (const p of res.problems) console.log(`  - ${p}`);
  process.exit(1);
}
const hint = res.total < res.budget ? `（实测 ${res.total} < 预算 ${res.budget}，可以收紧）` : "";
console.log(
  `OK: 审计基线 ${ids.length} 枚内置主题 × ${baseline.surfaces.length} 面 · 记账 ${res.total} 条 / 预算 ${res.budget} 条${hint} · severe(<${floor}) ${res.severe} 条全部带理由豁免`,
);

/* ---------------- 夹具自证：门自己不是瞎的 ---------------- */

const fixture = JSON.parse(JSON.stringify(baseline));
delete fixture.themes[ids[ids.length - 1]]; // ① 少一枚
const firstId = ids[0];
const firstSurface = fixture.surfaces[0];
fixture.themes[firstId].surfaces[firstSurface].sampled = 3; // ② 假覆盖
fixture.themes[firstId].surfaces[firstSurface].issues = [
  { selector: "i", ratio: 1.1, need: 4.5, fg: "rgb(0 0 0)", bg: "rgb(255 255 255)", severe: true },
  { selector: "zz-real", ratio: 1.9, need: 4.5, fg: "rgb(0 0 0)", bg: "rgb(255 255 255)", severe: true },
]; // ③ 冒出一条没豁免的 severe（1.9 也在 floor 之下——夹具要真的踩线，别踩个"看着像"）
fixture.exemptions = (fixture.exemptions ?? []).concat([
  { theme: firstId, surface: firstSurface, selector: "gone.long.ago", reason: "这条指向的条目早就不在了" }, // ④ 陈旧豁免
  { theme: firstId, surface: firstSurface, selector: "i", reason: "略" }, // ⑤ 理由不算理由
]);
fixture.budget.total = 0; // ⑥ 超预算
fixture.themes["ghost-theme"] = { kind: "builtin", surfaces: {} }; // ⑦ 多一枚

const fRes = checkBaseline(fixture, ids, floor);
const want = [
  `没有基线`,
  `低于下限`,
  `没有豁免理由`,
  `已经不在了`,
  `没有理由`,
  `超预算`,
  `但内置表里没有`,
];
const hit = want.filter((w) => fRes.problems.some((p) => p.includes(w)));
if (hit.length !== want.length) {
  console.log(`FAIL: 夹具自证只命中 ${hit.length}/${want.length} 条，门是瞎的：${want.filter((w) => !hit.includes(w)).join(" / ")}`);
  process.exit(1);
}
console.log(`OK: 检测式对 ${want.length} 条夹具全部命中（门自己不是瞎的）`);
