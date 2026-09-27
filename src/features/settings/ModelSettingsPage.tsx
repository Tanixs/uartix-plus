/**
 * P111-C「模型设置」：三栏里的中+右两栏（左栏是设置页自己的导航，在 SettingsModal）。
 *
 * 为什么从 AI 服务页里搬出来单独一页（用户判 P110-B3 不合格之后改判）：
 *  - 旧形状是"一家供应商 = 一行 set-row，行里 16 个控件同时在场"，实测那一行 674px 宽
 *    × 195px 高。它把"看"和"改"挤在同一处，谁都不是主角；
 *  - 供应商/模型是**一对多的清单**，清单类内容的通形就是 ZCode 那样：左列选，右列改
 *    （GitHub Desktop / Linear 的设置也是这个形状）。
 *  - 搬出来之后 AI 服务页只剩行为参数与授权面，两页各自能一屏读完。
 *
 * 两处刻意不同步的东西：
 *  - **试连态**是这一页的内存态，切走就没了。它不叫"在线状态"：做常绿的点需要心跳，
 *    这一页只需要"我刚点那一下成功没有"（P110-B3 同口径）。
 *  - **选中哪一家**也是内存态，但进页面时默认落在"当前使用模型"所属那一家 ——
 *    右列空白一屏会让人以为配置丢了。
 */
import { useMemo, useRef, useState } from "react";
import { SetRow } from "../../shared/SetRow";
import { Listbox } from "../../shared/Listbox";
import { IconChevron } from "../../shared/icons";
import { AI_FORMATS, AI_PRESETS, patch, useSettings, type AiFormat, type AiPreset } from "./settingsStore";
import { guessContextTokens, listModels, missingFrom } from "../ai/modelCatalog";
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

/** 中列那个点：四种说法各自对应一件真事，不是一根装饰线 */
function dotOf(p: AiProvider, probe: Probe, modelCount: number): { cls: string; tip: string } {
  if (probe === "ok") return { cls: "ok", tip: tx("上次试连通过（本页面内的记忆，重启回到未测）", "Last test passed (kept only while this page is open)") };
  if (probe === "err") return { cls: "err", tip: tx("上次试连失败", "Last test failed") };
  if (probe === "testing") return { cls: "run", tip: tx("正在试连…", "Testing…") };
  if (!p.enabled) return { cls: "off", tip: tx("这家已停用", "This provider is switched off") };
  if (!p.baseUrl.trim()) return { cls: "warn", tip: tx("还没有服务地址", "No base URL yet") };
  if (modelCount === 0) return { cls: "warn", tip: tx("这家下面一个模型都没有，选不到也发不出", "No model under this provider, so nothing can be sent") };
  return { cls: "idle", tip: tx("未测", "Untested") };
}

