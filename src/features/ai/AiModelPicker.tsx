/**
 * P111-E：发送框那枚**模型 chip**（照 Qoder 的 `Qwen3.8-Flash 极高`）。
 *
 * 它替代 P110-B4 那一带标签的下拉：常驻区原来写着
 * `模型 [DeepSeek · deepseek-v4-pro · 128k] 窗口 128k · 输出 8k · 历史预算 153600 字`
 * —— 一行里三处文字、两个分隔符族，用户判"好乱，干嘛整这么多字"。
 * 现在常驻只有模型名本身；档案数字与切换列表都收进点开的那一面，
 * 因为"我正在跟谁说话"是每句都要看的，"窗口多大"不是。
 *
 * 两件事没变：
 *  - 不可用的那一家**置灰留在列表里**并写明原因，不隐藏（隐藏会让人以为配置丢了）；
 *  - 思考强度只在档案给了档位时出现（没接线却摆一枚下拉就是假开关，红线 §8-34 的反面）。
 */
import { useRef, useState } from "react";
import { Dropdown } from "../../shared/Dropdown";
import { IconChevron } from "../../shared/icons";
import { invokeOpenSettings } from "./aiBus";
import { patch, useSettings } from "../settings/settingsStore";
import { fmtTokens } from "../agent/contextBudget";
import { setActive, thinkingLabels, useAiProfiles } from "./aiProfileStore";
import { tx, useLocale } from "../../i18n/strings";

export function AiModelChip() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const list = st.models.flatMap((model) => {
    const provider = st.providers.find((p) => p.id === model.providerId);
    return provider ? [{ model, provider }] : [];
  });
  if (!list.length) return null;
  const active = list.find((x) => x.model.id === st.activeModelId && x.provider.id === st.activeProviderId) ?? null;
  const usable = !!active && active.provider.enabled && active.model.enabled && active.provider.baseUrl.trim().length > 0;
  const levels = thinkingLabels(active?.model);
  // 设置里留着的档位名在这台模型上不存在时，实际退回档案的 defaultThinking（provider 那边同序）
  const shown = levels.includes(settings.aiThinkingLevel) ? settings.aiThinkingLevel : "";

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`ai-model-chip${usable ? "" : " warn"}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={active
          ? tx(`${active.provider.label} · ${active.model.model} · 窗口 ${fmtTokens(active.model.contextTokens)} · 输出 ${fmtTokens(active.model.maxOutputTokens)}`,
              `${active.provider.label} · ${active.model.model} · window ${fmtTokens(active.model.contextTokens)} · output ${fmtTokens(active.model.maxOutputTokens)}`)
          : tx("还没有可用的模型档案", "No model profile is usable yet")}
      >
        {/* 圆点说"能不能发"，文字说"发给谁"，档位说"它会怎么想"——三件事三种视觉通道 */}
        <span className={`ai-chip-dot${usable ? "" : active ? " warn" : " err"}`} aria-hidden="true" />
        <span className="ai-chip-name">{active?.model.model ?? tx("选模型", "Pick a model")}</span>
        {shown && <span className="ai-chip-level">{shown}</span>}
        <IconChevron dir="up" size={12} />
      </button>
      <Dropdown anchor={btnRef.current} open={open} onClose={() => setOpen(false)} align="end">
        <div className="ai-chip-pop">
          <div className="ai-chip-pop-title">{tx("模型", "Model")}</div>
          {list.map((x) => {
            const ok = x.provider.enabled && x.model.enabled && x.provider.baseUrl.trim().length > 0;
            const on = active?.model.id === x.model.id && active?.provider.id === x.provider.id;
            return (
              <button
                key={`${x.provider.id}:${x.model.id}`}
                type="button"
                role="menuitem"
                className={`ai-chip-opt${on ? " on" : ""}`}
                disabled={!ok}
                title={ok ? undefined : tx("这家还没填密钥或已停用——先补配置再选", "This one has no key or is off — configure it first")}
                onClick={() => {
                  setActive(x.provider.id, x.model.id);
                  setOpen(false);
                }}
              >
                <span className="ai-chip-opt-name">{x.model.model}</span>
                <span className="ai-chip-opt-meta">{`${x.provider.label} · ${fmtTokens(x.model.contextTokens)}`}</span>
                {!ok && <span className="ai-chip-opt-warn">{tx("未配置", "unset")}</span>}
              </button>
            );
          })}
          {levels.length > 0 && (
            <div className="ai-chip-levels">
              <span className="ai-chip-pop-title">{tx("思考强度", "Thinking")}</span>
              <div className="ai-chip-level-row">
                <button type="button" className={`btn sm${shown === "" ? " on" : ""}`} onClick={() => patch({ aiThinkingLevel: "" })}>
                  {tx("跟随默认", "Default")}
                </button>
                {levels.map((l) => (
                  <button key={l} type="button" className={`btn sm${shown === l ? " on" : ""}`} onClick={() => patch({ aiThinkingLevel: l })}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="ai-chip-foot">
            <button type="button" className="ai-chip-link" onClick={() => { setOpen(false); invokeOpenSettings("model"); }}>
              {tx("模型设置…", "Model settings…")}
            </button>
          </div>
        </div>
      </Dropdown>
    </>
  );
}
