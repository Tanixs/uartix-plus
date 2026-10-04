/**
 * P132-C · 审计基线门（详设 §9.3 的第二道牙）。
 *
 * 采集得在真浏览器里（计算样式与祖先背景合成），CI 没有浏览器，所以这道门**不重跑审计**：
 * 它读 `.tools/audit-baseline.json`，判的是这份账本身合不合规矩、有没有被悄悄放宽。
 * 回退那一半由 `npm run audit:live` 自己判（它逐条与磁盘上这份比，变差即非零退出；
 * 版本对不上时它明说"这一轮没有对照"，不会装作比过了）。
 *
 * 八条规矩：
 *  1. 清单一致——每枚内置主题、每个面都得有记录；多出来的（主题下架了还留着账）也判红；
 *  2. 采样量下限——只扫三个节点交上来的基线是假基线；
 *  3. `severe`（比读写不出来那条线还低）**零自动放行**：每条都得在 `exemptions` 里带理由；
 *  4. 三族各一条预算，都只降不升——`total` / `hitTargets` / `overflow`；
 *     一条族没有上限，就等于它可以无声地长回来（P132-F）；
 *  5. 陈旧豁免判红——问题修掉了豁免还留着，等于给下一个真问题预留了位置；
 *  6. 账本字段必须与判据返回的那几个同名，且 `need` 要等于判据那侧的线（P132-F：
 *     上一版把命中区抄成 `width/height`，undefined 在 JSON 落盘时被静默丢掉，`hitMin` 恒 null，
 *     那一族看着有账其实一条没记）；
 *  7. `hitMin` / `overflowWorst` 必须与条目算出来的一致——"恒 null"这种形状当场判红；
 *  8. 不该占账的条目（命中区并不低于 24、溢出量为 0）也判红：账要能自证它量到了东西。
 *
 * 门自己带夹具（§8-43②）：一份故意做坏的账必须被逐条命中，不然"绿"只是它没看见。
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "audit-baseline.json");
const THEME_DIR = path.join(__dirname, "..", "src", "styles", "themes");
/** severe 那条线住在 `themeCore`（判据与门禁共用一个出处），不在门里抄数字 */
const CORE = path.join(__dirname, "..", "src", "styles", "themeCore.ts");
/** 命中区那条线（`HIT_TARGET_MIN_PX`）住在判据本体，同理 */
const RENDER = path.join(__dirname, "..", "src", "styles", "renderAudit.ts");

/** 每面至少要扫到多少个带字节点（实测最低是 362，这条线只管"根本没扫"那种假基线） */
const MIN_SAMPLED = 120;
/** 理由短于这个字数不算理由 */
const MIN_REASON = 8;
/** 24px 那条线从判据出处读，别在门里抄第二份（与 severeFloor 同一理由） */
function hitFloor() {
  const src = fs.readFileSync(RENDER, "utf8");
  const m = /HIT_TARGET_MIN_PX\s*=\s*(\d+(?:\.\d+)?)/.exec(src);
  return m ? Number.parseFloat(m[1]) : null;
}

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

