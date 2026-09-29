#!/usr/bin/env node
/**
 * P104-B11 尾：i18n 覆盖门（check:i18n）。
 *
 * 为什么要有它：合同 B11 行的验收写着"英文构建无中文残留"，可这条**一直没人量过**。
 * 一量才发现差得比想象多 —— 而且第一次量还量错了：只扫带引号的字符串，
 * 漏掉 `<span>模板</span>` 这类 JSX 文本节点，View3D 报"19 处"、实际还有 10 处
 * 是裸文本（导入模型 / 复位视角 / 欧拉角 / 顺序 / 取反…）。所以判据必须两路都扫。
 *
 * 口径（三条，都是为了让它**可判**而不是为了让它好看）：
 *  1. 只看 `.tsx`（渲染给人的那一层）。`.ts` 里是**数据**：AI 提示词发给模型，
 *     翻译了会改变模型行为；用户模板/命令名是用户自己起的名字，
 *     顺手"翻译"等于改用户数据。这两类都不该被这道门推着走。
 *  2. 注释里的中文不算（那是写给读代码的人看的）。
 *  3. `tx("中文", "English")` / `pick("中文", "English")` 的中文那一路合法，先剥掉再数。
 *
 * 预算表**只许降不许升**，与 check-empty-copy 同一套：
 * 新增文件、或某个文件的计数变大 ⇒ 判红。清零的文件要从表里删掉，
 * 留着空条目同样是债（那会让"清单在变短"这件事看不出来）。
 *
 * 用法：node .tools/check-i18n.cjs [--print]
 *
 * ⚠ 曾经有的那个"已知缺陷"，方向写反了（P105-F 第二次实测纠正）：
 * 旧版扫描器是**正则配引号**，头注里写的是"只会虚报、不会漏报"，所以一直没人修。
 * 实际它会**漏报**：英文文案里一个 ASCII 撇号（`isn't`）就被当成字符串定界符，
 * 之后整段引号配对错位；`tx()` 第一参数里嵌带引号的模板也会吃掉后面一大片。
 * 代价实测：`AiChat` 报 4 / 真实 63，`SettingsModal` 报 12 / 真实 213，`HexView` 报 0 / 真实 4。
 * **会漏数债的门比没有门更坏** —— 它让人以为债还完了，于是真的还完了（在指标上）。
 * 现在换成 TypeScript 的 AST 数字面量（见 `.tools/i18n-scan.cjs`），并同一次改掉了
 * `list-untranslated.cjs` 那份第二实现：两个工具各数一遍，本来就是下一处漂移。
 *
 * 换口径当天用 `--rebaseline` 把 15 条预算改对（合计 24,102 → 25,089）：
 * 涨的那些**一个字的新中文都没有**，全是旧扫描器过去数漏了的存量债。
 * 这不是放松棘轮 —— 棘轮之前量的是错的数。之后照旧只降不升。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * 每个文件"未翻译的中文 UI 串"条数上限。数值 = 本次实测现状，只许往下走。
 * View3D.tsx 已在 B11 尾清零并移出本表。
 *
 * QuickCommandBar.tsx 剩余的 100 字是**故意留着**的：那 12 条 WIT 预置指令的名字与备注
 * 要写进用户命令库当数据，不是界面文字（同上面"出厂预设模板名"那条口径），
 * 理由写在 src/features/console/QuickCommandBar.tsx 的 presets 数组上方。
 *
 * AiChat.tsx 剩余的 4 字是 `PATROL_MARKER = "巡检发现"`：它不是文案，是**提示词与回执之间的暗号**
 * （`prompts.ts` 要求模型在回答末尾开这么一节，`AiChat` 靠它判断"这次有没有可上报的东西"）。
 * 换语言要两边一起换，而且旧会话的历史回复仍是老标题、判据会漏 —— 所以它留在原地，源文件里有说明。
 *
 * CardViews.tsx 剩余的 4 字是 `DIR_VALUES = ["上","下","左","右"]`：它是键盘遥控脚本变量 `dirName` 的
 * **值**，也会被模板 `{dirName}` 插进真正发出去的指令里。跟着界面语言走 = 同一张卡在中/英下发不同字节、
 * `if (dirName === "上")` 这类脚本当场失效。界面上屏的方向名另有一份（`dirLabels()`，切语言会变）。
 *
 * 剩下两笔同一族：**"对象的默认名"被当键用**，不是文案。
 *  - `App.tsx` 的 10 字 = 姿态调参预设建控制页时写的页名与卡片名（`name === "姿态调参"` 还被拿来判重，
 *    换了语言就会重复建页）。
 *  - `VdevPanel.tsx` 的 5 字 = `loadBuiltin("温控炉" / "虚拟 MPU6050")` 的**查表键**，
 *    按钮上给人看的话早就是双语了（源文件里写了这条）。
 * 整族决定（内置预设 / 出厂规格 / store 默认对象名要不要按当下语言播种）记在 P105-方案清单 §8 等拍。
 */
