/**
 * B4e：编排组内置模板库（详设 §7.2）；P78b 扩展为可携带变量声明与多组。
 *
 * build() 返回 { groups, vars? }：groups 每次生成全新 id 的 GroupNode 字面量
 * （不持久化用户修改）；vars 为可选的变量声明（导入时逐个 addVar，重名跳过）。
 * 导入走 orchestratorStore.importPresetGroup + addVar（guardLocked + groupCap 红线），
 * **默认未启用**（与序列导入同红线：参数是示意值，用户检查后手动打开，绝不静默开跑）。
 */
import { newId } from "./blockRegistry";
import type { FlowNode, FlowVar, GroupNode } from "./types";

export interface OrchPreset {
  id: string;
  name: { zh: string; en: string };
  desc: { zh: string; en: string };
  build(): { groups: GroupNode[]; vars?: FlowVar[] };
}

/** 块工厂：默认 enabled + onFail=continue，id 自动生成；node 形状由调用处按 kind 保证 */
const blk = (node: { kind: string; [k: string]: unknown }): FlowNode =>
  ({ id: newId("b"), enabled: true, onFail: "continue", ...node }) as FlowNode;

export const ORCH_PRESETS: OrchPreset[] = [
  {
    id: "alarm-notify",
    name: { zh: "报警通知", en: "Alarm notify" },
    desc: { zh: "通道越过阈值 → 弹警示 + 提示音（改通道与阈值即用）", en: "Threshold crossing → toast + sound" },
    build: () => ({
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "报警通知",
          enabled: false,
          cooldownMs: 1000,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "threshold", chId: "", op: "above", value: 0, edge: "enter", debounceMs: 300 }],
          children: [
            blk({ kind: "toast", level: "warn", text: "阈值告警 evt=${evt.value}" }),
            blk({ kind: "sound", level: "warn" }),
          ],
        },
      ],
    }),
  },
  {
    id: "watchdog",
    name: { zh: "看门狗", en: "Watchdog" },
    desc: { zh: "通信静默超过时长 → 弹严重告警并补发喂狗帧", en: "Silence → crit toast + keepalive frame" },
    build: () => ({
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "看门狗",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "idle", idleMs: 10000 }],
          children: [
            blk({ kind: "toast", level: "crit", text: "通信静默 ≥10s" }),
            blk({ kind: "send", payload: { type: "hex", text: "FF" } }),
          ],
        },
      ],
    }),
  },
  {
    id: "poll",
    name: { zh: "定时轮询", en: "Polling" },
    desc: { zh: "按固定间隔发查询帧（示意 Modbus 读保持寄存器，换帧即用）", en: "Send a query frame on a fixed interval" },
    build: () => ({
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "定时轮询",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "timer", intervalMs: 5000 }],
          children: [
            // 示意：Modbus RTU FC03 从站1 地址0 数量2（CRC 已算好）
            blk({ kind: "send", payload: { type: "hex", text: "01 03 00 00 00 02 C4 0B" } }),
          ],
        },
      ],
    }),
  },
  {
    id: "handshake",
    name: { zh: "收发握手", en: "Handshake" },
    desc: { zh: "收到指定帧 → 回应答帧 → 等确认 → 通过后弹通知", en: "On frame → reply → await ack → notify" },
    build: () => ({
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "收发握手",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "frame", match: { by: "raw", hex: "55 59" }, stride: 1 }],
          children: [
            blk({ kind: "send", onFail: "abort", payload: { type: "hex", text: "AA 55" } }),
            blk({ kind: "waitFrame", onFail: "abort", match: { by: "raw", hex: "AA" }, timeoutMs: 1000, ignoreFail: false }),
            {
              id: newId("b"),
              kind: "if",
              enabled: true,
              conds: [],
              then: [{ id: newId("b"), kind: "toast", enabled: true, onFail: "continue", level: "info", text: "握手完成" }],
              els: [],
            },
          ],
        },
      ],
    }),
  },
  /* ================= P78b：PID 继电反馈自整定（临界比例度法） =================
     继电反馈（Åström-Hägglund）：被控量越过 SP+hys → 关执行器；低于 SP−hys → 开执行器，
     系统进入等幅摆动。上穿越间隔 = 摆动周期 Tu；临界增益 Ku = 4d/(πa) = 1.2732·d/a；
     Z-N 经典整定：Kp=0.6Ku、Ti=Tu/2、Td=Tu/8。全部用现成块表达，导入后：
     ①选两个阈值事件的通道与值（SP±hys）②把 send 换成自己设备的开关命令
     ③变量 d/amp 按执行器步进与曲线峰谷修正 ④启用 + 总开关。
     教学闭环：配「虚拟设备工坊 → 温控炉」即可无硬件跑通全流程。 */
  {
    id: "pid-relay",
    name: { zh: "PID 继电反馈整定", en: "PID relay autotune" },
    desc: {
      zh: "继电反馈法自动整定 PID：超设定值关、低于设定值开，测摆动周期 → 算 Ku/Kp/Ti/Td → 自动发参（配温控炉可无硬件跑通；导入后按组备注检查 4 处）",
      en: "Relay-feedback auto-tuning: bang-bang around SP, measure oscillation → Ku/Kp/Ti/Td → send (works with the virtual furnace)",
    },
    build: () => ({
      vars: [
        { name: "SP", type: "number", def: 45, persist: false },
        { name: "hys", type: "number", def: 3, persist: false },
        { name: "d", type: "number", def: 35, persist: false },
        { name: "amp", type: "number", def: 12, persist: false },
        { name: "tUp", type: "number", def: 0, persist: false },
        { name: "Tu", type: "number", def: 0, persist: false },
        { name: "n", type: "number", def: 0, persist: false },
        { name: "Ku", type: "number", def: 0, persist: false },
        { name: "Kp", type: "number", def: 0, persist: false },
        { name: "Ti", type: "number", def: 0, persist: false },
        { name: "Td", type: "number", def: 0, persist: false },
        { name: "done", type: "number", def: 0, persist: false },
      ],
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "整定·上穿越（关执行器+计时）",
          note: "①两个阈值事件的通道设为被控量、值分别改为 SP+hys 与 SP−hys ②下方 HEAT ON/OFF 换成自己设备的开/关命令 ③变量 amp 按曲线峰谷修正（默认取阈值带半宽）④启用本组与「下穿越」组，开总开关",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "threshold", chId: "", op: "above", value: 48, edge: "enter", debounceMs: 0 }],
          children: [
            // 已完成 → 中止（整定结束不再动执行器）
            blk({
              kind: "if",
              conds: [{ k: "var", name: "done", op: "ge", value: 1 }],
              then: [{ id: newId("b"), kind: "abort", enabled: true, onFail: "continue" }],
              els: [],
            }),
            {
              id: newId("b"),
              kind: "if",
              enabled: true,
              conds: [{ k: "var", name: "tUp", op: "gt", value: 0 }],
              then: [
                blk({ kind: "setVar", name: "Tu", from: { k: "expr", src: "now - tUp" } }),
                blk({ kind: "setVar", name: "n", from: { k: "expr", src: "n + 1" } }),
              ],
              els: [],
            },
            blk({ kind: "setVar", name: "tUp", from: { k: "expr", src: "now" } }),
            blk({ kind: "send", onFail: "abort", payload: { type: "ascii", text: "HEAT OFF\n" } }),
            {
              id: newId("b"),
              kind: "if",
              enabled: true,
              conds: [{ k: "var", name: "n", op: "ge", value: 6 }],
              then: [
                blk({ kind: "setVar", name: "Ku", from: { k: "expr", src: "1.2732 * d / amp" } }),
                blk({ kind: "setVar", name: "Kp", from: { k: "expr", src: "0.6 * Ku" } }),
                blk({ kind: "setVar", name: "Ti", from: { k: "expr", src: "Tu / 2" } }),
                blk({ kind: "setVar", name: "Td", from: { k: "expr", src: "Tu / 8" } }),
                blk({ kind: "send", payload: { type: "ascii", text: "AT+PID={Kp},{Ti},{Td}\\n" } }),
                blk({ kind: "toast", level: "info", text: "整定完成：Tu=${round(Tu)}ms Ku=${round(Ku*100)/100} → Kp=${round(Kp*100)/100} Ti=${round(Ti)}ms Td=${round(Td)}ms（已发送，可对 AI 说「解读整定结果」）" }),
                blk({ kind: "setVar", name: "done", from: { k: "expr", src: "1" } }),
              ],
              els: [],
            },
          ],
        },
        {
          kind: "group",
          id: newId("g"),
          name: "整定·下穿越（开执行器）",
          note: "与「上穿越」组配对使用；整定完成后本组会把执行器关掉（安全态）",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "threshold", chId: "", op: "below", value: 42, edge: "enter", debounceMs: 0 }],
          children: [
            blk({
              kind: "if",
              conds: [{ k: "var", name: "done", op: "ge", value: 1 }],
              then: [
                blk({ kind: "send", payload: { type: "ascii", text: "HEAT OFF\\n" } }),
                blk({ id: newId("b"), kind: "abort", enabled: true, onFail: "continue" }),
              ],
              els: [],
            }),
            blk({ kind: "send", onFail: "abort", payload: { type: "ascii", text: "HEAT ON\n" } }),
          ],
        },
      ],
    }),
  },
  {
    id: "pid-verify",
    name: { zh: "整定·阶跃验证", en: "Post-tune step test" },
    desc: {
      zh: "整定完成后自动施加一次阶跃，观察超调与稳定时间（配合 2D 曲线游标测量；AI 可解读曲线）",
      en: "After tuning, applies one step; watch overshoot/settling on the 2D plot",
    },
    build: () => ({
      vars: [
        { name: "stepped", type: "number", def: 0, persist: false },
      ],
      groups: [
        {
          kind: "group",
          id: newId("g"),
          name: "整定·阶跃验证",
          note: "等「PID 继电反馈整定」跑完（done=1）后 3s 自动施加一次全量阶跃；把 HEAT ON 换成自己设备的指令",
          enabled: false,
          cooldownMs: 0,
          queuePolicy: "dropNew",
          events: [{ id: newId("ev"), kind: "timer", intervalMs: 3000 }],
          children: [
            {
              id: newId("b"),
              kind: "if",
              enabled: true,
              conds: [{ k: "var", name: "done", op: "ge", value: 1 }],
              then: [
                {
                  id: newId("b"),
                  kind: "if",
                  enabled: true,
                  conds: [{ k: "var", name: "stepped", op: "ge", value: 1 }],
                  then: [{ id: newId("b"), kind: "abort", enabled: true, onFail: "continue" }],
                  els: [],
                },
                blk({ kind: "send", payload: { type: "ascii", text: "HEAT ON\n" } }),
                blk({ kind: "toast", level: "info", text: "阶跃已施加：观察超调与稳定时间（曲线可开快照叠加对比）" }),
                blk({ kind: "setVar", name: "stepped", from: { k: "expr", src: "1" } }),
              ],
              els: [{ id: newId("b"), kind: "abort", enabled: true, onFail: "continue" }],
            },
          ],
        },
      ],
    }),
  },
];
