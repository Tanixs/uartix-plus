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
                    <li>标题条选择「数据接口」（当前支持串口），在工具栏选择 COM 口与波特率，点击「连接」。</li>
                    <li>左侧「协议模板」面板点「＋ 预设」，导入一个协议（如 匿名 V7 或 维特 WIT）；也可「＋ 新建」自己画。</li>
                    <li>没有设备？点左下角「启动演示源」，软件会生成混合协议数据流。</li>
                    <li>中央「帧画布」查看每帧的字节结构（绿色=字段、橙=帧头、粉=校验），悬停可看数值。</li>
                    <li>底部「2D 曲线」点亮字段图例的眼睛即可实时绘图；「数据表格」查看帧列表。</li>
                  </ol>
                </Section>
                <Section title="自己定义协议（零代码）">
                  <ol className="help-ol">
                    <li>帧画布中，按住左键在字节格上拖出一片区域 → 右键「定义为字段」。</li>
                    <li>字段可设名称/角色/类型/缩放；右键字段可锁定、删除、编辑。</li>
                    <li>右键帧头/帧尾区域可改字节（甚至删除——无帧头的逗号文本帧也支持）。</li>
                    <li>改完点画布左上角「💾 保存」，立即生效并持久化。</li>
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
                    <tr><td>控制画布</td><td>拖拽部署滑条/按钮/开关/LED 等控件向下位机发指令</td></tr>
                    <tr><td>控制台</td><td>原始收发日志，可发 ASCII/Hex、发送文件、录制日志</td></tr>
                  </tbody>
                </table>
                <p className="help-tip">推荐流：Hex/帧画布定义协议 → 表格与曲线观察 → 控制画布下发指令闭环调试。</p>
              </Section>
            )}
            {tab === "canvas" && (
              <>
                <Section title="协议簇">
                  <p>一个协议可含多个帧型（如匿名 V7 的 22 种功能码）：左侧列表一行代表整簇，点行选中，点 ▸ 箭头展开帧型；簇内右键可复制/粘贴帧型。画布顶部页签与左侧联动。</p>
                </Section>
                <Section title="自适应文本帧（JustFloat 式）">
                  <p>「＋ 新建 → 自适应文本帧」：设分隔符（, \ ;）与元素类型（float/uint8…），按每帧实际段数动态生成 通道1…通道N，各通道可单独绘图、供脚本引用。</p>
                </Section>
                <Section title="骨架编辑">
                  <p>选中一个模板但还没有收到匹配数据时，画布显示骨架格（按模板定义推算长度）——此时就能框选定义字段；协议完全匹配后格子才切换为真实数据。帧头/帧尾格固定显示模板字节。</p>
                </Section>
              </>
            )}
            {tab === "script" && (
              <>
                <p>滑条/按钮/开关/摇杆与命令库均支持 <b>类 C 脚本（JS 子集）</b>，异步执行，勾选「启用脚本」后原模板串不再发送。</p>
                <Section title="内置函数">
                  <table className="help-table">
                    <tbody>
                      <tr><td>send(text, mode?)</td><td>发送指令；mode 省略按命令的 ASCII/Hex 设置。如 send("AT+RST")、send("AA 55 01", "hex")</td></tr>
                      <tr><td>beep(freq, ms)</td><td>蜂鸣提示，如 beep(1000, 200)</td></tr>
                      <tr><td>delay_ms(ms)</td><td>异步延时，await delay_ms(500)</td></tr>
                      <tr><td>get(name)</td><td>读取变量当前值，如 get("温度")</td></tr>
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