const BUDGETS = {
  // P115-B：帮助回写时把改写过的那几句顺手转成 tx(中, 英) 双语（整句进 tx 的中文第一参
  // 在计数前就被剥掉），所以这一格从 20514 降到 20214。方向与棘轮一致：债只会更小。
  // P121-A：`%d` 那句改口时顺手收紧（"按格式插值"→"插值"），20214 → 20211。
  "src/features/help/HelpModal.tsx": 20211,
  "src/features/console/QuickCommandBar.tsx": 100,
  "src/App.tsx": 10,
  "src/features/vdev/VdevPanel.tsx": 5,
  "src/features/ai/AiChat.tsx": 4,
  "src/features/controls/CardViews.tsx": 4,
};












const CJK = /[一-鿿]/;

/**
 * 数一个文件里"没走 i18n 的中文 UI 串"有多少**个汉字**。
 * 口径与实现在 `.tools/i18n-scan.cjs`（门与 `list-untranslated.cjs` 共用一处，
 * 两边各数一遍就是"同一件事两个答案"）。
 *
 * 为什么按字数而不是按"条数"：第一版按条数，HelpModal 从 132 跳到 1441 ——
 * 因为条数对**排版**敏感（同样一段话，标签拆法一变条数就翻十倍）。
 * 一道会因为别人重排了 JSX 就变红的门，很快就会被无视，那还不如没有。
 * 汉字个数对排版几乎不敏感，而且"还剩多少字要翻"本来就是想知道的量。
 */
const { scanFile, walkTsx, walkAllCode, uiTsFiles } = require("./i18n-scan.cjs");
const count = (file) => scanFile(file).total;

const rows = [];
for (const f of [...walkTsx(path.join(ROOT, "src")), ...uiTsFiles(ROOT)]) {
  const rel = path.relative(ROOT, f).replace(/\\/g, "/");
  const n = count(f);
  if (n > 0) rows.push([rel, n]);
}
rows.sort((a, b) => b[1] - a[1]);

let fails = 0;
const actual = new Map(rows);

const grown = [];
for (const [rel, n] of rows) {
  const cap = BUDGETS[rel];
  if (cap === undefined) grown.push(`新文件未登记：${rel} = ${n}`);
  else if (n > cap) grown.push(`${rel} = ${n} > 上限 ${cap}`);
}
if (grown.length) {
  console.error(`FAIL: ${grown.length} 处中文 UI 文案超过登记上限（这道门的预算只许降不许升）：`);
  for (const g of grown.slice(0, 12)) console.error("  - " + g);
  fails++;
}

const stale = Object.keys(BUDGETS).filter((k) => !actual.has(k) || BUDGETS[k] > (actual.get(k) || 0));
if (stale.length) {
  console.error(`FAIL: ${stale.length} 条预算已过期，请把数字改小或整条删掉（留着等于假装还有债）：`);
  for (const k of stale.slice(0, 12)) console.error(`  - ${k} 登记 ${BUDGETS[k]}，实际 ${actual.get(k) ?? 0}`);
  fails++;
}

