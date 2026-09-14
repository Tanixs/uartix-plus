/**
 * 虚拟设备工坊面板（P78c；P79-R UI 重设计 + 数值捕获/多目标）。
 *
 * 布局原则（用户反馈：框和文字错位重叠）：
 *  - 一切「标签在上、输入在下」的网格单元（.vdev-cell），横排永不因文字长度互挤；
 *  - 同构行（信号/字段/输入量）用共享列头 + 等宽网格，参数列内小输入用 placeholder 自标；
 *  - 命令行两段式：匹配一行、赋值+应答一行，避免一行塞六个控件；
 *  - 运行中 fieldset 整体锁定（停机才能改，语义清晰）。
 *
 * 红线对齐：数据在 Rust vdev.rs 经 ingest 单点进管线（本面板不碰帧流）；
 * 虚拟设备是数据源不是面板功能（与演示源同权），关面板照常运行、状态栏徽标兜底。
 */
import { useEffect, useState } from "react";
import * as vdevStore from "./vdevStore";
import type { VDevCommand, VDevField, VDevFrameCfg, VDevNet, VDevNetTransport, VDevSignal, VDevSpec } from "./vdevStore";
import { tx, useLocale } from "../../i18n/strings";
import { IconClose, IconPlay, IconPlus } from "../../shared/icons";
import { requestAsk } from "../ai/chatStore";
import { toast } from "../ai/extRuntime";

const MODELS: { k: VDevSignal["model"]; zh: string; en: string }[] = [
  { k: "sine", zh: "正弦", en: "sine" },
  { k: "square", zh: "方波", en: "square" },
  { k: "triangle", zh: "三角波", en: "triangle" },
  { k: "const", zh: "常量", en: "const" },
  { k: "firstOrder", zh: "一阶对象", en: "1st-order" },
  { k: "mirror", zh: "镜像", en: "mirror" },
];

const FIELD_TYPES: VDevField["type"][] = ["int16", "uint16", "int8", "uint8", "int32", "uint32", "float32", "float64"];

function emptyNet(): VDevNet {
  return { transport: "udp", host: "127.0.0.1", port: 9010, bind: "127.0.0.1", listenPort: 0, listenBind: "127.0.0.1", path: "", baud: 115200, extraTargets: [] };
}

function emptySpec(): VDevSpec {
  return {
    kind: "uartix-vdev",
    version: 1,
    name: tx("新设备", "New device"),
    desc: "",
    periodMs: 100,
    frame: { header: "AA 55", footer: "", checksum: "sum8", fields: [{ signal: "value", type: "int16", endian: "little", scale: 1 }] },
    inputs: [{ name: "cmd", value: 0 }],
    signals: [{ name: "value", model: "sine", amp: 100, freqHz: 1, offset: 0, phaseDeg: 0, noise: 1, driftPerMin: 0 }],
    faults: { dropPct: 0, stuckPct: 0, spikePct: 0, spikeAmp: 0, spikeSignal: "" },
    commands: [],
  };
}

