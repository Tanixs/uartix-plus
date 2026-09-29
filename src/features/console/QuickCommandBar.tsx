import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as cmdStore from "../controls/commandStore";
import type { CommandItem } from "../controls/commandStore";
import * as serialStore from "../serial/serialStore";
import * as variableStore from "../controls/variableStore";
import { runCommand } from "../controls/cmdExec";
import { guardLocked } from "../operator/lock";
import { IconChevron, IconClose } from "../../shared/icons";
import { useSettings } from "../settings/settingsStore";
import { CODECS, userCodecToCodec, type Codec, type FactoryField } from "./commandFactory";
import * as userCodecStore from "./userCodecStore";
import { CodecEditorModal, MyCodecsModal } from "./CodecEditorModal";
import type { UserCodecDef } from "./commandFactory";
import { t, tx, useLocale } from "../../i18n/strings";

const b2 = (v: number) => (v & 0xff).toString(16).padStart(2, "0").toUpperCase();

function delay(ms: number) {
  return new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
}

/** HEX 文本预览：统一两位大写空格分组 */
function fmtHexPreview(t: string): string {
  const tokens = t.trim().split(/[\s,]+/).filter(Boolean);
  return tokens
    .map((tok) => b2(parseInt(tok.replace(/^0x/i, ""), 16)))
    .join(" ");
}

interface TipState {
  item: CommandItem;
  x: number;
  y: number;
  above: boolean;
}

