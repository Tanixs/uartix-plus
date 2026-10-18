/**
 * P155-E · 空态与自适应的形状钉（详设 `docs/designs/P155-界面观感打磨-详设.md` §E）。
 *
 * 三条都来自活体实测的真重叠：表格空槽宿主 0 高（骑表头）、TX 空态宿主含工具条（面板一矮必骑）、
 * 短宿主里 `center` 两头溢出。手法同 settingsShell.test.ts：读源码文本钉"接线形状"，
 * "看上去对不对"归验收截图（截图在 .tmp/p155-*.png）。
 */
import { describe, expect, it } from "vitest";
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
const CSS = read("styles/theme.css");
const TABLE = read("features/table/DataTable.tsx");
const SB = read("features/send/SendBuildPanel.tsx");

/** 同 settingsShell.test.ts 的 bodyOfRule：按「选择器 + 空格 + {」定位，只认真的规则头 */
function bodyOfRule(sel: string): string {
  const at = CSS.indexOf(`${sel} {`);
  expect(at, `theme.css 里找不到规则 ${sel} {`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

describe("P155-E · 空态不再骑工具条", () => {
  it("全局加固：宿主再矮也是顶对齐裁切（safe center + overflow hidden）", () => {
    const body = bodyOfRule(".empty-state");
    expect(body, "溢出时不再退回顶对齐（safe center 被换回 center 就是旧行为）").toContain("justify-content: safe center");
    expect(body, "没把溢出关在宿主内").toContain("overflow: hidden");
  });

  it("表格空槽：包含块是 .tbl-scroll，top 由组件行内给 HEADER_H", () => {
    expect(bodyOfRule(".tbl-scroll"), "滚动区没建包含块").toContain("position: relative");
    const slot = bodyOfRule(".tbl-empty-slot");
    expect(slot, "旧写法 top:40px 回来了（inner 无行时那是负高）").not.toContain("top: 40px");
    expect(slot).toContain("bottom: 0");
    expect(TABLE, "空槽没挂在滚动区/没走 HEADER_H 同一出处").toContain('<div className="tbl-empty-slot" style={{ top: HEADER_H }}>');
  });

  it("TX组帧台：空态住在 .sb-bar 之下的内容宿主里", () => {
    expect(SB, "空态宿主不见了（宿主含工具条时 320px 以下必骑）").toContain('<div className="sb-empty">');
    expect(CSS.replace(/\s+/g, ""), ".sb-empty 规则不在").toContain(".sb-empty{flex:1;min-height:0;position:relative;}");
  });

  it("顺手项：面包屑是 ›（? 是早年转码事故，别让它漂回来）", () => {
    expect(SB, "面包屑仍写着 ?").not.toContain("协议 ? 发送谱");
    expect(SB, "面包屑没改成 ›").toContain("去 协议 › 发送谱 新建");
  });
});
