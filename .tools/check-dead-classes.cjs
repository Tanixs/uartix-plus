/**
 * P132-I · 死规则门：CSS 里定义了、但**没有任何东西会渲染它**的类名。
 *
 * 为什么需要它：`.wlc-skip` 那条（P132-H 删掉的）是靠 grep 撞上的——静态门一条都不查这件事。
 * J 门查的是反方向（TSX 用到的类有没有定义），所以"改了名字没删旧规则"这种债只会越攒越多，
 * 而且**没人会去看**。这条门把它变成每次提交都数的一个数。
 *
 * 判"死"要过四道，缺一道都不算（这是本批量出来的，不是设计出来的）：
 *  ① CSS 选择器里有这个类名；
 *  ② `src` 下的 .ts/.tsx 里**没有这个整词**（保守取法，见 `sourceFacts` 的注释：宁可少报不误删）；
 *  ③ 源码里没有任何能拼出它的**模板前缀**（`orch-dot-${kind}` 能拼出 `.orch-dot-logic`，
 *     所以那 35 条不能算死——这一道是 P132-I 补的，没有它清单本身就是错的）；
 *  ④ 13 面运行时**没渲染过**它（`.tools/class-census.json`）。
 *     ④ 不是冗余：静态说"没人用"的 124 条里，被运行时证明活着的正好是 4 条 `.dv-*`
 *     ——dockview 自己画 DOM，我们的源码里当然没有那些字面量。
 *
 * 五条规矩：
 *  1. 普查文件在、版本对、面清单与 `audit-faces.mjs` 里的面表**一致**（面表改了普查没重跑＝假账），
 *     且每一面至少收到这么多类名——只扫三个节点交上来的并集是假覆盖；
 *  2. 账里每条都要仍然成立：CSS 里已经删掉的规则，账要一起删（不留空位）；
 *     反过来源码或运行时开始用它的，也要从账上掉出去；
 *  3. 不在账上的新死规则判红（"多出一条"）；
 *  4. 预算只降不升：`budget.unreferenced` 是上限，实测更低时提示收紧但不自己降；
 *  5. 豁免（第三方 DOM 前缀）必须带理由，且**必须还命中**——那个库不渲染了就把豁免一起删。
 *
 * 门自己带夹具：一份故意做坏的账必须被逐条命中，不然"绿"只是它没看见。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LEDGER = path.join(__dirname, "dead-classes.json");
const CENSUS = path.join(__dirname, "class-census.json");
const FACES = path.join(__dirname, "audit-faces.mjs");
const CSS_DIR = path.join(ROOT, "src", "styles");
const SRC_DIR = path.join(ROOT, "src");
const PKG_DIR = path.join(ROOT, "market");

/** 每面至少要收到多少个类名（实测最低 151，这条只管"根本没扫"那种假账） */
const MIN_PER_FACE = 60;
/** 豁免理由短于这个字数不算理由 */
const MIN_REASON = 8;

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (/node_modules|dist|\.git/.test(p)) continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
};

/** ① CSS 选择器里的类名（声明块里的值不算） */
function cssClasses() {
  const map = new Map();
  for (const f of walk(CSS_DIR).filter((x) => x.endsWith(".css"))) {
    const src = fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectorText = src.replace(/\{[^{}]*\}/g, "{}");
    for (const m of selectorText.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
      if (!map.has(m[1])) map.set(m[1], path.relative(ROOT, f));
    }
  }
  return map;
}

/** ② 源码里的 class token 与 ③ 能拼出它的模板前缀；外加主题包对宿主类的引用
 *
 * token 的取法是"整份源码按非类名字符切开"，不是"只认引号里的字符串"。
 * 理由实测：`` `snt-card ${a.level}${a.acked ? " acked" : ""}` `` 这种**模板里套引号**的写法
 * 会把朴素的引号扫描错配，`.acked` 因此被误判成死规则——而它是活的。
 * 方向是单向保守：标识符（`a.acked`）会让同名类算"活着"，所以这条门**只会少报、不会误删**，
 * 而它的职责是"别让新的死规则长出来"，少报可以接受、误判不能。 */
