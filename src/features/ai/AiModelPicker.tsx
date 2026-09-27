/**
 * P110-B4/B5：发送框下面那两枚选择器——**模型**与**思考强度**。
 *
 * 为什么单独一个文件：这两枚控件的真值全在 `aiProfileStore` 与 `contextBudget` 里，
 * 塞进 `AiChat`（一千多行）就没人能在一次阅读里看懂"选了之后到底发什么"。
 *
 * 思考强度**只在档案给了档位的时候出现**：这台模型没配档位 ⇒ 整枚选择器不出现。
 * 摆一枚下拉而下面没接线，就是 `aiScript` 那个"说明写着能关、实际一句没读"的假开关
 * 重演（红线 §8-34 的反面）。参数本身是档案里写死的静态对象，宿主只做浅合并，
 * 我们不为不认识的平台猜字段名（详设 §2′.7.2）。
 */
import type { AiModelProfile } from "./aiProfileStore";
import { patch, useSettings } from "../settings/settingsStore";
import { tx, useLocale } from "../../i18n/strings";
import { fmtTokens, historyCharBudget } from "../agent/contextBudget";
import { setActive, thinkingLabels, useAiProfiles } from "./aiProfileStore";

export function AiModelPicker() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const list = st.models.flatMap((model) => {
    const provider = st.providers.find((p) => p.id === model.providerId);
    return provider ? [{ model, provider }] : [];
  });
  if (!list.length) return null;
  const active = list.find((x) => x.model.id === st.activeModelId && x.provider.id === st.activeProviderId) ?? null;
  // 预算口径与仪表、chatStore 用的是同一个函数：这里显示的数必须等于实际生效的数，
  // 否则这行字只是安慰话。
  const budget = historyCharBudget(active?.model.contextTokens ?? 0, settings.aiCompactRatio);
  const levels = thinkingLabels(active?.model);
  // 设置里留着的档位名在这台模型上不存在时，实际退回档案的 defaultThinking（provider 那边同序）
  const shown = levels.includes(settings.aiThinkingLevel) ? settings.aiThinkingLevel : "";

  return (
    <div className="ai-model-picker">
      <label className="ai-model-picker-label">
        {tx("模型", "Model")}
        <select
          className="input"
          value={active?.model.id ?? ""}
          onChange={(e) => {
            const hit = list.find((x) => x.model.id === e.target.value);
            if (hit) setActive(hit.provider.id, hit.model.id);
          }}
          title={tx(
            "切换当前使用的模型。没填密钥的那一家在列表里置灰并写明原因，不是从列表里消失",
            "Switch the model in use. A provider without an API key is greyed out with the reason, not hidden from the list",
          )}
        >
          {!active && <option value="">{tx("（未选）", "(none)")}</option>}
          {list.map((x) => {
            const usable = x.provider.enabled && x.model.enabled && x.provider.baseUrl.trim().length > 0;
            return (
              <option key={`${x.provider.id}:${x.model.id}`} value={x.model.id} disabled={!usable}>
                {`${x.provider.label} · ${x.model.model} · ${fmtTokens(x.model.contextTokens)}${usable ? "" : tx("（不可用）", " (unusable)")}`}
              </option>
            );
          })}
        </select>
      </label>
      {levels.length > 0 && (
        <label className="ai-model-picker-label">
          {tx("思考强度", "Thinking")}
          <select
            className="input"
            value={shown}
            onChange={(e) => patch({ aiThinkingLevel: e.target.value })}
            title={tx(
              "档位名与每档要发的参数都写在这台模型的档案里；选「跟随模型默认」就按档案上那一档发。我们不为不认识的平台猜字段名",
              "Level names and their parameters live in this model's profile; Follow model default sends whatever the profile marks as default. We never guess field names for unknown providers",
            )}
          >
            <option value="">{tx("跟随模型默认", "Follow model default")}</option>
            {levels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        </label>
      )}
      {active && (
        <span
          className="ai-model-picker-note"
          title={tx(
            "上下文窗口 / 单次输出上限都取自档案表；历史预算按窗口乘以压缩阈值算，与仪表同一口径",
            "Context window and per-reply output cap come from the profile table; the history budget is window × compaction ratio, the same basis the meter uses",
          )}
        >
          {tx(
            `窗口 ${fmtTokens(active.model.contextTokens)} · 输出 ${fmtTokens(active.model.maxOutputTokens)} · 历史预算 ${budget} 字`,
            `window ${fmtTokens(active.model.contextTokens)} · output ${fmtTokens(active.model.maxOutputTokens)} · history budget ${budget} chars`,
          )}
        </span>
      )}
    </div>
  );
}

export type { AiModelProfile };