const total = rows.reduce((s2, [, n]) => s2 + n, 0);

/* ---------------- 守卫二：中心键必须存在、两本词典必须对称 ----------------
 * `t()` 查不到键的行为是**把键名原样返回** —— 于是屏幕上直接印出 `c.import` 这种字串：
 * 不报错、不红、测试也不知道。第一次上这道守卫就抓到现成的：`hx.pause` / `hx.resume`
 * 只加进了英文词典，中文模式下 HexView 那颗暂停键的 title 一直显示裸键名。
 * 所以钉两条：① 代码里每个 `t("字面量")` 都得在词典里；② zh / en 键集合必须完全相同
 * （少一边就是另一种"另一种语言下露出裸键 / 露出另一国语言"）。
 */
{
  const ts = require("typescript");
  const STRINGS = path.join(ROOT, "src", "i18n", "strings.ts");
  const dictKeys = (name) => {
    const sf = ts.createSourceFile(STRINGS, fs.readFileSync(STRINGS, "utf8"), ts.ScriptTarget.Latest, true);
    const keys = new Set();
    const visit = (n) => {
      if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) {
        if (d.name.getText() === name && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
          for (const pr of d.initializer.properties) {
            if (ts.isPropertyAssignment(pr) && pr.name) keys.add(pr.name.getText().replace(/^["']|["']$/g, ""));
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return keys;
  };
  const zhKeys = dictKeys("zh");
  const enKeys = dictKeys("en");
  const bad = [];
  let used = 0;
  for (const k of [...zhKeys].filter((x) => !enKeys.has(x))) bad.push(`词典只在 zh 有，英文模式会退回中文：${k}`);
  for (const k of [...enKeys].filter((x) => !zhKeys.has(x))) bad.push(`词典只在 en 有，中文模式会印出裸键：${k}`);
  const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
  for (const f of walkAllCode(path.join(ROOT, "src"))) {
    const src = fs.readFileSync(f, "utf8");
    if (!/\bt\(/.test(src)) continue;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "t"
        && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0])) {
        const k = n.arguments[0].text;
        used++;
        if (!zhKeys.has(k) || !enKeys.has(k)) {
          bad.push(`${rel(f)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} t("${k}") 不在词典里（会原样印到屏幕上）`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (bad.length) {
    console.error(`FAIL: 中心键有问题 ${bad.length} 处（两边词典必须对称、用到的键必须存在）：`);
    for (const b of bad.slice(0, 15)) console.error("  - " + b);
    fails++;
  } else {
    console.log(`OK: 中心键 ${zhKeys.size} 个且 zh / en 两本词典对称；代码里 ${used} 处 t("…") 全部取得到值`);
  }
}

/* ---------------- 守卫三：说了人话就得订阅语言 ----------------
 * 实测过的坑：设置页里把语言从中文切到英文，界面上还留着十几处中文（导轨项、接口类型、
 * 连接胶囊…）。不是没翻，是**那些组件根本没订阅 locale** —— 切语言时没人叫它们重渲染，
 * 于是它们把上一次的语言一直挂到刷新为止。`tx()` 数得清字数，数不清有没有人订阅。
 * 口径取文件级：一个 `.tsx` 里只要出现 `tx(` / `t("`，就得有 `useLocale(`。
 * 组件级太贵（一个文件十几个小组件各订一次是噪声），文件级会漏"同文件里另一个组件没重渲染"，
 * 但那种情况父级一定会重渲染到它 —— 真正会漏的正是"整文件零订阅"，这条钉的就是它。
 * 代价：不需要的文件多订一个 useSyncExternalStore，几毛钱的内存。
 */
{
  const files = walkTsx(path.join(ROOT, "src"));
  const missing = [];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    const speaks = /tx\(/.test(src) || /\bt\("/.test(src);
    if (!speaks) continue;
    if (!/useLocale\s*\(/.test(src)
      // 设置页那个 store 里就存着 `locale`，订阅它 = 订阅语言（HexView / LinkPanel 两处的注释就是这么写的），
      // 再叠一个 useLocale 是第二个真相；所以这条也算满足。
      && !/useSettings\s*\(/.test(src)) {
      // 例外必须写在源文件里、带理由，别在门里藏名单：搜 `i18n-subscribe:` 就能数清谁豁免了什么。
      if (/\/\/[^\n]*i18n-subscribe:/.test(src)) continue;
      missing.push(path.relative(ROOT, f).replace(/\\/g, "/"));
    }
  }
  if (missing.length) {
    console.error(`FAIL: ${missing.length} 个 .tsx 里有界面话术却没有订阅语言（useLocale() 或订阅设置 store 的 useSettings()）—— 切语言时这些面不会重渲染：`);
    for (const m of missing.slice(0, 15)) console.error("  - " + m);
    console.error("补一行 useLocale(); 是真的；确实补不了（类组件等）就写一行 `// i18n-subscribe: <理由>` 说明为什么。");
    fails++;
  } else {
    console.log("OK: 说人话的 .tsx 都订阅了语言切换（useLocale）");
  }
}

/* ---------------- 守卫四：双语不许写在模块顶层 ----------------
 * 这门之前只会数"中文有没有配英文"，配了就干净 —— 但 `const X = { label: tx("接入","Link") }`
 * 写在模块顶层，是 **import 那一刻求一次值**：语言从此冻死，切语言时哪怕组件订阅了 useLocale
 * 也拿不到新文案（`tx()` 早就把字符串焊进常量里了）。实测就是这么漏的：
 * 导轨五项与顶栏那颗连接胶囊在切语言后一直是旧语言，门全程绿。
 * 判据：`.tsx` / `UI_TS` 文件里，任何 `tx(` / `t("…")` 调用只要**不在函数体内**就判红。
 * 修法只有一条：把那张表改成函数（`const railItems = () => [...]`），值在渲染时取。
 *
 * P115-F11 补的盲区：这份清单原先只盖 `.tsx` + UI_TS 点名表——而模块级 tx 同样会
 * 长在 `.ts` 里（实录：shell/commandRegistry.ts 六个分组名 G_PANEL…G_HELP 冻在 import 时刻，
 * 门全程绿）。结构违规与"这文件是不是 UI 层"无关，改为扫全部代码文件
 * （walkAllCode = .ts + .tsx，排除测试）。
 */
{
  const ts = require("typescript");
  const bad = [];
  const inFunction = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isMethodDeclaration(p)) return true;
    }
    return false;
  };
  const files = walkAllCode(path.join(ROOT, "src"));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!/tx\(/.test(src) && !/\bt\("/.test(src)) continue;
    const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true);
    const relf = path.relative(ROOT, f).replace(/\\/g, "/");
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const nm = n.expression.text;
        const hit = nm === "tx" || (nm === "t" && n.arguments.length === 1 && ts.isStringLiteral(n.arguments[0]));
        if (hit && !inFunction(n)) {
          bad.push(`${relf}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${nm}() 写在模块顶层（值会冻在 import 那一刻）`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (bad.length) {
    console.error(`FAIL: ${bad.length} 处双语调用写在模块顶层（切语言不会跟着变，useLocale 也救不回来）：`);
    for (const b of bad.slice(0, 15)) console.error("  - " + b);
    console.error("把承载它的表改成函数：值在渲染时取，别在 import 时取。");
    fails++;
  } else {
    console.log("OK: 没有一句双语写在模块顶层（话术全部在函数里取值）");
  }
}

if (process.argv.includes("--print")) {
  for (const [rel, n] of rows) console.log(String(n).padStart(4), " ", rel);
}
if (fails) {
  console.log(`合计 ${total} 个汉字 / ${rows.length} 个文件`);
  process.exit(1);
}
console.log(`OK: 未翻译的中文 UI 文案 ${total} 个汉字 / ${rows.length} 个文件，全部在登记的预算内（预算只降不升）`);