function sourceFacts() {
  const tokens = new Set();
  const prefixes = new Set();
  let all = "";
  for (const f of walk(SRC_DIR).filter((x) => /\.(ts|tsx)$/.test(x))) all += fs.readFileSync(f, "utf8") + "\n";
  for (const t of all.split(/[^A-Za-z0-9_-]+/)) if (/^[A-Za-z_][\w-]*$/.test(t)) tokens.add(t);
  // 只认带 `-` 的静态段：不带连字符的前缀太宽（"x" 能拼出一切），等于没有这条判据
  for (const m of all.matchAll(/["'`]([^"'`\n]{1,80}?)\$\{/g)) {
    if (m[1].includes("-")) prefixes.add(m[1]);
  }
  // 主题包 CSS 引用宿主类名是合法的（那一侧由 J3 管），所以不能因为"我们自己的 tsx 没写"就判死
  const pkg = walk(PKG_DIR).filter((x) => x.endsWith(".css")).map((x) => fs.readFileSync(x, "utf8")).join("\n");
  return { tokens, prefixes, pkg };
}

/** 模板头能不能拼出这个类名：`` `agent-badge${warn}` `` 的头是 "agent-badge"，
    它**同时**覆盖"恰好等于头"与"以头开头"两种——只认后者会把 `agent-badge` 本身误判成死规则（实测踩过）。 */
const reachableByTemplate = (cls, pre) => pre.some((p) => cls === p || cls.startsWith(p));

/** 四道判据跑一遍；顺带把每条豁免命中了几次记回去（规矩 5 要用） */
function computeUnreferenced(census, css, facts, exemptions) {
  const rendered = new Set(census.rendered);
  const pre = [...facts.prefixes];
  for (const e of exemptions) e.hit = 0;
  const out = [];
  for (const [cls, file] of css) {
    if (facts.tokens.has(cls)) continue;
    if (reachableByTemplate(cls, pre)) continue;
    if (rendered.has(cls)) continue;
    if (cls.includes("-") && facts.pkg.includes(cls)) continue;
    const e = exemptions.find((x) => typeof x.prefix === "string" && cls.startsWith(x.prefix));
    if (e) { e.hit = (e.hit || 0) + 1; continue; }
    out.push({ cls, file });
  }
  return out.sort((a, b) => a.cls.localeCompare(b.cls));
}

/** 纯函数：账 + 普查 + 现算的清单 → 问题清单。夹具自证也走这里 */
function checkLedger(ledger, census, faceIds, found, css) {
  const problems = [];
  if (!ledger || typeof ledger !== "object") return { problems: ["死规则账不是一个对象"] };
  if (ledger.version !== 1) problems.push(`账 version=${ledger.version}，门只认 1（形状换了就要同步改门）`);
  if (!census) return { problems: problems.concat(["没有 class-census.json——跑 npm run census"]) };
  if (census.version !== 1) problems.push(`普查 version=${census.version}，门只认 1`);
  if (!Array.isArray(census.rendered) || census.rendered.length < MIN_PER_FACE) {
    problems.push(`普查并集只有 ${(census.rendered || []).length} 个类名，低于下限 ${MIN_PER_FACE}——这不叫覆盖`);
    return { problems, count: found.length };
  }
  /* 规矩 1：面表改了、普查没重跑，是最容易发生也最难发现的一种假账 */
  const censusFaces = Object.keys(census.faces || {});
  for (const id of faceIds) {
    if (!censusFaces.includes(id)) problems.push(`面 ${id} 在普查里没有记录（面表改了要重跑 npm run census）`);
  }
  for (const id of censusFaces) {
    if (!faceIds.includes(id)) problems.push(`普查里有面 ${id}，面表里却没有（删了面没删账？）`);
    const n = census.faces[id];
    if (typeof n !== "number" || n < MIN_PER_FACE) problems.push(`普查里 ${id} 只收到 ${n} 个类名，低于下限 ${MIN_PER_FACE}`);
  }

  const rendered = new Set(census.rendered);
  const listed = new Map((ledger.unreferenced || []).map((x) => [x.cls, x]));
  for (const f of found) {
    if (!listed.has(f.cls)) problems.push(`多出一条死规则 .${f.cls}（${f.file}）：CSS 里有、源码没有、面上没渲染——要么删掉，要么说清谁在渲染它`);
  }
  for (const [cls, x] of listed) {
    if (!css.has(cls)) {
      problems.push(`账上 .${cls} 在 CSS 里已经找不到了：规则删了就把这条账一起删（别留空位）`);
    } else if (rendered.has(cls)) {
      problems.push(`账上 .${cls} 现在被面上渲染到了：它不是死规则，把这条账删掉重跑 npm run census`);
    } else if (x.file && !fs.existsSync(path.join(ROOT, x.file))) {
      problems.push(`账上 .${cls} 记的文件 ${x.file} 不存在了`);
    }
  }
  for (const e of ledger.exemptions || []) {
    if (typeof e.prefix !== "string" || e.prefix.length < 2) problems.push(`豁免条目 "${e.prefix}" 不是一个像样的前缀`);
    if (typeof e.reason !== "string" || e.reason.trim().length < MIN_REASON) {
      problems.push(`豁免 ${e.prefix} 没有理由（或短于 ${MIN_REASON} 字）`);
      continue;
    }
    if (!e.hit) problems.push(`豁免 ${e.prefix} 一条都没命中：那个库不渲染这些类了就把豁免一起删`);
  }
  const n = found.length;
  if (typeof ledger.budget?.unreferenced !== "number") {
    problems.push("账里没有 budget.unreferenced（死规则没有上限＝可以无声长回来）");
  } else if (n > ledger.budget.unreferenced) {
    problems.push(`死规则 ${n} 条，超预算 ${ledger.budget.unreferenced} 条——只降不升，要放宽得说清为什么`);
  }
  return { problems, count: n, budget: ledger.budget?.unreferenced, cssTotal: css.size, rendered: rendered.size };
}

const faceIds = () => [...fs.readFileSync(FACES, "utf8").matchAll(/\{\s*id:\s*"([\w-]+)"/g)].map((m) => m[1]);

function main() {
  const ids = faceIds();
  if (!ids.length) {
    console.log("FAIL: 从 audit-faces.mjs 里一个面都没读到（面表写法换了？同步改这条门）");
    process.exit(1);
  }
  if (!fs.existsSync(CENSUS)) {
    console.log("FAIL: 没有 class-census.json——跑 npm run census（需要一次性 profile 的 headless 浏览器）");
    process.exit(1);
  }
  const census = JSON.parse(fs.readFileSync(CENSUS, "utf8"));
  const css = cssClasses();
  const facts = sourceFacts();
  const prev = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : null;
  const exemptions = prev?.exemptions ?? [];
  const found = computeUnreferenced(census, css, facts, exemptions);

  if (process.argv.includes("--write")) {
    const old = prev?.budget?.unreferenced;
    const ledger = {
      version: 1,
      generatedAt: new Date().toISOString().slice(0, 10),
      theme: census.theme,
      judge: "四道判据：CSS 有 ∧ 源码无同名字面量 ∧ 无模板前缀能拼出 ∧ 13 面没渲染（.tools/check-dead-classes.cjs）",
      exemptions,
      budget: { unreferenced: typeof old === "number" ? Math.min(old, found.length) : found.length },
      unreferenced: found,
    };
    fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8" });
    console.log(`已写 ${path.basename(LEDGER)}：CSS 类名 ${css.size} · 面上渲染 ${census.rendered.length} · 死规则 ${found.length} 条，预算 ${ledger.budget.unreferenced}`);
    return;
  }

  if (!prev) {
    console.log("FAIL: 没有 dead-classes.json——跑 node .tools/check-dead-classes.cjs --write 生成");
    process.exit(1);
  }
  const res = checkLedger(prev, census, ids, found, css);
  if (res.problems.length) {
    console.log(`FAIL: ${res.problems.length} problem(s)`);
    for (const p of res.problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  const hint = res.count < res.budget ? `（实测 ${res.count} < 预算 ${res.budget}，可以收紧）` : "";
  console.log(`OK: 死规则 ${res.count} 条 / 预算 ${res.budget} 条${hint} · CSS 类名 ${res.cssTotal} · 面上渲染过 ${res.rendered}`);

  /* ---------------- 夹具自证 ---------------- */
  const fix = JSON.parse(JSON.stringify(prev));
  const first = (fix.unreferenced || [])[0];
  if (!first) { console.log("FAIL: 账是空的，夹具没法自证"); process.exit(1); }
  fix.version = 9;                                              // ① 版本不对
  fix.unreferenced.push({ cls: "zz-nobody-renders-this", file: "src/styles/theme.css" }); // ② 账上有条 CSS 里已不存在
  fix.exemptions = (fix.exemptions || []).concat([{ prefix: "zzgone", reason: "这条豁免一条都不命中，应该被抓住" }]); // ③ 陈旧豁免
  fix.budget.unreferenced = 0;                                  // ④ 超预算
  const badCensus = JSON.parse(JSON.stringify(census));
  badCensus.faces = { workspace: 3 };                           // ⑤ 面表与普查不一致 + ⑥ 假覆盖
  const f = checkLedger(fix, badCensus, ids, found, css);
  const want = ["version=9", "在 CSS 里已经找不到", "一条都没命中", "超预算", "在普查里没有记录", "低于下限"];
  const hit = want.filter((w) => f.problems.some((p) => p.includes(w)));
  if (hit.length !== want.length) {
    console.log(`FAIL: 夹具自证只命中 ${hit.length}/${want.length} 条，门是瞎的：${want.filter((x) => !hit.includes(x)).join(" / ")}`);
    process.exit(1);
  }
  console.log(`OK: 检测式对 ${want.length} 条夹具全部命中（门自己不是瞎的）`);
}
main();