/** 纯函数：一份账 + 实际主题清单 + 两条线 → 问题清单。夹具自证也走这里 */
function checkBaseline(b, ids, floor, hitLine) {
  const problems = [];
  if (!b || typeof b !== "object") return ["基线不是一个对象"];
  if (b.version !== 3) problems.push(`基线 version=${b.version}，门只认 3（P151 把形状三族接进账，就要同步改门）`);
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
  let hitsTotal = 0;
  let shapesTotal = 0;
  let overTotal = 0;
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
        // fg/bg 是"事后能对"的那两个数：没有它们，一条比值只能重跑一次才知道是哪两层
        if (typeof i.fg !== "string" || typeof i.bg !== "string") {
          problems.push(`${id}/${s}：${i.selector} 没带 fg/bg——复现不了是哪两层在打架`);
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

      /* ---- 形状（P151 新增）：A 方底垫圆身 / B 无脸投影。条目形状由 shapeAudit 定：{selector, kind, why} ---- */
      if (!Array.isArray(r.shapes)) {
        problems.push(`${id}/${s}：shapes 不是数组（这一族没记账＝没采到）`);
      } else {
        for (const sh of r.shapes) {
          if (typeof sh.selector !== "string" || typeof sh.why !== "string") {
            problems.push(`${id}/${s}：形状记录缺 selector/why（判据返回的字段名与采集器抄的漂了）`);
            continue;
          }
          if (sh.kind !== "square-behind-rounded" && sh.kind !== "shadow-without-face") {
            problems.push(`${id}/${s}：形状记录 ${sh.selector} 的 kind=${sh.kind} 不在判据会返回的两种里`);
            continue;
          }
          shapesTotal++;
        }
      }

      /* ---- 命中区（P132-F 新增）----
         上一版这一族只记了条数，而采集器把字段名抄成了 width/height（判据返回的是 minSide/need），
         于是 JSON 落盘时两条都变 undefined 被静默丢掉，`hitMin` 恒 null——
         "24px 那条线有没有被踩过"在账上根本不存在，回退比对那句 `hitMin != null` 也永远不成立。
         所以现在记**条目**，并且门逐条核对形状与最小值。 */
      if (!Array.isArray(r.hits)) {
        problems.push(`${id}/${s}：hits 不是数组（这一族没记账＝没采到）`);
      } else {
        let prevSide = -1;
        for (const h of r.hits) {
          if (typeof h.selector !== "string" || typeof h.minSide !== "number" || typeof h.need !== "number") {
            problems.push(`${id}/${s}：命中区记录 ${h.selector ?? "?"} 缺 selector/minSide/need——采集器抄的字段名与判据的返回漂了`);
            continue;
          }
          if (h.minSide >= h.need) {
            problems.push(`${id}/${s}：命中区 ${h.selector} 有 ${h.minSide}px，并不低于 ${h.need}，不该占账（判据改了？重采）`);
          }
          if (hitLine != null && h.need !== hitLine) {
            problems.push(`${id}/${s}：命中区记的 need=${h.need}，判据那侧是 ${hitLine}——两边必须同源`);
          }
          if (/\d/.test(h.selector)) problems.push(`${id}/${s}：命中区 selector ${h.selector} 没归一化`);
          if (h.minSide < prevSide - 1e-9) {
            problems.push(`${id}/${s}：hits 没按 minSide 升序（手改过？重新采集一次）`);
            break;
          }
          prevSide = h.minSide;
          hitsTotal++;
        }
        const want = r.hits.length ? Math.min(...r.hits.map((x) => x.minSide ?? Infinity)) : null;
        if (r.hitMin !== want) {
          problems.push(`${id}/${s}：hitMin=${r.hitMin} 与 hits 里算出来的 ${want} 不一致（恒 null 就是这么溜过去的）`);
        }
      }

      /* ---- 溢出（同族同理：记条目，不记一个光秃秃的数）---- */
      if (!Array.isArray(r.overflow)) {
        problems.push(`${id}/${s}：overflow 不是数组（这一族没记账＝没采到）`);
      } else {
        for (const o of r.overflow) {
          if (typeof o.selector !== "string" || typeof o.overPx !== "number" || !(o.overPx > 0)) {
            problems.push(`${id}/${s}：溢出记录 ${o?.selector ?? "?"} 缺 selector/overPx（或 overPx 不是正数）`);
            continue;
          }
          if (/\d/.test(o.selector)) problems.push(`${id}/${s}：溢出 selector ${o.selector} 没归一化`);
          overTotal++;
        }
        const worst = r.overflow.length ? Math.max(...r.overflow.map((x) => x.overPx ?? -Infinity)) : null;
        if (r.overflowWorst !== worst) {
          problems.push(`${id}/${s}：overflowWorst=${r.overflowWorst} 与 overflow 里算出来的 ${worst} 不一致`);
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
  /* 三族各自一条预算，都只降不升：一条族没有上限，就等于它可以无声地长回来 */
  const BUDGETS = [
    ["total", total, "对比度"],
    ["hitTargets", hitsTotal, "命中区"],
    ["overflow", overTotal, "溢出"],
    ["shapes", shapesTotal, "形状"],
  ];
  for (const [k, n, label] of BUDGETS) {
    const have = b.budget?.[k];
    if (typeof have !== "number") {
      problems.push(`基线没有 budget.${k}（${label}没有上限＝可以无声长回来）`);
    } else if (n > have) {
      problems.push(`${label}记账 ${n} 条，超预算 ${have} 条——只降不升，要放宽得说清为什么`);
    }
  }
  return { problems, total, hits: hitsTotal, overflow: overTotal, shapes: shapesTotal, severe, budget: b.budget };
}

/* ---------------- 跑 ---------------- */

const floor = severeFloor();
if (floor == null) {
  console.log("FAIL: 读不到 TEXT_CONTRAST_FLOOR（门与判据要同一条线）");
  process.exit(1);
}
const hitLine = hitFloor();
if (hitLine == null) {
  console.log("FAIL: 读不到 renderAudit.ts 里的 HIT_TARGET_MIN_PX（命中区那条线必须与判据同源）");
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
const res = checkBaseline(baseline, ids, floor, hitLine);
if (res.problems?.length) {
  console.log(`FAIL: ${res.problems.length} problem(s)`);
  for (const p of res.problems) console.log(`  - ${p}`);
  process.exit(1);
}
const bud = res.budget ?? {};
console.log(
  `OK: 审计基线 ${ids.length} 枚内置主题 × ${baseline.surfaces.length} 面 · 对比度 ${res.total}/${bud.total} 命中区 ${res.hits}/${bud.hitTargets} 溢出 ${res.overflow}/${bud.overflow} 形状 ${res.shapes}/${bud.shapes}（四档预算都只降不升）· severe(<${floor}) ${res.severe} 条全部带理由豁免`,
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
/* ⑧~⑬ 命中区与溢出这两族：P132-F 之前它们只记了一个数，所以门对它们一句都没说过。
   夹具必须能逐条抓到"字段抄错 / 该删的占着 / 最小值对不上 / 预算不见了"。 */
const fs2 = fixture.themes[firstId].surfaces[firstSurface];
fs2.hits = [
  { selector: "aa", minSide: 22 }, // ⑧ 缺 need：字段名与判据漂了就是这一形状
  { selector: "bb", minSide: 30, need: hitLine }, // ⑨ 并不低于线，不该占账
];
fs2.hitMin = 999; // ⑩ 与 hits 里算出来的对不上（旧版恒 null 的形状）
fs2.overflow = [{ selector: "cc", overPx: 0 }]; // ⑪ 溢出记录没量到东西
delete fixture.budget.hitTargets; // ⑫ 这一族没上限＝可以无声长回来
/* ⑭⑮ 形状族（P151 接进账）：判据返回 {selector, kind, why}，字段漂了必须当场抓到 */
fs2.shapes = [
  { selector: "sd", kind: "square-behind-rounded" }, // ⑭ 缺 why
  { selector: "se", kind: "made-up-kind", why: "看着不对" }, // ⑮ kind 不是判据会返回的那两种
];

const fRes = checkBaseline(fixture, ids, floor, hitLine);
const want = [
  `没有基线`,
  `低于下限`,
  `没有豁免理由`,
  `已经不在了`,
  `没有理由`,
  `超预算`,
  `但内置表里没有`,
  `缺 selector/minSide/need`,
  `不该占账`,
  `与 hits 里算出来的`,
  `缺 selector/overPx`,
  `没有上限`,
  `缺 selector/why`,
  `kind=made-up-kind`,
];
const hit = want.filter((w) => fRes.problems.some((p) => p.includes(w)));
if (hit.length !== want.length) {
  console.log(`FAIL: 夹具自证只命中 ${hit.length}/${want.length} 条，门是瞎的：${want.filter((w) => !hit.includes(w)).join(" / ")}`);
  process.exit(1);
}
console.log(`OK: 检测式对 ${want.length} 条夹具全部命中（门自己不是瞎的）`);
