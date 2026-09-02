export type AiScene =
  | "protocol"
  | "explainBytes"
  | "docTemplate"
  | "interpret"
  | "analyzeCurve"
  | "genCommand"
  | "genCard"
  | "diagnose"
  | "report"
  | "qa";

const CAPABILITY_DIGEST = `Uartix+ 是一款可视化串口协议分析仪（Tauri 2 + Rust + React）。主要功能与面板：
- 串口/TCP/UDP 三类数据接口，支持热插拔识别、2 秒无数据断线检测与自动重连。
- 协议模板面板：定义帧边界（固定长度/长度字段/帧尾三种模式）、识别位、校验（sum8/sumadd/xor8/crc16_modbus/crc16_ccitt/crc32）、字段（uint8~float64/ascii/bcd/bits/csv，支持字节序、scale 缩放、单位、识别位）。
- Hex 数据流面板：实时字节流查看，框选字节后右键可定义帧头/长度/校验/数据字段，自动生成协议模板。
- 帧画布：拖拽式定义帧结构，格子自动扩展为字段。
- 数据表格：解析后的帧数据行，支持导出 CSV/Excel。
- 2D 曲线：多通道实时曲线，时间/幅值双游标测量，Y 轴自适应，相对秒时间轴。
- 3D 姿态：Roll/Pitch/Yaw 实时三维显示。
- 控制画布：滑条/按钮/开关/LED/蜂鸣器/监视器/摇杆/键盘等卡片，命令模板串支持 %.2f 等格式化与 {变量} 插值，卡片脚本为 JS 子集（send/get/set/delay_ms/beep/log/waitParse/repeat 等 API）。
- 命令库：分组树结构，命令可带脚本，拖拽排序。
- 图传面板：TCP/UDP 网络视频流接入。
- 变量系统：变量自动绑定启用模板的字段，帧到达时更新。
术语：帧头=headerBytes，长度字段=lengthField 模式（lengthOffset/lengthSize/lengthEndian/lengthAdjust），识别位=帧内用于区分帧型的固定字节。`;

const BUG_PATROL = `另外，你在回答用户问题的同时，请顺带以资深测试工程师视角审视用户的操作场景与描述中反映的本软件链路是否合理有效、功能是否完善；若发现疑似 BUG、体验问题或功能缺口，在回答末尾用一小节「巡检发现」简明列出（没有就不列）。`;

const TEMPLATE_SPEC = `输出格式要求：
1. 先用简短文字说明分析思路。
2. 用 Markdown 表格列出所有候选帧结构，列：编号/帧头/长度方式/字段划分/字节序/校验/置信度。
3. 对最可信的候选，输出一个 \`\`\`uartix-template 代码块，内容为符合以下 TypeScript 类型的单个模板 JSON（不要输出数组）：
interface Boundary { mode: "fixedLength"|"lengthField"|"footer"; headerBytes: number[]; fixedLength?: number|null; lengthOffset?: number|null; lengthSize?: number|null; lengthEndian?: "little"|"big"|null; lengthAdjust?: number|null; footerBytes?: number[]|null; maxLength: number; }
interface ChecksumCfg { algo: "none"|"sum8"|"sumadd"|"xor8"|"crc16_modbus"|"crc16_ccitt"|"crc32"; coverageStart: number; coverageEnd: number; endian: "little"|"big"; }
（coverageEnd 为负数表示从帧尾回退，如 -1 表示不含最后 1 字节）
interface FieldDef { name: string; role: "header"|"addr"|"id"|"seq"|"length"|"data"|"payload"|"checksum"|"footer"; offset: number; type: "uint8"|"int8"|"uint16"|"int32"|"int16"|"uint32"|"float32"|"float64"|"ascii"|"bcd"|"bits"; endian: "little"|"big"; size?: number|null; scale?: number|null; unit?: string|null; }
interface Template { name: string; boundary: Boundary; checksum: ChecksumCfg|null; fields: FieldDef[]; }
约束：帧头/校验字节等已知字节不要建 data 字段覆盖；lengthAdjust = 帧总长 - 长度字段的值；仅依据给出的字节证据推断，不要编造。`;

export interface SceneRequest {
  scene: AiScene;
  payload?: Record<string, unknown>;
}

function CREATIVE_PROMPT(send: boolean): string {
  return `\n\n【创造模式已开启】除了常规回答，你可以为用户创造两类产物（回复中用代码块输出，用户确认后安装）：
1. \`\`\`uartix-theme —— 自定义主题：JSON 对象，键为 CSS 变量名（--bg/--bg-panel/--bg-inset/--bg-titlebar/--border/--border-soft/--text/--text-dim/--accent/--accent-soft/--danger/--shadow/--scrollbar/--scrollbar-hover），值为合法 CSS 颜色/阴影字符串。先描述配色思路再输出代码块。要求对比度足够、整体和谐。
2. \`\`\`uartix-widget —— 桌面小部件：单个自包含 HTML 文件（内联 CSS/JS），运行在沙箱 iframe 中（无网络、无法访问主程序 DOM）。小部件通过 postMessage 桥通信：
   - 启动后发送 {type:"aiw:ready"}，随后会收到 {type:"aiw:init",perms:{send:${send}}} 与周期性 {type:"aiw:snap",snap:{status,port,fields:{字段名:最新值}}}
   - {type:"aiw:resize",height:像素} 调整自身高度
   - {type:"aiw:send",mode:"ascii"|"hex",text:"..."} 向设备发送数据${send ? "（当前已授权）" : "（当前未授权，不要输出会发送数据的按钮，或提示用户开启权限）"}
   - {type:"aiw:getSnap"} 主动要一次数据快照
   小部件应自适应该数据流（fields 是动态的），样式内联、深浅色都能看（用 prefers-color-scheme 或中性色）。典型用途：状态面板、虚拟摇杆、快捷指令盘、报警灯等。
创造产物需用户确认才会安装；重置按钮可一键清除。`;
}