export function VdevPanel() {
  useLocale();
  const s = vdevStore.useVdev();
  const [pick, setPick] = useState("");
  const spec = s.editing;

  useEffect(() => {
    void vdevStore.refreshRunning();
  }, []);
  useEffect(() => {
    if (!s.running) return;
    const h = window.setInterval(() => void vdevStore.fetchStatus(), 1000);
    return () => window.clearInterval(h);
  }, [s.running]);

  const patch = (p: Partial<VDevSpec>) => {
    if (!spec) return;
    vdevStore.setEditing({ ...spec, ...p });
  };
  const patchNet = (p: Partial<VDevNet>) => {
    if (!spec) return;
    const base = spec.net ?? emptyNet();
    const next = { ...base, ...p };
    if (next.bind === "0.0.0.0" && base.bind !== "0.0.0.0") {
      if (!window.confirm(tx("绑定 0.0.0.0 将允许局域网内任意主机连接/发令，确定？", "Binding 0.0.0.0 lets any LAN host connect and send commands. Continue?"))) {
        return;
      }
    }
    patch({ net: next });
  };
  const patchSignal = (idx: number, p: Partial<VDevSignal>) => {
    if (!spec) return;
    patch({ signals: spec.signals.map((x, i) => (i === idx ? ({ ...x, ...p } as VDevSignal) : x)) });
  };
  const patchField = (idx: number, p: Partial<VDevField>) => {
    if (!spec) return;
    patch({ frame: { ...spec.frame, fields: spec.frame.fields.map((x, i) => (i === idx ? { ...x, ...p } : x)) } });
  };
  const patchCommand = (idx: number, p: Partial<VDevCommand>) => {
    if (!spec) return;
    patch({ commands: spec.commands.map((x, i) => (i === idx ? { ...x, ...p } : x)) });
  };

  const toggleRun = async () => {
    if (s.running) {
      await vdevStore.stopDevice();
      return;
    }
    if (!spec) {
      toast(tx("先从左侧选择或新建一台设备", "Pick or create a device first"));
      return;
    }
    await vdevStore.startDevice(spec);
  };

  const loadBuiltin = (name: string) => {
    const b = vdevStore.builtinSpecs().find((x) => x.name === name);
    if (b) vdevStore.loadEditing(structuredClone(b), null);
    setPick("");
  };

  const doImport = async (f: File) => {
    try {
      const parsed = vdevStore.normalizeSpec(JSON.parse(await f.text()));
      vdevStore.loadEditing(parsed, null);
      toast(tx(`已载入「${parsed.name}」（未运行，检查后点启动）`, `Loaded "${parsed.name}" (not running — review then start)`));
    } catch (e) {
      toast(tx(`导入失败：${e instanceof Error ? e.message : String(e)}`, `Import failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  };

  const doExport = async () => {
    if (!spec) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const path = await save({
        defaultPath: `${spec.name || "vdev"}.vdev.json`,
        filters: [{ name: "Uartix 虚拟设备", extensions: ["json"] }],
      });
      if (typeof path !== "string") return;
      await invoke("save_text_file", { path, content: JSON.stringify(spec, null, 2) });
      toast(tx("已导出虚拟设备（教学关卡可分享）", "Virtual device exported (shareable as a lesson)"));
    } catch {
      const blob = new Blob([JSON.stringify(spec, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${spec.name || "vdev"}.vdev.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };

  const askAi = () => {
    const r = requestAsk(
      tx(
        "请帮我生成一个虚拟设备规格（uartix-action：kind=vdev, op=create）。需求：",
        "Generate a virtual device spec for me (uartix-action: kind=vdev, op=create). Requirements: ",
      ),
    );
    toast(r.ok ? tx("已把需求转给 AI 助手，回答里点「执行」即可入库", "Sent to the AI assistant — click Run in its reply to save") : r.err ?? tx("AI 助手忙，稍后再试", "AI busy, try later"));
  };

  return (
    <div className="vdev">
      <div className="vdev-bar">
        <button
          className={`btn sm${s.running ? " danger" : " primary"}`}
          onClick={() => void toggleRun()}
          title={s.running ? tx("停止仿真（数据流随之中断）", "Stop the simulation") : tx("启动仿真：经 ingest 单点进入全管线", "Start the simulation")}
        >
          {s.running ? <IconClose /> : <IconPlay />}
          {s.running ? tx("停止设备", "Stop device") : tx("启动设备", "Start device")}
        </button>
        <button
          className={`btn sm${s.dirty && !s.running ? " primary" : ""}`}
          disabled={!s.dirty || s.running}
          title={s.dirty ? tx("保存当前编辑到设备库（按设备名原位更新，不产生重复条目）", "Save the current spec to the library (updates in place, no duplicates)") : tx("没有未保存的修改", "Nothing to save")}
          onClick={() => {
            const name = vdevStore.saveEditing();
            if (name) toast(tx(`已保存到设备库「${name}」`, `Saved "${name}" to the library`));
          }}
        >
          {tx("保存", "Save")}
          {s.dirty && !s.running && <i className="vdev-dirty" />}
        </button>
        <span
          className={`vdev-state${s.running ? " on" : ""}`}
          title={s.running ? tx("虚拟设备仿真运行中；命令经发送路由进入设备", "Device running; commands route into it") : tx("空闲", "Idle")}
        >
          {s.running ? tx(`运行中 · ${s.device ?? ""}`, `running · ${s.device ?? ""}`) : tx("空闲", "Idle")}
        </span>
        <select className="input" value={pick} onChange={(e) => loadBuiltin(e.target.value)} disabled={s.running} title={tx("载入内置设备", "Load a built-in device")}>
          <option value="" hidden>{tx("内置设备…", "Built-in…")}</option>
          {vdevStore.builtinSpecs().map((b) => (
            <option key={b.name} value={b.name}>{b.name}</option>
          ))}
        </select>
        <span className="vdev-sp" />
        <button className="btn sm" disabled={s.running} onClick={askAi} title={tx("让 AI 按自然语言生成设备规格（存入设备库）", "Ask AI to generate a device spec")}>
          {tx("AI 生成", "AI generate")}
        </button>
        <button className="btn sm" disabled={!spec || s.running} onClick={() => spec && vdevStore.loadEditing(structuredClone(spec), null)} title={tx("把当前编辑另存为新设备（未保存态，点保存入库）", "Copy the current spec as a new device (unsaved until Save)")}>
          {tx("另存副本", "Duplicate")}
        </button>
        <label className={`btn sm${(!spec || s.running) ? " dis" : ""}`} title={tx("导入设备规格 JSON（教学关卡）", "Import a device spec JSON")}>
          {tx("导入", "Import")}
          <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void doImport(f); }} />
        </label>
        <button className="btn sm" disabled={!spec} onClick={() => void doExport()} title={tx("导出当前设备规格 JSON", "Export the current spec")}>
          {tx("导出", "Export")}
        </button>
      </div>
      <div className="vdev-body">
        <div className="vdev-lib">
          <div className="vdev-lib-h">
            {tx("设备库", "Library")}
            <button className="btn sm" disabled={s.running} title={tx("新建空白设备（点保存后入设备库）", "New blank device (Save to add it to the library)")} onClick={() => vdevStore.loadEditing(emptySpec(), null)}>
              <IconPlus />
            </button>
          </div>
          {s.specs.length === 0 && <div className="vdev-lib-empty">{tx("还没有保存的设备。用内置设备或 AI 生成一个。", "No saved devices yet — load a built-in or ask AI.")}</div>}
          {s.specs.map((it) => (
            <div key={it.id} className={`vdev-lib-it${spec?.name === it.spec.name ? " sel" : ""}`}>
              <button className="vdev-lib-n" onClick={() => !s.running && vdevStore.loadEditing(structuredClone(it.spec), it.id)} title={tx("载入编辑", "Load into editor")}>
                {it.spec.name}
              </button>
              <button
                className="vdev-lib-x"
                disabled={s.running}
                title={tx("从设备库删除", "Remove from library")}
                onClick={() => {
                  if (!window.confirm(tx(`从设备库删除「${it.spec.name}」？（正在运行的设备不受影响）`, `Remove "${it.spec.name}" from the library? (a running device is unaffected)`))) return;
                  vdevStore.removeFromLibrary(it.id);
                }}
              >
                <IconClose />
              </button>
            </div>
          ))}
          <div className="vdev-lib-tip">
            {tx("运行中面板可以关闭：数据源与演示源同权继续跑，状态栏有「虚拟设备」徽标兜底。", "The panel may be closed while running — the source keeps feeding; the status bar shows a badge.")}
          </div>
        </div>
        {!spec ? (
          <div className="vdev-empty">
            <div className="vdev-empty-t">{tx("虚拟设备工坊", "Virtual Device Workshop")}</div>
            <div className="vdev-empty-d">
              {tx(
                "用自然语言让 AI 生成虚拟传感器（有温漂、偶尔丢帧的 MPU6050…），或载入内置设备；设备像真的一样输出数据帧、接收指令并反应，还能经 UDP/TCP/串口对外收发。与时间机器互补：回放的是过去，虚拟设备生成的是现在。",
                "Describe a sensor in natural language and let AI build it, or load a built-in. Devices stream frames, react to commands, and can emit/receive over UDP/TCP/serial.",
              )}
            </div>
            <ol className="vdev-steps">
              <li>{tx("载入内置设备或 AI 生成 → 检查规格", "Load a built-in or ask AI → review the spec")}</li>
              <li>{tx("点「启动设备」：协议模板自动配套，2D 曲线点亮", "Start: the protocol template is auto-imported, curves light up")}</li>
              <li>{tx("从控制台/编排器发命令，设备会反应（HEAT ON…）", "Send commands from console/orchestrator — the device reacts")}</li>
            </ol>
            <div className="vdev-empty-ops">
              <button className="btn primary" onClick={() => loadBuiltin("温控炉")}>
                {tx("载入「温控炉」（PID 教学被控对象）", "Load \"Furnace\" (PID plant)")}
              </button>
              <button className="btn" onClick={() => loadBuiltin("虚拟 MPU6050")}>
                {tx("载入「虚拟 MPU6050」", "Load \"Virtual MPU6050\"")}
              </button>
            </div>
          </div>
        ) : (
          <fieldset className="vdev-editor" disabled={s.running}>
            {s.running && (
              <div className="vdev-lock" title={tx("运行中不能改规格：停机再改，避免半套参数生效", "Editing is locked while running — stop first")}>
                {tx("运行中：规格只读。停止设备后才能编辑。", "Running: spec is read-only. Stop the device to edit.")}
              </div>
            )}
            <div className="vdev-card">
              <div className="vdev-grid4">
                <label className="vdev-cell">
                  <span>{tx("设备名", "Name")}</span>
                  <input className="input" value={spec.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} />
                </label>
                <label className="vdev-cell" title={tx("输出节拍：每多久发一帧", "Frame interval")}>
                  <span>{tx("周期 ms", "Period ms")}</span>
                  <input className="input" type="number" min={20} max={5000} value={spec.periodMs} onChange={(e) => patch({ periodMs: Number(e.target.value) || 100 })} />
                </label>
                <label className="vdev-cell" title={tx("开启后启动即自动导入配套协议模板；WIT 兼容设备等现成预设可解码时关闭它", "When on, starting the device auto-imports its protocol template")}>
                  <span>{tx("自动配套模板", "Auto template")}</span>
                  <span className="vdev-checkrow">
                    <input type="checkbox" checked={spec.skipAutoTpl !== true} onChange={(e) => patch({ skipAutoTpl: !e.target.checked })} />
                    <em>{spec.skipAutoTpl ? tx("关（用现成预设解码）", "off (use a stock preset)") : tx("开（启动时自动导入）", "on (import on start)")}</em>
                  </span>
                </label>
                <label className="vdev-cell">
                  <span>{tx("说明", "Desc")}</span>
                  <input className="input" value={spec.desc} maxLength={200} placeholder={tx("一句话描述这台设备", "What does it simulate?")} onChange={(e) => patch({ desc: e.target.value })} />
                </label>
              </div>
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">
                {tx("信号模型", "Signals")}
                <button className="btn sm" disabled={spec.signals.length >= 32} onClick={() => patch({ signals: [...spec.signals, { name: `sig${spec.signals.length + 1}`, model: "sine", amp: 1, freqHz: 1, offset: 0, phaseDeg: 0, noise: 0, driftPerMin: 0 }] })}>
                  <IconPlus />
                  {tx("加信号", "Add")}
                </button>
              </div>
              <div className="vdev-table">
                <div className="vdev-thead">
                  <span>{tx("名称", "Name")}</span>
                  <span>{tx("模型", "Model")}</span>
                  <span className="wide">{tx("参数", "Params")}</span>
                  <span>{tx("噪声", "Noise")}</span>
                  <span>{tx("漂移/min", "Drift/min")}</span>
                  <span />
                </div>
                {spec.signals.map((sig, i) => (
                  <SignalRow key={i} sig={sig} idx={i} inputs={spec.inputs} signals={spec.signals} patch={patchSignal} remove={() => patch({ signals: spec.signals.filter((_, j) => j !== i) })} />
                ))}
              </div>
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">
                {tx("输入量（命令可写）", "Inputs (command-writable)")}
                <button className="btn sm" disabled={spec.inputs.length >= 16} onClick={() => patch({ inputs: [...spec.inputs, { name: `in${spec.inputs.length + 1}`, value: 0 }] })}>
                  <IconPlus />
                  {tx("加输入量", "Add")}
                </button>
              </div>
              <div className="vdev-thead cols2">
                <span>{tx("名称", "Name")}</span>
                <span>{tx("初值", "Initial")}</span>
                <span />
              </div>
              {spec.inputs.map((ip, i) => (
                <div key={i} className="vdev-grid2">
                  <input className="input" value={ip.name} placeholder="cmd" onChange={(e) => patch({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })} />
                  <input className="input" type="number" value={ip.value} onChange={(e) => patch({ inputs: spec.inputs.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) || 0 } : x)) })} />
                  <button className="vdev-del" title={tx("删除输入量", "Remove input")} onClick={() => patch({ inputs: spec.inputs.filter((_, j) => j !== i) })}>
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">
                {tx("命令（匹配前缀 → 写输入量/应答）", "Commands (match prefix → set / reply)")}
                <button className="btn sm" disabled={spec.commands.length >= 32} onClick={() => patch({ commands: [...spec.commands, { match: { type: "ascii", prefix: "" }, set: {} }] })}>
                  <IconPlus />
                  {tx("加命令", "Add")}
                </button>
              </div>
              {spec.commands.map((c, i) => (
                <div key={i} className="vdev-cmdcard">
                  <div className="vdev-cmdrow">
                    <select className="input vdev-w72" value={c.match.type} onChange={(e) => patchCommand(i, { match: { ...c.match, type: e.target.value as "ascii" | "hex" } })}>
                      <option value="ascii">ASCII</option>
                      <option value="hex">HEX</option>
                    </select>
                    <input className="input grow" value={c.match.prefix} placeholder={c.match.type === "hex" ? "A0 01" : tx("前缀，如 HEAT ON", "prefix e.g. HEAT ON")} onChange={(e) => patchCommand(i, { match: { ...c.match, prefix: e.target.value } })} />
                    <label className="vdev-inline-check" title={tx("捕获前缀后的数值写入输入量（如 SET DUTY 45 → duty=45）；畸形数值按未命中拒收", "Capture the number after the prefix into an input (SET DUTY 45 → duty=45); malformed = no match")}>
                      <input type="checkbox" checked={c.match.captureNumber === true} onChange={(e) => patchCommand(i, { match: { ...c.match, captureNumber: e.target.checked } })} />
                      {tx("捕获数值→", "capture→")}
                    </label>
                    {c.match.captureNumber && (
                      <select className="input vdev-w110" value={c.match.setInput ?? ""} onChange={(e) => patchCommand(i, { match: { ...c.match, setInput: e.target.value } })}>
                        <option value="">{tx("选输入量…", "input…")}</option>
                        {spec.inputs.map((ip) => (
                          <option key={ip.name} value={ip.name}>{ip.name}</option>
                        ))}
                      </select>
                    )}
                    <button className="vdev-del" title={tx("删除命令", "Remove command")} onClick={() => patch({ commands: spec.commands.filter((_, j) => j !== i) })}>
                      <IconClose />
                    </button>
                  </div>
                  <div className="vdev-cmdrow sub">
                    <span className="vdev-lbl">{tx("固定赋值", "set")}</span>
                    {Object.entries(c.set).map(([k, v]) => (
                      <span key={k} className="vdev-chip">
                        <input className="input vdev-w80" value={k} onChange={(e) => {
                          const set: Record<string, number> = {};
                          for (const [k2, v2] of Object.entries(c.set)) set[e.target.value.trim() || k2] = v2;
                          patchCommand(i, { set });
                        }} />
                        <input className="input vdev-w64" type="number" value={v} onChange={(e) => patchCommand(i, { set: { ...c.set, [k]: Number(e.target.value) || 0 } })} />
                        <button className="vdev-chip-x" title={tx("删除赋值", "Remove assignment")} onClick={() => {
                          const set = { ...c.set };
                          delete set[k];
                          patchCommand(i, { set });
                        }}>
                          <IconClose />
                        </button>
                      </span>
                    ))}
                    <button className="btn sm" disabled={Object.keys(c.set).length >= 8} onClick={() => patchCommand(i, { set: { ...c.set, [spec.inputs[0]?.name ?? "in1"]: 0 } })}>
                      <IconPlus />
                    </button>
                    <span className="vdev-lbl">{tx("应答", "reply")}</span>
                    <input className="input vdev-w160" value={c.reply?.text ?? ""} placeholder={tx("可空，如 OK\\n", "optional, e.g. OK")} onChange={(e) => patchCommand(i, { reply: { type: "ascii", text: e.target.value } })} />
                  </div>
                </div>
              ))}
              {spec.commands.length === 0 && <div className="vdev-none">{tx("无命令：这台设备只吐数据、不响应指令", "No commands: emit-only device")}</div>}
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">
                {tx("帧格式", "Frame")}
                <button className="btn sm" disabled={spec.frame.fields.length >= 32} onClick={() => patch({ frame: { ...spec.frame, fields: [...spec.frame.fields, { signal: `f${spec.frame.fields.length + 1}`, type: "int16", endian: "little", scale: 1 }] } })}>
                  <IconPlus />
                  {tx("加字段", "Add")}
                </button>
              </div>
              <div className="vdev-grid4 vdev-mb6">
                <label className="vdev-cell">
                  <span>{tx("帧头 (HEX)", "Header")}</span>
                  <input className="input vdev-mono" value={spec.frame.header} placeholder="AA 55" onChange={(e) => patch({ frame: { ...spec.frame, header: e.target.value } })} />
                </label>
                <label className="vdev-cell">
                  <span>{tx("帧尾 (HEX)", "Footer")}</span>
                  <input className="input vdev-mono" value={spec.frame.footer} onChange={(e) => patch({ frame: { ...spec.frame, footer: e.target.value } })} />
                </label>
                <label className="vdev-cell">
                  <span>{tx("校验", "Checksum")}</span>
                  <select className="input" value={spec.frame.checksum} onChange={(e) => patch({ frame: { ...spec.frame, checksum: e.target.value as VDevFrameCfg["checksum"] } })}>
                    <option value="sum8">sum8</option>
                    <option value="xor8">xor8</option>
                    <option value="crc16_modbus">crc16_modbus</option>
                    <option value="none">none</option>
                  </select>
                </label>
              </div>
              <div className="vdev-table">
              <div className="vdev-thead cols4">
                <span>{tx("信号", "Signal")}</span>
                <span>{tx("类型", "Type")}</span>
                <span>{tx("端序", "Endian")}</span>
                <span>{tx("缩放", "Scale")}</span>
                <span />
              </div>
              {spec.frame.fields.map((f, i) => (
                <div key={i} className="vdev-frow">
                  <input className="input" value={f.signal} onChange={(e) => patchField(i, { signal: e.target.value.trim() })} />
                  <select className="input" value={f.type} onChange={(e) => patchField(i, { type: e.target.value as VDevField["type"] })}>
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select className="input" value={f.endian} onChange={(e) => patchField(i, { endian: e.target.value as VDevField["endian"] })}>
                    <option value="little">LE</option>
                    <option value="big">BE</option>
                  </select>
                  <input className="input" type="number" step="any" value={f.scale} title={tx("物理值 = 原始值 × scale", "physics = raw × scale")} onChange={(e) => patchField(i, { scale: Number(e.target.value) || 1 })} />
                  <button className="vdev-del" title={tx("删除字段", "Remove field")} onClick={() => patch({ frame: { ...spec.frame, fields: spec.frame.fields.filter((_, j) => j !== i) } })}>
                    <IconClose />
                  </button>
                </div>
              ))}
              </div>
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">{tx("故障注入", "Fault injection")}</div>
              <div className="vdev-grid5">
                <label className="vdev-cell" title={tx("随机丢帧概率", "Random frame drop")}>
                  <span>{tx("丢帧 %", "Drop %")}</span>
                  <input className="input" type="number" min={0} max={95} value={spec.faults.dropPct} onChange={(e) => patch({ faults: { ...spec.faults, dropPct: Math.min(95, Math.max(0, Number(e.target.value) || 0)) } })} />
                </label>
                <label className="vdev-cell" title={tx("重发上一帧（传感器卡死）", "Resend previous frame (stuck)")}>
                  <span>{tx("卡死 %", "Stuck %")}</span>
                  <input className="input" type="number" min={0} max={95} value={spec.faults.stuckPct} onChange={(e) => patch({ faults: { ...spec.faults, stuckPct: Math.min(95, Math.max(0, Number(e.target.value) || 0)) } })} />
                </label>
                <label className="vdev-cell">
                  <span>{tx("毛刺 %", "Spike %")}</span>
                  <input className="input" type="number" min={0} max={95} value={spec.faults.spikePct} onChange={(e) => patch({ faults: { ...spec.faults, spikePct: Math.min(95, Math.max(0, Number(e.target.value) || 0)) } })} />
                </label>
                <label className="vdev-cell">
                  <span>{tx("毛刺幅度", "Spike amp")}</span>
                  <input className="input" type="number" value={spec.faults.spikeAmp} onChange={(e) => patch({ faults: { ...spec.faults, spikeAmp: Number(e.target.value) || 0 } })} />
                </label>
                <label className="vdev-cell">
                  <span>{tx("毛刺信号", "Spike signal")}</span>
                  <select className="input" value={spec.faults.spikeSignal} onChange={(e) => patch({ faults: { ...spec.faults, spikeSignal: e.target.value } })}>
                    <option value="">{tx("关", "off")}</option>
                    {spec.signals.map((x) => (
                      <option key={x.name} value={x.name}>{x.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="vdev-card">
              <div className="vdev-card-h">{tx("网络（对外收发）", "Network (emit & command-in)")}</div>
              <div className="vdev-grid4">
                <label className="vdev-cell">
                  <span>{tx("链路", "Link")}</span>
                  <select className="input" value={spec.net?.transport ?? "none"} disabled={s.running} onChange={(e) => {
                    const v = e.target.value;
                    if (v === "none") patch({ net: undefined });
                    else patchNet({ ...(spec.net ?? emptyNet()), transport: v as VDevNetTransport });
                  }}>
                    <option value="none">{tx("关（仅本机仿真）", "Off (local only)")}</option>
                    <option value="udp">UDP</option>
                    <option value="tcp-client">TCP {tx("客户端（拨出）", "client")}</option>
                    <option value="tcp-server">TCP {tx("服务端（监听）", "server")}</option>
                    <option value="serial">{tx("串口", "Serial")}</option>
                  </select>
                </label>
                {spec.net?.transport === "udp" && (
                  <>
                    <label className="vdev-cell">
                      <span>{tx("目标主机", "Host")}</span>
                      <input className="input" value={spec.net.host} onChange={(e) => patchNet({ host: e.target.value.trim() })} />
                    </label>
                    <label className="vdev-cell">
                      <span>{tx("目标端口", "Port")}</span>
                      <input className="input" type="number" value={spec.net.port} onChange={(e) => patchNet({ port: Number(e.target.value) || 0 })} />
                    </label>
                    <label className="vdev-cell" title={tx("可选：监听一个 UDP 端口接收外部命令（TCP/串口天然双向无需此项）", "Optional UDP command listener (TCP/serial are bidirectional by nature)")}>
                      <span>{tx("收令端口", "Cmd port")}</span>
                      <input className="input" type="number" value={spec.net.listenPort} onChange={(e) => patchNet({ listenPort: Number(e.target.value) || 0 })} />
                    </label>
                  </>
                )}
                {spec.net?.transport === "tcp-client" && (
                  <>
                    <label className="vdev-cell">
                      <span>{tx("对端主机", "Peer")}</span>
                      <input className="input" value={spec.net.host} onChange={(e) => patchNet({ host: e.target.value.trim() })} />
                    </label>
                    <label className="vdev-cell">
                      <span>{tx("对端端口", "Port")}</span>
                      <input className="input" type="number" value={spec.net.port} onChange={(e) => patchNet({ port: Number(e.target.value) || 0 })} />
                    </label>
                  </>
                )}
                {spec.net?.transport === "tcp-server" && (
                  <>
                    <label className="vdev-cell" title={tx("0.0.0.0 = 允许局域网连接（需确认）", "0.0.0.0 = allow LAN (confirm)")}>
                      <span>{tx("监听地址", "Bind")}</span>
                      <select className="input" value={spec.net.bind} onChange={(e) => patchNet({ bind: e.target.value })}>
                        <option value="127.0.0.1">127.0.0.1</option>
                        <option value="0.0.0.0">0.0.0.0</option>
                      </select>
                    </label>
                    <label className="vdev-cell">
                      <span>{tx("监听端口", "Port")}</span>
                      <input className="input" type="number" value={spec.net.port} onChange={(e) => patchNet({ port: Number(e.target.value) || 0 })} />
                    </label>
                  </>
                )}
                {spec.net?.transport === "serial" && (
                  <>
                    <label className="vdev-cell" title={tx("设备独占该 COM 口；接收端可用 com0com 虚拟串口对", "The device owns this COM port; use a com0com pair for the receiver")}>
                      <span>{tx("端口路径", "Port")}</span>
                      <input className="input" value={spec.net.path} placeholder="COM5" onChange={(e) => patchNet({ path: e.target.value.trim() })} />
                    </label>
                    <label className="vdev-cell">
                      <span>{tx("波特率", "Baud")}</span>
                      <input className="input" type="number" value={spec.net.baud} onChange={(e) => patchNet({ baud: Number(e.target.value) || 115200 })} />
                    </label>
                  </>
                )}
              </div>
              {spec.net?.transport === "udp" && (
                <div className="vdev-targets">
                  <div className="vdev-card-h sub">
                    {tx("附加目标（一帧多投，≤4）", "Extra targets (≤4)")}
                    <button className="btn sm" disabled={spec.net.extraTargets.length >= 4} onClick={() => patchNet({ extraTargets: [...spec.net!.extraTargets, { host: "127.0.0.1", port: 0 }] })}>
                      <IconPlus />
                    </button>
                  </div>
                  {spec.net.extraTargets.map((t, i) => (
                    <div key={i} className="vdev-grid2">
                      <input className="input" value={t.host} onChange={(e) => patchNet({ extraTargets: spec.net!.extraTargets.map((x, j) => (j === i ? { ...x, host: e.target.value.trim() } : x)) })} />
                      <input className="input" type="number" value={t.port} onChange={(e) => patchNet({ extraTargets: spec.net!.extraTargets.map((x, j) => (j === i ? { ...x, port: Number(e.target.value) || 0 } : x)) })} />
                      <button className="vdev-del" title={tx("删除目标", "Remove target")} onClick={() => patchNet({ extraTargets: spec.net!.extraTargets.filter((_, j) => j !== i) })}>
                        <IconClose />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {s.running && spec.net && (
                <div className="vdev-netline">
                  <span>{spec.net.transport} · {s.netStatus?.target ?? tx("连接中…", "connecting…")}</span>
                  {s.netStatus && (
                    <>
                      <span>→ {s.netStatus.outSent} {tx("帧", "fr")}/{s.netStatus.outBytes}B</span>
                      {s.netStatus.outErrs > 0 && <span className="bad">✗{s.netStatus.outErrs}</span>}
                      <span>← {s.netStatus.inRecv} {tx("收令", "cmd")}</span>
                      {spec.net.transport === "tcp-server" && <span>· {s.netStatus.clients} {tx("客户端", "cli")}</span>}
                      {s.netStatus.lastCmd && <span className="vdev-netcmd" title={tx("最近收到的命令", "Last command")}>{s.netStatus.lastCmd}</span>}
                      {s.netStatus.lastError && <span className="bad" title={s.netStatus.lastError}>{tx("链路异常", "link error")}</span>}
                    </>
                  )}
                </div>
              )}
            </div>
            {s.err && <div className="vdev-err">{s.err}</div>}
            <div className="vdev-hint">
              {tx(
                "启动后：协议模板自动配套（关「自动配套模板」则用现成预设解码）；控制台/编排器/序列器与网络来令走同一命令匹配器，网络应答原路返回；TX/RX 与坏帧统计走全管线。",
                "On start the protocol template is auto-imported (turn it off when a stock preset decodes it). Local and network commands share one matcher; network replies go back to the sender.",
              )}
            </div>
          </fieldset>
        )}
      </div>
    </div>
  );
}

/** 信号行：列头共享；参数列按模型出小输入，placeholder 即标签（避免横排文字互挤） */
function SignalRow(props: {
  sig: VDevSignal;
  idx: number;
  inputs: { name: string; value: number }[];
  signals: VDevSignal[];
  patch: (idx: number, p: Partial<VDevSignal>) => void;
  remove: () => void;
}) {
  const { sig, idx, inputs, signals, patch, remove } = props;
  const p = (k: string, v: number) => patch(idx, { [k]: v } as Partial<VDevSignal>);
  return (
    <div className="vdev-srow">
      <input className="input" value={sig.name} title={tx("信号名", "Signal name")} onChange={(e) => patch(idx, { name: e.target.value.trim() } as Partial<VDevSignal>)} />
      <select className="input" value={sig.model} onChange={(e) => patch(idx, switchModel(e.target.value as VDevSignal["model"]))}>
        {MODELS.map((m) => (
          <option key={m.k} value={m.k}>{tx(m.zh, m.en)}</option>
        ))}
      </select>
      <div className="vdev-params">
        {sig.model === "const" && <PCell label={tx("值", "value")} v={sig.value} on={(v) => p("value", v)} />}
        {sig.model === "sine" && (
          <>
            <PCell label={tx("幅值", "amp")} v={sig.amp} on={(v) => p("amp", v)} />
            <PCell label={tx("频率", "freq")} v={sig.freqHz} step={0.1} on={(v) => p("freqHz", v)} />
            <PCell label={tx("偏置", "offset")} v={sig.offset} on={(v) => p("offset", v)} />
            <PCell label={tx("相位°", "phase")} v={sig.phaseDeg} on={(v) => p("phaseDeg", v)} />
          </>
        )}
        {sig.model === "square" && (
          <>
            <PCell label={tx("幅值", "amp")} v={sig.amp} on={(v) => p("amp", v)} />
            <PCell label={tx("频率", "freq")} v={sig.freqHz} step={0.1} on={(v) => p("freqHz", v)} />
            <PCell label={tx("偏置", "offset")} v={sig.offset} on={(v) => p("offset", v)} />
            <PCell label={tx("占空比", "duty")} v={sig.duty} step={0.1} on={(v) => p("duty", v)} />
          </>
        )}
        {sig.model === "triangle" && (
          <>
            <PCell label={tx("幅值", "amp")} v={sig.amp} on={(v) => p("amp", v)} />
            <PCell label={tx("频率", "freq")} v={sig.freqHz} step={0.1} on={(v) => p("freqHz", v)} />
            <PCell label={tx("偏置", "offset")} v={sig.offset} on={(v) => p("offset", v)} />
          </>
        )}
        {sig.model === "firstOrder" && (
          <>
            <label className="vdev-pcell" title={tx("驱动输入量", "Driving input")}>
              <span>{tx("输入量", "input")}</span>
              <select className="input" value={sig.from} onChange={(e) => patch(idx, { from: e.target.value } as Partial<VDevSignal>)}>
                {inputs.map((n) => (
                  <option key={n.name} value={n.name}>{n.name}</option>
                ))}
              </select>
            </label>
            <PCell label="K" v={sig.gain} on={(v) => p("gain", v)} />
            <PCell label={tx("τ s", "tau s")} v={sig.tau} step={0.1} on={(v) => p("tau", v)} />
            <PCell label={tx("环境值", "ambient")} v={sig.ambient} on={(v) => p("ambient", v)} />
            <PCell label={tx("初值", "init")} v={sig.init} on={(v) => p("init", v)} />
          </>
        )}
        {sig.model === "mirror" && (
          <label className="vdev-pcell wide" title={tx("镜像的信号或输入量", "Signal or input to mirror")}>
            <span>{tx("镜像自", "mirror of")}</span>
            <select className="input" value={sig.of} onChange={(e) => patch(idx, { of: e.target.value } as Partial<VDevSignal>)}>
              {signals.map((x) => x.name).filter((n) => n !== sig.name).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
              {inputs.map((n) => (
                <option key={n.name} value={n.name}>{n.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <PCell label={tx("噪声", "noise")} v={sig.noise} step={0.1} title={tx("均匀噪声幅度", "Uniform noise amplitude")} on={(v) => p("noise", v)} />
      <PCell label={tx("漂移/min", "drift/min")} v={sig.driftPerMin} title={tx("每分钟漂移", "Drift per minute")} on={(v) => p("driftPerMin", v)} />
      <button className="vdev-del" title={tx("删除信号", "Remove signal")} onClick={remove}>
        <IconClose />
      </button>
    </div>
  );
}

function switchModel(m: VDevSignal["model"]): Partial<VDevSignal> {
  switch (m) {
    case "const": return { model: m, value: 0 } as Partial<VDevSignal>;
    case "sine": return { model: m, amp: 1, freqHz: 1, offset: 0, phaseDeg: 0 } as Partial<VDevSignal>;
    case "square": return { model: m, amp: 1, freqHz: 1, offset: 0, duty: 0.5 } as Partial<VDevSignal>;
    case "triangle": return { model: m, amp: 1, freqHz: 1, offset: 0 } as Partial<VDevSignal>;
    case "firstOrder": return { model: m, from: "", gain: 1, tau: 1, ambient: 0, init: 0 } as Partial<VDevSignal>;
    case "mirror": return { model: m, of: "" } as Partial<VDevSignal>;
  }
}

/** 参数微格：标签在上、输入在下（与全表面板同一「标签在上」原则，不再依赖 placeholder 当标签） */
function PCell(props: { label: string; v: number; step?: number; title?: string; on: (v: number) => void }) {
  return (
    <label className="vdev-pcell" title={props.title ?? props.label}>
      <span>{props.label}</span>
      <input
        className="input"
        type="number"
        step={props.step ?? 1}
        value={props.v}
        onChange={(e) => props.on(Number(e.target.value) || 0)}
      />
    </label>
  );
}
