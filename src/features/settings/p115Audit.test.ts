/**
 * P115 审计批的形状钉（批次 B/C/D 落在 settings/mcp 面上的那部分）。
 *
 * 手法同 P114-A/B：没有 RTL，钉的是**接线形状**——每条都对应一个已实锤的缺陷，
 * 摘掉修复形状这条就该红（证伪记录见批次报告）。个别纯函数（jobStateText）
 * 直接驱动取值，比钉源码更硬。
 */
import { describe, expect, it, vi } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as { readFileSync: (p: string, e?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");

/**
 * 剥注释再断言（§8-41④：源码守卫只能看代码不能看注释）。反向钉尤其要剥——
 * 修复说明注释里必然复述旧写法的形状，不剥就把"解释自己为什么被删"误判成"又回来了"。
 * `//` 前一位排除 `:` 以免吃掉字符串里的 `https://`。
 */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/([^:])\/\/[^\n]*/g, "$1");

const PAGE = "features/settings/ModelSettingsPage.tsx";
const MODAL = "features/settings/SettingsModal.tsx";

/* F18 行为级取值：先桩 localStorage（jobExecutor 求值期经 settingsStore 读它），再载模块。
   import 必须在模块顶层 await——放进 describe 回调里就不是顶层了（esbuild 直接拒）。 */
const backing = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, v),
  removeItem: (k: string) => void backing.delete(k),
});
const { jobStateText } = await import("../mcp/jobExecutor");

describe("P115-B · Esc 级联与回执归属", () => {
  it("F5：设置页 Esc 守卫豁免 .ui-dropdown（⋯ 菜单开着时 Esc 只收菜单）", () => {
    expect(read(MODAL)).toMatch(/\[role="listbox"\], \.ui-dropdown/);
  });

  it("F17：切页签清空回执横幅（回执属于触发它的那一页，§8-53）", () => {
    const src = read(MODAL);
    const at = src.indexOf("setTab(x.key)");
    expect(at, "切页调用不见了").toBeGreaterThan(-1);
    expect(src.slice(at - 80, at + 80), "setTab 没有伴随 setMsg(\"\")").toContain('setMsg("")');
  });
});

describe("P115-A/D · 模型设置页的面", () => {
  it("F4：历史预算输入框永远可编辑（旧写法值为 0 时连框带钮一起锁死）", () => {
    const src = read(PAGE);
    expect(src, "输入框又被 disabled 焊死了").not.toContain("value={settings.aiHistoryOverride} disabled=");
    expect(src, "空值要显「自动」placeholder").toMatch(/placeholder=\{tx\("自动", "auto"\)\}/);
    // 「恢复自动」只在已是 0 时禁用（这条形状必须保留：非 0 时得有路回自动）
    expect(src).toMatch(/disabled=\{settings\.aiHistoryOverride === 0\}/);
  });

  it("F7：刷新回执分层——密钥被接受 / 清单取回 · 端点可达，不再替没验过的密钥背书", () => {
    const src = read(PAGE);
    expect(src).toContain("密钥被接受");
    expect(src).toContain("清单取回 · 端点可达");
    expect(code(PAGE), "「密钥有效」又回来了：GET /models 的 200 证明不了密钥").not.toContain("密钥有效");
  });

  it("F8：远端清单带 {baseUrl, format} 快照，快照不符不再当 fresh", () => {
    const src = read(PAGE);
    expect(src).toMatch(/interface RemoteCatalog/);
    expect(src).toMatch(/catalog\.baseUrl === provider\.baseUrl\.trim\(\) && catalog\.format === provider\.format/);
    // 旧形状：清单只按 provider.id 存 id 数组，改地址后照显旧清单
    expect(src, "清单又退回按 id 裸存（无地址快照）").not.toMatch(/\[provider\.id\]: ids\b/);
  });

  it("F14：Probe 有 blocked 态，点色与 tip 走穷举 Record（§8-35①），缺钥匙两处同一句", () => {
    const src = read(PAGE);
    expect(src).toMatch(/type Probe = "idle" \| "testing" \| "ok" \| "err" \| "blocked"/);
    expect(src).toMatch(/const PROBE_DOT: Record<Probe, string>/);
    expect(src).toMatch(/Record<Exclude<Probe, "idle">, \{ cls: string; tip: string \}>/);
    expect((src.match(/noKeyNote\(\)/g) ?? []).length, "缺钥匙的解释必须两处同源").toBeGreaterThanOrEqual(3);
  });

  it("F19：逐模型测试补了空 baseUrl 预检（与供应商级同句）", () => {
    const src = read(PAGE);
    expect(src, "空地址预检又只剩供应商级一处了").toContain('tx("先填服务地址", "Fill in the base URL first")');
  });

  it("F9/F10：编辑弹窗 portal 到 body + Esc 真关 + 悬空默认档在保存时被拦", () => {
    const src = read(PAGE);
    expect(src, "弹窗没 portal 到 body（§20）").toMatch(/createPortal\(/);
    expect(src).toMatch(/,\s*document\.body,\s*\n\s*\);/);
    expect(src, "Esc 处理不见了（旧写法是 stopPropagation 吞键的死桩）").toMatch(/document\.addEventListener\("keydown", onKey, true\)/);
    expect(code(PAGE)).not.toContain('onKeyDown={(e) => e.stopPropagation()}');
    expect(src, "悬空 defaultThinking 的校验不见了").toContain("dangling");
    expect(src).toContain("再按一次「保存」确认");
  });

  it("F15：删除供应商走 cascade=false 的两段明说；够不着的 ExtPage 死行已删", () => {
    const src = read(PAGE);
    expect(src, "又把 models.length 当 cascade 传回去了").toMatch(/removeProvider\(provider\.id, false\)/);
    expect(src).not.toMatch(/removeProvider\(provider\.id, models\.length > 0\)/);
    expect(src, "首次点击的拒绝提示不见了").toContain("先删除或移走它们");
    expect(code(MODAL), "外层三元已经拦截插件页，这行永远渲染不到").not.toMatch(/\{tab === SETTINGS_TAB_PLUGINS && <ExtPage \/>\}/);
  });

  it("F16：AI 页「测试连接」整行删除（含 helper 与 ai_agent_turn ping）", () => {
    const src = read(MODAL);
    expect(src).not.toContain("AiConnTestRow");
    expect(src).not.toContain("classifyConnError");
    expect(src, "设置页不再直接 invoke ai_agent_turn（试连都住在模型设置页）").not.toContain('"ai_agent_turn"');
    expect(src, "slice(80) 式截断（F1 的垃圾文案源头）不许在任何设置残余里回来").not.toMatch(/e\.slice\(0, 80\)/);
  });
});

