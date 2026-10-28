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

  /**
   * 训练页的分层：52 项平铺在一个网格里等于没有主次（用户 2026-10-28 的原话：
   * "每个项目都是一长条，没有主次，很多参数设置项不是经常用"）。判据钉住三件事：
   * 主卡与核心数字各有落点、其余参数必须以 `<details>` 折叠、常改的六项在核心名单里。
   */
  it("训练页必须分层：主卡 / 核心数字 / 其余折叠", () => {
    const html = readFileSync(YOLO_PANEL, "utf8");
    for (const id of ["c_primary", "c_core", "c_adv"]) {
      expect(html, `训练页缺容器 #${id}`).toContain(`id="${id}"`);
    }
    expect(html, "高级参数必须用 details 折叠").toMatch(/<details class="advgrp"/);
    const core = /var TRAIN_CORE = \[([^\]]*)\]/.exec(html);
    expect(core, "找不到 TRAIN_CORE 名单").toBeTruthy();
    const coreList = core ? core[1] : "";
    for (const k of ["epochs", "imgsz", "batch", "device", "patience", "name"]) {
      expect(coreList, `核心数字里少了 ${k}`).toContain(`"${k}"`);
    }
    // 反向自证：把一项塞进核心就会从高级里消失 —— 名字只许出现在名单里一次
    expect(html.split('"weights"').length - 1, "weights 该在主卡，不该同时出现在别处").toBeLessThan(6);
  });
});

/* ============================================================================
   P175 · 同名函数不许出现两次
   ----------------------------------------------------------------------------
   面板是**一个非 module 的 `<script>`**，同名函数声明后者会静默盖掉前者 —— 端到端试用时
   就是这么把「概览 · 训练记录」整张表弄成空白的（`renderRuns` 被实验页那份同名函数盖了），
   语法门是绿的、页面也不报错，只有真数据能照出来。我自己新加的 `num()` 也撞过一次
   （撞的是"按 id 读数字输入框"那个），会把保存数据集的数值悄悄变成 NaN。
   ============================================================================ */

describe("P175 · 面板里不许有同名函数", () => {
  const files = [
    path.join(ROOT, "plugins", "uartix.yolo", "panel.html"),
    path.join(ROOT, "plugins", "uartix.yolo", "main.mjs"),
  ];

  for (const file of files) {
    it(`${path.basename(path.dirname(file))}/${path.basename(file)}：函数名不重复`, () => {
      const src = readFileSync(file, "utf8");
      const names = [...src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
      const count = {};
      for (const n of names) count[n] = (count[n] || 0) + 1;
      const dup = Object.entries(count).filter(([, v]) => v > 1);
      expect(names.length, `${file} 里一个函数声明都没扫到，这条判据是空的`).toBeGreaterThan(5);
      expect(dup, `同名函数会被后者静默盖掉：${JSON.stringify(dup)}`).toEqual([]);
    });
  }

  it("反向自证：同名函数必须被扫出来", () => {
    const src = "function a(){}\nfunction a(){}\nfunction b(){}";
    const names = [...src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual(["a"]);
  });
});
