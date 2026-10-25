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
