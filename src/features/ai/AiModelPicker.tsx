/**
 * P110-B4：发送框下面那枚**模型选择器**。
 *
 * 为什么只有模型、没有"思考强度"：思考强度要真的改变发出去的参数才算一个开关。
 * 各家下发形状不同（`reasoning_effort` / `thinking.budget_tokens` / 自定义字段），
 * 而按详设 §2′.7.2 我们要走"档案里写死的档位 + 白名单参数"那条路，宿主侧还得收
 * `extra_body` —— 那是 B5 的活。在这一批先把选择器摆上去而下面没接线，
 * 就是 `aiScript` 那个"说明写着能关、实际一句没读"的假开关重演（红线 §8-34 的反面）。
 *
 * 依赖方向：本组件只读 `aiProfileStore` 与 `settingsStore`，不引 agent/、不引 chatStore
 * （chatStore→agentRun→…→settings 那条链已经很长，UI 组件再挂上去就是给环开门）。
 */
import { tx, useLocale } from "../../i18n/strings";
import {
  fmtTokens,
  historyCharBudget,
} from "../agent/contextBudget";
import { selectableModels, setActive, useAiProfiles } from "./aiProfileStore";
import { useSettings } from "../settings/settingsStore";

/** 发送框下的模型一行：当前用哪家哪个模型 + 这一对的窗口/输出容量（数字来自档案，不手抄） */
export function AiModelPicker() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const list = selectableModels(st);
  if (!list.length) return null;
  const active = list.find((x) => x.model.id === st.activeModelId && x.provider.id === st.activeProviderId) ?? null;
  // 预算口径与 chatStore/AiChat 用的是同一个函数：这里显示的数必须等于实际生效的数，
  // 否则这行字就只是一句安慰话（详设 §2′.4 那条"仪表不许撒谎"）。
  const budget = historyCharBudget(active?.model.contextTokens ?? 0, settings.aiCompactRatio);

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
            "切换当前使用的模型；这一家没填密钥时选不了（先在这页上面补密钥）",
            "Switch the model in use. A provider without an API key can't be picked (add the key above first)",
          )}
        >
          {!active && <option value="">{tx("（未选）", "(none)")}</option>}
          {list.map((x) => (
            <option key={`${x.provider.id}:${x.model.id}`} value={x.model.id} disabled={!x.usable}>
              {`${x.provider.label} · ${x.model.model} · ${fmtTokens(x.model.contextTokens)}${x.usable ? "" : tx("（不可用）", " (unusable)")}`}
            </option>
          ))}
        </select>
      </label>
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
