/**
 * P174-R5：把「工作区预设」「任务模板」两类贡献项接到宿主动作上。
 *
 * 这里只做"读包内文件 → 交给纯判据（pluginContrib）→ 递给宿主的既有出口"，
 * 三个重模块（appBus / chatStore / settingsStore）一律**动态 import**：
 * 它们在求值期会摸 localStorage / 拉整条 UI 图，静态挂进插件引擎就会把老环焊回来（§8-33）。
 * 换布局的执行权只在 App（dockview api 不出 App），这里也只发 `requestApplyLayout`，不碰 api。
 */
import { readInExt, type InstalledPlugin } from "./pluginEngine";
import { parsePresetDoc, parseTaskDoc, composeTaskPrompt } from "./pluginContrib";
import type { PluginPresetDecl, PluginTaskDecl } from "./manifest";

export interface HostActionResult {
  ok: boolean;
  msg: string;
}

/** 应用一枚工作区预设：读包内 JSON → 校验像布局 → 走宿主的 applyLayout（换前自动备份当前布局）。 */
export async function applyPluginPreset(plugin: InstalledPlugin, decl: PluginPresetDecl): Promise<HostActionResult> {
  let text: string;
  try {
    text = await readInExt(plugin.id, decl.entry);
  } catch (e) {
    return { ok: false, msg: `读不出布局文件（${decl.entry}）：${String((e as Error)?.message ?? e)}` };
  }
  const doc = parsePresetDoc(text);
  if (!doc.ok || !doc.layout) return { ok: false, msg: doc.error ?? "布局内容不合法" };
  const { requestApplyLayout } = await import("../../ai/appBus");
  return await new Promise<HostActionResult>((resolve) => {
    requestApplyLayout(doc.layout, (err) => {
      resolve(err
        ? { ok: false, msg: err }
        : { ok: true, msg: `已应用工作区预设「${decl.title}」（换前的布局已存进 设置 → 工作区 的自动备份槽）` });
    });
  });
}

/** 载入一个任务模板：读包内 JSON → 拼成一段话 → 填进 AI 输入框并打开助手面板。**不代发**。 */
export async function loadPluginTask(plugin: InstalledPlugin, decl: PluginTaskDecl): Promise<HostActionResult> {
  let text: string;
  try {
    text = await readInExt(plugin.id, decl.entry);
  } catch (e) {
    return { ok: false, msg: `读不出任务文件（${decl.entry}）：${String((e as Error)?.message ?? e)}` };
  }
  const doc = parseTaskDoc(text);
  if (!doc.ok || !doc.goal) return { ok: false, msg: doc.error ?? "任务内容不合法" };
  const prompt = composeTaskPrompt({ goal: doc.goal, steps: doc.steps }, { pluginName: plugin.manifest.name, title: decl.title });
  const [{ pushDraft }, { requestOpenPanel }] = await Promise.all([
    import("../../ai/chatStore"),
    import("../../ai/appBus"),
  ]);
  pushDraft(prompt);
  requestOpenPanel("ai");
  return { ok: true, msg: `已把「${decl.title}」填进 AI 助手输入框（只填不发送：发不发、用哪个授权档由你决定）` };
}
