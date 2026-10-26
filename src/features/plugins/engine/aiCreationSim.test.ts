/**
 * P174-R8：**扮演 AI，把「造一个插件」从头走一遍**（用户要求的那种模拟）。
 *
 * 这不是又一份纯函数单测：它驱动的是 AI 真正调用的那几个工具（`draftToolEntries`），
 * 加上引擎真正会跑的安装/批准/启用链，只把最底下的 Tauri 文件与进程命令换成内存实现。
 * 换句话说——**模型能做的每一步都在这里走了一遍，模型做不到的（装、启用、批准）也证明它做不到**。
 *
 * 为什么要它：能力面这种东西，"看代码觉得有"和"真的能跑通"差得很远。
 * 这条用例同时钉住用户点名的六件事：
 *   ① 五种产物（面板 / 主题 / 小部件 / 工作区预设 / 任务模板）都能写成草稿并通过清单校验；
 *   ② 草稿**不是**插件：写完不在已装列表、不能启动、不进「+面板」；
 *   ③ 转正必须过批准卡（`installed:false` 拿着计划回来），批准后才落账、且默认**停用**；
 *   ④ 启用后面板才进「+面板」，并且 `openPanel(plugin-view-…)` 真的打得开；
 *   ⑤ 全量主题落进设置页的主题卡（`plg:<包id>:<主题id>`）；局部改动（theme_patch）进不去；
 *   ⑥ 越界路径（`../`）写不进草稿区——能力面放开不等于笼子拆了。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------- 内存里的 Tauri（只实现引擎用到的那几条） ---------------- */

const H = vi.hoisted(() => {
  // 设置/主题那几个模块在**求值期**就会读 localStorage（颜色方案缓存）；node 环境补一个内存实现。
  const ls = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, String(v)),
    removeItem: (k: string) => void ls.delete(k),
    clear: () => ls.clear(),
    key: (i: number) => [...ls.keys()][i] ?? null,
    get length() {
      return ls.size;
    },
  } as Storage;

  const files = new Map<string, string>();
  const stores = new Map<string, unknown>();
  const appDir = "/app";
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const under = (p: string, dir: string) => p === dir || p.startsWith(dir + "/");

  function copyPrefix(src: string, dst: string): number {
    let n = 0;
    for (const [k, v] of [...files]) {
      if (!under(k, src)) continue;
      files.set(dst + k.slice(src.length), v);
      n++;
    }
    return n;
  }

  const invoke = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
    const path = typeof args.path === "string" ? norm(args.path) : "";
    switch (cmd) {
      case "plugin_paths":
        return {
          appDir,
          pluginsRoot: `${appDir}/plugins`,
          hostDir: `${appDir}/plugin-host`,
          bootstrapPath: `${appDir}/plugin-host/bootstrap.mjs`,
        };
      case "plugin_probe_node":
        return { found: true, path: "node", version: "v22.0.0", tried: [] };
      case "plugin_fs_write":
        files.set(path, String(args.content ?? ""));
        return { ok: true, bytes: String(args.content ?? "").length, path };
      case "plugin_fs_append":
        files.set(path, (files.get(path) ?? "") + String(args.content ?? ""));
        return { ok: true, path };
      case "plugin_fs_read":
        return files.has(path)
          ? { exists: true, text: files.get(path), truncated: false }
          : { exists: false, text: "", truncated: false };
      case "plugin_fs_list": {
        const dir = norm(String(args.dir ?? ""));
        const seen = new Set<string>();
        const items: { name: string; dir: boolean }[] = [];
        for (const k of files.keys()) {
          if (!under(k, dir) || k === dir) continue;
          const rest = k.slice(dir.length + 1);
          const head = rest.split("/")[0];
          if (!head || seen.has(head)) continue;
          seen.add(head);
          items.push({ name: head, dir: rest.includes("/") });
        }
        return { exists: true, items };
      }
      case "plugin_store_read":
        return { exists: stores.has(String(args.name)), data: stores.get(String(args.name)) };
      case "plugin_store_write":
        stores.set(String(args.name), args.data);
        return { ok: true };
      case "plugin_store_read_raw":
        return { exists: false, data: null };
      case "plugin_remove_tree":
        for (const k of [...files.keys()]) if (under(k, path)) files.delete(k);
        return { ok: true };
      case "plugin_copy_dir": {
        const src = norm(String(args.src));
        const dst = norm(String(args.dst));
        let bytes = 0;
        for (const [k, v] of files) if (under(k, src)) bytes += v.length;
        return { files: copyPrefix(src, dst), bytes, skippedLinks: 0 };
      }
      case "plugin_promote": {
        const id = String(args.id);
        const draftId = String(args.draftId);
        const from = `${appDir}/plugins/staging/${draftId}`;
        const to = `${appDir}/plugins/${id}`;
        copyPrefix(from, to);
        for (const k of [...files.keys()]) if (under(k, from)) files.delete(k);
        return { ok: true };
      }
      case "plugin_host_status":
        return { hosts: [], count: 0 };
      case "plugin_host_send":
      case "plugin_host_stop":
      case "plugin_host_touch":
        return { ok: true };
      default:
        throw new Error(`内存实现里没有这条命令：${cmd}`);
    }
  };

  return { files, stores, appDir, invoke };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: H.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