/**
 * 掩码回显。P111-C 修掉一处双掩码：旧代码 `type="password"` 与掩码串叠着写，
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

export function ModelSettingsPage() {
  const st = useAiProfiles();
  const settings = useSettings();
  useLocale();
  const [sel, setSel] = useState<string>(st.providers[0]?.id ?? "");
  const [probes, setProbes] = useState<Record<string, Probe>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** 上一次试连拉回的远端清单（按供应商存）。null = 还没拉过；空数组 = 这家不开清单 */
  const [remote, setRemote] = useState<Record<string, string[] | null>>({});
  const [armed, setArmed] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const modelsOf = (id: string) => st.models.filter((m) => m.providerId === id);
  // 选中的那家被删掉了要落到别处，否则右列指着空气。
  // 这里**没有"一家都没有"那种空态**：档案表的 load 与 removeProvider 都保证至少留一家
  // （删空会退回 seed 默认），为一个到不了的分支写文案，就是给空态预算白加一笔。
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

  /**
   * 试连 = 拉一次模型清单（P111-D）。
   * 旧写法是发一次真 completion（内容 "ping"）——要花钱才能证明"配得对"，那是设计缺陷。
   * `Ok(空表)` 在这套语义里是**好消息**：连得上、鉴权过，只是这家不开清单端点。
   */
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

  /** 导入一个远端模型：窗口从 id 后缀预填，认不出就留档案默认（不编数） */
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
          <button ref={addBtnRef} className="btn sm" onClick={() => setAddOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={addOpen}>
            {tx("添加", "Add")}
            <IconChevron dir="down" size={12} />
          </button>
        </div>
        {st.providers.map((p) => {
          const n = modelsOf(p.id).length;
          const d = dotOf(p, probes[p.id] ?? "idle", n);
          return (
            <button key={p.id} type="button" className={`msp-row${provider?.id === p.id ? " on" : ""}`} onClick={() => { setSel(p.id); setArmed(false); }}>
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
              <div className="set-group-title">{tx("连接", "Connection")}</div>
              <SetRow label={tx("名称", "Name")} tip={tx("只影响界面显示，不参与请求", "UI label only — never sent")}>
                <input className="input" style={{ width: 220 }} value={provider.label}
                  onChange={(e) => updateProvider(provider.id, { label: e.target.value })} />
              </SetRow>
              <SetRow label={tx("API 格式", "API format")} tip={tx("决定请求体怎么拼、端点路径是哪一条", "Chooses the request shape and the endpoint path")}>
                <select className="input" style={{ width: 160 }} value={provider.format}
                  onChange={(e) => updateProvider(provider.id, { format: e.target.value as AiFormat })}>
                  {AI_FORMATS.map((f) => <option key={f.key} value={f.key}>{f.label.split(" (")[0]}</option>)}
                </select>
              </SetRow>
              <SetRow label={tx("服务地址", "Base URL")} tip={tx("不含 /chat/completions 这类端点路径", "Without the endpoint path")}>
                <input className="input" style={{ width: 420 }} value={provider.baseUrl} placeholder="https://api.example.com/v1"
                  onChange={(e) => updateProvider(provider.id, { baseUrl: e.target.value })} />
              </SetRow>
              <SetRow label="API Key" tip={tx("聚焦时换成原文可编辑；密钥只在发送那一刻清洗，出境只有 aiWireArgs 一处", "Shows the real value while focused; it is scrubbed at send time in exactly one place")}>
                <KeyField value={provider.apiKey} hint={keyHintFor(provider.baseUrl)}
                  onChange={(v) => updateProvider(provider.id, { apiKey: v })} />
              </SetRow>
              <SetRow label={tx("代理", "Proxy")} tip={tx("留空 = 跟随系统 / 无", "Empty = follow the system")}>
                <input className="input" style={{ width: 300 }} value={provider.proxy} placeholder="http://127.0.0.1:7890"
                  onChange={(e) => updateProvider(provider.id, { proxy: e.target.value })} />
              </SetRow>
              <SetRow label={tx("免代理列表", "No-proxy list")}>
                <input className="input" style={{ width: 300 }} value={provider.noProxy} placeholder="localhost,127.0.0.1"
                  onChange={(e) => updateProvider(provider.id, { noProxy: e.target.value })} />
              </SetRow>
              <SetRow label={tx("启用", "Enabled")} tip={tx("停用后它在选择器里置灰，不是从列表里消失", "Switching off greys it out in the picker; it does not vanish")}>
                <input type="checkbox" checked={provider.enabled} onChange={(e) => updateProvider(provider.id, { enabled: e.target.checked })} />
              </SetRow>
              <SetRow label={tx("试连", "Test")} tip={tx("只拉一次模型清单（GET /models），不花 token；404 也算连通", "A single GET /models — no tokens spent; even a 404 proves the connection")}>
                <div className="msp-test">
                  <button type="button" className="btn sm" disabled={probe === "testing"} onClick={() => void test()}>
                    {probe === "testing" ? tx("测试中…", "Testing…") : tx("拉模型清单", "Fetch models")}
                  </button>
                  {note && <span className="set-hint">{note}</span>}
                </div>
              </SetRow>
              <SetRow label={tx("删除这家", "Delete provider")}>
                <button type="button" className={`btn sm${armed ? " danger" : ""}`} onClick={del}
                  title={models.length
                    ? tx(`名下还有 ${models.length} 个模型：再点一次连它们一起删（不可撤销）`, `${models.length} model(s) inside: press again to delete them too (no undo)`)
                    : tx("删除这家供应商", "Delete this provider")}>
                  {armed ? tx("再点确认", "Press again") : tx("删除", "Delete")}
                </button>
              </SetRow>
            </div>

            <div className="msp-card">
              <div className="set-group-title">{tx("模型", "Models")}</div>
              {models.map((m) => {
                const isActive = m.id === st.activeModelId;
                const levels = thinkingLabels(m);
                return (
                  <SetRow key={m.id} label={m.model || tx("（空名）", "(empty)")}
                    tip={`${tx("上下文窗口是分母：压缩阈值与用量条都按它算", "The context window is the denominator for compaction and the meter")}${levels.length ? tx(`；这台配了 ${levels.length} 档思考强度`, `; this one has ${levels.length} thinking levels`) : ""}`}>
                    <div className="msp-model">
                      <input className="input" style={{ width: 220 }} value={m.model} placeholder="deepseek-v4-pro"
                        title={tx("发给 API 的模型名", "Model id sent to the API")}
                        onChange={(e) => updateModel(m.id, { model: e.target.value, label: e.target.value })} />
                      <input className="input" style={{ width: 110 }} type="number" min={1024} step={1000} value={m.contextTokens}
                        title={tx("上下文窗口（token）", "Context window in tokens")}
                        onChange={(e) => updateModel(m.id, { contextTokens: Math.max(1024, Math.round(Number(e.target.value) || 0)) })} />
                      <input className="input" style={{ width: 100 }} type="number" min={256} step={1024} value={m.maxOutputTokens}
                        title={tx("单次回复输出上限（宿主侧还会再钳一次）", "Per-reply output cap (the host clamps it again)")}
                        onChange={(e) => updateModel(m.id, { maxOutputTokens: Math.max(256, Math.round(Number(e.target.value) || 0)) })} />
                      <label className="set-inline">
                        <input type="checkbox" checked={m.enabled} onChange={(e) => updateModel(m.id, { enabled: e.target.checked })} />
                        {tx("启用", "On")}
                      </label>
                      <button type="button" className="btn sm" disabled={!provider.enabled || !m.enabled || isActive}
                        onClick={() => setActive(m.providerId, m.id)}
                        title={provider.enabled && m.enabled
                          ? tx("设为当前使用（发送框那枚模型钮会跟着变）", "Use this one; the model chip next to the composer follows")
                          : tx("先启用这家供应商和这个模型", "Enable this provider and model first")}>
                        {isActive ? tx("使用中", "In use") : tx("设为当前", "Use")}
                      </button>
                      <button type="button" className="btn sm" onClick={() => removeModel(m.id)} title={tx("删除这个模型档案", "Delete this model profile")}>
                        {tx("删", "Del")}
                      </button>
                    </div>
                  </SetRow>
                );
              })}
              <SetRow label={tx("新增", "Add")}>
                <div className="msp-test">
                  <button type="button" className="btn sm" onClick={() => addModel({ providerId: provider.id, model: "new-model", label: "new-model" })}>
                    {tx("添加模型", "Add model")}
                  </button>
                  {/* 远端有、档案里没有的那些：一次点一个导进来，窗口从 id 后缀预填。
                      不"一键全部导入"——有的家一次列 200 个模型，全塞进档案表只是把噪声留下。 */}
                  {fresh.length > 0 && (
                    <span className="set-hint">
                      {tx(`远端有 ${fresh.length} 个还没进档案`, `${fresh.length} upstream model(s) are not in the profile yet`)}
                    </span>
                  )}
                </div>
              </SetRow>
              {fresh.slice(0, 12).map((id) => (
                <div className="msp-pick" key={id}>
                  <span className="msp-pick-name">{id}</span>
                  {guessContextTokens(id) && (
                    <span className="set-hint">{tx(`窗口按名字猜 ${fmtTokens(guessContextTokens(id)!)}`, `window guessed from the name: ${fmtTokens(guessContextTokens(id)!)}`)}</span>
                  )}
                  <button type="button" className="btn sm" onClick={() => importModel(id)}>
                    {tx("导入", "Import")}
                  </button>
                </div>
              ))}
              {fresh.length > 12 && (
                <div className="msp-pick">
                  <span className="set-hint">
                    {tx(`另有 ${fresh.length - 12} 个未列出：用「添加模型」自己填名字`, `${fresh.length - 12} more are not shown — add them by name`)}
                  </span>
                </div>
              )}
            </div>
        {/* 上下文那一卡独立于"选中的是哪一家"，所以它不跟着上面的选择块走。 */}

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
      style={{ width: 420 }}
      value={focus ? value : maskKey(value)}
      placeholder={hint ?? "sk-…"}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onChange={(e) => onChange(e.target.value)}
      title={tx("聚焦时换成原文；不聚焦只留头 6 位与尾 3 位用来认出是哪把 key", "Real value while focused; otherwise only the first 6 and last 3 characters, enough to tell keys apart")}
    />
  );
}
