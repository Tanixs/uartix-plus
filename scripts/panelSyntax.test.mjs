/**
 * P174-A9 尾：插件面板的**脚本语法**门。
 *
 * 为什么需要它：`panel.html` 是这一套里唯一没有自动化通道的东西（宿主与 iframe 之间的
 * postMessage 只能真机看，A7 起就欠着）。但"语法错了"这一种失败最廉价也最致命——
 * 一个多余的花括号会让整个面板**一片空白**，而宿主那边只会显示"扩展面板"四个字，
 * 没有任何报错。所以至少把这一层关进判据。
 *
 * 手法与 `bootstrapSyntax.test.mjs` 一致：把 `<script>` 内容抠出来交给真的 `node --check`，
 * 再带一条反向夹具说明这个检查不是永真的。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const dir = mkdtempSync(path.join(tmpdir(), "uartix-panel-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** 抽最后一个 `<script>` 块（面板的代码在最后；前面的都是数据无关的）。 */
function scriptOf(html) {
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  return m ? m[1] : "";
}

function check(code) {
  const f = path.join(dir, `p${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(f, code, "utf8");
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    return "";
  } catch (e) {
    return String(e.stderr || e.message).slice(0, 400);
  }
}

describe("P174-A9 · 面板脚本语法", () => {
  const panels = [
    ["YOLO 工作台", path.join(ROOT, "plugins", "uartix.yolo", "panel.html")],
    ["示例扩展", path.join(ROOT, "examples", "plugins", "uartix.hello", "panel.html")],
  ];

  for (const [name, file] of panels) {
    it(`${name}：panel.html 里的脚本能被 node 解析`, () => {
      const html = readFileSync(file, "utf8");
      const code = scriptOf(html);
      // 抽不出来也算失败：说明模板被改成了 `<script type=module>` 之类，
      // 那时这个门会静默变成"检查了一个空字符串"——这正是最该防的假绿
      expect(code.length, `${file} 里没抽到 <script> 块`).toBeGreaterThan(200);
      expect(check(code)).toBe("");
    });
  }

  it("反向夹具：少一个右花括号必须被抓到（门不是永真的）", () => {
    expect(check("function a(){ if (1) { return 1; }\n")).not.toBe("");
  });
});

/* ============================================================================
   P175 · 勾选框的排版不变量
   ----------------------------------------------------------------------------
   面板的全局样式是 `label { display:flex; flex-direction:column }`（表单标题要在控件上方），
   而 `input { width:100% }`。两条叠在一起，任何"框 + 同一行那句说明"的写法都会变成
   **框在上、字在下**——监控页的「自动刷新（5 秒）」就是这么歪的，而且只在截图里看得见。
   所以把这条形状钉住：带 checkbox 的 label 必须走 `bool` 那一档。
   ============================================================================ */

describe("P175 · 勾选框的排版不变量", () => {
  const YOLO_PANEL = path.join(ROOT, "plugins", "uartix.yolo", "panel.html");

  /** 找出所有"里面有 checkbox、但没声明横排"的 label。 */
  function badCheckboxLabels(html) {
    const out = [];
    const re = /<label\b([^>]*)>([\s\S]*?)<\/label>/g;
    let m;
    while ((m = re.exec(html))) {
      if (!/type=["']checkbox["']/.test(m[2])) continue;
      if (/\bbool\b/.test(m[1])) continue;
      if (/flex-direction\s*:\s*row/.test(m[1])) continue;
      out.push(m[0].replace(/\s+/g, " ").slice(0, 90));
    }
    return out;
  }

  it("每个带勾选框的 label 都是横排的（bool 档或显式 flex-direction:row）", () => {
    const html = readFileSync(YOLO_PANEL, "utf8");
    const bad = badCheckboxLabels(html);
    expect(bad, `这些勾选框会被全局 label 竖排：\n${bad.join("\n")}`).toEqual([]);
    // 反向自证：这条判据不是永真的
    expect(badCheckboxLabels('<label><input type="checkbox" /> 自动刷新</label>')).toHaveLength(1);
    expect(badCheckboxLabels('<label class="p bool"><input type="checkbox" /> 自动刷新</label>')).toEqual([]);
  });

  it("checkbox 不许继承 input 的 width:100%", () => {
    const css = readFileSync(YOLO_PANEL, "utf8");
    expect(css).toMatch(/input\[type="checkbox"\]\s*\{[^}]*width:\s*auto/);
  });
});