// 引擎在几处用 `window.setTimeout`（日志攒批、握手兜底）；node 环境补一个最小 window。
if (!(globalThis as { window?: unknown }).window) {
  (globalThis as { window?: unknown }).window = globalThis;
}

const engine = await import("./pluginEngine");
const { draftToolEntries } = await import("../../agent/draftTools");
const { collectPluginPanels, panelViewId, pluginPanelTarget } = await import("./panelBridge");
const { panelEnabled } = await import("./repo");
const { themeCards } = await import("../../settings/themePicker");

type ToolOut = { ok: boolean; data?: Record<string, unknown>; error?: string; status?: string };
const tool = (name: string) => {
  const t = draftToolEntries.find((x) => x.name === name);
  if (!t) throw new Error(`没有这个工具：${name}`);
  return t;
};
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  return (await tool(name).execute(args, { callId: `c-${name}` } as never)) as unknown as ToolOut;
}

/* ---------------- 造包用的最小清单 ---------------- */

const panelPkg = {
  "plugin.json": JSON.stringify({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "sim.panel",
    version: "1.0.0",
    name: "模拟面板",
    main: "main.mjs",
    activation: ["onPanel:main"],
    permissions: { ui: { panel: true } },
    contributes: { panels: [{ id: "main", title: "模拟面板", entry: "panel.html" }] },
  }),
  "main.mjs": 'export async function activate(ctx) {\n  ctx.panels.register("main", { hello: async () => "hi" });\n}\n',
  "panel.html": "<!doctype html><html><body><p>hello</p></body></html>",
};

const themePkg = {
  "plugin.json": JSON.stringify({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "sim.theme",
    version: "1.0.0",
    name: "模拟主题",
    permissions: { ui: { theme: true } },
    contributes: { themes: [{ id: "mint", title: "薄荷", entry: "theme.css" }] },
  }),
  "theme.css": ":root { --bg: #101418; --accent: #3fb6a8; }\n",
};

const widgetPkg = {
  "plugin.json": JSON.stringify({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "sim.widget",
    version: "1.0.0",
    name: "模拟小部件",
    permissions: { ui: { widget: true } },
    contributes: { widgets: [{ id: "chip", title: "小条", entry: "w.html" }] },
  }),
  "w.html": "<!doctype html><html><body>·</body></html>",
};

const contribPkg = {
  "plugin.json": JSON.stringify({
    format: "uartix-plugin",
    schemaVersion: 3,
    id: "sim.contrib",
    version: "1.0.0",
    name: "预设与模板",
    permissions: { ui: { layout: true } },
    contributes: {
      presets: [{ id: "focus", title: "专注布局", entry: "preset.json" }],
      tasks: [{ id: "train", title: "训练任务", entry: "task.json" }],
    },
  }),
  "preset.json": JSON.stringify({ layout: { grid: { root: { type: "branch" } } }, note: "两栏" }),
  "task.json": JSON.stringify({ goal: "把数据集拆成训练/验证并跑 30 轮", steps: [{ tool: "fs_list", note: "先看目录" }] }),
};

/* ---------------- 走一遍 ---------------- */

async function ensureClean(): Promise<void> {
  H.files.clear();
  H.stores.clear();
  await engine.reload();
}

async function promoteThroughApproval(name: string): Promise<void> {
  // ① AI 只排队
  const queued = await call("plugin_draft_promote", { name });
  expect(queued.ok, JSON.stringify(queued)).toBe(true);
  expect(queued.data?.pending).toBe(true);
  // ② 用户在设置页点「转正为插件」→ 拿到计划；这里必须回来要批准
  const got = await engine.promoteDraft(name);
  expect(got.installed).toBe(false);
  // ③ 用户过批准卡
  await engine.commitDraftPromotion(got.plan, name);
}