function ChipTooltip({ tip }: { tip: TipState }) {
  const { item } = tip;
  const isScript = Boolean(item.scriptEnabled && item.script.trim());
  const badge = isScript ? tx("脚本", "Script") : item.sendMode === "hex" ? "HEX" : "ASCII";
  let body: React.ReactNode;
  if (isScript) {
    body = <pre className="qk-tip-pre">{item.script}</pre>;
  } else {
    // P121-A：预览显示的是**要发出去的那一份**（求值后），不是模板原文。
    // 旧版这里数的是原文的字节，而发送路径会不会替换变量取决于另一个入口——提示与事实两回事。
    const out = variableStore.resolveVars(item.template);
    if (item.sendMode === "hex") {
      const shown = fmtHexPreview(out);
      const count = shown ? shown.split(" ").length : 0;
      body = (
        <>
          <div className="qk-tip-mono">{shown || tx("（空）", "(empty)")}</div>
          <div className="qk-tip-sub">{tx(`${count} 字节`, `${count} bytes`)}</div>
        </>
      );
    } else {
      const bytes = new TextEncoder().encode(out).length;
      body = (
        <>
          <div className="qk-tip-mono">{out || tx("（空）", "(empty)")}</div>
          <div className="qk-tip-sub">
            {tx(`${bytes} 字节`, `${bytes} bytes`)}
            {out !== item.template && ` · ${item.template}`}
          </div>
        </>
      );
    }
  }
  return (
    <div
      className={`qk-tip ${tip.above ? "above" : "below"}`}
      style={{ left: tip.x, top: tip.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="qk-tip-head">
        <span className="qk-tip-name">{item.name}</span>
        <span className={`qk-tip-badge ${isScript ? "script" : item.sendMode}`}>{badge}</span>
      </div>
      {body}
      {item.note && <div className="qk-tip-note">{item.note}</div>}
      <div className="qk-tip-foot">{tx("点击立即发送", "Click to send now")}</div>
    </div>
  );
}

export function QuickCommandBar() {
  useLocale(); // 守卫三：这一面说的话是 tx() 出来的，切语言得有人重渲染
  const cmds = useSyncExternalStore(cmdStore.subscribe, cmdStore.getSnapshot);
  const settings = useSettings();
  const [open, setOpen] = useState(() => localStorage.getItem("vs.qkbar.open") !== "0");
  const [factoryOpen, setFactoryOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [tip, setTip] = useState<TipState | null>(null);
  const tipTimer = useRef<number | null>(null);

  // ---- 指令工厂状态 ----
  const uc = useSyncExternalStore(userCodecStore.subscribe, userCodecStore.getSnapshot);
  const allCodecs: Codec[] = useMemo(
    () => [...CODECS, ...uc.codecs.map(userCodecToCodec)],
    [uc.codecs],
  );
  const [codecId, setCodecId] = useState<string>(CODECS[0].id);
  const [editorOpen, setEditorOpen] = useState<{ def: UserCodecDef | null } | null>(null);
  const [myOpen, setMyOpen] = useState(false);
  const codec: Codec = allCodecs.find((c) => c.id === codecId) ?? allCodecs[0];
  const codecById = (id: string): Codec | undefined => {
    const builtIn = CODECS.find((c) => c.id === id);
    if (builtIn) return builtIn;
    const def = userCodecStore.getById(id.startsWith("user:") ? id.slice(5) : id);
    return def ? userCodecToCodec(def) : undefined;
  };
  const initVals = (c: Codec): Record<string, string> => {
    const fields = typeof c.fields === "function" ? c.fields({}) : c.fields;
    const out: Record<string, string> = {};
    for (const f of fields) out[f.key] = f.def ?? "";
    return out;
  };
  const [vals, setVals] = useState<Record<string, string>>(() => initVals(CODECS[0]));
  const switchCodec = (id: string) => {
    setCodecId(id);
    const c = codecById(id);
    setVals(c ? initVals(c) : {});
  };
  const setVal = (key: string, v: string) => setVals((s) => ({ ...s, [key]: v }));

  const flat = cmdStore.flatCommands();
  const hasWitGroup = cmds.groups.some((g) => g.name === "WIT");

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    localStorage.setItem("vs.qkbar.open", next ? "1" : "0");
  };

  const showMsg = (t: string) => {
    setMsg(t);
    setErr(null);
    setTimeout(() => setMsg((m) => (m === t ? null : m)), 2000);
  };

  // ---- 芯片悬浮预览 ----
  const tipEnter = (item: CommandItem, el: HTMLElement) => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const above = r.top > 150;
      // rect 是视觉像素；position:fixed 的 top/left 是逻辑像素（CSS zoom 缩放），需除回 zoom
      const zf = (settings.zoom || 100) / 100;
      setTip({
        item,
        x: Math.min(Math.max((r.left + r.width / 2) / zf, 130), window.innerWidth / zf - 130),
        y: (above ? r.top - 8 : r.bottom + 8) / zf,
        above,
      });
    }, 300);
  };
  const tipLeave = () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    setTip(null);
  };

  const runItem = async (item: CommandItem) => {
    try {
      // P121-A：执行判据搬进 `cmdExec.runCommand`。原先这份重复实现**漏了 resolveVars**，
      // 同一条 `SPD:{speed}` 在导轨点会替换变量、在这里直接发原文——两份都不算错，
      // 只是不是同一份。
      await runCommand(item);
      setErr(null);
      setFlash(item.id);
      setTimeout(() => setFlash((f) => (f === item.id ? null : f)), 400);
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  // ---- 指令工厂 ----
  const factoryFields: FactoryField[] =
    typeof codec.fields === "function" ? codec.fields(vals) : codec.fields;

  let preview: { frames: string[]; parts: import("./commandFactory").FramePart[]; note?: string } | null = null;
  let previewErr: string | null = null;
  try {
    preview = codec.build(vals);
  } catch (e) {
    previewErr = String(e).replace(/^Error:\s*/, "");
  }

  const sendFactory = async () => {
    try {
      const r = codec.build(vals);
      for (let i = 0; i < r.frames.length; i++) {
        if (i > 0) await delay(60);
        await serialStore.sendData("hex", r.frames[i]);
      }
      setErr(null);
      showMsg(tx(`已发送 ${r.frames.length} 帧`, `Sent ${r.frames.length} frame(s)`));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const ensureGroup = (name: string): string => {
    const g = cmdStore.getSnapshot().groups.find((x) => x.name === name);
    if (g) return g.id;
    cmdStore.addGroup(name);
    return cmdStore.getSnapshot().groups.find((x) => x.name === name)!.id;
  };

  const saveFactory = () => {
    // P121-A：Operator 只读锁下先就地返回。store 那五个写方法本来就各自拦锁，
    // 但 `ensureGroup` 里有一句 `groups.find(...)!`——被拦之后分组不存在，
    // 空断言会抛一个和"只读"毫无关系的 TypeError 糊在错误面上。
    if (guardLocked()) return;
    try {
      const r = codec.build(vals);
      const gid = ensureGroup(codec.group);
      cmdStore.addCommand(gid);
      const g = cmdStore.getSnapshot().groups.find((x) => x.id === gid)!;
      const item = g.items[g.items.length - 1] as CommandItem;
      const base = {
        name: `${codec.name} ${codec.summary?.(vals) ?? ""}`.trim(),
        sendMode: "hex" as const,
        note: r.note ?? "",
      };
      if (r.frames.length === 1) {
        cmdStore.patchCommand(item.id, { ...base, template: r.frames[0], script: "", scriptEnabled: false });
      } else {
        // 多帧序列存为脚本，逐帧发送
        const script = r.frames
          .map((f, i) => `await send("${f}","hex");${i < r.frames.length - 1 ? "\nawait delay_ms(60);" : ""}`)
          .join("\n");
        cmdStore.patchCommand(item.id, { ...base, template: "", script, scriptEnabled: true });
      }
      showMsg(tx("已存入命令库，可在控制画布拖挂到卡片", "Saved to the command library — drag it onto a card in the control canvas"));
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, ""));
    }
  };

  const addPresetGroup = () => {
    if (guardLocked()) return; // 同上：只读锁下就地返回，别让 ensureGroup 的空断言抛 TypeError
    const gid = ensureGroup("WIT");
    const calib = (addr: number, v: number, pre = 200) =>
      [
        `await send("FF AA 69 88 B5","hex");`,
        `await delay_ms(${pre});`,
        `await send("FF AA ${b2(addr)} ${b2(v)} 00","hex");`,
        `await delay_ms(100);`,
        `await send("FF AA 00 00 00","hex");`,
      ].join("\n");
    /**
     * 这一块的中文**故意不套 tx()**（i18n 预算里那 100 字就是它）：指令名与备注是要写进
     * 用户命令库的**数据**，不是渲染给人的界面文字 —— 同 B11 把"出厂预设模板名"划在门外。
     * 套上 tx() 等于让"预置出来的指令叫什么"取决于按按钮那一刻的语言，
     * 用户之后改名/导出/换语言再导入都会撞上"同一个东西两个名字"。
     */
    const presets: { name: string; template?: string; script?: string; note: string }[] = [
      { name: "解锁", template: "FF AA 69 88 B5", note: "解锁寄存器，10s 内有效" },
      { name: "保存配置", template: "FF AA 00 00 00", note: "保存当前配置" },
      { name: "重启模块", template: "FF AA 00 FF 00", note: "软重启" },
      { name: "航向角置零", script: calib(0x01, 0x04), note: "解锁→CALSW=4→保存" },
      { name: "加计校准", script: calib(0x01, 0x01), note: "解锁→CALSW=1→保存，需静止放置" },
      { name: "高度清零", script: calib(0x01, 0x03), note: "解锁→CALSW=3→保存" },
      { name: "磁场校准", script: calib(0x01, 0x07), note: "解锁→CALSW=7→保存，缓慢画8字" },
      { name: "输出100Hz", script: calib(0x03, 0x09), note: "RRATE=0x09" },
      { name: "输出200Hz", script: calib(0x03, 0x0b), note: "RRATE=0x0B" },
      { name: "波特率115200", script: calib(0x04, 0x06), note: "改后需用新波特率重连" },
      { name: "六轴算法", script: calib(0x24, 0x01), note: "AXIS6=1（无磁力计融合）" },
      { name: "九轴算法", script: calib(0x24, 0x00), note: "AXIS6=0" },
    ];
    for (const p of presets) {
      cmdStore.addCommand(gid);
      const g = cmdStore.getSnapshot().groups.find((x) => x.id === gid)!;
      const item = g.items[g.items.length - 1] as CommandItem;
      cmdStore.patchCommand(item.id, {
        name: p.name,
        template: p.template ?? "",
        sendMode: "hex",
        note: p.note,
        script: p.script ?? "",
        scriptEnabled: Boolean(p.script),
      });
    }
    showMsg(tx("已预置 WIT 常用指令", "WIT common commands seeded"));
  };

  const renderFactoryField = (f: FactoryField) => {
    let control: React.ReactNode;
    if (f.kind === "select") {
      control = (
        <select
          className="input"
          value={vals[f.key] ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          title={f.hint}
        >
          {f.options?.map((o) => (
            <option key={o.v} value={String(o.v)}>
              {o.label}
            </option>
          ))}
        </select>
      );
    } else if (f.kind === "hex") {
      control = (
        <input
          className="input qk-hexin"
          value={vals[f.key] ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          placeholder={f.hint}
          title={f.hint}
          spellCheck={false}
        />
      );
    } else if (f.kind === "text") {
      control = (
        <input
          className="input"
          style={{ width: 160 }}
          value={vals[f.key] ?? f.def ?? ""}
          onChange={(e) => setVal(f.key, e.target.value)}
          placeholder={f.label}
          title={f.hint}
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendFactory();
          }}
        />
      );
    } else {
      control = (
        <span className="qk-field">
          <input
            className="input qk-val"
            value={vals[f.key] ?? f.def ?? ""}
            onChange={(e) => setVal(f.key, e.target.value)}
            placeholder={f.label}
            title={`${f.label}${f.hint ? `：${f.hint}` : ""}`}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendFactory();
            }}
          />
          {f.options && (
            <select
              className="input"
              value=""
              onChange={(e) => {
                if (e.target.value !== "") setVal(f.key, e.target.value);
              }}
              title={tx("常用值", "Common values")}
            >
              <option value="">{tx("常用值…", "Common values…")}</option>
              {f.options.map((o) => (
                <option key={o.v} value={String(o.v)}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </span>
      );
    }
    return (
      <div key={f.key} className="qk-fgroup">
        <label className="qk-flabel" title={f.hint}>
          {f.label}
        </label>
        {control}
        {f.hint && <span className="qk-fhint">{f.hint}</span>}
      </div>
    );
  };

  return (
    <div className="qk-bar">
      <div className="qk-head">
        <button className="qk-fold" onClick={toggleOpen} title={open ? tx("收起快捷指令栏", "Collapse the quick bar") : tx("展开快捷指令栏", "Expand the quick bar")}>
          <IconChevron size={13} dir={open ? "down" : "right"} /> {tx("快捷指令", "Quick commands")}
        </button>
        {open && (
          <>
            <div className="qk-chips">
              {flat.map(({ item }) => (
                <button
                  key={item.id}
                  className={`qk-chip ${flash === item.id ? "flash" : ""}`}
                  onClick={() => void runItem(item)}
                  onMouseEnter={(e) => tipEnter(item, e.currentTarget)}
                  onMouseLeave={tipLeave}
                >
                  {item.scriptEnabled && item.script.trim() ? "⚡ " : ""}
                  {item.name}
                </button>
              ))}
              {!flat.length && (
                <span className="qk-empty">{tx("暂无指令", "No commands yet")}</span>
              )}
            </div>
            <button
              className={`btn ${factoryOpen ? "on" : ""}`}
              style={{ flex: "0 0 auto" }}
              onClick={() => setFactoryOpen((v) => !v)}
              title={tx("多协议指令构造器：WIT / 匿名V7 / Modbus / 校验工具", "Multi-protocol command builder: WIT / V7 / Modbus / checksum tools")}
            >
              {tx("指令工厂", "Command builder")}
            </button>
          </>
        )}
        <button className="btn" style={{ flex: "0 0 auto" }} onClick={() => setManageOpen(true)}>
          {tx("管理", "Manage")}
        </button>
      </div>
      {open && factoryOpen && (
        <div className="qk-factory">
          <div className="qk-factory-row">
            <div className="qk-fgroup">
              <label className="qk-flabel">{tx("协议", "Protocol")}</label>
              <select
                className="input"
                value={codec.id}
                onChange={(e) => switchCodec(e.target.value)}
                title={tx("选择协议编解码器", "Pick a protocol codec")}
              >
                <optgroup label={tx("内置协议", "Built-in protocols")}>
                  {CODECS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
                {uc.codecs.length > 0 && (
                  <optgroup label={tx("我的协议", "My protocols")}>
                    {allCodecs
                      .filter((c) => c.id.startsWith("user:"))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
            </div>
            <button
              className="btn"
              onClick={() => setEditorOpen({ def: null })}
              title={tx("可视化编辑自己的帧模板：固定字节 + 变量字段 + 长度段 + 校验段", "Visually edit your own frame templates: fixed bytes + variable fields + length + checksum")}
            >
              {tx("＋新建自定义协议", "+ New custom protocol")}
            </button>
            {uc.codecs.length > 0 && (
              <button className="btn" onClick={() => setMyOpen(true)} title={tx("编辑/删除/导入/导出我的协议", "Edit / delete / import / export my protocols")}>
                {tx("管理我的协议", "Manage my protocols")}
              </button>
            )}
          </div>
          {codec.guide && <div className="qk-guide">💡 {codec.guide}</div>}
          <div className="qk-factory-form">{factoryFields.map(renderFactoryField)}</div>
          <div className="qk-factory-actions">
            <button className="btn primary" onClick={() => void sendFactory()}>
              {tx("发送", "Send")}
            </button>
            <button className="btn" onClick={saveFactory} title={tx(`存入命令库「${codec.group}」分组，可拖挂到控制画布卡片`, `Save into the “${codec.group}” group — draggable onto control-canvas cards`)}>
              {tx("存为指令", "Save as command")}
            </button>
            {codec.group === "WIT" && !hasWitGroup && (
              <button className="btn" onClick={addPresetGroup} title={tx("一键添加解锁/保存/校准等常用指令", "One click adds the usual unlock / save / calibrate commands")}>
                {tx("预置常用指令", "Seed common commands")}
              </button>
            )}
          </div>
          <div className="qk-factory-preview">
            {preview ? (
              <>
                <div className="qk-frames">
                  {preview.frames.map((f, i) => (
                    <span key={i} className="qk-frame-line">
                      {preview!.frames.length > 1 ? `${i + 1}. ` : ""}
                      {f}
                    </span>
                  ))}
                </div>
                <div className="qk-parts">
                  {preview.parts.map((p, i) => (
                    <span key={i} className="fp-col">
                      <span className={`fp ${p.cls}`} title={p.label}>
                        {p.text}
                      </span>
                      <span className="fp-label">{p.label}</span>
                    </span>
                  ))}
                </div>
                {preview.note && <div className="qk-note">{preview.note}</div>}
              </>
            ) : (
              <div className="qk-note">{previewErr ?? "—"}</div>
            )}
          </div>
        </div>
      )}
      {open && err && <div className="qk-err">{err}</div>}
      {open && msg && <div className="qk-msg">{msg}</div>}
      {tip && <ChipTooltip tip={tip} />}
      {editorOpen && (
        <CodecEditorModal
          initial={editorOpen.def}
          onClose={() => setEditorOpen(null)}
          onSaved={(id) => {
            setEditorOpen(null);
            switchCodec(`user:${id}`);
            showMsg(tx("已保存，可在协议下拉中选用", "Saved — pick it from the protocol dropdown"));
          }}
        />
      )}
      {myOpen && (
        <MyCodecsModal
          onClose={() => setMyOpen(false)}
          onEdit={(def) => {
            setMyOpen(false);
            setEditorOpen({ def });
          }}
          onDeleted={(id) => {
            if (codecId === `user:${id}`) switchCodec(CODECS[0].id);
          }}
        />
      )}
      {manageOpen && <ManageModal onClose={() => setManageOpen(false)} />}
    </div>
  );
}

function ManageModal(props: { onClose: () => void }) {
  const cmds = useSyncExternalStore(cmdStore.subscribe, cmdStore.getSnapshot);
  const [grpId, setGrpId] = useState(cmds.groups[0]?.id ?? "");
  const grp = cmds.groups.find((g) => g.id === grpId) ?? cmds.groups[0];

  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{tx("快捷指令管理", "Quick command manager")}</div>
        <div className="form-row">
          <label>{tx("分组", "Group")}</label>
          <select
            className="input"
            value={grp?.id ?? ""}
            onChange={(e) => setGrpId(e.target.value)}
          >
            {cmds.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}（{g.items.length}）
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => cmdStore.addGroup(tx(`分组${cmds.groups.length + 1}`, `Group ${cmds.groups.length + 1}`))}
          >
            {tx("新增分组", "New group")}
          </button>
          {grp && cmds.groups.length > 1 && (
            <button
              className="btn"
              onClick={() => {
                cmdStore.removeNode(grp.id);
                setGrpId(cmdStore.getSnapshot().groups[0]?.id ?? "");
              }}
            >
              {tx("删除该组", "Delete group")}
            </button>
          )}
        </div>
        <div className="qk-manage-list">
          {grp?.items.map((n) =>
            "items" in n ? null : (
              <div key={n.id} className="qk-manage-row">
                <input
                  className="input"
                  style={{ width: 110 }}
                  value={n.name}
                  onChange={(e) => cmdStore.patchCommand(n.id, { name: e.target.value })}
                  placeholder={tx("名称", "Name")}
                />
                <select
                  className="input"
                  style={{ width: 72 }}
                  value={n.sendMode}
                  onChange={(e) =>
                    cmdStore.patchCommand(n.id, { sendMode: e.target.value as "ascii" | "hex" })
                  }
                >
                  <option value="ascii">ASCII</option>
                  <option value="hex">Hex</option>
                </select>
                <input
                  className="input"
                  style={{ flex: 1, fontFamily: "var(--font-mono)" }}
                  value={n.template}
                  onChange={(e) => cmdStore.patchCommand(n.id, { template: e.target.value })}
                  placeholder={n.scriptEnabled ? tx("（脚本命令）", "(script command)") : tx("发送内容，如 FF AA 69 88 B5 或 RST!", "Payload, e.g. FF AA 69 88 B5 or RST!")}
                  disabled={Boolean(n.scriptEnabled && n.script)}
                  title={n.scriptEnabled ? tx("脚本命令，请在控制画布的命令树中编辑", "Script command — edit it in the control canvas command tree") : n.note}
                />
                <button className="btn" onClick={() => cmdStore.removeNode(n.id)} title={t("c.delete")}>
                  <IconClose />
                </button>
              </div>
            ),
          )}
          {!grp?.items.length && <div className="qk-empty">{tx("该分组暂无指令", "No commands in this group")}</div>}
        </div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <button
            className="btn primary"
            disabled={!grp}
            onClick={() => grp && cmdStore.addCommand(grp.id)}
          >
            {tx("新增命令", "New command")}
          </button>
          <span className="form-hint">
            {tx("⚡脚本命令与分组重命名请在左侧「命令」导轨里编辑；此处改动与命令库实时互通", "⚡ Script commands and group renaming are edited in the Commands rail on the left; changes here sync with the command library live")}
          </span>
        </div>
      </div>
    </div>
  );
}
