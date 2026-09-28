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
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Dropdown } from "../../shared/Dropdown";
import { HelpHint } from "../../shared/HelpHint";
import { SetRow } from "../../shared/SetRow";
import { Listbox } from "../../shared/Listbox";
import { IconCheck, IconEdit, IconMore, IconPlus, IconRefresh, IconTarget, IconTrash } from "../../shared/icons";
import { AI_FORMATS, AI_PRESETS, patch, useSettings, type AiFormat, type AiPreset } from "./settingsStore";
import { guessContextTokens, listModels, missingFrom } from "../ai/modelCatalog";
import { aiWireArgs } from "../agent/provider";
import {
  addModel,
  addProvider,
  keyHintFor,
  removeModel,
  removeProvider,
  providerNeedsKey,
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

/**
 * 试连状态。P115-F14 加 `"blocked"`：没发出去（缺钥匙）不是"没测过"（idle 灰点）
 * 也不是"测失败"（err 红点）——红点会让人以为连不上，灰点会让人以为还没人碰过。
 * 分发一律 `Record<Probe,…>` / 穷举（§8-35①）：将来加状态漏配一处，编译期就红。
 */
type Probe = "idle" | "testing" | "ok" | "err" | "blocked";

/** 中列探针点色：状态 → 颜色类，一张表说完（旧写法是嵌套三元 if 链） */
const PROBE_DOT: Record<Probe, string> = {
  idle: "idle",
  testing: "run",
  ok: "ok",
  err: "err",
  blocked: "warn",
};

/** 缺钥匙那句解释：供应商级与逐模型两处**同一句**（两套说法早晚漂移） */
const noKeyNote = () =>
  tx("还没填 API Key —— 没发请求，也没法说它通不通", "No API key yet — nothing was sent, so nothing can be claimed");

/**
 * 远端清单的落点（P115-F8）：除了 id 列表，还存**这份清单是从哪个地址、哪种格式拉回来的**。
 * 旧写法只按 provider.id 键控——改了 baseUrl/format 之后旧清单照显「远端有 N 个还没进档案」，
 * 照着导入写出的全是会 404 的模型。快照与当前供应商不符 ⇒ 不再当 fresh（选快照而非清除：
 * 撤销编辑后清单自动回来）。
 */
interface RemoteCatalog {
  baseUrl: string;
  format: AiFormat;
  ids: string[];
}

/**
 * 宿主错误到界面的路上不再截第二次：Rust 侧 `classify_error` 已经把上游响应体
 * 裁到 220 字了，这里再 slice 一下，剩下的正好是要行动的那半句（P114-A）。
 * 折行交给 `.msp-med/.msp-probe .set-hint`（见 theme.css）。
 */
function errText(e: unknown): string {
  return String(e).replace(/^Error:\s*/i, "");
}

/** 中列那个点：几种说法各对应一件真事，不是一根装饰线（P115-F14：穷举 Record 编译期兜底） */
function dotOf(p: AiProvider, probe: Probe, modelCount: number): { cls: string; tip: string } {
  if (probe !== "idle") {
    const direct: Record<Exclude<Probe, "idle">, { cls: string; tip: string }> = {
      ok: { cls: "ok", tip: tx("上次试连通过（本页内的记忆，重启回到未测）", "Last test passed (kept only while this page is open)") },
      err: { cls: "err", tip: tx("上次试连失败", "Last test failed") },
      blocked: { cls: "warn", tip: noKeyNote() },
      testing: { cls: "run", tip: tx("正在试连…", "Testing…") },
    };
    return direct[probe];
  }
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

/**
 * 模型编辑弹窗（P113-D，照 ZCode 图4 那扇窗；P115-F9/F10 修三条）：
 *  - F9 它原先**不是** portal（注释自称是，实际只靠 position:fixed 巧合没被裁）——
 *    现在真 portal 到 body（§20，与 shared/Dialog 同一纪律）；
 *  - F9 Esc 原先被一行 `onKeyDown={(e) => e.stopPropagation()}` 吞掉（没有 handler，
 *    纯死键），Tab 一出场就落进弹窗背后的页面——现在 Esc=关闭（document 捕获段，
 *    抢在设置页 window 守卫之前），打开即聚焦第一个输入框；
 *  - F10 保存时校验默认档：指向的档位被删/被改名 ⇒ `defaultThinking` 悬空，
 *    `thinkingParamsFor` 返回 null、思考参数**静默不发**。第一次保存拦下：置回「不设」
 *    并在弹窗里说清楚，用户再按一次保存确认——不静默、不猜测。
 *
 * 复用现成的 `workflow-dialog` 一族（`ParameterSetDialog` 在用）：mask + head + body + foot，
 * label 本来就在控件上方。**不新造第四种弹窗样式**。
 */
function ModelEditDialog({ provider, model, onClose }: { provider: AiProvider; model: AiModelProfile; onClose: () => void }) {
  const [draft, setDraft] = useState<AiModelProfile>({ ...model });
  const [err, setErr] = useState("");
  useLocale();
  const firstInputRef = useRef<HTMLInputElement | null>(null);
  const titleId = "msp-edit-title";

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = () => {
    const name = draft.model.trim();
    if (!name) {
      // 空名字不是"保存一个空串"，而是会发一个必然 404 的 model 字段 —— 在这里拦住
      setErr(tx("模型 ID 不能为空", "The model id cannot be empty"));
      return;
    }
    const levels = draft.thinkingLevels.filter((l) => l.label.trim());
    const dangling = !!draft.defaultThinking && !levels.some((l) => l.label === draft.defaultThinking);
    if (dangling) {
      setDraft({ ...draft, thinkingLevels: levels, defaultThinking: "" });
      setErr(tx(
        `默认档「${draft.defaultThinking}」指向的那一档已经不存在（被删或被改名），已改回「不设」——再按一次「保存」确认`,
        `The default level “${draft.defaultThinking}” no longer exists (removed or renamed); it was reset to “none” — press Save again to confirm`,
      ));
      return;
    }
    updateModel(model.id, {
      model: name,
      label: name,
      contextTokens: Math.max(1024, Math.round(draft.contextTokens || 0)),
      maxOutputTokens: Math.max(256, Math.round(draft.maxOutputTokens || 0)),
      vision: !!draft.vision,
      thinkingLevels: levels,
      defaultThinking: draft.defaultThinking,
    });
    onClose();
  };

  const renameLevel = (i: number, label: string) => {
    setDraft((d) => ({ ...d, thinkingLevels: d.thinkingLevels.map((l, k) => (k === i ? { ...l, label } : l)) }));
  };

  return createPortal(
    <div className="modal-mask workflow-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal workflow-dialog" role="dialog" aria-modal="true" tabIndex={-1}
        aria-labelledby={titleId}>
        <header className="workflow-dialog-head">
          <h2 className="workflow-dialog-head-title" id={titleId}>{tx("编辑模型配置", "Edit model profile")}</h2>
          <p className="workflow-dialog-head-sub">
            {tx(`${provider.label} · 窗口与输出上限决定压缩阈值和仪表的分母`, `${provider.label} — the window and output cap are the denominators for compaction and the meter`)}
          </p>
        </header>
        <div className="workflow-dialog-body">
          <Field label={tx("模型 ID", "Model id")} tip={tx("原样发给 API；改了这里就等于改了这个档案是谁", "Sent to the API verbatim; changing it changes who this profile is")}>
            <input ref={firstInputRef} className="input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </Field>
          <div className="msp-field-2">
            <Field label={tx("上下文窗口", "Context window")} tip={tx("token 数。压缩阈值按它算，用量条也按它显示", "In tokens: the compaction threshold and the meter both divide by it")}>
              <input className="input" type="number" min={1024} step={1000} value={draft.contextTokens}
                onChange={(e) => setDraft({ ...draft, contextTokens: Number(e.target.value) || 0 })} />
            </Field>
            <Field label={tx("单次输出上限", "Max output")} tip={tx("宿主侧还会再钳一次（对话 256–32768 / Agent 1024–32768）", "The host clamps it again (chat 256-32768 / agent 1024-32768)")}>
              <input className="input" type="number" min={256} step={1024} value={draft.maxOutputTokens}
                onChange={(e) => setDraft({ ...draft, maxOutputTokens: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          <label className="workflow-check">
            <input type="checkbox" checked={!!draft.vision} onChange={(e) => setDraft({ ...draft, vision: e.target.checked })} />
            {tx("支持视觉（可发图片）", "Accepts images")}
          </label>

          <div className="workflow-inset">
            <div className="workflow-inset-title">{tx("思考档位", "Thinking levels")}</div>
            {/* 档位名可以改、可以增删；**每档要发什么参数不在这里编辑**。
                那是档案里的静态对象（宿主只做浅合并、保留键拒收），
                给一个自由表达式输入框等于让用户写出一个让上游 400 的东西 —— 宁缺不猜。 */}
            {draft.thinkingLevels.length === 0 && (
              <p className="workflow-muted">{tx("这台没有档位：发送框里那枚「思考强度」整个不出现。", "No levels on this model: the thinking selector does not appear at all.")}</p>
            )}
            {draft.thinkingLevels.map((l, i) => (
              <div className="workflow-level" key={i}>
                <input className="input" style={{ width: 140 }} value={l.label}
                  aria-label={tx(`第 ${i + 1} 档的名字`, `Label of level ${i + 1}`)}
                  onChange={(e) => renameLevel(i, e.target.value)} />
                <span className="set-hint">
                  {Object.keys(l.params).length
                    ? tx(`发 ${Object.keys(l.params).length} 个参数`, `sends ${Object.keys(l.params).length} field(s)`)
                    : tx("什么都不发", "sends nothing")}
                </span>
                <button type="button" className="msp-ibtn" aria-label={tx("删掉这一档", "Remove this level")}
                  onClick={() => setDraft({ ...draft, thinkingLevels: draft.thinkingLevels.filter((_, k) => k !== i) })}>
                  <IconTrash />
                </button>
              </div>
            ))}
            <button type="button" className="btn sm"
              onClick={() => setDraft({ ...draft, thinkingLevels: [...draft.thinkingLevels, { label: `level-${draft.thinkingLevels.length + 1}`, params: {} }] })}>
              {tx("加一档", "Add a level")}
            </button>
            {draft.thinkingLevels.length > 0 && (
              <label className="workflow-check">
                {tx("默认档", "Default")}
                <select className="input" style={{ width: 140 }} value={draft.defaultThinking}
                  onChange={(e) => setDraft({ ...draft, defaultThinking: e.target.value })}>
                  <option value="">{tx("不设", "none")}</option>
                  {draft.thinkingLevels.map((l, i) => <option key={i} value={l.label}>{l.label || `#${i + 1}`}</option>)}
                </select>
              </label>
            )}
          </div>
          {err && <p role="alert" className="workflow-status">{err}</p>}
        </div>
        <footer className="workflow-dialog-foot">
          <button type="button" className="btn" onClick={() => setDraft({ ...model })}>{tx("重置表单", "Reset")}</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>{tx("取消", "Cancel")}</button>
          <button type="button" className="btn primary" onClick={save}>{tx("保存", "Save")}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** 一个模型档案行：一行装名字、徽标与四个动作；「编辑」开一扇窗（P113-D） */
function ModelRow({
  m, provider, isActive, editing, onEdit,
}: {
  m: AiModelProfile; provider: AiProvider; isActive: boolean; editing: boolean; onEdit: (v: boolean) => void;
}) {
  const [probe, setProbe] = useState<Probe>("idle");
  const [note, setNote] = useState("");
  /** 成功那侧的证据（上游真回过的那几个字），放在 title 里，不占行内 */
  const [proof, setProof] = useState("");
  const [armed, setArmed] = useState(false);
  const levels = thinkingLabels(m);

  /**
   * 逐模型「测试」发一次真请求（P114-A）。它必须花钱：清单接口能证明"这家通不通"，
   * 证明不了"这个模型答不答"。供应商级那个 `↻` 仍然是免费的 GET，两件事两个入口。
   *
   * 判定只能来自 `ai_probe` 的 Ok/Err。原来这里 await 的是 `ai_chat`，而它是流式命令：
   * 签名 `Result<(), String>`，每条失败分支（连不上 / HTTP 4xx / 流断）都是
   * `emit("ai:error", {reqId, msg})` 之后 `return Ok(())`。于是"命令返回了"被当成
   * "模型应答了"——删掉密钥一个字母照样绿，后面那个 ms 还是货真价实的一个完整往返。
   * 错误事件按 reqId 派发，而 `probe-<uuid>` 没人监听（chatStore 第一行就把它丢了），
   * 所以上游那句 401 从来没有到过你眼前。
   */
  const test = async () => {
    // 同供应商级那条判据（P115-F19）：地址没填就别把"连不上"错报成网络/代理问题
    if (!provider.baseUrl.trim()) {
      setProbe("err");
      setProof("");
      setNote(tx("先填服务地址", "Fill in the base URL first"));
      return;
    }
    // 同 P113-C 那条判据：需要密钥而没填，就别花额度去打一个必然失败的请求
    if (providerNeedsKey(provider) && !provider.apiKey.trim()) {
      setProbe("blocked");
      setProof("");
      setNote(noKeyNote());
      return;
    }
    setProbe("testing");
    setNote("");
    setProof("");
    const t0 = Date.now();
    try {
      const excerpt = await invoke<string>("ai_probe", aiWireArgs({ provider, model: m }));
      setProbe("ok");
      setNote(`${Date.now() - t0}ms`);
      setProof(excerpt.trim()
        ? tx(`它回的是：「${excerpt}」`, `Its reply: “${excerpt}”`)
        : tx("200 的完成体，只是没带文字（地址、密钥、模型名这三件事已经证明）", "A 200 completion with no text in it — URL, key and model name are still proven"));
    } catch (e) {
      // 上游原文整句留给 title，行内由 CSS 折行——被裁掉的错误等于没说（用户："直接显示返回的错误信息"）
      setProbe("err");
      setNote(errText(e));
    }
  };

  return (
    <div className={`msp-mrow${isActive ? " on" : ""}${editing ? " open" : ""}`}>
      <div className="msp-mline">
        <span className="msp-mname" title={m.model}>{m.model || tx("（空名）", "(empty)")}</span>
        <span className="msp-badge">{fmtTokens(m.contextTokens)}</span>
        {m.vision && <span className="msp-badge">{tx("视觉", "vision")}</span>}
        {/* 档位数也上徽标：它决定发送框里那枚「思考强度」出不出现，是这台模型的能力，不是偏好 */}
        {levels.length > 0 && <span className="msp-badge">{tx(`${levels.length} 档`, `${levels.length} lvl`)}</span>}
        {!m.enabled && <span className="msp-moff">{tx("已停用", "off")}</span>}
        <span className="msp-macts">
          <button type="button" className={`msp-ibtn${isActive ? " on" : ""}`} disabled={!provider.enabled || !m.enabled || isActive}
            aria-label={isActive ? tx("当前使用的模型", "This is the model in use") : tx("设为当前使用", "Use this model")}
            title={isActive
              ? tx("发送框那枚模型钮正指着它", "The composer's model chip points at this one")
              : tx("设为当前使用（发送框那枚模型钮会跟着变）", "Use it; the model chip next to the composer follows")}
            onClick={() => setActive(m.providerId, m.id)}>
            <IconCheck />
          </button>
          <button type="button" className="msp-ibtn" onClick={() => void test()} disabled={probe === "testing"}
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
      {(probe !== "idle") && (
        <div className="msp-med">
          <span className="set-hint" title={probe === "testing" ? "" : probe === "ok" ? proof : note}>
            {probe === "testing"
              ? tx("测试中…", "testing…")
              : probe === "ok"
                ? tx(`通了 · ${note}`, `answered · ${note}`)
                : note}
          </span>
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
  const [remote, setRemote] = useState<Record<string, RemoteCatalog>>({});
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
  // P115-F8：清单只在快照（拉它时的地址/格式）与当前供应商一致时才算数
  const catalog = remote[provider.id] ?? null;
  const catalogFresh = !!catalog && catalog.baseUrl === provider.baseUrl.trim() && catalog.format === provider.format;
  const remoteIds = catalogFresh ? catalog.ids : null;
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
   * 供应商级试连 = 拉一次模型清单（P111-D），不花 token。
   *
   * P113-C 修掉一处**判据错误**：空密钥也报"已连通"。两层原因——
   *  ① 没走现成的 `providerNeedsKey()`；
   *  ② 更本质：`GET /models` 返回 200 只证明**地址可达**，不证明**密钥有效**——
   *    不少网关的清单端点压根不鉴权。我把"连通"和"配得对"混成了一件事。
   * 所以现在：需要密钥而密钥为空 ⇒ **不发请求**，直接写"先填 API Key"。
   * 发出去的每一次都只报它真正证明到的事（P115-F7 分层）：密钥随请求被 2xx 收下 ⇒
   * 才敢说「密钥被接受」；免钥匙/端点不鉴权 ⇒ 只说「清单取回 · 端点可达」。
   */
  const test = async () => {
    const base = provider.baseUrl.trim();
    if (!base) {
      setProbes((s) => ({ ...s, [provider.id]: "err" }));
      setNotes((s) => ({ ...s, [provider.id]: tx("先填服务地址", "Fill in the base URL first") }));
      return;
    }
    if (providerNeedsKey(provider) && !provider.apiKey.trim()) {
      // P115-F14：没发出去要说成 blocked（灰黄点），不能落回 idle——灰点说的是"还没人测过"
      setProbes((s) => ({ ...s, [provider.id]: "blocked" }));
      setNotes((s) => ({
        ...s,
        [provider.id]: noKeyNote(),
      }));
      return;
    }
    setProbes((s) => ({ ...s, [provider.id]: "testing" }));
    setNotes((s) => ({ ...s, [provider.id]: "" }));
    const t0 = Date.now();
    try {
      const ids = await listModels(provider);
      const ms = Date.now() - t0;
      // P115-F7：回执措辞分层——带上去的密钥被 2xx 收下才说「密钥被接受」；
      // 免钥匙（回环）或清单端点本来就不鉴权时只说真正证明到的事：清单取回了、端点可达。
      // 旧写法对无钥匙的 Ollama 也报「密钥有效」，是替没人验过的东西背书。
      const keyProven = providerNeedsKey(provider) && provider.apiKey.trim().length > 0;
      setRemote((s) => ({ ...s, [provider.id]: { baseUrl: base, format: provider.format, ids } }));
      setProbes((s) => ({ ...s, [provider.id]: "ok" }));
      setNotes((s) => ({
        ...s,
        [provider.id]: keyProven
          ? ids.length
            ? tx(`密钥被接受 · ${ms}ms · 清单 ${ids.length} 个`, `key accepted · ${ms}ms · ${ids.length} listed`)
            : tx(`密钥被接受 · 这家不提供模型清单（可以自己填）`, `key accepted · no model list here (fill names by hand)`)
          : ids.length
            ? tx(`清单取回 · 端点可达 · ${ids.length} 个`, `catalog fetched · endpoint reachable · ${ids.length} listed`)
            : tx(`清单取回 · 端点可达（这家不提供模型清单，可以自己填）`, `catalog fetched · endpoint reachable (no model list here; fill names by hand)`),
      }));
    } catch (e) {
      setProbes((s) => ({ ...s, [provider.id]: "err" }));
      setNotes((s) => ({ ...s, [provider.id]: errText(e) }));
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
    // P115-F8：只从"还新鲜"的那份清单里划掉；快照已过期的清单不动它（它本来就不再显示）
    setRemote((s) => {
      const cat = s[provider.id];
      if (!cat) return s;
      return { ...s, [provider.id]: { ...cat, ids: cat.ids.filter((x) => x !== id) } };
    });
  };

  /**
   * P115-F15：删除走"两段明说"，不走聪明的自动级联。
   * 旧写法第二次点击把 `cascade = models.length > 0` 传下去——有模型就**连模型一起删**，
   * 拒绝分支因此永远够不着（死代码），而菜单上那句"一起删"藏在浮层里没人读全。
   * 现在：首次点击就把「名下还有 N 个模型，先删除或移走它们」亮在 hint 行（不碰探针，
   * 删除不是"试连失败"），第二次点击传 `cascade=false`——被拒就走真正的拒绝分支。
   */
  const del = () => {
    if (!armed) {
      setArmed(true);
      if (models.length > 0) {
        setNotes((s) => ({
          ...s,
          [provider.id]: tx(`名下还有 ${models.length} 个模型，先删除或移走它们`, `${models.length} model(s) still live under this provider — delete or move them first`),
        }));
      }
      return;
    }
    const r = removeProvider(provider.id, false);
    setArmed(false);
    setMenuOpen(false);
    if (!r.ok) {
      setNotes((s) => ({
        ...s,
        [provider.id]: r.reason === "has_models"
          ? tx(`名下还有 ${models.length} 个模型，先删除或移走它们`, `${models.length} model(s) still live under this provider — delete or move them first`)
          : tx("删除被拒绝", "Delete refused"),
      }));
      return;
    }
    const next = st.providers.find((p) => p.id !== provider.id);
    setSel(next?.id ?? "");
  };

  const activeModel = st.models.find((m) => m.id === st.activeModelId) ?? null;
  // 弹窗只挂一个实例，编辑哪一行由 `editing` 指；换供应商时上面已经把它清了
  const editingModel = models.find((m) => m.id === editing) ?? null;

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
                  ? tx("再点一次确认删除这家供应商（不可撤销）", "Press again to delete this provider (no undo)")
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
          {note && <div className="msp-probe"><span className={`msp-dot ${PROBE_DOT[probe]}`} aria-hidden="true" /><span className="set-hint">{note}</span></div>}
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
              {/* P115-F4：输入框永远可编辑——旧写法在值为 0 时连输入框一起禁用，
                  从这一页就没有任何路径设出手动预算，那是一枚死控件。
                  口径：空/0 提交 = 回自动（写 0），placeholder 常驻「自动」。 */}
              <input className="input" style={{ width: 110 }} type="number" min={0} step={1000}
                value={settings.aiHistoryOverride || ""}
                placeholder={tx("自动", "auto")}
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
      {editingModel && (
        <ModelEditDialog provider={provider} model={editingModel} onClose={() => setEditing("")} />
      )}
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