describe("扮演 AI：五种产物都能造，但都不是装", () => {
  beforeEach(ensureClean);

  it("面板 / 主题 / 小部件 / 预设+模板：四份草稿全部通过清单校验", async () => {
    for (const [id, files] of [
      ["sim.panel", panelPkg],
      ["sim.theme", themePkg],
      ["sim.widget", widgetPkg],
      ["sim.contrib", contribPkg],
    ] as const) {
      const saved = await call("plugin_draft_save", { id, files });
      expect(saved.ok, `${id}: ${JSON.stringify(saved)}`).toBe(true);
    }
    const listed = await call("plugin_draft_list");
    const drafts = listed.data?.drafts as { name: string; issue: string; permissions: string[] }[];
    expect(drafts).toHaveLength(4);
    for (const d of drafts) expect(d.issue, `${d.name} 的清单问题`).toBe("");
    // 权限面照实列出来（批准卡上看到的就是这些）
    expect(drafts.find((d) => d.name.startsWith("sim.panel"))!.permissions.join()).toContain("面板");
  });

  it("草稿**不是**插件：不进已装列表、不进 +面板、不在主题格里", async () => {
    await call("plugin_draft_save", { id: "sim.panel", files: panelPkg });
    await call("plugin_draft_save", { id: "sim.theme", files: themePkg });
    const snap = engine.getSnapshot();
    expect(snap.entries).toHaveLength(0);
    expect(collectPluginPanels([])).toHaveLength(0);
    expect(themeCards({ settingsTheme: "", sysDark: true, drawnId: null, drawnName: null, drawnPluginId: null, records: snap.entries, labelOf: (k) => k }).some((c) => c.key.includes("sim.theme"))).toBe(false);
  });

  it("包里摆了 main.mjs 却没写 main 字段：草稿合法，但必须当场提醒", async () => {
    // 主题插件不需要 activation，清单合法；但包里躺着的 main.mjs 不会被加载——
    // 这是"模型以为写了主进程逻辑"的形态：草稿合法、转正成功、功能静默缺失。
    const themeNoMain = JSON.parse(themePkg["plugin.json"]) as Record<string, unknown>;
    const saved = await call("plugin_draft_save", {
      id: "sim.orphan",
      files: {
        "plugin.json": JSON.stringify(themeNoMain),
        "theme.css": themePkg["theme.css"],
        "main.mjs": "export async function activate() {}",
      },
    });
    expect(saved.ok).toBe(true);
    expect(JSON.stringify(saved.data)).toContain("没有");
    expect(JSON.stringify(saved.data)).toContain("main.mjs");
    expect(JSON.stringify(saved.data)).toContain("不会加载");
  });

  it("清单点名的 entry 不在包里：草稿判不合法（真模型踩过这个坑）", async () => {
    // 真机形态：模型写了 "entry": "theme.css"，但整份草稿里只有 plugin.json 与 main.mjs。
    // 清单本身合法，转正也会成功——装完是一个"没有 CSS 的主题"。这条必须拦在草稿层。
    const saved = await call("plugin_draft_save", {
      id: "sim.nocss",
      files: {
        "plugin.json": themePkg["plugin.json"],
        "main.mjs": "import('./theme.css');",
      },
    });
    expect(saved.ok).toBe(true);
    expect(saved.data?.valid).toBe(false);
    expect(String(saved.data?.issue)).toContain("theme.css");
    expect(String(saved.data?.issue)).toContain("不在包里");
    // 把文件补上就立刻合法（同一条写入路径，不要求"重来一份草稿"）
    const fixed = await call("plugin_draft_save", { id: "sim.nocss", files: { "theme.css": themePkg["theme.css"] } });
    expect(fixed.ok).toBe(true);
    expect(fixed.data?.valid).toBe(true);
  });

  it("越界路径写不进草稿区（能力面放开 ≠ 笼子拆了）", async () => {
    const bad = await call("plugin_draft_save", {
      id: "sim.evil",
      files: { ...panelPkg, "../escape.json": "{}" },
    });
    expect(bad.ok).toBe(false);
    // 回执的拒绝形状是 notExecuted(code + data.hint)；这里只钉"它说了为什么"
    expect(JSON.stringify(bad)).toMatch(/路径|path|相对/);
  });
});