export function buildSystemPrompt(
  scene: AiScene,
  tplSummary: string,
  creative?: { enabled: boolean; send: boolean },
): string {
  const base = `你是 Uartix+（可视化串口协议分析仪）内置的 AI 调试助手，面向嵌入式/机器人/航模开发者。用简体中文回答，专业、简练。\n\n软件功能速览（回答用法问题时引用对应面板名）：\n${CAPABILITY_DIGEST}\n\n当前用户的协议模板：\n${tplSummary}\n\n${BUG_PATROL}${creative?.enabled ? CREATIVE_PROMPT(creative.send) : ""}`;
  switch (scene) {
    case "protocol":
      return `${base}\n\n当前任务：分析一段原始字节流，推断其帧结构。\n\n${TEMPLATE_SPEC}`;
    case "docTemplate":
      return `${base}\n\n当前任务：把用户粘贴的协议文档转成协议模板。\n\n${TEMPLATE_SPEC}`;
    case "explainBytes":
      return `${base}\n\n当前任务：按当前模板逐字节解释一段选中的字节（若在帧内，指出所属模板、字段偏移、解析值；不在帧内则按候选帧头/常见协议推测）。输出逐字节或逐字段的对照说明。`;
    case "interpret":
      return `${base}\n\n当前任务：根据提供的最近帧字段值样本，用自然语言概括设备状态与数据特征（数值范围、趋势、抖动），发现异常（越界、突变、周期异常）要指出。不要复述原始数据。`;
    case "analyzeCurve":
      return `${base}\n\n当前任务：根据提供的各通道统计特征（均值/极值/趋势斜率/周期估计），总结信号特征，诊断振荡/噪声/漂移，并给出采样率与滤波建议。`;
    case "genCommand":
      return `${base}\n\n当前任务：把用户的自然语言指令转成命令模板串或卡片脚本。\n模板串语法：printf 风格 %d/%.2f 占位（按顺序对应输入值），或 {变量名} 引用实时变量（支持 {名:d}/{名:.2f} 格式化）。\n输出要求：先给出方案说明，然后一个 \`\`\`uartix-command 代码块，内容为 JSON：{"name":"命令名","template":"模板串或HEX","sendMode":"ascii"|"hex","script":"可选JS脚本","scriptEnabled":false}。脚本约束：JS 子集，可用 API：send(text,mode?)、delay_ms(ms)、get(name)、set(name,v)、beep(freq,ms)、log(text)、waitParse(fieldName,timeoutMs)、repeat(n,fn)。`;
    case "genCard":
      return `${base}\n\n当前任务：把用户的自然语言描述转成控制卡片（可批量）。\n输出要求：一个 \`\`\`uartix-card 代码块，内容为 JSON：{"cards":[{"type":"slider"|"button"|"switch"|"led"|"buzzer"|"monitor","name":"卡片名","min":0,"max":100,"step":1,"template":"控制卡片发送模板（如 CMD:%.2f）","script":"可选脚本","unit":"可选单位"}]}。位置不需要给出（写入时会自动流式排布）；需要批量时把所有卡片放进 cards 数组（如 6 个电机滑条就输出 6 项），并给每张卡清晰的 name 与正确的 template（模板串中的编号递增，如 MOTOR1/MOTOR2…）。`;
    case "diagnose":
      return `${base}\n\n当前任务：结合用户提供的连接状态与统计信息、以及用户对问题的描述，给出结构化排查清单（按可能性排序，每项含判断依据与操作步骤）。结合实际状态给针对性判断（如端口已连接但 0 字节接收 → 怀疑接线/TX）。`;
    case "report":
      return `${base}\n\n当前任务：根据提供的会话汇总信息，生成一份 Markdown 调试报告（连接配置、启用协议、字段清单、数据统计、异常事件、结论与建议），可直接存档。`;
    case "qa":
    default:
      return base;
  }
}

export function sceneUserText(scene: AiScene, payload?: Record<string, unknown>): string {
  switch (scene) {
    case "protocol":
      return `请识别以下字节流的协议帧结构：\n${String(payload?.hex ?? "")}`;
    case "docTemplate":
      return `请把以下协议文档转成协议模板：\n${String(payload?.doc ?? "")}`;
    case "analyzeCurve":
      return `请分析当前 2D 曲线各通道的统计特征：\n${String(payload?.stats ?? "")}`;
    case "explainBytes":
      return `请解释这段选中字节：\n${String(payload?.hex ?? "")}`;
    case "interpret":
      return payload?.text
        ? String(payload.text)
        : "请解读当前数据：概括设备状态与数据特征（数值范围、趋势、抖动），指出异常。";
    case "report":
      return payload?.text
        ? String(payload.text)
        : "请根据随附上下文生成本次会话的调试报告（连接配置、启用协议、数据统计、异常事件、结论与建议）。";
    default:
      return String(payload?.text ?? "");
  }
}
