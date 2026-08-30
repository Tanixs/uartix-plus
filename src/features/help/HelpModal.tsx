import { useState } from "react";
import { Section } from "../../shared/Section";

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState("start");
  const tabs: { key: string; label: string }[] = [
    { key: "start", label: "快速入门" },
    { key: "panels", label: "面板总览" },
    { key: "canvas", label: "协议画布教程" },
    { key: "script", label: "脚本命令详解" },
    { key: "keys", label: "快捷键与技巧" },
    { key: "export", label: "导出文件格式" },
  ];
  return (
    <div className="modal-mask" onMouseDown={onClose}>
      <div className="modal set-modal help-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">帮助与入门</div>
        <div className="set-body">
          <div className="set-nav">
            {tabs.map((x) => (
              <button key={x.key} className={tab === x.key ? "on" : ""} onClick={() => setTab(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="set-content help-content">
            {tab === "start" && (
              <>
                <p><b>Uartix+</b> 是可视化串口协议分析仪：定义协议 → 自动筛选有效帧 → 在干净数据上查看/绘图/控制。</p>
                <Section title="五步上手">
                  <ol className="help-ol">
                    <li>标题条选择<code>数据接口</code>（串口 / TCP 客户端 / TCP 服务端 / UDP），在工具栏完成参数设置后点击<code>连接</code>。</li>
                    <li>左侧<code>协议模板</code>面板点<code>＋ 预设</code>，导入一个协议（如 匿名 V7 或 维特 WIT）；也可<code>＋ 新建</code>自己画。</li>
                    <li>没有设备？点左下角<code>启动演示源</code>，软件会生成混合协议数据流。</li>
                    <li>中央<code>帧画布</code>查看每帧的字节结构（绿色=字段、橙=帧头、粉=校验），悬停可看数值。</li>
                    <li>底部<code>2D 曲线</code>点亮字段图例的眼睛即可实时绘图；<code>数据表格</code>查看帧列表。</li>
                  </ol>
                </Section>
                <Section title="自己定义协议（零代码）">
                  <ol className="help-ol">
                    <li>帧画布中，按住左键在字节格上拖出一片区域 → 右键<code>定义为字段</code>。</li>
                    <li>字段可设名称/角色/类型/缩放；右键字段可锁定、删除、编辑。</li>
                    <li>右键帧头/帧尾区域可改字节（甚至删除——无帧头的逗号文本帧也支持）。</li>
                    <li>改完点画布左上角<code>💾 保存</code>，立即生效并持久化。</li>
                  </ol>
                </Section>
                <Section title="网络接口（TCP / UDP）">
                  <ol className="help-ol">
                    <li><b>TCP 客户端</b>：填对方的 IP 与端口，主动连接；断线后自动重连。</li>
                    <li><b>TCP 服务端</b>：只填<code>本地端口</code>监听，等设备来接入；新设备接入会替换旧连接。</li>
                    <li><b>UDP</b>：填<code>本地端口</code>（设备往这个端口发数据）和<code>远程地址</code>（你发数据去的默认对端）。</li>
                    <li>网络数据与串口走完全相同的解析/绘图/控制管线；首次监听端口时请在 Windows 防火墙弹窗中允许访问。</li>
                    <li>提示：远程地址填 127.0.0.1 时数据会发给自己（本机回环），适合自测；发送前请确认状态栏已显示<code>已连接 地址</code>。</li>
                  </ol>
                </Section>
                <Section title="控制台与快捷指令">
                  <ol className="help-ol">
                    <li>发送框上方是<code>快捷指令</code>栏：命令芯片<b>左键立即发送</b>，鼠标悬停可预览实际内容（自动识别 Hex/ASCII/脚本）。</li>
                    <li><code>指令工厂</code>内置 WIT 寄存器、匿名 V7 触发/参数、Modbus RTU 与校验工具，组帧和校验全自动；也可<code>＋ 新建自定义协议</code>用可视化模板（固定字节 + 变量字段 + 校验段）定义自己的协议。</li>
                    <li><code>存为指令</code>后命令进入命令库，可拖挂到控制画布变成实体按键。</li>
                    <li>控制台时间戳以彩色显示；RX/TX 可分别隐藏。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "panels" && (
              <Section title="九个面板与推荐工作流">
                <table className="help-table">
                  <tbody>
                    <tr><td>协议模板</td><td>协议簇管理：导入预设、新建、启停解析、复制/粘贴帧型</td></tr>
                    <tr><td>帧画布</td><td>核心编辑器：字节格上框选定义字段，帧头帧尾可编辑</td></tr>
                    <tr><td>Hex 数据流</td><td>原始字节流总览，同样支持框选定义与 Ctrl+F 搜索</td></tr>
                    <tr><td>属性</td><td>选中模板/字段后编辑其全部参数</td></tr>
                    <tr><td>数据表格</td><td>逐帧列表，可排序/筛选/导出 CSV·XLSX</td></tr>
                    <tr><td>2D 曲线</td><td>字段图例点眼睛开曲线；支持平移/框选缩放/双击复位</td></tr>
                    <tr><td>3D 姿态</td><td>把欧拉角或四元数字段映射到 3D 模型（+面板可添加）</td></tr>
                    <tr><td>控制画布</td><td>拖拽部署滑条/按钮/开关/LED/蜂鸣器等控件向下位机发指令；拖动时虚线幽灵框指示落点，松手只会落到空格</td></tr>
                    <tr><td>控制台</td><td>原始收发日志（时间戳彩色），可发 ASCII/Hex、发送文件、录制日志；上方快捷指令栏一键发送，指令工厂可组各协议帧</td></tr>
                  </tbody>
                </table>
                <p className="help-tip">推荐流：Hex/帧画布定义协议 → 表格与曲线观察 → 控制画布下发指令闭环调试。</p>
              </Section>
            )}
            {tab === "canvas" && (
              <>
                <Section title="协议簇">
                  <p>一个协议可含多个帧型（如匿名 V7 的 22 种功能码）：左侧列表一行代表整簇，点行选中，点行首箭头展开帧型；簇内右键可复制/粘贴帧型。画布顶部页签与左侧联动。</p>
                </Section>
                <Section title="自适应文本帧（JustFloat 式）">
                  <p><code>＋ 新建 → 自适应文本帧</code>：设分隔符（, \ ;）与元素类型（float/uint8…），按每帧实际段数动态生成 通道1…通道N，各通道可单独绘图、供脚本引用。</p>
                </Section>
                <Section title="骨架编辑">
                  <p>选中一个模板但还没有收到匹配数据时，画布显示骨架格（按模板定义推算长度）——此时就能框选定义字段；协议完全匹配后格子才切换为真实数据。帧头/帧尾格固定显示模板字节。</p>
                </Section>
              </>
            )}
            {tab === "script" && (
              <>
                <p>滑条/按钮/开关/摇杆与命令库均支持 <b>类 C 脚本（JS 子集）</b>，异步执行，勾选<code>启用脚本</code>后原模板串不再发送。</p>
                <Section title="内置函数">
                  <table className="help-table">
                    <tbody>
                      <tr><td>send(text, mode?)</td><td>发送指令；mode 省略按命令的 ASCII/Hex 设置。如 send("AT+RST")、send("AA 55 01", "hex")</td></tr>
                      <tr><td>beep(freq, ms)</td><td>蜂鸣提示，如 beep(1000, 200)</td></tr>
                      <tr><td>delay_ms(ms)</td><td>异步延时，await delay_ms(500)</td></tr>
                      <tr><td>get(name)</td><td>读取变量当前值，如 get("温度")</td></tr>
                      <tr><td>set(name, v)</td><td>写入变量（配合模板 {"{name}"} 插值发送）；同名解析帧到达时会被覆盖</td></tr>
                      <tr><td>await waitParse(name, ms?)</td><td>等待解析字段出现并取值（默认超时 5s），校准流程用</td></tr>
                      <tr><td>setControl(控件名, v)</td><td>驱动控制画布滑条/开关等控件的值（自动化联动）</td></tr>
                      <tr><td>await repeat(n, i=&gt;…)</td><td>循环语法糖；也可直接用 JS 的 for / while / if</td></tr>
                      <tr><td>log(text)</td><td>输出到控制台（前缀 [脚本]），调试脚本用</td></tr>
                      <tr><td>变量名</td><td>启用模板的字段名直接可用（重名自动 _1/_2）；自适应帧为 通道1/通道2…</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="示例 1：条件报警">
                  <pre>{`if (get("温度") > 60) {
  beep(2000, 300);
  send("ALARM ON");
}`}</pre>
                </Section>
                <Section title="示例 2：顺序连发">
                  <pre>{`send("AT+MODE=1");
await delay_ms(200);
send("AA 01 02", "hex");
await delay_ms(200);
send("AT+SAVE");`}</pre>
                </Section>
                <Section title="示例 3：滑条映射（滑条脚本）">
                  <pre>{`// 滑条值在变量 value 中（0~100）
const duty = Math.round(value * 2.55);
send("PWM:" + duty);`}</pre>
                  <p className="help-tip">模板串写法：<code>{"{温度:.1f}"}</code> 按格式插值、<code>{"{名称:str}"}</code> 文本插值、<code>{"%d"}</code> 等printf风格用于命令库。</p>
                </Section>
                <Section title="控件联动（setControl）">
                  <p>
                    <code>setControl("控件名", 值)</code> 可以在任意脚本里<b>真正触发</b>其他控件（按控件名）：
                    <b>按钮</b> = 触发一次发送；<b>开关</b> = 切到目标档位并发送该档指令（2 档用 0/1）；<b>滑条</b> = 设值并立即发送；<b>键盘遥控</b> = 模拟按下方向（0上/1下/2左/3右）。
                  </p>
                  <pre>{`// 例：温度超过阈值 → 报警灯亮、蜂鸣器响、油门清零
if (get("温度") > 60) {
  setControl("报警灯", 1);
  setControl("警报声", 1);
  setControl("油门", 0);
  send("ALARM ON");
} else {
  setControl("报警灯", 0);
  setControl("警报声", 0);
}`}</pre>
                  <p className="help-tip">控件名 = 卡片左下角显示的名称，双击卡片可改名；联动目标控件不需要启用脚本。</p>
                </Section>
                <Section title="JS 基础语法速查">
                  <table className="help-table">
                    <tbody>
                      <tr><td>变量</td><td>let x = 1; const name = "abc";（const 不可重新赋值）</td></tr>
                      <tr><td>判断</td><td>if (x &gt; 0) {"{ … }"} else if (x === 0) {"{ … }"} else {"{ … }"}；比较：&gt; &lt; &gt;= &lt;= ==（值）!= ===（值+类型）</td></tr>
                      <tr><td>逻辑</td><td>&amp;&amp;（且）||（或）!（非），如 if (a &gt; 0 &amp;&amp; b &lt; 10)</td></tr>
                      <tr><td>循环</td><td>for (let i = 0; i &lt; 10; i++) {"{ … }"}；while (条件) {"{ … }"}；await repeat(10, i =&gt; {"{ … }"})</td></tr>
                      <tr><td>函数</td><td>function 步进(n) {"{ return n * 2; }"} 或 const 步进 = (n) =&gt; n * 2;</td></tr>
                      <tr><td>数学</td><td>Math.abs(-5)=5 · Math.min(a,b) · Math.max(a,b) · Math.round(1.6)=2 · Math.floor(1.9)=1 · Math.random()∈[0,1)</td></tr>
                      <tr><td>文本</td><td>"共" + n + "帧" 拼接；s.toFixed(2) 保留2位小数；s.includes("ON") 包含判断</td></tr>
                      <tr><td>数组</td><td>const arr = [1, 2, 3]; arr[0]; arr.push(4); arr.length; for (const v of arr) {"{ … }"}</td></tr>
                      <tr><td>异步</td><td>await delay_ms(500) 等待；await waitParse("温度") 等解析帧；顶层可直接 await</td></tr>
                      <tr><td>异常</td><td>throw new Error("原因") 中止脚本并在控制台提示</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">解析字段的字段名可直接当变量使用（重名自动 _1/_2）；字符串模板支持 {"{字段名:.2f}"} 格式化插值。</p>
                </Section>
              </>
            )}
            {tab === "keys" && (
              <table className="help-table">
                <tbody>
                  <tr><td>Ctrl+F</td><td>Hex 数据流搜索（Esc 关闭）</td></tr>
                  <tr><td>Ctrl+Z / Ctrl+Y</td><td>协议编辑撤销 / 重做（全局 50 步）</td></tr>
                  <tr><td>← / →</td><td>帧画布上一帧 / 下一帧</td></tr>
                  <tr><td>Esc</td><td>取消框选 / 关闭菜单</td></tr>
                  <tr><td>左键拖拽</td><td>Hex/帧画布框选定义字段</td></tr>
                  <tr><td>右键</td><td>帧画布：字段/帧头/帧尾/簇 菜单；曲线区：更多设置</td></tr>
                  <tr><td>双击</td><td>帧画布帧头/帧尾直接打开编辑框</td></tr>
                  <tr><td>拖拽图例</td><td>把字段拖到 2D 曲线区直接开线</td></tr>
                </tbody>
              </table>
            )}
            {tab === "export" && (
              <>
                <Section title="外层信封（三种文件通用）">
                  <p>设置 → 导入 / 导出 中的三类文件均为 JSON，外层统一包裹，导入时按 <code>kind</code> 校验类型：</p>
                  <pre>{`{
  "kind": "uartix-templates | uartix-controls | uartix-commands",
  "version": 1,
  "data": { ... }
}`}</pre>
                </Section>
                <Section title="协议模板（kind = uartix-templates）">
                  <p>data 含 <code>templates</code>（帧型数组）与 <code>groups</code>（协议簇名映射）。导入时以副本追加，重名自动加后缀。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>id / name / color / enabled</td><td>帧型唯一标识、名称、图例颜色、是否启用解析</td></tr>
                      <tr><td>presetKey / groupKey</td><td>预设协议标识（自建为 null）/ 自建簇的分组 key</td></tr>
                      <tr><td>boundary.mode</td><td>定界方式：fixedLength 定长 / lengthField 长度域 / footer 帧尾</td></tr>
                      <tr><td>boundary.headerBytes</td><td>帧头同步字节数组，如 [170, 85]（即 AA 55）</td></tr>
                      <tr><td>boundary.fixedLength</td><td>定长模式的帧总长（字节）</td></tr>
                      <tr><td>boundary.lengthOffset / lengthSize / lengthEndian / lengthAdjust</td><td>长度域模式的：域偏移 / 位宽 / 字节序 / 修正值（总帧长 = 原始值 + 修正）</td></tr>
                      <tr><td>boundary.footerBytes</td><td>帧尾模式：帧尾字节序列</td></tr>
                      <tr><td>boundary.maxLength</td><td>安全上限，超长候选帧直接丢弃重新同步</td></tr>
                      <tr><td>boundary.discs</td><td>帧识别字段列表：{"{ offset, value: number[] }"}，用于同簇多帧型筛选</td></tr>
                      <tr><td>checksum.algo</td><td>none / sum8 / sumadd / xor8 / crc16_modbus / crc16_ccitt / crc32</td></tr>
                      <tr><td>checksum.coverageStart / coverageEnd</td><td>校验覆盖区间；正数=帧头偏移，负数=距帧尾（-1 = 不含最后 1 字节）</td></tr>
                      <tr><td>checksum.endian</td><td>校验值存储字节序：little / big</td></tr>
                      <tr><td>fields[].role</td><td>header / addr / id / seq / length / data / payload / checksum / checksum2 / footer</td></tr>
                      <tr><td>fields[].type</td><td>uint8 / int8 / uint16 / int16 / uint32 / int32 / float32 / float64 / ascii / bcd / bits / csv</td></tr>
                      <tr><td>fields[].offset / endian</td><td>帧内字节偏移 / 解析字节序</td></tr>
                      <tr><td>fields[].scale / offsetValue / unit</td><td>物理值 = 原始值 × scale + offsetValue；unit 为显示单位</td></tr>
                      <tr><td>fields[].disc</td><td>帧识别值（本字段偏移处应有的固定字节串）</td></tr>
                      <tr><td>fields[].bits / csvDelim / csvType</td><td>位域：{"{ index, count }"}；文本帧：分隔符 / 元素类型</td></tr>
                    </tbody>
                  </table>
                  <pre>{`{
  "templates": [{
    "id": "…uuid…", "name": "姿态帧", "color": "#e5534b", "enabled": true,
    "boundary": { "mode": "fixedLength", "headerBytes": [187, 102],
      "fixedLength": 12, "maxLength": 512, "discs": [] },
    "checksum": { "algo": "crc16_modbus", "coverageStart": 0, "coverageEnd": -2, "endian": "little" },
    "fields": [
      { "id": "…", "name": "Roll", "role": "data", "offset": 4,
        "type": "int16", "endian": "big", "scale": 0.1, "unit": "°", "color": "#3fb950" }
    ],
    "presetKey": null, "groupKey": "usr-…"
  }],
  "groups": { "usr-…": { "name": "我的协议" } }
}`}</pre>
                </Section>
                <Section title="控制画布（kind = uartix-controls）">
                  <p>data 为控制页数组（导入取第一个，生成新页，不影响现有页面）。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>页级字段</td><td>id / name / cols(2~24) / rows(2~48) / locked / cards[]</td></tr>
                      <tr><td>卡片公共字段</td><td>id / type / name / x / y / w / h（网格坐标与宽高）</td></tr>
                      <tr><td>slider 滑条</td><td>template / sendMode(ascii|hex) / min / max / step / defaultValue / sendTrigger(onRelease|continuous) / minIntervalMs / useScript / script</td></tr>
                      <tr><td>button 按钮</td><td>template / sendMode / holdRepeat(长按连发) / minIntervalMs / useScript / script</td></tr>
                      <tr><td>switch 开关</td><td>positions(2|3) / templates[] / labels[] / sendMode / state / useScript / script</td></tr>
                      <tr><td>led 指示灯</td><td>varName / op(gt|ge|lt|le|eq|ne) / value / strValue / onColor</td></tr>
                      <tr><td>buzzer 蜂鸣器</td><td>varName / op / value / strValue / onColor / freq / volume / durationMs / repeat</td></tr>
                      <tr><td>monitor 数值监视</td><td>varName / unit / decimals</td></tr>
                      <tr><td>joystick 摇杆</td><td>template(%x,%y) / sendMode / range / minIntervalMs / springBack / useScript / script</td></tr>
                    </tbody>
                  </table>
                  <pre>{`[{
  "id": "…", "name": "控制页 1", "cols": 12, "rows": 12, "locked": false,
  "cards": [{
    "id": "…", "type": "slider", "name": "油门",
    "x": 0, "y": 0, "w": 2, "h": 1,
    "template": "PWM:%.2f!", "sendMode": "ascii",
    "min": 0, "max": 100, "step": 1, "defaultValue": 50,
    "sendTrigger": "onRelease", "minIntervalMs": 50,
    "useScript": false, "script": ""
  }]
}]`}</pre>
                </Section>
                <Section title="命令库（kind = uartix-commands）">
                  <p>data 为分组数组，<b>递归树</b>：节点含 <code>items</code> 即分组，否则为命令。导入按顶层分组名合并，重名自动改名。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>分组节点</td><td>{"{ id, name, items: [子节点…] }"}，items 可继续嵌套分组</td></tr>
                      <tr><td>命令节点</td><td>id / name / template（发送串）/ sendMode(ascii|hex) / note / script / scriptEnabled</td></tr>
                    </tbody>
                  </table>
                  <pre>{`[{
  "id": "…", "name": "电机控制",
  "items": [
    { "id": "…", "name": "复位", "template": "RST!",
      "sendMode": "ascii", "note": "下位机复位", "script": "", "scriptEnabled": false },
    { "id": "…", "name": "子分组", "items": [ /* … */ ] }
  ]
}]`}</pre>
                </Section>
              </>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button className="btn primary" onClick={onClose}>开始使用</button>
        </div>
      </div>
    </div>
  );
}