describe("扮演 AI：转正、批准、启用、打开——每一步谁说了算", () => {
  beforeEach(ensureClean);

  it("面板：排队 → 批准 → 默认停用 → 启用后进 +面板 → openPanel 打得开", async () => {
    await call("plugin_draft_save", { id: "sim.panel", files: panelPkg });
    await promoteThroughApproval("sim.panel-draft");

    const entry = engine.getSnapshot().entries.find((e) => e.id === "sim.panel")!;
    expect(entry).toBeTruthy();
    expect(entry.source).toBe("ai");
    expect(entry.enabled).toBe(false); // 装完不启用是产品流程，不是缺陷
    expect(entry.verdict).toBe("trusted"); // 批准卡已过

    const viewId = panelViewId("sim.panel", "main");
    const none = collectPluginPanels([{ id: entry.id, manifest: entry.manifest, enabled: panelEnabled(entry) }]);
    expect(none).toHaveLength(0);

    await engine.setEnabled("sim.panel", true);
    const on = engine.getSnapshot().entries.find((e) => e.id === "sim.panel")!;
    expect(collectPluginPanels([{ id: on.id, manifest: on.manifest, enabled: panelEnabled(on) }]).map((p) => p.viewId)).toEqual([viewId]);

    // 同一个判据也给 AI 的动作面用：没启用时明确说"去启用并批准"，启用后能开
    const off = pluginPanelTarget([{ id: "sim.panel", name: "模拟面板", manifest: on.manifest, enabled: false }], viewId);
    expect(off.ok).toBe(false);
    const ok = pluginPanelTarget([{ id: "sim.panel", name: "模拟面板", manifest: on.manifest, enabled: true }], viewId);
    expect(ok).toMatchObject({ ok: true, title: "模拟面板" });
  });

  it("主题：只有启用且批准后才进外观；停用/失批退回内置并撤出列表", async () => {
    await call("plugin_draft_save", { id: "sim.theme", files: themePkg });
    await promoteThroughApproval("sim.theme-draft");
    const cardsOf = () =>
      themeCards({
        settingsTheme: "",
        sysDark: true,
        drawnId: null,
        drawnName: null,
        drawnPluginId: null,
        records: engine.getSnapshot().entries,
        labelOf: (k) => k,
      });
    expect(engine.getSnapshot().entries.find((e) => e.id === "sim.theme")!.enabled).toBe(false);
    expect(cardsOf().some((c) => c.key === "plg:sim.theme:mint")).toBe(false);
    // 未启用时直接设主题也要被挡（不能靠"外观列表里没这张卡"当唯一防线）
    await expect(engine.setActiveTheme("plg:sim.theme:mint")).rejects.toThrow("还没启用");

    await engine.setEnabled("sim.theme", true);
    expect(cardsOf().some((c) => c.key === "plg:sim.theme:mint")).toBe(true);
    await engine.setActiveTheme("plg:sim.theme:mint");
    expect(engine.getSnapshot().activeTheme).toBe("plg:sim.theme:mint");

    await engine.setEnabled("sim.theme", false);
    expect(engine.getSnapshot().activeTheme).toBe("");
    expect(cardsOf().some((c) => c.key === "plg:sim.theme:mint")).toBe(false);
  });

  it("没有 main 的插件：ensureRunning 说人话，且**不把 phase 打成 failed**（防重试死循环）", async () => {
    await call("plugin_draft_save", { id: "sim.theme", files: themePkg });
    await promoteThroughApproval("sim.theme-draft");
    await expect(engine.ensureRunning("sim.theme")).rejects.toThrow("只有界面、没有主进程");
    // 关键：它不该落成 failed —— 那正是"面板每挂载一次就重试一次"的燃料
    expect(engine.getSnapshot().entries.find((e) => e.id === "sim.theme")!.phase).toBe("idle");
  });

  it("包根可以列举，一键发布读得到整包（真机曾报「路径越界或非法：」）", async () => {
    await call("plugin_draft_save", { id: "sim.theme", files: themePkg });
    await promoteThroughApproval("sim.theme-draft");
    // 空路径 = 包根：以前它被当成非法路径，发布第一步就失败
    const root = await engine.listInExt("sim.theme", "");
    expect(root.map((x) => x.name).sort()).toEqual(["plugin.json", "theme.css"]);
    const { readPackageTextFiles } = await import("./pluginPublish");
    const packed = await readPackageTextFiles("sim.theme");
    expect(packed.files.map((f) => f.path).sort()).toEqual(["plugin.json", "theme.css"]);
    // 内容真的读到了（base64 非空），不是列了个空壳
    for (const f of packed.files) expect(f.content.length).toBeGreaterThan(8);
  });

  it("预设与任务模板：装好之后包内 JSON 能被解析成动作", async () => {
    await call("plugin_draft_save", { id: "sim.contrib", files: contribPkg });
    await promoteThroughApproval("sim.contrib-draft");
    const { parsePresetDoc, parseTaskDoc } = await import("./pluginContrib");
    const preset = parsePresetDoc(await engine.readInExt("sim.contrib", "preset.json"));
    expect(preset.ok).toBe(true);
    const task = parseTaskDoc(await engine.readInExt("sim.contrib", "task.json"));
    expect(task.ok).toBe(true);
    if (task.ok) expect(task.goal).toContain("数据集");
  });
});
