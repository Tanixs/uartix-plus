/**
 * P124-A · `FormRow` 的结构钉。
 *
 * 为什么用"读源文本"而不是渲染断言：这个仓库没有组件渲染测试基座（`*.test.ts` 全是纯函数与
 * 源码形状两类），而为一条 CSS 选择器关系去装一套 jsdom 渲染栈不划算。`checksums.test.ts`
 * 早就开了这个先例：钉的是"代码长什么样"，因为错的正是形状。
 *
 * 这条测试要防的事故是真实发生过的：`FormRow` 第一版把标签写成 `<span>`，
 * 而样式只挂在 `.form-row > label` 上，`body` 又不设字号 ⇒ tx 侧行标签退回浏览器默认 16px，
 * rx 侧是 12px，同一个属性页里两种字号（用户原话"字体为什么有的那么大，一点也不统一"）。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string | URL, enc?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};
const SRC = readFileSync(fileURLToPath(new URL("./FormInputs.tsx", import.meta.url)), "utf8");
const THEME = readFileSync(fileURLToPath(new URL("./../styles/theme.css", import.meta.url)), "utf8");

describe("P124-A · FormRow 必须落在被样式命中的那个元素上", () => {
  it("行外层是 div.form-row，标签是 <label>（不是 span）", () => {
    const body = /export function FormRow[\s\S]*?\n}/.exec(SRC)?.[0] ?? "";
    expect(body, "FormRow 找不到了（改名或搬走时记得同步这条钉）").toBeTruthy();
    expect(body).toContain('<div className="form-row">');
    expect(body).toContain("<label");
    expect(body, "<span> 当标签就没人管字号：body 不设 font-size，会退回 16px").not.toContain("<span>{props.label}</span>");
  });

  it("CSS 里那条规则确实只认 label —— 这正是上面那条存在的原因", () => {
    const rule = /\.form-row > label\s*\{([^}]*)\}/.exec(THEME)?.[1] ?? "";
    expect(rule, ".form-row > label 这条规则不见了：那两边字号又会各走各的").toContain("font-size: var(--fs-sm)");
    expect(THEME, "body 一旦设了 font-size，这条钉的前提就变了（改它时把上面那条一起重新想）").toMatch(/body\s*\{[^}]*\}/);
    const bodyRule = /body\s*\{[^}]*\}/.exec(THEME)?.[0] ?? "";
    expect(bodyRule).not.toContain("font-size");
  });

  it("参数列表用卡（props-item），不再把一堆行平铺在一起", () => {
    const insp = readFileSync(
      fileURLToPath(new URL("./../features/inspector/SendFieldInspector.tsx", import.meta.url)),
      "utf8",
    );
    expect(insp).toContain('className={`props-item');
    expect(insp, "参数又变回全平铺就是没分级").toContain("props-item-body");
    expect(insp, "折叠框只该留给校验与派生").toContain('<Section title={tx("校验"');
    expect(insp).not.toContain('<Section title={tx("参数"');
    expect(insp).not.toContain('<Section title={tx("发送块"');
  });

  /**
   * P125 · 页头一行 + 说明的三级归位。
   *
   * 钉的是两条已经付过学费的规则，不是口味：
   *  1. 页头。面包屑（谱名 › 块名）和标题「发送块」是两行同字号同灰色的字，中间不留白 ⇒
   *     用户看到的是"两行字贴在一起"。现在回到帧画布那块的老形状：`.props-title` 一行，
   *     里面是返回键 + 色点 + 「对象 · 名」，`insp-crumb` 那套类连 CSS 一起删了。
   *  2. `.props-hint` 是**整页空态**的样式（`padding:20px` + 居中），不是行内说明。
   *     上一版把它当行内说明用了 8 处，每一处都长成一个居中的大块 —— 那些话现在要么进
   *     行尾的问号（HelpHint），要么走 `.form-hint`（左对齐、跟着表单列缩进）。
   *     整页空态只留一处：谱被删了。多出来的那条就是有人又把空态样式当说明用。
   */
  it("页头只剩一行；行内说明不再借用整页空态那套样式", () => {
    const insp = readFileSync(
      fileURLToPath(new URL("./../features/inspector/SendFieldInspector.tsx", import.meta.url)),
      "utf8",
    );
    expect(insp, "面包屑回来了：它会和标题叠成两行").not.toContain("insp-crumb");
    expect(THEME, "面包屑那套类没人用了还留着，就是等着下一个人误用").not.toContain(".insp-crumb");
    expect(insp).toContain('className="props-title"');
    expect(insp).toContain('className="back-btn"');
    const emptyish = insp.match(/className="props-hint"/g) ?? [];
    expect(emptyish, ".props-hint 只许用在整页空态那一处").toHaveLength(1);
    expect(insp).toContain('className="form-hint"');
    expect(insp, "参数分层的行内口径也该收进问号").toContain('className="props-section"');
  });

  /**
   * P126-A · 参数那层"删得掉"。
   *
   * 为什么钉这条而不是钉长相：`sendStore.removeParam` 带着 `usedBy` 守卫、单测也覆盖了，
   * 但界面上**一个调用方都没有** —— 于是"值来源切一次参数就长一条"这件事只有加没有减，
   * 孤儿参数堆在卡列表里改名都嫌烦。这种缺口不会自己响：store 说"我支持删"，
   * 界面说"我什么都没得删"，两边各自都成立。所以钉的是"这条链路真的接上了"。
   */
  it("参数删除走 store 那道 usedBy 守卫，不在界面另算一遍谁在用", () => {
    const insp = readFileSync(
      fileURLToPath(new URL("./../features/inspector/SendFieldInspector.tsx", import.meta.url)),
      "utf8",
    );
    expect(insp, "删除入口又没了：参数表只能长不能收").toContain("sendStore.removeParam(");
    expect(insp, "点名话术要用 store 算出来的 usedBy，界面不许自己扫一遍 fields").toContain("r.usedBy");
    expect(insp).toContain("删掉这个参数");
    expect(insp, "守卫不通过时必须说明是谁还在用，不能静默").toContain("删不掉");
  });

  /**
   * P127-A · `enum` 进了类型表，就必须同时有填它的地方。
   *
   * 这条钉的是两者**一起存在**这个关系，不是长相。历史上 `enum` 被故意从类型下拉里排除，
   * 理由写得很清楚："档位表还没有编辑入口，给一个选了却没法填的选项就是假开关"（§8-34）。
   * 以后谁把 `enum` 加回类型表却没配入口 —— 或者反过来把入口删了留着类型 —— 都是回到那扇门。
   * 规格串的解析规则本身有五条单测在 `sendTypes.test.ts`（含"坏条目与同名档交回界面点名"）。
   */
  it("enum 可选 ⇔ 有档位表可填：两头必须同时在场", () => {
    const insp = readFileSync(
      fileURLToPath(new URL("./../features/inspector/SendFieldInspector.tsx", import.meta.url)),
      "utf8",
    );
    expect(insp, "类型表里请了 enum，却没把档位表请回来 ⇒ 假开关").toContain('"enum"');
    expect(insp, "档位表的入口没了：选了 enum 就没法填").toContain("parseEnumSpec(");
    expect(insp).toContain('label={tx("档位表"');
    expect(insp, "拒收时不许把框子留在被拒的那句话上（话和框得说同一件事）").toContain("enumNonce");
  });

  /**
   * P126-B · 行尾的问号不许站在 form-pair 外面。
   *
   * 这条钉的是一个**我自己在 P125 里造成的**缺陷，而且是实测出来的：属性面板 263px 宽时，
   * 「范围」「覆盖起 / 止」两行高 45px / 53px —— 问号掉到了第二排。原因在换行判定用的是
   * 基准宽而不是可缩宽：`.form-row` 是 `flex-wrap:wrap`，`.form-pair.grow` 是 `flex:1 1 130px`，
   * 于是 56 + 130 + 13 + 两个 gap ≈ 215 > 213 ⇒ 那一项整个被推到下一行，
   * 哪怕它其实缩得下去。把问号放进 form-pair 里就绕开了：一个 flex 项，不参与换行计数。
   *
   * 钉形状而不是钉像素：这个仓库没有渲染测试基座，而错的那个东西就是形状。
   */
  it("成对输入框那行，问号在 form-pair 里面（否则窄面板里它掉第二排）", () => {
    const insp = readFileSync(
      fileURLToPath(new URL("./../features/inspector/SendFieldInspector.tsx", import.meta.url)),
      "utf8",
    );
    /**
     * 按 span 深度找每个 `form-pair grow` 那一项的闭合处，再看紧跟其后的是不是问号。
     * 不这么写就会误判：一条扁平正则的 lazy `[\s\S]*?</span>` 能一路吃过别的行的 span
     * （档位那行就正好是 `<span className="sb-hint">…</span>` + 问号，那是合法的），
     * 于是钉住的是"下一个 span 后面有没有问号"这种和形状无关的东西。
     */
    const open = /<span className="form-pair grow">/g;
    let m: RegExpExecArray | null;
    let checked = 0;
    while ((m = open.exec(insp))) {
      let depth = 1;
      const tag = /<\/?span\b/g;
      tag.lastIndex = m.index + m[0].length;
      let t: RegExpExecArray | null;
      let closeAt = -1;
      while ((t = tag.exec(insp))) {
        depth += t[0][1] === "/" ? -1 : 1;
        if (depth === 0) {
          closeAt = t.index;
          break;
        }
      }
      expect(closeAt, `第 ${m.index} 行起的那个 form-pair 没有闭合`).toBeGreaterThan(0);
      const after = insp.slice(closeAt + 7, closeAt + 400).replace(/^\s*(?:\{\/\*[\s\S]*?\*\/\s*)?/, "");
      expect(
        after.startsWith("<HelpHint"),
        "问号站到 form-pair 外面了：窄属性面板里它会掉到第二排（实测 263px 宽时行高从 24 变 45）",
      ).toBe(false);
      checked++;
    }
    expect(checked, "一个 form-pair grow 都没找到：这一面的结构整个变了，这条钉该重新想").toBeGreaterThan(0);
  });
});
