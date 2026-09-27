/**
 * P111-C 起、P112-B 对齐 ZCode 的「模型设置」页：中列挑供应商，右列改这一家。
 *
 * 为什么从"一行摊着 16 个控件"改成这样（用户判 P110-B3 不合格的第一现场）：
 *  - 旧形状实测 674px 宽 × 195px 高，把"看"和"改"挤在同一处，谁都不是主角；
 *  - 供应商/模型是一对多的清单，清单的通形就是左列选、右列改（ZCode / GitHub 设置同形）；
 *  - ZCode 的模型行平时只有一行（名字 + 徽标 + 四个动作），字段点「编辑」才展开——
 *    这才是那面看起来清爽的原因，而不是它字少。
 *
 * 两处刻意不同步的东西：
 *  - **试连态**是这一页的内存态，切走就没了。它不叫"在线状态"：常绿需要心跳，
 *    这一页只需要"我刚点那一下成功没有"（P110-B3 同口径）。
 *  - **哪一行在编辑**也是内存态，换供应商就清空——留着会让用户以为编辑的是另一家的模型。
 */
import { useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../../shared/Dropdown";
import { HelpHint } from "../../shared/HelpHint";
import { SetRow } from "../../shared/SetRow";
import { Listbox } from "../../shared/Listbox";
import { IconEdit, IconMore, IconPlus, IconRefresh, IconTarget, IconTrash } from "../../shared/icons";
import { AI_FORMATS, AI_PRESETS, patch, useSettings, type AiFormat, type AiPreset } from "./settingsStore";
import { guessContextTokens, listModels, missingFrom } from "../ai/modelCatalog";
import { aiWireArgs } from "../agent/provider";
import {
  addModel,
  addProvider,
  keyHintFor,
  removeModel,
  removeProvider,
  setActive,
  thinkingLabels,
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
  fmtTokens,
  historyCharBudget,
} from "../agent/contextBudget";
import { t, tx, useLocale } from "../../i18n/strings";

type Probe = "idle" | "testing" | "ok" | "err";

/** 中列那个点：几种说法各对应一件真事，不是一根装饰线 */
function dotOf(p: AiProvider, probe: Probe, modelCount: number): { cls: string; tip: string } {
  if (probe === "ok") return { cls: "ok", tip: tx("上次试连通过（本页内的记忆，重启回到未测）", "Last test passed (kept only while this page is open)") };
  if (probe === "err") return { cls: "err", tip: tx("上次试连失败", "Last test failed") };
  if (probe === "testing") return { cls: "run", tip: tx("正在试连…", "Testing…") };
  if (!p.enabled) return { cls: "off", tip: tx("这家已停用", "This provider is switched off") };
  if (!p.baseUrl.trim()) return { cls: "warn", tip: tx("还没有服务地址", "No base URL yet") };
  if (modelCount === 0) return { cls: "warn", tip: tx("这家下面一个模型都没有，选不到也发不出", "No model under this provider, so nothing can be sent") };
  return { cls: "idle", tip: tx("未测", "Untested") };
}

/**
 * 密钥回显。P111-C 修掉一处双掩码：旧代码 `type="password"` 与掩码串叠着写，
 * 于是 maskKey 精心留出的头 6 尾 3 被圆点全盖掉 —— 那段是死代码。
 * 现在未聚焦时是**文本**（看得见头尾，用来判断"这格装的到底是哪把 key"），
 * 聚焦才换成原文可编辑。中间值不出现，出境仍只有 `aiWireArgs` 一处。
 */
function maskKey(k: string): string {
  const v = k.trim();
  if (!v) return "";
  if (v.length <= 10) return "•••••";
  return `${v.slice(0, 6)}…${v.slice(-3)}`;
}

/** 竖排字段：label 在上、控件通栏 —— ZCode 那一面的表单形状，比左标签右控件更能撑开宽度 */
function Field({ label, tip, children }: { label: string; tip?: string; children: React.ReactNode }) {
  return (
    <div className="msp-field">
      <span className="msp-field-label">
        {label}
        {/* 说明走那颗「?」气泡（SetRow 同一族原语），不写成长句摊在字段下面 */}
        {tip && <HelpHint text={tip} />}
      </span>
      {children}
    </div>
  );
}

/** 一个模型档案行：平时一行，点编辑才展开字段（ZCode 的清爽来自这里，不是字少） */
function ModelRow({
  m, provider, isActive, editing, onEdit,
}: {
  m: AiModelProfile; provider: AiProvider; isActive: boolean; editing: boolean; onEdit: (v: boolean) => void;
}) {
  const [probe, setProbe] = useState<"idle" | "run" | "ok" | "err">("idle");
  const [note, setNote] = useState("");
  const [armed, setArmed] = useState(false);
  const levels = thinkingLabels(m);

  /**
   * 逐模型「测试」发一次真请求（max output 收到最小）。
   * 它必须花钱：清单接口能证明"这家通不通"，证明不了"这个模型答不答"。
   * 供应商级那个 `↻` 仍然是免费的 GET，两件事两个入口。
   */
  const test = async () => {
    setProbe("run");
    setNote("");
    const t0 = Date.now();
    try {
      await invoke("ai_chat", {
        reqId: `probe-${crypto.randomUUID()}`,
        ...aiWireArgs({ provider, model: m }),
        temperature: m.temperature ?? 0,
        messages: [{ role: "user", content: "ping" }],
        thinking: false,
        maxTokens: 16,
      });
      setProbe("ok");
      setNote(`${Date.now() - t0}ms`);
    } catch (e) {
      setProbe("err");
      setNote(String(e).slice(0, 120));
    }
  };

  return (
    <div className={`msp-mrow${isActive ? " on" : ""}${editing ? " open" : ""}`}>
      <div className="msp-mline">
        <span className="msp-mname" title={m.model}>{m.model || tx("（空名）", "(empty)")}</span>
        <span className="msp-badge">{fmtTokens(m.contextTokens)}</span>
        {m.vision && <span className="msp-badge">{tx("视觉", "vision")}</span>}
        {!m.enabled && <span className="msp-moff">{tx("已停用", "off")}</span>}
        <span className="msp-macts">
          <button type="button" className="msp-ibtn" onClick={() => void test()} disabled={probe === "run"}
            aria-label={tx("测试这个模型", "Test this model")}
            title={tx("发一次真请求问它答不答（会消耗少量额度）；供应商级的 ↻ 才是免费的", "Sends one real request to see whether this model answers (costs a little); the provider-level refresh is the free one")}>
            <IconTarget />
          </button>
          <button type="button" className={`msp-ibtn${editing ? " on" : ""}`} onClick={() => onEdit(!editing)}
            aria-label={tx("编辑这个模型", "Edit this model")}
            title={tx("改窗口、输出上限与思考档位", "Change the window, output cap and thinking levels")}>
            <IconEdit />
          </button>
          <button type="button" className={`msp-ibtn danger${armed ? " on" : ""}`}
            aria-label={tx("删除这个模型", "Delete this model")}
            title={armed ? tx("再点一次确认删除（不可撤销）", "Press again to delete (no undo)") : tx("删除这个模型档案", "Delete this model profile")}
            onClick={() => { if (!armed) { setArmed(true); return; } removeModel(m.id); }}>
            <IconTrash />
          </button>
          <label className="set-switch" title={tx("启用后它才出现在发送框那枚模型钮里", "Only enabled models show up in the composer chip")}>
            <input type="checkbox" aria-label={tx("启用这个模型", "Enable this model")} checked={m.enabled} onChange={(e) => updateModel(m.id, { enabled: e.target.checked })} />
            <span />
          </label>
        </span>
      </div>
      {(probe !== "idle" || editing) && (
        <div className="msp-med">
          {editing && (
            <>
              <label className="msp-med-field">
                {tx("上下文窗口", "Context window")}
                <input className="input" type="number" min={1024} step={1000} value={m.contextTokens}
                  onChange={(e) => updateModel(m.id, { contextTokens: Math.max(1024, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <label className="msp-med-field">
                {tx("单次输出上限", "Max output")}
                <input className="input" type="number" min={256} step={1024} value={m.maxOutputTokens}
                  title={tx("宿主侧还会再钳一次", "The host clamps it again")}
                  onChange={(e) => updateModel(m.id, { maxOutputTokens: Math.max(256, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <label className="msp-med-check">
                <input type="checkbox" checked={!!m.vision} onChange={(e) => updateModel(m.id, { vision: e.target.checked })} />
                {tx("支持视觉", "Accepts images")}
              </label>
              <button type="button" className="btn sm" disabled={!provider.enabled || !m.enabled || isActive}
                onClick={() => setActive(m.providerId, m.id)}>
                {isActive ? tx("使用中", "In use") : tx("设为当前", "Use")}
              </button>
              {levels.length > 0 && (
                <span className="msp-med-note">
                  {tx(`思考档位 ${levels.join(" / ")}，默认 ${m.defaultThinking || tx("无", "none")}`, `thinking levels ${levels.join(" / ")}, default ${m.defaultThinking || "none"}`)}
                </span>
              )}
            </>
          )}
          {note && <span className="set-hint">{probe === "ok" ? tx(`已应答 · ${note}`, `answered · ${note}`) : probe === "err" ? tx(`失败：${note}`, `failed: ${note}`) : tx("测试中…", "testing…")}</span>}
        </div>
      )}
    </div>
  );
}

export function ModelSettingsPage() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const [sel, setSel] = useState<string>(st.providers[0]?.id ?? "");
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [remote, setRemote] = useState<Record<string, string[] | null>>({});
  const [armed, setArmed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<string>("");
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const modelsOf = (id: string) => st.models.filter((m) => m.providerId === id);
  // 选中的那家被删掉了要落到别处，否则右列指着空气。档案表保证至少留一家，
  // 所以这里没有"一家都没有"的空态分支（那是到不了的代码）。
  const provider = st.providers.find((p) => p.id === sel) ?? st.providers[0];
  const models = modelsOf(provider.id);
  const probe: Probe = probes[provider.id] ?? "idle";
  const note = notes[provider.id] ?? "";
  const remoteIds = remote[provider.id] ?? null;
  const fresh = remoteIds ? missingFrom(remoteIds, models.map((m) => m.model)) : [];

  const templateOptions = useMemo(
    () =>
      (Object.keys(AI_PRESETS) as AiPreset[]).map((k) => ({
        value: k,
        label: AI_PRESETS[k].label,
        note: AI_PRESETS[k].baseUrl.replace(/^https:\/\//, ""),
      })),
    [],
  );

  const addFromTemplate = (key: string) => {
    const tpl = AI_PRESETS[key as AiPreset];
    const p = addProvider({
      label: tpl.label,
      baseUrl: tpl.baseUrl,
      apiKey: "",
      format: (key as AiPreset) === "anthropic" ? "anthropic" : "chat",
    });
    addModel({ providerId: p.id, model: tpl.model, label: tpl.model });
    setSel(p.id);
    setAddOpen(false);
  };

  /** 供应商级试连 = 拉一次模型清单（P111-D），不花 token */
  const test = async () => {
    if (!provider.baseUrl.trim()) {
      setProbes((s) => ({ ...s, [provider.id]: "err" }));
      setNotes((s) => ({ ...s, [provider.id]: tx("先填服务地址", "Fill in the base URL first") }));
      return;
    }
    setProbes((s) => ({ ...s, [provider.id]: "testing" }));
    setNotes((s) => ({ ...s, [provider.id]: "" }));
    const t0 = Date.now();
    try {
      const ids = await listModels(provider);
      const ms = Date.now() - t0;
      setRemote((s) => ({ ...s, [provider.id]: ids }));
      setProbes((s) => ({ ...s, [provider.id]: "ok" }));
      setNotes((s) => ({
        ...s,
        [provider.id]: ids.length
          ? tx(`已连通 · ${ms}ms · 清单 ${ids.length} 个`, `connected · ${ms}ms · ${ids.length} listed`)
          : tx("已连通 · 这家不提供模型列表（可以自己填）", "connected · no model list here (fill names by hand)"),
      }));
    } catch (e) {
      setProbes((s) => ({ ...s, [provider.id]: "err" }));
      setNotes((s) => ({ ...s, [provider.id]: String(e).slice(0, 160) }));
    }
  };

  const importModel = (id: string) => {
    const guessed = guessContextTokens(id);
    addModel({
      providerId: provider.id,
      model: id,
      label: id,
      ...(guessed ? { contextTokens: guessed } : {}),
    });
    setRemote((s) => ({ ...s, [provider.id]: (s[provider.id] ?? []).filter((x) => x !== id) }));
  };

  const del = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    const r = removeProvider(provider.id, models.length > 0);
    setArmed(false);
    setMenuOpen(false);
    if (!r.ok) {
      setNotes((s) => ({ ...s, [provider.id]: r.reason ?? tx("删除被拒绝", "Delete refused") }));
      return;
    }
    const next = st.providers.find((p) => p.id !== provider.id);
    setSel(next?.id ?? "");
  };

  const activeModel = st.models.find((m) => m.id === st.activeModelId) ?? null;

  return (
    <div className="msp">
      <aside className="msp-list">
        <div className="msp-list-head">
          <span className="msp-list-title">{tx("供应商", "Providers")}</span>
          <span className="msp-list-acts">
            <button type="button" className="msp-ibtn" onClick={() => void test()} disabled={probe === "testing"}
              aria-label={tx("刷新模型清单", "Refresh the model list")}
              title={tx("拉一次 /models：免费（不消耗额度），顺带证明连得通", "Fetch /models — free, and it proves the connection too")}>
              <IconRefresh />
            </button>
            <button ref={addBtnRef} className="btn sm primary" onClick={() => setAddOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={addOpen}>
              <IconPlus />
              {tx("添加供应商", "Add provider")}
            </button>
          </span>
        </div>
        {st.providers.map((p) => {
          const n = modelsOf(p.id).length;
          const d = dotOf(p, probes[p.id] ?? "idle", n);
          return (
            <button key={p.id} type="button" className={`msp-row${provider.id === p.id ? " on" : ""}`}
              onClick={() => { setSel(p.id); setArmed(false); setEditing(""); }}>
              <span className={`msp-dot ${d.cls}`} title={d.tip} aria-hidden="true" />
              <span className="msp-name">{p.label}</span>
              <span className="msp-count">{n}</span>
            </button>
          );
        })}
        <Listbox
          anchorRef={addBtnRef}
          open={addOpen}
          onClose={() => setAddOpen(false)}
          ariaLabel={tx("按模板添加供应商", "Add a provider from a template")}
          value={null}
          options={templateOptions}
          onSelect={addFromTemplate}
        />
      </aside>

      <section className="msp-detail">
        <div className="msp-card">
          <div className="msp-card-head">
            <input className="msp-title-input" value={provider.label} aria-label={tx("供应商名称", "Provider name")}
              title={tx("界面上叫这个名字，不参与请求", "The name shown in the UI; never sent")}
              onChange={(e) => updateProvider(provider.id, { label: e.target.value })} />
            <label className="set-switch" title={tx("停用后它在模型选择器里置灰，不是消失", "Switching off greys it out in the picker; it does not vanish")}>
              <input type="checkbox" aria-label={tx("启用这家", "Enable this provider")} checked={provider.enabled}
                onChange={(e) => updateProvider(provider.id, { enabled: e.target.checked })} />
              <span />
            </label>
            <button ref={menuBtnRef} type="button" className="msp-ibtn" onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu" aria-expanded={menuOpen} aria-label={tx("更多操作", "More actions")}>
              <IconMore />
            </button>
            <Dropdown anchor={menuBtnRef.current} open={menuOpen} onClose={() => setMenuOpen(false)} align="end">
              <button type="button" role="menuitem" className="ai-scene-menu-item danger" onClick={del}>
                {armed
                  ? tx(`再点确认删除（名下 ${models.length} 个模型一起删，不可撤销）`, `Press again to delete (${models.length} model(s) go too; no undo)`)
                  : tx("删除这家供应商", "Delete this provider")}
              </button>
            </Dropdown>
          </div>
          <Field label="Base URL" tip={tx("不含 /chat/completions 这类端点路径", "Without the endpoint path")}>
            <input className="input" value={provider.baseUrl} placeholder="https://api.example.com/v1"
              onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })} />
          </Field>
          <Field label={tx("API 格式", "API format")} tip={tx("决定请求体怎么拼、端点路径是哪一条", "Chooses the request shape and the endpoint path")}>
            <select className="input" value={provider.format}
              onChange={(e) => updateProvider(provider.id, { format: e.target.value as AiFormat })}>
              {AI_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="API Key" tip={tx("聚焦时换成原文可编辑；出境只有 aiWireArgs 一处清洗", "Shows the real value while focused; scrubbed at send time in exactly one place")}>
            <KeyField value={provider.apiKey} hint={keyHintFor(provider.baseUrl)} onChange={(v) => updateProvider(provider.id, { apiKey: v })} />
          </Field>
          <div className="msp-field-2">
            <Field label={tx("代理", "Proxy")} tip={tx("留空 = 跟随系统 / 无", "Empty = follow the system")}>
              <input className="input" value={provider.proxy} placeholder="http://127.0.0.1:7890"
                onChange={(e) => updateProvider(provider.id, { proxy: e.target.value })} />
            </Field>
            <Field label={tx("免代理列表", "No-proxy list")}>
              <input className="input" value={provider.noProxy} placeholder="localhost,127.0.0.1"
                onChange={(e) => updateProvider(provider.id, { noProxy: e.target.value })} />
            </Field>
          </div>
          {note && <div className="msp-probe"><span className={`msp-dot ${probe === "ok" ? "ok" : probe === "err" ? "err" : probe === "testing" ? "run" : "idle"}`} aria-hidden="true" /><span className="set-hint">{note}</span></div>}
        </div>

        <div className="msp-card">
          <div className="msp-card-head">
            <span className="msp-card-title">{tx("模型列表", "Models")}</span>
            <button type="button" className="btn sm" onClick={() => addModel({ providerId: provider.id, model: "new-model", label: "new-model" })}>
              <IconPlus />
              {tx("添加模型", "Add model")}
            </button>
          </div>
          <div className="msp-models">
            {models.map((m) => (
              <ModelRow key={m.id} m={m} provider={provider} isActive={m.id === st.activeModelId}
                editing={editing === m.id} onEdit={(v) => setEditing(v ? m.id : "")} />
            ))}
          </div>
          {fresh.length > 0 && (
            <div className="msp-fresh">
              <div className="msp-fresh-head">
                {tx(`远端有 ${fresh.length} 个还没进档案`, `${fresh.length} upstream model(s) are not in the profile yet`)}
              </div>
              {fresh.slice(0, 12).map((id) => (
                <div className="msp-pick" key={id}>
                  <span className="msp-pick-name">{id}</span>
                  {guessContextTokens(id) && (
                    <span className="set-hint">{tx(`窗口按名字猜 ${fmtTokens(guessContextTokens(id)!)}`, `window guessed from the name: ${fmtTokens(guessContextTokens(id)!)}`)}</span>
                  )}
                  <button type="button" className="btn sm" onClick={() => importModel(id)}>{tx("导入", "Import")}</button>
                </div>
              ))}
              {fresh.length > 12 && (
                <div className="msp-pick">
                  <span className="set-hint">{tx(`另有 ${fresh.length - 12} 个未列出：用「添加模型」自己填名字`, `${fresh.length - 12} more are not shown — add them by name`)}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="msp-card">
          <div className="set-group-title">{tx("上下文", "Context")}</div>
          <SetRow label={tx("压缩阈值", "Compaction threshold")} tip={t("set.ai.compact.tip")}>
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
          </SetRow>
          <SetRow label={tx("手动历史预算", "Manual history budget")} tip={t("set.ai.history.tip")}>
            <div className="msp-test">
              <input className="input" style={{ width: 110 }} type="number" min={0} step={1000}
                value={settings.aiHistoryOverride} disabled={settings.aiHistoryOverride === 0}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  patch({ aiHistoryOverride: Number.isFinite(n) && n > 0 ? Math.min(200_000, n) : 0 });
                }}
              />
              <button type="button" className="btn sm" disabled={settings.aiHistoryOverride === 0} onClick={() => patch({ aiHistoryOverride: 0 })}>
                {tx("恢复自动", "Restore auto")}
              </button>
              <span className="set-hint">
                {activeModel
                  ? tx(`按 ${activeModel.model} 的 ${fmtTokens(activeModel.contextTokens)} 窗口算，当前 ${(settings.aiHistoryOverride || historyCharBudget(activeModel.contextTokens, settings.aiCompactRatio))} 字`,
                      `from ${activeModel.model}'s ${fmtTokens(activeModel.contextTokens)} window: ${(settings.aiHistoryOverride || historyCharBudget(activeModel.contextTokens, settings.aiCompactRatio))} chars now`)
                  : tx("没有当前模型：窗口算不出来，走固定兜底预算", "No active model: the window is unknown, so the fallback budget applies")}
              </span>
            </div>
          </SetRow>
        </div>
      </section>
    </div>
  );
}

/** 密钥那一格：未聚焦给掩码文本，聚焦给原文（见 maskKey 上那段注释） */
function KeyField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  const [focus, setFocus] = useState(false);
  return (
    <input
      className="input"
      value={focus ? value : maskKey(value)}
      placeholder={hint ?? "sk-…"}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(e.target.value)}
      title={tx("聚焦时换成原文；不聚焦只留头 6 位与尾 3 位用来认出是哪把 key", "Real value while focused; otherwise only the first 6 and last 3 characters, enough to tell keys apart")}
    />
  );
}
