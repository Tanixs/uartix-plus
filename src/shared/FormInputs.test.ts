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
});
