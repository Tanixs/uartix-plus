/**
 * P105-F：i18n 债的**唯一测量口径**。`check-i18n.cjs`（门）与 `list-untranslated.cjs`（干活清单）
 * 都从这里取数 —— 两边各数一遍，就是"同一件事两个答案"的老坑。
 *
 * 为什么重写：旧版用正则配对引号。它会在两种情况下**悄悄少计**（不是多计）：
 *  1. 英文文案里出现 ASCII 撇号（`isn't`）—— 撇号被当成字符串定界符，后面整段配对错位；
 *  2. `tx()` 第一参数里嵌了带引号的模板 —— 剥不掉，或者反过来吃掉后面一大片。
 * 实测代价：`AiChat.tsx` 正则报 4、真实 63；`SettingsModal.tsx` 报 12、真实 213；
 * `HexView.tsx` 报 0、真实 4。**一道会漏数债的门，比没有门更坏**——它让人以为债还完了。
 *
 * 现在改成用 TypeScript 自己的解析器走 AST：字面量就是字面量，不靠字符猜。
 * 口径不变：
 *  - `tx(中文, 英文)` / `pick(中文, 英文)` 只数**第二个**参数（第一参数是原文，已经双语了）；
 *  - `t("中心.键名")` 整条不数（那是键名不是文案）；
 *  - 数的是**汉字个数**（按字数不按条数，理由见 check-i18n.cjs 头部：条数对排版敏感）。
 */
const ts = require("typescript");
const fs = require("fs");

const CJK = /[一-鿿]/g;
const zhLen = (s) => (s.match(CJK) || []).length;

/** 双语helper 的名字：第一参数是中文原文，数它等于把已经翻好的东西再计一遍债。 */
const BILINGUAL = new Set(["tx", "pick"]);
/** 中心键取词：参数是键名，不是文案。 */
const KEY_ONLY = new Set(["t"]);

function isTypeScript(file) {
  return /\.tsx$/.test(file);
}

/**
 * @param {string} file 绝对或相对路径
 * @returns {{ total: number, hits: Array<{line: number, chars: number, text: string}> }}
 */
function scanFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.ESNext,
    true,
    isTypeScript(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const skip = new Set();
  const hits = [];
  let total = 0;

  const isStringish = (node) =>
    ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node);

  const add = (text, at) => {
    const c = zhLen(text);
    if (!c) return;
    total += c;
    hits.push({ line: sf.getLineAndCharacterOfPosition(at).line + 1, chars: c, text: text.trim().slice(0, 96) });
  };

  (function walk(node) {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : "";
      const args = node.arguments;
      if (BILINGUAL.has(callee) && args.length >= 2) skip.add(args[0].getStart(sf));
      else if (KEY_ONLY.has(callee) && args.length === 1) skip.add(args[0].getStart(sf));
    }
    if (ts.isTemplateExpression(node)) {
      /**
       * 模板串只数**它自己的字面片段**，不数整段文本：
       * 整段取法会把 `${tx("已翻好的话", "already translated")}` 里那句中文再数一遍
       * —— 明明双语了却记成债，方向和旧正则一样坏（这次是反过来：让人去翻不用翻的东西）。
       * 插值表达式本身照常下钻，那里面的真字面量不能漏。
       */
      if (!skip.has(node.getStart(sf))) {
        add(node.head.text, node.head.getStart(sf));
        node.templateSpans.forEach((span) => {
          walk(span.expression);
          // TemplateSpan 的字面片段一律叫 `literal`（中间的是 TemplateMiddle、结尾是 TemplateTail）
          add(span.literal.text, span.literal.getStart(sf));
        });
      }
      return;
    }
    if (isStringish(node)) {
      if (!skip.has(node.getStart(sf))) add(node.getText(sf), node.getStart(sf));
      return;
    }
    node.forEachChild(walk);
  })(sf);

  return { total, hits };
}

/** 与旧门同一套文件筛选：src 下的 .tsx，排除测试。 */
function walkTsx(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = dir + "/" + e.name;
    if (e.isDirectory()) walkTsx(p, out);
    else if (/\.tsx$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * **点名申报**"这一份 `.ts` 是对人说话的"，于是它也进这道门的账。
 *
 * 为什么不干脆全扫 `.ts`：全扫的账是 24,086 汉字 / 110 个文件，而里面 `src/i18n/strings.ts`
 * 一个文件就占 1,991 —— 那正是中文词典本体；再往下 `prompts.ts` / `appActions.ts` 是**发给模型的**，
 * `commandFactory.ts` / `presets.ts` 是出厂数据。给词典和提示词各登记一笔预算，
 * 这道门当场就没人当真了。所以反过来：谁要声称"我这里面的中文是会显示给人看的"，
 * 就把文件加进这张表，并接受预算计数 —— 加一行的成本，就是"这段话到底给谁看"这个问题必须回答一次。
 *
 * 新文件从 T3a 起走这条路（P105-F 用户裁决：拆结构化 + 按出口分别措辞）。
 */
const UI_TS = [
  "src/features/plugins/pluginUiNames.ts",
  // 市场那一面的全部话术（按钮字、空态、地址回声、出处、镜像判据）都长在这一层，
  // 组件只是把它贴上去 —— 这里漏一句中文，界面上就是漏一句中文。
  "src/features/market/marketBrowse.ts",
];

function uiTsFiles(root) {
  return UI_TS.map((rel) => root + "/" + rel);
}

/** 词典/键名那类结构检查要扫全 `src`（`.ts` + `.tsx`，排除测试）—— 与"数中文"是两回事，别混用。 */
function walkAllCode(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = dir + "/" + e.name;
    if (e.isDirectory()) walkAllCode(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

module.exports = { scanFile, walkTsx, walkAllCode, uiTsFiles, UI_TS, zhLen };
