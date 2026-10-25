/**
 * P174-R5：把「工作区预设」与「任务模板」两类贡献项的**包内数据**读成宿主能用的东西。
 *
 * 为什么单独一个纯模块：这两条路的"读文件 + 解析 + 判形状"是可测的纯函数，
 * 而"真正换布局 / 真的填进 AI 输入框"要碰 dockview api 与 AiChat 的输入框（都在 App/AiChat 里）。
 * 把判据留在这一层，UI 只做"点一下 → 调这里 → 把结果递给总线"，两边都能测（§8-33）。
 *
 * 两条硬口径：
 * 1. **不深校验 dockview 布局**：那是 dockview 的私有格式，抄一份校验器＝第二真相；
 *    只挡"明显不是布局"的东西（复用 applyLayout.looksLikeLayoutJson 的同一判据）。
 * 2. **任务模板不执行任何东西**：它只把"目标 + 建议步骤"拼成一段话填进输入框，
 *    发不发、用哪个授权档仍是用户的决定。工具名对不对这里不判（那是模型运行期的事）。
 */
import { looksLikeLayoutJson } from "../../settings/applyLayout";

export interface PresetDoc {
  ok: boolean;
  error?: string;
  layout?: unknown;
  note?: string;
}

/** 解析一个 preset JSON：`{ layout: <dockview>, note? }`，或直接就是一份 dockview 布局本体。 */
export function parsePresetDoc(text: string): PresetDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `布局 JSON 解析失败：${String((e as Error)?.message ?? e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "布局内容不是对象" };
  const o = raw as Record<string, unknown>;
  const layout = "layout" in o ? o.layout : o;
  if (!looksLikeLayoutJson(layout)) return { ok: false, error: "这份 JSON 看着不像 dockview 布局（缺 panels/groups/grid）" };
  return { ok: true, layout, note: typeof o.note === "string" ? o.note : undefined };
}

export interface TaskStep {
  tool: string;
  args?: unknown;
  note?: string;
}
export interface TaskDoc {
  ok: boolean;
  error?: string;
  goal?: string;
  steps?: TaskStep[];
}

/** 解析一个 task JSON：`{ goal: string, steps?: [{tool,args?,note?}] }`。 */
export function parseTaskDoc(text: string): TaskDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `任务 JSON 解析失败：${String((e as Error)?.message ?? e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "任务内容不是对象" };
  const o = raw as Record<string, unknown>;
  if (typeof o.goal !== "string" || !o.goal.trim()) return { ok: false, error: "任务缺 goal（要做什么，一句话）" };
  const steps: TaskStep[] = [];
  if (Array.isArray(o.steps)) {
    for (const s of o.steps) {
      if (s && typeof s === "object" && typeof (s as { tool?: unknown }).tool === "string") {
        const rec = s as { tool: string; args?: unknown; note?: unknown };
        steps.push({ tool: rec.tool, ...(rec.args !== undefined ? { args: rec.args } : {}), ...(typeof rec.note === "string" ? { note: rec.note } : {}) });
      }
    }
  }
  return { ok: true, goal: o.goal.trim(), steps };
}

/**
 * 拼成填进 AI 输入框的那段话。末尾两句是刻意的：
 * ① 步骤是建议不是硬指令；② 写操作仍走当前授权档与批准卡——模板不是一把免批准的钥匙。
 */
export function composeTaskPrompt(t: { goal: string; steps?: TaskStep[] }, src: { pluginName: string; title: string }): string {
  const lines = (t.steps ?? []).map((s, i) => {
    const args = s.args && typeof s.args === "object" && Object.keys(s.args as object).length ? ` ${JSON.stringify(s.args)}` : "";
    return `${i + 1}. ${s.tool}${args}${s.note ? ` —— ${s.note}` : ""}`;
  });
  const parts = [`按这个任务模板来做：${t.goal}`, ""];
  if (lines.length) parts.push("建议步骤（工具名以本机实际可用为准）：", ...lines, "");
  parts.push(`模板由插件「${src.pluginName}」的「${src.title}」提供。步骤是建议不是硬指令：某步不适用就停下来问，别硬凑。`);
  parts.push("所有写操作仍按当前授权档与批准设置执行，需要批准的就照常弹卡。");
  return parts.join("\n");
}
