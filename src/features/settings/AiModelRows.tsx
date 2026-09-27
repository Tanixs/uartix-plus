/**
 * P110-B3：设置 → AI 服务 里的「模型与供应商」一节。
 *
 * 为什么单独一个文件（不是继续往 `SettingsModal` 里堆）：
 *  - `SettingsModal` 已经一千多行，再加两张表的 CRUD 就没人能在一次阅读里看完；
 *  - 更实在的原因是那条「每个 Settings 键必须在设置页有一句 patch」的守卫：
 *    阈值与手动预算的写入方搬到这里之后，`settingsSchema.test` 的 `DELEGATED_WRITERS`
 *    必须能扫到**这个文件里真的写着 `patch({`** —— 登记的前提是它真在写，不是给豁免开门。
 *
 * 旧 AI 页那五行（模板 / Key / 模型名 / 地址 / 格式）是这一节的前身：那时只有一个当前模型，
 * "改配置"就等于"改那三个标量"。档案表成型后留着它们，就是同一份数据的第二套编辑面
 * （改的还是"当前那一对"，但界面说不出它在改谁），所以撤掉。
 *
 * 试连态**不持久化**，也不叫"在线状态"：那是组件里的内存态，重启回到"未测"。
 * 做一个会自己变绿的圆点需要心跳，而这批不需要心跳，只需要"我刚点的那一下成功没有"。
 */
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AI_FORMATS,
  AI_PRESETS,
  patch,
  useSettings,
  type AiFormat,
  type AiPreset,
} from "./settingsStore";
import { aiWireArgs } from "../agent/provider";
import {
  addModel,
  addProvider,
  redactedProjection,
  removeModel,
  removeProvider,
  setActive,
  updateModel,
  updateProvider,
  useAiProfiles,
  type AiModelProfile,
  type AiProvider,
} from "../ai/aiProfileStore";
import {
  CTX_FILL_RATIO_DEFAULT,
  CTX_FILL_RATIO_MAX,
  CTX_FILL_RATIO_MIN,
} from "../agent/contextBudget";
import { t, tx, useLocale } from "../../i18n/strings";

/** 掩码回显：不编辑时不把整串密钥写进 DOM（聚焦才换回原文，与旧的那只眼睛同语义） */
function maskKey(k: string): string {
  const v = k.trim();
  if (!v) return tx("（未填）", "(empty)");
  if (v.length <= 10) return "••••";
  return `${v.slice(0, 6)}…${v.slice(-3)}`;
}

type Probe = "idle" | "testing" | "ok" | "err";

/**
 * 状态词必须**在渲染时**取。写在模块顶层就成了常量：切语言不会跟着变，
 * `useLocale` 也救不回来 —— `check-i18n` 那条"没有一句双语写在模块顶层"的门
 * 就是拦这个的（我第一版就撞上了，报错点名到 `ProviderCard`）。
 */
function probeWord(p: Probe): string {
  if (p === "ok") return tx("已连通", "connected");
  if (p === "err") return tx("失败", "failed");
  if (p === "testing") return tx("测试中…", "testing…");
  return tx("未测", "untested");
}