describe("P115-D · F18 任务状态中文化（行为级）", () => {
  it("八个状态各有中文说法（对齐 bridge_jobs.rs 状态机），未知码原样回显", () => {
    expect(jobStateText("queued")).toBe("已排队");
    expect(jobStateText("running")).toBe("执行中");
    expect(jobStateText("cancel_requested")).toBe("停止中");
    expect(jobStateText("succeeded")).toBe("已完成");
    expect(jobStateText("failed")).toBe("失败");
    expect(jobStateText("cancelled")).toBe("已取消");
    expect(jobStateText("timed_out")).toBe("已超时");
    expect(jobStateText("interrupted")).toBe("已中断");
    expect(jobStateText("some_future_state")).toBe("some_future_state");
  });

  it("两处消费点都接了 jobStateText；审计行 OK/ERR 也说了人话", () => {
    expect(read(MODAL)).toContain("jobStateText(jobRow.state)");
    expect(read("features/mcp/JobDetails.tsx")).toContain("jobStateText(e.state)");
    expect(read(MODAL), "审计行又在裸显 OK/ERR").not.toMatch(/\{a\.ok \? "OK" : "ERR"\}/);
  });
});

describe("P115-E · 插件卡图标 / 工作区药丸 / 窄窗兜底 / 令牌化", () => {
  it("F20：类型图标按固定优先级取，未知 kind 落「更多」而不是插头", () => {
    const src = code("features/plugins/PluginLibraryDialog.tsx");
    expect(src).toMatch(/const KIND_ICON: Record<import\("\.\/artifact"\)\.ArtifactKind, \(\) => ReactElement>/);
    expect(src.indexOf('"theme", "panel", "widget"'), "优先级表不见了（又退回 kinds[0] 看运气）").toBeGreaterThan(-1);
    expect(src).not.toMatch(/const one = kinds\[0\]/);
    expect(src).toMatch(/hit \? KIND_ICON\[hit\] : IconMore/);
  });

  it("F21：工作区药丸挂 shared/Dropdown（portal+Esc+焦点归还），不再自写 mousedown 关闭", () => {
    const src = code("shell/TopBars.tsx");
    expect(src).toMatch(/<Dropdown anchor=\{btnRef\.current\} open=\{open\} onClose=\{\(\) => setOpen\(false\)\} className="cb-ws-menu">/);
    expect(src, "自写的 mousedown-outside 又回来了").not.toContain('window.addEventListener("mousedown"');
    expect(src, "inline absolute 弹层又回来了（§20）").not.toMatch(/className="tb-menu cb-ws-menu"/);
  });

  it("F23：窄窗兜底——胶囊可收缩 + 药丸图标档 + 700/900 两档 media", () => {
    const css = read("styles/theme.css");
    const capAt = css.indexOf(".cb-capsule {");
    const capBody = css.slice(capAt, css.indexOf("}", capAt));
    expect(capBody, "胶囊又退回不可收缩（flex 默认 min-width=内容宽）").toMatch(/flex: 0 1 auto/);
    expect(capBody).toMatch(/min-width: 0/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{\s*\.cb-capsule \{ max-width: 150px; \}/);
    expect(css).toMatch(/@media \(max-width: 700px\) \{\s*\.cb-capsule \{ max-width: 96px; \}\s*\.cb-ws-label \{ display: none; \}/);
  });

  it("F22：五个十六进制字面量家族归令牌；新令牌进 contrast 门", () => {
    const css = read("styles/theme.css");
    expect(css).toContain("color: var(--on-danger, #fff) !important;");
    for (const hex of ["#e07b1f", "#e0a030", "#d8863b"]) {
      // 命中行排除注释与 :root 的令牌定义本身（「一处定义」正住在那里）
      const inRule = css.split("\n").filter((l) =>
        l.includes(hex)
        && !/^\s*(\*|\/\*|--)/.test(l.trim())
        && !l.includes("P115-F22")
        && !l.includes("此前")
        && !l.includes("归到"),
      );
      expect(inRule, `${hex} 的字面量规则还在（应归 --warn-fg）`).toEqual([]);
    }
    expect(css).toMatch(/background: var\(--k-keypad\);/);
    expect(css).toMatch(/color: var\(--k-keypad-ink\);/);
    const gate = read("../.tools/check-contrast.cjs");
    expect(gate).toContain('"--on-danger"');
    expect(gate).toMatch(/keypad-ink\/keypad/);
  });
});