function ProviderCard({ p, models, activeModelId }: { p: AiProvider; models: AiModelProfile[]; activeModelId: string }) {
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<Probe>("idle");
  const [note, setNote] = useState("");
  // 删除用两步而不是原生 confirm：Tauri 里 `window.confirm` 会静默返回 false，
  // 那会让"确认"这一步看起来像"点了没反应"——比不确认更坏。
  const [armed, setArmed] = useState(false);
  const childCount = models.length;

  const test = async () => {
    if (!p.baseUrl.trim()) {
      setProbe("err");
      setNote(tx("先填服务地址", "Fill in the base URL first"));
      return;
    }
    setProbe("testing");
    setNote("");
    const t0 = Date.now();
    try {
      await invoke("ai_agent_turn", {
        reqId: crypto.randomUUID(),
        // 与真实请求同一个构造点：清洗过、字段一致，试连通过而实发失败不该由参数拼法不同引起
        ...aiWireArgs({ provider: p, model: models[0] ?? { id: "", providerId: p.id, label: "", model: "", contextTokens: 0, maxOutputTokens: 0, thinkingLevels: [], defaultThinking: "", enabled: true, createdAt: 0 } }),
        messages: [{ role: "user", content: "ping" }],
        tools: [],
      });
      setProbe("ok");
      setNote(`${Date.now() - t0}ms`);
    } catch (e) {
      setProbe("err");
      setNote(String(e).slice(0, 160));
    }
  };

  const del = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    const r = removeProvider(p.id, childCount > 0);
    if (!r.ok) {
      setProbe("err");
      setNote(tx("删除失败：档案表里一家供应商都没有会退回默认，不许多次点", "Delete refused: the table falls back to the default provider when it would be empty"));
    }
  };

  return (
    <div className="set-row">
      <label>
        {/* 标题位放"哪家 + 什么状态"，比只放名字更能说明"点它会怎样" */}
        {`${p.label} · ${probeWord(probe)}`}
      </label>
      <div className="set-ctl" style={{ flexDirection: "column", alignItems: "stretch", gap: "var(--sp-1)" }}>
        <div className="set-ctl">
          <input className="input" style={{ width: 150 }} value={p.label} title={tx("界面上叫这个名字", "Label shown in the UI")}
            onChange={(e) => updateProvider(p.id, { label: e.target.value })} />
          <select className="input" style={{ width: 90 }} value={p.format} title={tx("API 协议格式", "API protocol")}
            onChange={(e) => updateProvider(p.id, { format: e.target.value as AiFormat })}>
            {AI_FORMATS.map((f) => (
              <option key={f.key} value={f.key}>{f.label.split(" (")[0]}</option>
            ))}
          </select>
          <label className="set-inline">
            <input type="checkbox" checked={p.enabled} onChange={(e) => updateProvider(p.id, { enabled: e.target.checked })} />
            {tx("启用", "On")}
          </label>
          <button type="button" className="btn sm" disabled={probe === "testing"} onClick={() => void test()}>
            {tx("试连", "Test")}
          </button>
          <button type="button" className={`btn sm${armed ? " danger" : ""}`} onClick={del}
            title={childCount
              ? tx(`名下还有 ${childCount} 个模型：再点一次连它们一起删（不可撤销）`, `${childCount} model(s) inside: press again to delete them too (no undo)`)
              : tx("删除这家供应商", "Delete this provider")}>
            {armed ? tx("再点确认删除", "Press again to confirm") : tx("删除", "Delete")}
          </button>
        </div>
        <div className="set-ctl">
          <input className="input" style={{ flexGrow: 1 }} value={p.baseUrl} placeholder="https://api.example.com/v1"
            title={tx("服务地址（不含 /chat/completions 这类端点路径）", "Base URL, without the endpoint path")}
            onChange={(e) => updateProvider(p.id, { baseUrl: e.target.value })} />
          <input className="input" style={{ width: 200 }} type={showKey ? "text" : "password"}
            value={showKey ? p.apiKey : maskKey(p.apiKey)}
            onFocus={() => setShowKey(true)} onBlur={() => setShowKey(false)}
            onChange={(e) => updateProvider(p.id, { apiKey: e.target.value })}
            title={tx("聚焦时显示原文，失焦回到掩码", "Shows the value while focused, masks on blur")} />
        </div>
        <div className="set-ctl">
          <input className="input" style={{ width: 200 }} value={p.proxy} placeholder={tx("代理（可空）", "Proxy (optional)")}
            onChange={(e) => updateProvider(p.id, { proxy: e.target.value })} />
          <input className="input" style={{ width: 200 }} value={p.noProxy} placeholder={tx("免代理列表（可空）", "No-proxy list (optional)")}
            onChange={(e) => updateProvider(p.id, { noProxy: e.target.value })} />
        </div>
        {note && <span className="set-hint">{note}</span>}
        {models.map((m) => (
          <div className="set-ctl" key={m.id}>
            <button type="button" className="btn sm" disabled={!p.enabled || !m.enabled}
              onClick={() => setActive(m.providerId, m.id)}
              title={p.enabled && m.enabled
                ? tx("设为当前使用", "Use this model")
                : tx("先启用这家供应商和这个模型", "Enable this provider and model first")}>
              {activeModelId === m.id ? tx("使用中", "In use") : tx("选用", "Use")}
            </button>
            <input className="input" style={{ width: 200 }} value={m.model} title={tx("发给 API 的模型名", "Model id sent to the API")}
              onChange={(e) => updateModel(m.id, { model: e.target.value, label: e.target.value })} />
            <input className="input" style={{ width: 110 }} type="number" min={1024} step={1000} value={m.contextTokens}
              title={tx("上下文窗口（token）：压缩阈值和仪表的分母", "Context window in tokens: the denominator for compaction and the meter")}
              onChange={(e) => updateModel(m.id, { contextTokens: Math.max(1024, Math.round(Number(e.target.value) || 0)) })} />
            <input className="input" style={{ width: 100 }} type="number" min={256} step={1024} value={m.maxOutputTokens}
              title={tx("单次回复输出上限（宿主侧还会再钳一次）", "Per-reply output cap (the host clamps it again)")}
              onChange={(e) => updateModel(m.id, { maxOutputTokens: Math.max(256, Math.round(Number(e.target.value) || 0)) })} />
            <label className="set-inline">
              <input type="checkbox" checked={m.enabled} onChange={(e) => updateModel(m.id, { enabled: e.target.checked })} />
              {tx("启用", "On")}
            </label>
            <button type="button" className="btn sm" onClick={() => removeModel(m.id)} title={tx("删除这个模型档案", "Delete this model profile")}>
              {tx("删", "Del")}
            </button>
          </div>
        ))}
        <div className="set-ctl">
          <button type="button" className="btn sm"
            onClick={() => addModel({ providerId: p.id, model: "new-model", label: "new-model" })}>
            {tx("添加模型", "Add model")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 设置 → AI 服务 的「模型与供应商」+「当前使用」两节 */
export function AiModelSection() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const [preset, setPreset] = useState<AiPreset>("deepseek");
  const active = st.models.find((m) => m.id === st.activeModelId) ?? null;

  const add = () => {
    const tpl = AI_PRESETS[preset];
    const p = addProvider({
      label: tpl.label,
      baseUrl: tpl.baseUrl,
      apiKey: "",
      format: preset === "anthropic" ? "anthropic" : "chat",
    });
    addModel({ providerId: p.id, model: tpl.model, label: tpl.model });
  };

  return (
    <>
      <div className="set-group-title">{tx("模型与供应商", "Models & providers")}</div>
      <div className="set-row">
        <label>{tx("按模板添加供应商", "Add a provider from a template")}</label>
        <div className="set-ctl">
          <select className="input" style={{ width: 180 }} value={preset} onChange={(e) => setPreset(e.target.value as AiPreset)}>
            {(Object.keys(AI_PRESETS) as AiPreset[]).map((k) => (
              <option key={k} value={k}>{AI_PRESETS[k].label}</option>
            ))}
          </select>
          <button type="button" className="btn" onClick={add}>{tx("添加", "Add")}</button>
          <span className="set-hint">{tx("密钥、地址、格式之后都能改；模板只负责第一下别填错", "Keys and URLs stay editable — a template only saves the first round of typing")}</span>
        </div>
      </div>
      {st.providers.map((p) => (
        <ProviderCard key={p.id} p={p} models={st.models.filter((m) => m.providerId === p.id)} activeModelId={st.activeModelId} />
      ))}

      <div className="set-group-title">{tx("当前使用", "In use")}</div>
      <div className="set-row">
        <label>{tx("当前模型", "Current model")}</label>
        <div className="set-ctl">
          <select className="input" style={{ width: 260 }} value={st.activeModelId}
            onChange={(e) => {
              const m = st.models.find((x) => x.id === e.target.value);
              if (m) setActive(m.providerId, m.id);
            }}>
            {st.models.map((m) => {
              const p = st.providers.find((x) => x.id === m.providerId);
              return (
                <option key={m.id} value={m.id}>
                  {`${p?.label ?? "?"} · ${m.model} · ${Math.round(m.contextTokens / 1000)}k`}
                </option>
              );
            })}
          </select>
          <span className="set-hint">{active ? `${active.contextTokens} / ${active.maxOutputTokens}` : ""}</span>
        </div>
      </div>
      <div className="set-row">
        <label>{tx("上下文压缩阈值", "Context compaction threshold")}</label>
        <div className="set-ctl">
          <input className="input" style={{ width: 90 }} type="number"
            min={CTX_FILL_RATIO_MIN} max={CTX_FILL_RATIO_MAX} step={0.05}
            value={settings.aiCompactRatio}
            onChange={(e) => {
              const n = Number(e.target.value);
              patch({
                aiCompactRatio: Math.min(
                  CTX_FILL_RATIO_MAX,
                  Math.max(CTX_FILL_RATIO_MIN, Number.isFinite(n) ? n : CTX_FILL_RATIO_DEFAULT),
                ),
              });
            }}
          />
          <span className="set-hint">{t("set.ai.compact.tip")}</span>
        </div>
      </div>
      <div className="set-row">
        <label>{tx("手动历史预算", "Manual history budget")}</label>
        <div className="set-ctl">
          <input className="input" style={{ width: 110 }} type="number" min={0} step={1000}
            value={settings.aiHistoryOverride} disabled={settings.aiHistoryOverride === 0}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              patch({ aiHistoryOverride: Number.isFinite(n) && n > 0 ? Math.min(200_000, n) : 0 });
            }}
          />
          <button type="button" className="btn sm" disabled={settings.aiHistoryOverride === 0}
            onClick={() => patch({ aiHistoryOverride: 0 })}>
            {tx("恢复自动", "Restore auto")}
          </button>
          <span className="set-hint">{t("set.ai.history.tip")}</span>
        </div>
      </div>
      <details className="set-row">
        <summary>{tx("AI 能读到的配置投影（不含密钥）", "What the agent can read (no keys)")}</summary>
        <pre className="set-json">{JSON.stringify(redactedProjection(st), null, 2)}</pre>
      </details>
    </>
  );
}
