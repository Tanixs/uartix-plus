import { useState } from "react";
import { Section } from "../../shared/Section";
import { tx, useLocale } from "../../i18n/strings";
import * as tourStore from "../tour/tourStore";
import { TOUR_STEPS } from "../tour/tourSteps";
import { IconPlay } from "../../shared/icons";
// P99b-N6：市场那一页说的每个数/每句承诺都要能指回实现——
// 放行域、自带索引地址、"装完是停用态"与"列表不等于背书"那两句原文，一律从代码取，不抄第二份。
import { MARKET_ALLOW_HOSTS, MARKET_BUNDLED_INDEX_URL } from "../market/marketIndex";
import { MARKET_INSTALL_NOTE, MARKET_NO_ENDORSE } from "../market/marketBrowse";
import { CAP_LABEL, autoEnableBlockedCaps } from "../plugins/pluginManifest";

export function HelpModal({ onClose }: { onClose: () => void }) {
  useLocale();
  const [tab, setTab] = useState("start");
  const tabs: { key: string; label: string }[] = [
    { key: "start", label: tx("快速入门", "Quick Start") },
    { key: "panels", label: tx("面板总览", "Panels Overview") },
    { key: "ai", label: tx("AI 助手详解", "AI Assistant Guide") },
    { key: "plugins", label: tx("插件与创造", "Plugins & Creation") },
    { key: "canvas", label: tx("协议画布教程", "Protocol Canvas Guide") },
    { key: "plot3d", label: tx("3D 轨迹面板", "3D Trajectory Panel") },
    { key: "orchestrator", label: tx("自动编排器", "Orchestrator") },
    { key: "script", label: tx("脚本命令详解", "Scripting Guide") },
    { key: "keys", label: tx("快捷键与技巧", "Shortcuts & Tips") },
    { key: "export", label: tx("导出文件格式", "Export Formats") },
    { key: "operator", label: tx("部署与分发", "Deploy & Distribute") },
    { key: "market", label: tx("插件市场", "Plugin Market") },
  ];
  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={onClose}>
      <div className="modal set-modal help-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-title">{tx("帮助与入门", "Help & Getting Started")}</div>
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
                <div className="help-tour-row">
                  <button
                    className="btn primary"
                    onClick={() => {
                      onClose();
                      tourStore.start(TOUR_STEPS);
                    }}
                  >
                    <IconPlay />
                    {tx("启动交互式教学（分步带你走通主流程）", "Start the guided tour (walks the main flow step by step)")}
                  </button>
                </div>
                <p><b>Uartix+</b> 是一台跑在电脑上的可视化上位机：定义协议 → 自动筛选有效帧 → 在干净数据上查看、绘图并反向控制设备。</p>
                <Section title="五步上手">
                  <ol className="help-ol">
                    <li>标题条选择<code>数据接口</code>（串口 / TCP 客户端 / TCP 服务端 / UDP / 蓝牙 BLE），在工具栏完成参数设置后点击<code>连接</code>。</li>
                    <li>左侧<code>协议模板</code>面板点<code>＋ 预设</code>，导入一个协议（如 匿名 V7、维特 WIT、Modbus RTU / TCP）；也可<code>＋ 新建</code>自己画。</li>
                    <li>没有设备？点左下角<code>启动演示源</code>，软件会生成混合协议数据流；想扮演一台有脾气的具体设备（温漂/丢帧/命令应答，还能 UDP/TCP/串口对外发），开<code>虚拟设备工坊</code>面板。</li>
                    <li>中央<code>帧画布</code>查看每帧的字节结构（绿色=字段、橙=帧头、粉=校验），悬停可看数值。</li>
                    <li>底部<code>2D 曲线</code>点亮字段图例的眼睛即可实时绘图；<code>数据表格</code>查看帧列表。</li>
                  </ol>
                </Section>
                <Section title="自己定义协议（零代码）">
                  <ol className="help-ol">
                    <li>帧画布中，按住左键在字节格上拖出一片区域 → 右键<code>定义为字段</code>。</li>
                    <li>字段可设名称/角色/类型/缩放；右键字段可锁定、删除、编辑。</li>
                    <li>右键帧头/帧尾区域可改字节（甚至删除——无帧头的逗号文本帧也支持）。</li>
                    <li>改完点画布左上角<code>💾 保存</code>，立即生效并持久化（平时改动也会自动同步解析内核）。</li>
                    <li>页签下方细条是<code>结构覆盖条</code>：红色段=还没被字段覆盖的字节，点一下直接定义；新建/AI/考古得到的协议在未启用时显示为<code>灰色页签</code>，点它一键启用。</li>
                    <li>工具栏<code>对比</code>按钮把当前帧设为基线，←/→ 翻帧时差异字节左上角标红，用于协议考古与版本对比。</li>
                    <li>把左侧协议模板面板的<code>字段</code>直接拖到 2D 曲线=开通道、拖到控制画布=建监视卡、拖到编排器=秒挂阈值事件组；字段改名后曲线图例与通道标签同步更新。</li>
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
                <Section title="AI 助手">
                  <ol className="help-ol">
                    <li>先到<code>设置 → AI 服务</code>选服务商预设（OpenAI 兼容 / DeepSeek / 智谱 GLM / 通义千问 / 本地 Ollama / Claude），选<code>接口格式</code>并填入 API Key；如需代理可填 HTTP 代理地址。</li>
                    <li>按 <code>Ctrl+K</code> 或点标题栏星形按钮唤起 AI 浮窗；浮窗可拖动、缩放、最小化到角落气泡，也可一键<code>停靠为面板</code>（面板内可再弹出为浮窗）。</li>
                    <li><b>识别协议</b>：在 Hex 数据流框选一段字节 → 右键「AI 识别协议」，AI 输出候选帧结构表（帧头/长度/字段/校验+置信度），点「写入协议模板」即可直接解析。</li>
                    <li><b>解读数据 / 分析曲线</b>：一键概括设备状态、诊断振荡与噪声；发现坏帧率偏高、数据停滞、字段突变时面板顶部会主动提示。</li>
                    <li><b>生成指令 / 生成卡片</b>：自然语言生成命令模板或控制卡片，回复内直接点「加入命令库」「临时发送」「写入控制画布」，生成即可用。</li>
                    <li>发送前可在输入框上方勾选「本次发送的上下文」（协议摘要/数据样本/Hex 选区等），AI 只看你授权的内容。</li>
                    <li>它还能<b>读这个软件本身</b>（连接现状、协议字段、控件、帧统计…见「AI 助手详解」里的自省目录一节），
                      以及<b>把成果存成插件留在你机器上</b>（主题 / 小部件 / 面板 / 工作区预设 / 任务模板 / 逻辑模块，见「插件与创造」页）。</li>
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
            {tab === "ai" && (
              <>
                <Section title="基础操作">
                  <ol className="help-ol">
                    <li>先到<code>设置 → AI 服务</code>：选服务商预设（OpenAI 兼容 / DeepSeek / 智谱 GLM / 通义千问 / 本地 Ollama / Claude）→ 填 API Key → 需要代理时在「高级连接」里填。</li>
                    <li>按 <code>Ctrl+K</code> 或点标题栏星形按钮唤起 AI 浮窗；可停靠为面板（工具栏「+ 面板」）。</li>
                    <li>输入框：<code>Enter</code> 发送；<code>Shift+Enter</code> 或 <code>Ctrl+Enter</code> 换行。</li>
                    <li>要带哪些上下文，点输入框左侧的 <code>＋</code> → <b>发送上下文</b> 勾选；<b>协议清单</b>（一行式，便宜）默认带，<b>协议完整定义</b>只在需要精确分析时勾。面板上实时显示本次发送的估算体积。</li>
                    <li>支持思维链模型（如 deepseek-v4-pro / glm-5.3）：思考过程实时流式显示并计时，正文开始后自动折叠。<b>「显示思考过程」与「深度思考（先想后答）」是两个独立开关</b>（设置 → AI 服务）：只想看过程就开前者，长任务反复超时就把后者关掉，别为了看过程而背上等待。同处的<b>「流式读空闲超时」</b>只管本机这一侧：连续多少秒收不到任何字节才判定卡住并重试（默认 120 秒）——上游网关自己返回的超时错误调它没用，那种情况关深度思考或换更快的模型。</li>
                    <li>消息悬停出现操作钮：复制 / 编辑重发 / 重新生成 / 删除；会话侧栏支持多会话、搜索、双击重命名。</li>
                    <li>顶栏「更多 ▾」四件事：<b>本地插件库</b>、<b>导出对话为 Markdown</b>（纯本地写文件）、
                      <b>上传巡检报告</b>、<b>清空当前对话</b>。
                      其中「上传巡检报告」是<b>真的往外发</b>：它把最近那条含「巡检发现」的回复正文（末尾最多 8000 字）连同软件版本与时间戳发到一个固定收报地址。
                      报告里写到的字段名、数值、端口、文件路径会<b>一起出去</b>——涉及客户设备或内部编号时先自己看一眼正文再点。</li>
                  </ol>
                </Section>
                <Section title="工作方式与授权档（发送方式 pill）">
                  <p>输入框下方那颗 pill 是 Agent 的唯一入口，点开是<b>两个各自独立的选择</b>——先选「工作方式」，再选「授权档」：</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>普通对话</td><td>一问一答，不执行任何应用操作。适合问用法、解读数据、要一段代码。</td></tr>
                      <tr><td>Agent 任务</td><td>多轮自主执行：想 → 调工具 → 看回执 → 再想，直到完成或触达预算。下面三档决定它有多大权。</td></tr>
                    </tbody>
                  </table>
                  <table className="help-table">
                    <tbody>
                      <tr><td>仅预览</td><td>只读数据与状态。任何写入都只给预览，<b>不落一行改动</b>——想先看 AI 打算怎么做，就用这一档。</td></tr>
                      <tr><td>界面创造</td><td>默认档。改应用设置、保存主题/控件/面板插件，可逆的自动做；<b>不碰设备与本机</b>。</td></tr>
                      <tr><td>全权执行</td><td>软件目录内八个能力域全开（含界面深改、读白名单文件、写目录内文件、网络、命令行）。<b>但覆盖已有文件、删除、实车发送、命令行仍然逐条弹批准卡</b>——这一档放开的是能力面，不是撤掉人工确认。</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">
                    需要中间态（比如"能读文件但别碰命令行"）就展开 pill 里的<b>「高级 · 具体授权域」</b>：
                    八项勾选逐一决定，另有 <code>工作区写入</code> / <code>设备收发</code> / <code>本机全能力</code> 三个一键预设。
                    勾了任何一项与预设不同的组合，pill 会如实显示「自定义 · N 项授权」，不猜你授了什么。
                  </p>
                  <p className="help-tip">
                    档位会被记住，<b>但「全权执行」与自定义勾选不跨重启恢复</b>——开机后回落到「界面创造」并提示你，
                    避免某天带着满权限启动而没察觉。一项都不勾时按「界面创造」同权执行，不会出现"选了自定义却什么都改不动"。
                  </p>
                  <p className="help-tip">
                    预算（轮数 / 工具调用数 / 时长）显示在 pill 面板底部；任务运行中档位与预算锁定，防止中途换权限。
                  </p>
                  <p><b>八个授权域分别放开什么</b>（高级区里逐项勾选的就是它们）：</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>配置写入</td><td>改应用设置（可撤销项）与外观 token。仅预览档不给。</td></tr>
                      <tr><td>插件库</td><td>保存/启用插件、保存主题、<b>升版与退回上一版</b>。这是"AI 造的东西能不能落地"的那道门。</td></tr>
                      <tr><td>设备发送</td><td>向仿真/虚拟设备自动发送。<b>实车连接或无法判定时一律逐次人工批准</b>，这一档授权也不例外。</td></tr>
                      <tr><td>文件读取</td><td>读<b>设置 → AI 服务 → 「Agent 文件白名单」</b>里列出的路径（含从图片取色）。白名单留空＝这条能力等于关掉：工具还在，但每次调用都被拒并回执「路径不在白名单」。</td></tr>
                      <tr><td>文件写入</td><td>在软件目录/工作区内<b>新建</b>文件。<b>覆盖已存在的文件仍要逐条批准</b>。</td></tr>
                      <tr><td>网络访问</td><td>抓取网页与搜索。内网/回环地址按私有网段规则另行把关。</td></tr>
                      <tr><td>命令行</td><td>执行 shell。三重门：本授权域 + 设置页总开关 + <b>每条命令逐次批准</b>。</td></tr>
                      <tr><td>界面深改</td><td>对具体组件/面板注入受校验的样式与动效。全局选择器、fixed 遮罩、外链资源、超高 z-index 一律拒。</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="上下文用量与手动压缩">
                  <ul className="help-ol">
                    <li>Agent 模式下，输入区右下角常驻一条 <code>上下文 240 KB / 1.6 MB · 15%</code> 的用量条。
                      它显示的是<b>下一次发送真正会带上的那份内容</b>，不是历史累计——所以压缩之后数字立刻就会动。</li>
                    <li>超过 70% 转黄、超过 90% 转红。撞线时模型会报"上下文过大"，任务卡上会写明当前用量。</li>
                    <li><b>压缩</b>：把较早的工具回执收得更紧（只发摘要，不发全文）。<b>台账事件一条都不删</b>，
                      所以这是"少发给模型"，不是"忘掉"——展开任务卡仍能看到完整过程。
                      连压到下限后按钮会禁用并说明原因；要彻底清空请新建会话。</li>
                    <li>超预算时系统本来就会<b>自动</b>走同一套阶梯（先丢较早历史的附图 → 再折叠 → 仍超才报错），
                      手动压缩只是让你不必等到撞线。</li>
                  </ul>
                </Section>
                <Section title="让 AI 改界面：正确姿势">
                  <p>界面类需求（改某个按钮/面板/标题栏的样子、加动效）请走 <b>Agent 任务 + 「全权执行」档</b>，它的工作顺序是：</p>
                  <ol className="help-ol">
                    <li><code>ui_inventory</code> 读软件的真实构成：面板清单、控件类型、可改的外观 token、内置动效配方——全部从注册表现取，不是它凭印象说的。</li>
                    <li><code>ui_inspect</code> 读<b>活界面</b>：给一个选择器，它回给你这一带真实存在的类名与各自命中多少个元素、节点树、当前计算样式。<b>先 inspect 再改</b>，选择器才不会打空。</li>
                    <li><code>style_patch</code> 按组件下样式（结构化规则，不是一整段 CSS 文本）。回执逐条报：<b>命中几个元素、哪个属性从什么变成什么</b>；命中 0 的会直接把真实类名递给你（打偏了不会静默）。</li>
                    <li>想加发光/流光/粒子这类动效，先 <code>ui_inventory &#123;section:"fx"&#125;</code> 取内置配方与旋钮，别从零写关键帧。</li>
                    <li>这些改动是<b>会话临时层</b>：重启就没了，也不归插件管。满意了要显式说"保存为主题/固化下来"才会持久化——
                      让它报个名字就行，它会用 <code>style_commit</code> 把<b>当前真正生效的那几层</b>读出来存成已启用的主题插件
                      （不是凭记忆重抄一遍规则，重抄在多轮改动后一定走样）。想撤就 <code>style_revert</code>、卡片上的「撤销」，
                      或直接 设置 → 通用 → <b>清除 AI 的全部临时改动</b>；固化之后恢复路径变成 停用插件 或 <code>rollback_plugin</code>。</li>
                    <li>改坏了的插件版本可以 <code>rollback_plugin</code> 退回上一版——Agent 自己改自己存的东西会升版本号并留下旧版，不会堆出一堆近似副本。</li>
                  </ol>
                  <p className="help-tip">
                    全局选择器（<code>html</code>/<code>body</code>/<code>#root</code>/<code>*</code>）、<code>position:fixed</code> 遮罩、
                    外链资源、超高 z-index 都会被逐条拒绝并给出原因——一条写歪不会废掉整批改动，也不会让界面再也点不动。
                  </p>
                </Section>
                <Section title="外观是怎么叠起来的（撤不回去时看这里）">
                  <p>最终界面是这几层叠出来的，<b>越靠下越优先</b>。哪一层有内容，就说明当前样子是它改的：</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>兜底层（暗/亮两张）</td><td>主题没写的键由它垫上，取的是内置 <code>dark</code>/<code>light</code> 那两枚的表。<b>不可停用，也不需要你动。</b></td></tr>
                      <tr><td>在画的这一枚主题</td><td><b>内置与插件主题同级</b>：同一张列表里点哪枚就是哪枚，<b>同时只有一枚在画</b>。内置不可卸载；插件主题落盘在插件库，停用/卸载就是撤掉它。<b>落盘。</b></td></tr>
                      <tr><td>外观设置</td><td>界面缩放、显示精度、减弱动效等。<b>落盘。</b></td></tr>
                      <tr><td>AI 临时 token 覆盖</td><td>AI 改主题色/字号/圆角时的会话层。<b>不落盘。</b></td></tr>
                      <tr><td>AI 组件样式层</td><td>AI 按组件下的样式（一层一个名字）。<b>不落盘。</b></td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">
                    主题只改了几项也没关系：其余按键按明暗归属垫对应那张底，
                    设置里那枚卡会写明「本枚覆写几项、几项沿用兜底」——不猜、也不留空。
                  </p>
                  <p className="help-tip">
                    常见困惑：「AI 把按钮改圆了，我把那个主题插件停用甚至卸载了，怎么还在？」
                    —— 因为那是<b>AI 临时层</b>改的，插件停用管不到它。
                    去 设置 → 通用 → <b>「当前外观被谁改了」</b>，那里逐层显示谁在生效，
                    点<b>「清除 AI 的全部临时改动」</b>就干净了（你自己的设置与已存插件不受影响）。
                  </p>
                  <p className="help-tip">
                    旁边那颗<b>「恢复外观默认」</b>是另一回事：它连你自己选的主题、缩放、精度一起回默认，会先弹确认。
                    两者都不是「恢复出厂」——那个在 设置 → AI 服务 底部，会清空<b>全部</b>本地数据，不可恢复。
                  </p>
                </Section>
                <Section title="场景菜单（顶部「场景 ▾」）">
                  <p>八个常用场景收在 AI 助手顶栏的<code>场景 ▾</code>下拉里（旧版是八个并排按钮，窄浮窗下会被裁掉）。点一下即按该场景发起，也可自己打字。</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>识别协议</td><td>先在 Hex 数据流框选字节 → 点击 → AI 推断帧结构并输出「写入协议模板」按钮</td></tr>
                      <tr><td>解读数据</td><td>概括最近帧的设备状态、数值范围、趋势与异常</td></tr>
                      <tr><td>分析曲线</td><td>统计各通道均值/极值/周期/趋势斜率，诊断振荡与噪声</td></tr>
                      <tr><td>生成指令</td><td>描述需求 → 生成命令模板（写入命令库或临时发送）</td></tr>
                      <tr><td>生成卡片</td><td>描述需求 → 生成控制卡片（直接写入控制画布）</td></tr>
                      <tr><td>创造</td><td>主题 / 小部件 / 面板 / 工作区预设 / 任务模板——经「Agent 任务」保存为插件并自动启用；<b>逻辑模块</b>（能带 JS 的那类）不会自动启用，要你在插件库里点一次。详见「插件与创造」页。</td></tr>
                      <tr><td>诊断</td><td>结合连接状态与异常巡检给出结构化排查清单</td></tr>
                      <tr><td>调试报告</td><td>汇总本次会话生成 Markdown 报告，可存档</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="哨兵 × AI 诊断">
                  <ul className="help-ol">
                    <li><b>手动诊断</b>：哨兵面板顶部点<code>AI 诊断</code>，会自动携带结构化证据（连接状态、健康度、近期报警、异常通道评分、帧型与错误率统计）打开 AI 助手发起诊断，无需手动描述现象。</li>
                    <li><b>自动诊断</b>：哨兵面板底部参数区开启<code>自动 AI 诊断</code>后，出现<b>严重报警</b>（通信静默、重大突变等）会自动发起诊断并直接写入 AI 会话——不弹窗、不抢焦点，打开 AI 助手即可看到结论。</li>
                    <li><b>冷却</b>：自动诊断按所选冷却时间（1~60 分钟）去重，避免报警风暴时连环调用；未配置 AI 服务时会提示先到 设置 → AI 服务 配置。</li>
                  </ul>
                </Section>
                <Section title="代码块与 UI 创造（回复中直接可用）">
                  <table className="help-table">
                    <tbody>
                      <tr><td>动作执行<br /><code>uartix-action</code></td><td>让 AI 直接操作软件：打开面板、切主题/布局、清空画布、删除配置、开关连接、读写编排器与 3D 轨迹、生成并启动虚拟设备等（39 个白名单动作）。回复中显示操作卡片，点「执行」逐个运行。<b>对 AI 说「清空控制画布」「打开曲线面板」「主题换成琉璃」即可。</b></td></tr>
                      <tr><td>控制卡片<br /><code>uartix-card</code></td><td>生成滑条/按钮/开关/LED/摇杆/组合控件，或 <b>custom 自定义卡片</b>（任意 HTML 界面）。批量生成用 {"{"}"cards":[…]{"}"}。</td></tr>
                      <tr><td>命令库命令<br /><code>uartix-command</code></td><td>单条或批量（{"{"}"commands":[…]{"}"}）写入命令库「AI 生成」分组，可带脚本。</td></tr>
                      <tr><td>协议模板<br /><code>uartix-template</code></td><td>生成帧结构模板（截帧边界/字段/校验），写入协议面板；多帧型协议支持 {"{"}"group":"簇名","templates":[…]{"}"} 一次写入整簇并自动建组归档，默认停用待你启用。</td></tr>
                      <tr><td>指令工厂协议<br /><code>uartix-codec</code></td><td>生成自定义协议（帧头/变量/长度/校验段），写入指令工厂「我的协议」，填参数即组帧。</td></tr>
                      <tr><td>UI 创造<br /><code>主题 / 小部件 / 面板 / 工作区预设 / 任务模板 / 逻辑模块</code></td><td>对 AI 描述你想要的主题、浮窗小部件或常驻面板，AI 会引导你打开输入框下方的<b>「Agent 任务」pill</b>：任务里用 <code>save_plugin</code> 把成果保存为插件并自动启用，无需手动安装。插件在 设置 → 插件管理 启停、配置、导入导出；<b>Agent 再改同一个插件会升版本号并保留旧版</b>，可在插件库里退回上一版。<br />另外两类是能真正落地的产物：<b>工作区预设</b>（一套面板排布）在插件库那条产物上点<b>「应用此布局」</b>——整屏排列会被替换，动手前当前布局自动存进 设置 → 工作区 的自动备份槽，随时回得去；<b>任务模板</b>（一段目标 + 建议步骤）点<b>「载入 AI 助手」</b>只把话填进输入框，<b>不会替你发送</b>，发不发、用哪个授权档还是你说了算。AI 想存一个引用了不存在工具的模板会被直接拒绝，不会留下一个跑不动的模板。</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">插件里的沙箱小部件 / 自定义面板 / 自定义卡片自动注入 <code>window.uartix</code> API（见上）；<b>能不能调某一支，看那个包声明了哪几项能力</b>——完整名册与"哪些包不会自动启用"在「插件与创造」页。</p>
                </Section>
                <Section title="Agent 能调用的工具（展开看它做了什么）">
                  <p>Agent 任务卡展开后每一步都是一个工具。按能力分组，<b>括号里是它需要的授权域</b>：</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>读</td><td><code>settings_read</code> · <code>app_state</code>（一次看全局，省得逐个探）· <code>app_catalog</code> / <code>app_read</code>（宿主信息目录：先看有哪些可读视图，再按路径取，列表可翻页）· <code>list_plugins</code> · <code>ui_inventory</code> / <code>ui_inspect</code>（看界面到底有什么）· <code>plot_channels</code> / <code>plot_window</code> · <code>theme_read</code> · <code>fs_read</code> / <code>fs_list</code> · <code>read_artifact</code>（回执太大时分页取回原文）</td></tr>
                      <tr><td>写配置</td><td><code>settings_apply</code>（配置写入）· <code>run_app_action</code>（39 个白名单动作，协议/指令/卡片都走它）· <code>save_plugin</code> · <code>theme_patch</code> / <code>theme_preset</code> / <code>save_theme_extension</code> · <code>style_patch</code> · <code>fs_write</code> · <code>shell_exec</code></td></tr>
                      <tr><td>外观</td><td><code>theme_read</code> / <code>theme_patch</code> / <code>theme_preset</code>（配置写入）· <code>image_swatch</code> 从图片取色（文件读取）· <code>save_theme_extension</code> / <code>style_commit</code> / <code>save_plugin</code> / <code>enable_plugin</code> / <code>rollback_plugin</code>（插件库）</td></tr>
                      <tr><td>界面深改</td><td><code>ui_inventory</code> / <code>ui_inspect</code> 只读自省 · <code>style_patch</code> / <code>style_revert</code> 按组件下样式与撤回（界面深改）· <code>layout_apply</code> 换工作区版式（内置预设/布局槽，每次切换自动快照、可一键回滚）· <code>chrome_set</code> 工具栏三段的排序与显隐</td></tr>
                      <tr><td>本机</td><td><code>fs_read</code> / <code>fs_list</code>（文件读取，限白名单）· <code>fs_write</code>（软件目录内写文件；<b>覆盖已有文件逐条批准</b>）· <code>web_fetch</code> / <code>web_search</code>（网络）· <code>shell_exec</code>（命令行；另需设置页总开关 + 每条批准）</td></tr>
                    </tbody>
                  </table>
                  <p>
                    <b>它是怎么「看见」这个软件的</b>：可读的东西集中在一张<b>宿主自省目录</b>里，覆盖这些面——运行现状、协议模板与完整字段表、
                    指令库、控件面板、帧与解析统计、会话录制、曲线通道、插件库、<b>3D 轨迹</b>、<b>自动编排器</b>、<b>测试序列器</b>、
                    <b>分析面板</b>、<b>Modbus 工作台</b>、<b>虚拟设备工坊</b>、<b>哨兵</b>、<b>插件市场</b>（货架上有什么、上一次取回是什么样——
                    这两支视图<b>一次网都不联</b>，没取过就照实说没取过）。<code>app_catalog</code> 列菜单（有哪些视图以它当场返回为准，
                    这里不抄一份数字给你过期），<code>app_read</code> 按路径取内容。目录里没有的东西是<b>不存在</b>，不是"藏在哪儿没告诉它"：
                    它反射不到任意内部状态，也读不到设置里的密钥那一类。列表视图的回执带 <code>total / returned / nextCursor</code>，
                    它照着翻页，而不是自己猜偏移。
                  </p>
                  <p className="help-tip">
                    新接的七面给的是<b>配置与事实的摘要</b>，不是整包数据：轨迹点数上限、校准采样进度、编排块树、序列步骤与上次结果计数、
                    Modbus 从站配置与轮询行统计、虚拟设备规格规模、哨兵健康度与报警清单都在；
                    但<b>点云本体、寄存器历史数组、原始收发字节、GLTF 路径、串口与网络端点、备注正文</b>这类不外带（只给长度或有无）。
                    <b>编排器的活值现在也在目录里</b>（<code>orchestrator.runtime</code>：总开关、在跑几条、各组成功与失败计数、变量现值、最近日志的阶段），
                    它与动作 <code>orchestratorRead</code> 读的是<b>同一份判定</b>、两个投影（数字不会两处各说一套），日志原文与备注正文同样不带；
                    读这一条会把编排器引擎装载起来，这一点与那条动作一样。3D 轨迹点本体这类仍然走各自的动作（<code>plot3dRead</code>），那些同样是免批准的只读动作。
                  </p>
                  <p>
                    每轮开始它还会重读一次<b>现状</b>（授权档与勾选域、可见工具数、串口连没连、有没有被操纵者锁住、软件版本），
                    所以任务中途你把串口插上、开始录制，下一轮它就知道了。台账里那行<b>「运行现状变化」</b>就是它读到数值变了的痕迹。
                  </p>
                  <p className="help-tip">
                    没授权的工具<b>根本不会发给模型</b>——看得见却调不动只会白烧一轮再报一句莫名失败。
                    所以 pill 上显示授了几项，就是在如实告诉你它现在能动什么。
                  </p>
                  <p>
                    <b>每个任务一张工具面</b>：任务开始时按你当时那一档（工作方式 + 授权档 + 高级区勾选）现算一份清单发给模型，
                    任务跑起来就锁定，中途改设置不会让一个正在跑的任务突然多出手来。副作用（发送、删除、覆盖、命令行、动实车）
                    <b>不是模型自报的，是宿主按工具自己的登记判的</b>——批准卡上写的动词与参数就是它真正要做的动作，
                    你批的是"删除卡片"，不是"执行应用动作"这一句含糊话。
                  </p>
                </Section>
                <Section title="动作执行（uartix-action）示例">
                  <p>对 AI 说「清空控制画布，然后打开 2D 曲线」，AI 输出：</p>
                  <pre>{`{"actions":[
  {"kind":"clearPage","args":{}},
  {"kind":"openPanel","args":{"panel":"plot2d"}},
  {"kind":"toast","args":{"msg":"已清空并打开曲线"}}
]}`}</pre>
                  <p>点「执行」逐步运行，每步结果显示在卡片上。含破坏性动作（清空/删除）时卡片红色标注。</p>
                </Section>
                <Section title="小部件 uartix API 与无边框形态">
                  <ul className="help-ol">
                    <li>所有沙箱组件（小部件 / 自定义面板 / 自定义卡片）自动注入全局 <code>window.uartix</code>，AI 生成的代码直接调用：onSnap 数据快照、<b>onChat 感知 AI 对话（phase + 思维链/正文尾部）</b>、ask 向 AI 提问、send 串口发送、app 软件动作、onKey 键盘（浮窗悬停即收）、onCursor 鼠标跟随、screen 屏幕尺寸、resize 高度。</li>
                    <li><b>能调哪几支，取决于它是"谁装的"</b>：你在扩展区自己建的小部件、以及控制画布里的自定义卡片，上面这套 API 全给（<code>send</code> 仍受全局「允许向设备发送」总闸）。
                      而<b>插件包里</b>的小部件/面板只能调它那个包声明过的能力，缺就<b>静默不生效</b>（调用不报错，只是什么都不发生）：
                      <code>uartix.app</code> 要<b>界面动作</b>、<code>uartix.send</code> 要<b>发送串口数据</b>、<code>uartix.ask</code> 与 onChat/数据快照推送要<b>向 AI 助手提问</b> / <b>读取数据快照</b>。
                      所以"AI 用 save_plugin 存的小部件包"里点按钮发不出数据是<b>设计如此</b>——它那个包只有小部件 + 读数据两项能力；要能发或能操作软件，得你自己去装带对应能力的包。</li>
                    <li>窗口控制 <code>uartix.win.*</code>：menu 弹菜单、close、popOut 弹出独立桌面窗、moveTo/moveBy/resizeTo/get、top 置顶、through 点击穿透（60 秒自动恢复）；移动类自动钳制屏幕边界，不会拖丢。</li>
                    <li>右键菜单可完全自定义：<code>uartix.menu.define(items)</code> 换掉默认菜单（支持子菜单/分隔线/勾选/多组命名菜单），<code>uartix.onMenu(cb)</code> 接收点击，<code>uartix.menu.off()</code> 关闭自动菜单改由组件自己处理右键。</li>
                    <li>无边框形态：AI 声明 <code>{"<meta name=\"uartix:chrome\" content=\"none\">"}</code>（卡片带「无边框形态」角标）——无标题栏、窗口透明，内容完全自绘：悬浮通知条、贴角信息窗、计时器、互动桌宠等任意形态。</li>
                    <li>无边框形态开箱行为：按住空白处即拖动（按住跟随、松开即停、自动跳过按钮/输入框、限制不出屏幕）、右键自动弹菜单——由宿主内置，AI 不需要也不允许自己写拖拽代码。</li>
                    <li>管理动作：listWidgets / openWidget / closeWidget / popWidget / removeWidget——「把某挂件弹出到桌面」「关闭某挂件浮窗」一句话直达。</li>
                    <li>示例：对 AI 说「做一个无边框透明桌宠，眼睛跟随鼠标，AI 思考时冒问号，回答时气泡打字机，点击它能向 AI 提问，右键菜单里加『闹脾气』『睡觉』，串口断线时沮丧」。</li>
                  </ul>
                </Section>
                <Section title="软件动作（app action）：39 种，三个入口">
                  <p>
                    这张表是<b>软件动作清单</b>——一处登记、三个入口共用：聊天回复里的 <code>uartix-action</code> 代码块（你点「执行」）、
                    MCP 的 <code>run_action</code>、小部件/自定义卡片里的 <code>uartix.app(kind, args)</code>。
                    除这三个入口外<b>没有</b>第四种调法：能跑 JS 的形态只剩插件里的<b>逻辑模块</b>（见「插件与创造」页），
                    软件不再对用户开放"手写脚本调动作"的 API。
                  </p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>界面控制</td><td>openPanel({"{"}panel{"}"}) · applyPreset({"{"}preset{"}"}) · setTheme({"{"}theme{"}"})</td></tr>
                      <tr><td>查询</td><td>listProtocols() · listCommands() · listCards() · listWidgets()</td></tr>
                      <tr><td>曲线</td><td>addChannel({"{"}tpl,field{"}"}) · clearChannels()</td></tr>
                      <tr><td>写入</td><td>writeCard / writeCommand / writeTemplate / writeCodec（参数 {"{"}json:"…"{"}"}，writeTemplate 支持协议簇批量）</td></tr>
                      <tr><td>控制页</td><td>clearPage()【破坏性】· addPage({"{"}name{"}"}) · patchCard({"{"}name,patch{"}"})</td></tr>
                      <tr><td>删除</td><td>removeCard / removeProtocol / removeCommand / removeCodec / removeWidget（按 name）【破坏性】</td></tr>
                      <tr><td>挂件</td><td>openWidget / closeWidget / popWidget({"{"}name{"}"}) 浮窗管理与弹出桌面</td></tr>
                      <tr><td>连接</td><td>openPort() · closePort()（需开启「允许向设备发送」总闸）</td></tr>
                      <tr><td>传输</td><td>xferStart({"{"}path,proto{"}"}) 预填文件传输对话框（path 可数组多文件排队；开始发送仍需用户点击）</td></tr>
                      <tr><td>Modbus</td><td>modbus({"{"}op:"…"{"}"}) 操作工作台：<code>status</code> · <code>slave.start/stop/configure/write/writeMany/resize</code> · <code>poll.add/remove/clear/configure/start/stop/reset</code>（高权限动作，会占用总线发数据，需逐次批准）</td></tr>
                      <tr><td>读图</td><td>readPlot({"{"}ask{"}"}) 截取当前 2D 曲线面板画面发给模型分析（面板未开会自动打开）</td></tr>
                      <tr><td>哨兵</td><td>sentinel({"{"}op:"status/enable/ackAll/mute/clear"{"}"}) 异常监测查询与控制（高权限动作，需逐次批准）</td></tr>
                      <tr><td>结构发现</td><td>xrayEvidence() / xrayCrack() 读协议考古证据链（帧长/帧型簇/校验爆破/轮询周期，面板需先「采样分析」）· xrayReport() 生成引用证据编号的考古报告（高权限动作，需逐次批准）</td></tr>
                      <tr><td>编排器</td><td>orchestratorRead() 只读快照（总开关/在跑实例/各组统计/变量现值/日志）· orchestrator({"{"}op:"enable/run/stopAll/groupAdd/groupUpdate/groupRemove/eventAdd/eventRemove/blockAdd/blockRemove/varsSet"{"}"}) 写操作（需高权限——发送块会真实发包；eventAdd/blockAdd 能把自动化「说出来即搭」）</td></tr>
                      <tr><td>3D 轨迹</td><td>plot3dRead() 只读快照（全部 groups：各组 axes/mode/显示与配对配置/校准采样/拟合结果/六面进度）· plot3d({"{"}op:"bind/set/groupAdd/groupRemove/clear/undo/redo/calib"{"}"}) 写操作（需高权限；gid 为现存组 ID，缺省 g1（已删则拒绝）；groupRemove 需用户在本机确认；calib 子动作 enter/exit/start/stop/clear/solve6；校准采样源由 calibSource 指定）</td></tr>
                      <tr><td>虚拟设备</td><td>vdev({"{"}op:"status/list/create/start/stop"{"}"}) 虚拟设备工坊（需高权限——设备占据数据管线等同发送）：create/start 带整台设备规格 JSON（信号模型+故障注入+命令应答+可选 net 段），自然语言即可生成虚拟传感器</td></tr>
                      <tr><td>通知</td><td>toast({"{"}msg{"}"})</td></tr>
                    </tbody>
                  </table>
                  <pre>{`// 小部件 / 自定义卡片里（window.uartix 由宿主自动注入，不用自己写 postMessage）：
uartix.app("applyPreset", { preset: "analyze" });
uartix.app("openPanel", { panel: "plot2d" });`}</pre>
                  <pre>{`// 聊天里对 AI 说"本机当从站，40003 写 1234，再开主站轮询读回来画曲线"，它输出的动作块：
{"actions":[
  {"kind":"modbus","args":{"op":"slave.configure","address":1}},
  {"kind":"modbus","args":{"op":"slave.write","area":"holding","index":2,"value":1234}},
  {"kind":"modbus","args":{"op":"slave.start"}},
  {"kind":"modbus","args":{"op":"poll.add","slave":1,"fn":3,"addr":0,"qty":3,"periodMs":500,"varName":"MB温度"}},
  {"kind":"modbus","args":{"op":"poll.start"}}
]}
// 点「执行」逐条跑；modbus 会真的占总线发数据，所以每条都要你在批准卡上确认。`}</pre>
                  <p className="help-tip">高权限动作（破坏性、modbus、sentinel、考古报告、编排器/3D 写入、虚拟设备等）在挂件侧一律不可调用——这是硬限制，不随设置变化；要执行请走 AI 助手的 Agent 任务，由你在批准卡上逐次确认。<b>插件包里的小部件还要另过一道能力门</b>：包没声明 <code>ui.action</code> 时 <code>uartix.app</code> 根本不通（详见「插件与创造」页）。</p>
                </Section>
                <Section title="常用诉求 → 一句话指令">
                  <table className="help-table">
                    <tbody>
                      <tr><td>清空控制画布</td><td>「帮我清空控制画布」</td></tr>
                      <tr><td>批量加控件</td><td>「加 6 个电机速度滑条，模板 MOTOR1~6，2×1 大小流式排布」</td></tr>
                      <tr><td>自定义控件</td><td>「做一个圆表盘电压表卡片，实时显示 VOLT 字段，0~15V」</td></tr>
                      <tr><td>生成命令</td><td>「生成一条归零指令加入命令库」「生成 3 条不同频率的采样指令」</td></tr>
                      <tr><td>做协议</td><td>「做一个指令工厂协议：帧头 AA 55、命令 u8、长度、数据、CRC16-Modbus」</td></tr>
                      <tr><td>协议考古</td><td>「结构发现面板分析完了吗？分析一下这个协议是什么结构，给我一份考古报告」</td></tr>
                      <tr><td>换主题</td><td>「主题换成琉璃，加一点液态玻璃感」</td></tr>
                      <tr><td>做挂件</td><td>「做一个桌面电压监视挂件，低于 10V 变红闪烁」</td></tr>
                      <tr><td>无边框挂件</td><td>「做一个无边框透明挂件贴在屏幕角落，AI 回答时气泡提示」</td></tr>
                      <tr><td>桌宠（示例）</td><td>「做一个无边框桌宠，AI 思考时冒问号，回答时气泡打字机」</td></tr>
                      <tr><td>挂件管理</td><td>「把 XX 弹出到桌面」「关闭 XX 浮窗」「重新打开 XX」</td></tr>
                      <tr><td>自动化</td><td>「写个脚本：每 100ms 上报一次 roll，越界时蜂鸣」</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="MCP 服务器（接入 Claude Desktop / Cursor）">
                  <p className="help-tip">
                    让写代码的 AI 顺手看板子：IDE 里的智能体经 MCP 直接读 Uartix+ 的实时遥测、发指令、跑测试序列。
                    三步接入：
                  </p>
                  <ol className="help-ol">
                    <li>设置 → 集成：打开「启用 MCP 桥」（默认端口 7731，token 自动生成）。</li>
                    <li>
                      构建桥接 CLI：<code>npm run build:mcp</code>，得到 <code>dist-cli/uartix-mcp.cjs</code>
                      （需要本机 Node ≥ 18）；把它的绝对路径填进「桥接 CLI 路径」。
                    </li>
                    <li>
                      点「复制 MCP JSON」，粘贴到 Claude Desktop 的{" "}
                      <code>%APPDATA%\Claude\claude_desktop_config.json</code> 或 Cursor 的{" "}
                      <code>~/.cursor/mcp.json</code>，支持 jobs v1 的应用协商后显示 14 个工具
                      （含 4 个异步任务工具）；旧应用或离线时仅显示原 10 个短工具，不模拟长任务。
                    </li>
                  </ol>
                  <p className="help-tip">
                    安全：服务只绑定 127.0.0.1 + 首行 token 握手 + 单客户端；<b>允许远程发送</b>关闭时 send / run_sequence
                    直接拒绝；删除/开关连接类动作需另开「允许高权限动作」；每次调用在设置页留审计。改端口无需改客户端配置（客户端经发现文件自动定位）。
                  </p>
                  <p className="help-tip">
                    <b>长任务（P88a）</b>：run_sequence 已改为执行前返回 <code>async_required</code>（不执行任何步骤）。耗时超过
                    短调用上限的任务请用 <code>create_job</code> 提交，立即拿到 jobId，再用 <code>get_job</code> 查询、
                    <code>wait_event</code> 短等待、<code>cancel_job</code> 停止。边界如实告知：仅受理可证明无设备副作用的序列
                    （sequence.validate、仅 wait/note/waitForFrame/assertVar 的 sequence.run）；含发送步骤的序列一律立即返回
                    <code>needs_manual_confirmation</code>，不入队、不等待、之后也不执行——<b>highPriv/confirmed 参数不是人工批准</b>。
                    幂等键重试同一任务不会重复执行；应用重启后旧任务返回 instance_changed（不自动补发）；
                    任务状态以 Rust 登记表为准（停止中≠已停止，取消不撤销已发生效果）。设置 → 集成 → 「任务」区可本机查看与取消。
                  </p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>读</td><td>get_status 连接总览 · get_fields 变量快照 · get_frames 最近帧 · get_plot_stats 曲线统计 · get_alerts 哨兵健康 · get_orchestrator 编排器快照 · get_plot3d 3D 轨迹与校准快照</td></tr>
                      <tr><td>写</td><td>send 发送（ascii 支持 \r \n \t \xNN）· run_action 白名单动作（含 orchestrator / plot3d 两组）· run_sequence 已停用（async_required → 用 create_job）</td></tr>
                      <tr><td>任务</td><td>create_job 提交（taskType=sequence.validate|sequence.run）· get_job 查询/结果分页 · wait_event ≤1s 短等待 · cancel_job 协作停止；同一幂等键重复提交返回同一 jobId</td></tr>
                      <tr><td>调试</td><td><code>node uartix-mcp.cjs --status</code> 检查发现文件与连通性；<code>npm run mcp:e2e</code> 跑协议层冒烟</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="成本控制（省钱技巧）">
                  <ul className="help-ol">
                    <li>上下文默认只带「协议清单」（几十 token）；「协议完整定义」按需勾选。</li>
                    <li>系统提示按需注入：AI 只在需要某格式时自动加载对应规范，普通问答不带全量提示词。</li>
                    <li>多轮长对话定期「新对话」；历史只带最近 20 条。</li>
                    <li>协议识别建议温度 ≤0.3；本地 Ollama 零成本。</li>
                  </ul>
                </Section>
              </>
            )}
            {tab === "plugins" && (
              <>
                <p>
                  这一页讲<b>软件能装什么、装完归谁管</b>。入口有两个：<code>设置 → 插件管理</code>，
                  以及 AI 助手顶栏「更多 ▾ → 本地插件库」（同一个东西，少跳一步）。
                  包格式是 <code>uartix-plugin</code>，本地 JSON 存储。<b>标题栏 AI 助手旁边那颗拼图图标直接开「插件管理」</b>（就是设置页那一栏，不另做一个窗口）；<b>插件市场</b>在插件库面板里那颗按钮后面（设置 → 插件管理、AI 助手「更多 ▾ → 本地插件库」两处都有）。市场<b>只在你打开那一页时才联网</b>取索引（启动路径零外发），装进来的包一律是<b>停用态</b>，覆盖本机已有版本的那种还要你在确认卡上点「装入」。
                </p>
                <Section title="六种产物：分别是什么、装上会不会自己生效">
                  <table className="help-table">
                    <tbody>
                      <tr><td>主题</td><td>一套外观变量（+可选受限 CSS）。<b>分两条路，结果不一样</b>：AI 保存/固化出来的主题<b>当场就是已启用</b>；<b>从插件市场装的是一枚停用态的包</b>，要你在市场「外观」页签或插件库里点一次「启用」才会上屏。停用/卸载即撤掉这枚主题，界面回到你在设置里选中的内置那枚。<b>同时只有一枚主题在画</b>——启用第二枚会把前一枚挤掉（回执里会点名是谁）。</td></tr>
                      <tr><td>小部件</td><td>浮窗 / 桌面挂件（HTML 沙箱 iframe）。<b>会</b>自动启用。</td></tr>
                      <tr><td>面板</td><td>一块常驻面板，可以是声明式积木，也可以是 HTML。<b>会</b>自动启用。</td></tr>
                      <tr><td>工作区预设</td><td>一套面板排布（dockview 布局 JSON）。<b>启用 ≠ 生效</b>：它只是出现在库里，你要在那条产物上点<b>「应用此布局」</b>，整屏排列才会被替换；点之前当前布局自动存进 设置 → 工作区 的备份槽，随时回得去。</td></tr>
                      <tr><td>任务模板</td><td>一段目标 + 给 AI 的建议步骤。点<b>「载入 AI 助手」</b>只是把话填进输入框，<b>不替你发送</b>；步骤是建议，不是硬指令。存的时候引用了不存在的工具会被直接拒绝。</td></tr>
                      <tr><td>逻辑模块</td><td>本包自带的 JS，跑在<b>专用 Worker</b> 里（见下）。<b>不会</b>自动启用，永远要你在插件库里点一次。</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">
                    前四类是"AI 存下来就能自己生效"的（<b>从市场装的除外——市场那条路径一律落成停用态</b>）。
                    <b>逻辑模块不会自动启用</b>——会跑 JS 的包不得被自动放行，
                    这是硬规矩：否则"AI 存一个包 → 自己启用 → 下一步多出一支自己能调的工具"就是自提权的正门。
                  </p>
                </Section>
                <Section title="能力名册（12 项）：包能声明什么">
                  <p>manifest 里写在这 12 项之外的能力，一律拒绝入库。名字与插件库详情里的标签是同一份：</p>
                  <table className="help-table">
                    <tbody>
                      <tr><td>主题 token</td><td>改外观变量</td></tr>
                      <tr><td>自定义面板</td><td>加一块常驻面板</td></tr>
                      <tr><td>小部件</td><td>加浮窗 / 桌面挂件</td></tr>
                      <tr><td>界面动作</td><td>调 39 个软件动作（<code>uartix.app</code>）；缺它那些调用静默不生效</td></tr>
                      <tr><td>窗口控制</td><td>置顶 / 点击穿透 / 弹出独立窗口。<b>不会自动启用</b></td></tr>
                      <tr><td>运行 JS</td><td>本包 JS 进专用 Worker。<b>不会自动启用</b></td></tr>
                      <tr><td>注册 AI 工具</td><td>往 AI 助手的工具面里加自定义工具。<b>不会自动启用</b></td></tr>
                      <tr><td>工作区布局预设</td><td>带一套面板排布（生效仍要你点「应用此布局」）</td></tr>
                      <tr><td>任务模板</td><td>存一段可复用的目标 + 建议步骤</td></tr>
                      <tr><td>读取数据快照</td><td>接收实时字段与 AI 对话状态推送</td></tr>
                      <tr><td>发送串口数据</td><td>向设备发字节。<b>不会自动启用</b>，且另受全局「允许向设备发送」总闸限制</td></tr>
                      <tr><td>向 AI 助手提问</td><td>组件反向问 AI。<b>不会自动启用</b></td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">
                    <b>不会自动启用</b>的那五项（窗口控制、运行 JS、注册 AI 工具、发送串口数据、向 AI 助手提问）是<b>按能力类别整类挡</b>的，
                    不是按"作者看起来可不可信"挡的；作者自报的可信标记不构成信任。
                  </p>
                </Section>
                <Section title="导入、启停、批量管理">
                  <ul className="help-ol">
                    <li><b>导入一律先停用</b>：选文件 / 粘贴包 JSON → 先跑校验（超限字段带截断标记报给你），通过了也还是停用状态，启用是你另一次动作。超 4 MiB 直接拒。</li>
                    <li>导出：单个包或批量导成 JSON，可以直接发给别人；<b>没有</b>任何"导出即签名"的含义。</li>
                    <li>批量：顶部多选后可批量启用 / 停用 / 卸载 / 导出，装多了不用一个个点。</li>
                    <li>详情里能看见这个包声明了哪几项能力、带了哪几类产物、以及它有没有触发过<b>隔离违规</b>（伪造消息 / 越权调用）。多次违规会被隔离，卸载重装才解。</li>
                    <li>版本链：同一个包被反复保存会升版本号并保留旧版，可<b>退回上一版</b>；更新候选要你先批准或拒绝，不会静默替换你在用的东西。</li>
                  </ul>
                </Section>
                <Section title="逻辑模块：JS 跑在哪、封了什么、怎么算失控">
                  <ul className="help-ol">
                    <li>每包最多 1 个模块、代码上限 256 KiB；<b>不联网</b>（Worker 内取回原引用的路数被逐条封掉，出网通道不存在）。</li>
                    <li>启用后先做<b>封网自证</b>：模块自己按宿主要求逐项验证"我确实拿不到 fetch / import / 主世界对象"，4 秒内自证不通过就标为<b>封网未通过（已拦停）</b>，工具不注册、代码不再跑。</li>
                    <li>每次调用 10 秒超时；超时或崩掉会被终止并标<b>已失控终止（停用再启用可重来）</b>，重建最多 3 次。</li>
                    <li>带工具的模块可注册自定义工具：每包 ≤8 支、全局 ≤64 支，名字强制 <code>plg_</code> 前缀 + 包名 + 稳定短哈希，<b>宿主同名工具永远不被接管</b>。</li>
                    <li>新注册的工具<b>下一个任务才生效</b>——正在跑的任务不会中途多出手来。</li>
                  </ul>
                  <p className="help-tip">
                    如实说一句边界：realm 内封网是"同一条路走不通"，不是"引擎层面不可能"。所以信任边界仍然是<b>安装前你自己看一眼能力与产物 + 含 JS 的包必须人工启用</b>，
                    Worker 加固是第二层，不是第一层。
                  </p>
                </Section>
                <Section title="AI 造的插件 vs 你装的插件：能力从哪来">
                  <ul className="help-ol">
                    <li>AI 用 <code>save_plugin</code> 存的包，能力<b>由产物种类决定</b>，它没有加码的余地：小部件包只有小部件 + 读取数据快照两项，所以那种包里的发送 / 界面动作 / 提问调用都不会生效。要那些能力得你自己装带相应能力的包。</li>
                    <li>AI 自己造的包<b>碰不到设备发送</b>——这是产物表里写死的，不是一个可以被设置翻掉的开关。</li>
                    <li>只有 AI 自己创建的包能被它静默升版；你导入的包它改不动，回执是 <code>update_needs_user</code>，绝不覆盖。</li>
                    <li>插件带来的工具在台账里标着来源包，你能看出这一步是宿主动的还是某个包动的。</li>
                  </ul>
                </Section>
              </>
            )}
            {tab === "panels" && (
              <>
                  <Section title="面板一览与推荐工作流">
                  <table className="help-table">
                    <tbody>
                      <tr><td>协议模板</td><td>协议簇管理：导入预设、新建、启停解析、复制/粘贴帧型</td></tr>
                      <tr><td>帧画布</td><td>核心编辑器：字节格上框选定义字段，帧头帧尾可编辑</td></tr>
                      <tr><td>Hex 数据流</td><td>原始字节流总览，同样支持框选定义与 Ctrl+F 搜索</td></tr>
                      <tr><td>属性</td><td>选中模板/字段后编辑其全部参数</td></tr>
                      <tr><td>数据表格</td><td>逐帧列表，可排序/筛选/导出 CSV·XLSX</td></tr>
                      <tr><td>2D 曲线</td><td>字段图例点眼睛开曲线；支持平移/框选缩放/双击复位</td></tr>
                      <tr><td>频谱分析</td><td>FFT 频谱（主峰/频率分辨率/线性或 dB）与直方图（均值/σ/分布）双模式；与 2D 曲线共享通道数据，选通道点数窗函数，可冻结谱面观察</td></tr>
                      <tr><td>3D 姿态</td><td>把欧拉角或四元数字段映射到 3D 模型（+面板可添加）</td></tr>
                      <tr><td>3D 轨迹</td><td>三路变量当空间坐标画实时三维轨迹（着色/拖尾/网格/跟随/自动旋转/键盘飞行/光标缩放/底部时间条历史回看与回放联动）；内置椭球校准（八象限点云采样 → 九参数拟合：硬磁偏置×3 + 软磁对称校正矩阵×6，给 CV 与残差 RMS，支持残差着色、校正前后对比、在线补偿预览，一键复制 JSON/C 数组）与六面校准（加计专用，六姿态各静置 2 秒直接解算）</td></tr>
                      <tr><td>图传</td><td>把每帧数据渲染为画面：暂停/回看/保存帧、镜像翻转、缩放拖动；「解析设置」定义帧定界方式</td></tr>
                      <tr><td>控制画布</td><td>拖拽部署滑条/按钮/开关/LED/蜂鸣器等控件向下位机发指令；拖动时虚线幽灵框指示落点，松手只会落到空格。「更多」菜单可从预设生成<b>惯导调试页</b>（1–12 个受管参数滑条 + 录制/停止/打点等会话动作卡）并用<b>参数集</b>保存/载入本地草稿值；受管设备的发送/急停/校准/读回需配置设备契约后可用，生成与载入均不发送指令</td></tr>
                      <tr><td>控制台</td><td>原始收发日志（时间戳彩色），可发 ASCII/Hex、发送文件、录制日志；上方快捷指令栏一键发送，指令工厂可组各协议帧</td></tr>
                      <tr><td>结构发现</td><td>未知协议考古：对原始字节做周期/帧头统计推断、校验算法爆破与帧型序列分析，勾选帧型一键批量生成模板；AI 可引用其证据链生成推理报告</td></tr>
                      <tr><td>哨兵</td><td>静默异常监测：数值通道突变（双 EMA z-score）、新帧型出现、错误帧率超限、通信静默四类报警；报警自动降噪合并，可最小化成右下角浮球或弹出桌面挂件驻留报警（面板、浮球与桌面挂件全部关闭才停止监测），支持合成提示音；一键或自动发起 AI 诊断（携带证据，见 AI 助手详解）</td></tr>
                      <tr><td>Modbus 工作台</td><td>模拟从站（本机当从站应答，四张可编辑数据表 + 故障注入）与主站轮询表（按周期读寄存器/线圈，值直接写成变量）；关掉面板仍在运行，工具栏有绿色徽标</td></tr>
                      <tr><td>测试序列器</td><td>拖积木组出自动化测试：发送/等待/等帧/断言/分组/备注六类步骤，帧到达触发自动运行、单步调试、failFast；自包含 HTML 报告一键导出；JSON 导入导出分享套件；配套 CLI（内置回环设备）可进 CI 无硬件跑断言。关面板即停，绝不后台发包</td></tr>
                      <tr><td>自动编排器</td><td>事件-条件-动作编排：组头部事件槽挂事件块（帧命中/坏帧/新帧型/阈值/通道变化/定时器/会话开断/哨兵/变量变更/自定义事件/通信静默共 12 类）自动触发，组内块流 23 类块——除发送/等待/等帧/跑序列/调用组/变量/通知/提示音与如果/循环/跳出/中止/子组外，还有操作画布控件、写 Modbus、截图/导 CSV/剪贴板、发自定义事件等自动化工具箱；「从模板新建」内置报警通知/看门狗/定时轮询/收发握手/PID 继电反馈整定五套模板（导入默认停用）；总开关 + 冷却 + 熔断多重保护（详见帮助页签）</td></tr>
                      <tr><td>AI 助手</td><td>AI 调试助手：协议识别、数据解读、曲线分析、指令/卡片生成、诊断排查、调试报告；Ctrl+K 唤起浮窗，可停靠为面板（+面板 可添加）</td></tr>
                      <tr><td>虚拟设备工坊</td><td>可编程虚拟数据源（与真实接口互斥，关面板仍在跑，状态栏有徽标）：信号模型（常量/正弦/方波/三角/一阶对象/镜像）+ 温漂/丢帧/卡死/毛刺故障注入 + 命令应答（匹配前缀可捕获数值写输入量、回应答帧）；可选 net 段走 UDP/TCP 客户端/TCP 服务端/串口对外收发；启动即自动配套协议模板；内置「温控炉」（PID 教学被控对象）与「虚拟 MPU6050」（WIT 兼容帧）；设备库存档/导出 JSON 分享，也可让 AI 按自然语言生成（+面板 可添加）</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">推荐流：Hex/帧画布定义协议 → 表格与曲线观察 → 控制画布下发指令闭环调试。没有硬件？「虚拟设备工坊」载入内置设备即可全链路体验；新手推荐先点「快速入门」顶部的「启动交互式教学」。</p>
                  </Section>
                {/* P102：这一节原先在「协议画布教程」里——图传是一枚面板（+ 面板 → 数据接入），
                    不是画布上的定义动作；它唯一与画布有关的那句（帧定界）就是"复用解析设置"。 */}
                <Section title="图传（视频链路）用法">
                  <p>
                    面板在<b>「+ 面板 → 数据接入」</b>。把数据流按<b>已解析出的帧</b>渲染成画面（如无人机摄像头的 JPEG 帧流）：
                  </p>
                  <ol className="help-ol">
                    <li>工具栏点<code>解析设置</code>，选择帧定界方式（定长 / 长度域 / 帧尾）——<b>每解析出一帧即刷新画面</b>，所以它跟的是解析结果，不是原始字节。</li>
                    <li>点<code>暂停</code>后可点选历史帧回看，点<code>保存</code>导出当前显示的帧。</li>
                    <li><code>水平镜像</code>、<code>垂直翻转</code>矫正画面方向；滚轮缩放、拖动平移，双击复位。</li>
                    <li>数据来源与串口/网络完全一致：TCP/UDP 接收图传流同样可用。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "canvas" && (
              <>
                <Section title="Modbus 工作台：没有硬件也能测">
                  <p>面板分两页，<b>同一时刻只能开一页的服务</b>（自己问自己答会得出"设备健康"的假象）：</p>
                  <ul className="help-ol">
                    <li><b>模拟从站</b>：设本机从站地址（也可"应答所有地址"当多从站），四张数据表就是被读的内容——线圈/离散输入点位格子点击翻转，保持/输入寄存器直接填数（可切 HEX，悬停显示 4x 手册编号）。<b>故障注入</b>可让它不回应答（复现主站超时）、一律回某异常码、或隔一次回一次异常；还能加应答延时模拟慢速从站。主站写进来的值会实时反映在表里。</li>
                    <li><b>主站轮询</b>：一行 = 问谁、用什么功能码、起始地址、数量、周期、值写进哪个变量（还能指定取第几个元素与倍率）。响应解析在这里完成，<b>不需要再配协议模板</b>，变量直接可画曲线、进表格、被脚本读。半双工保护：一条请求没回应答前不会发下一条，1 秒无应答记一次超时。</li>
                    <li><b>帧格式</b>：RTU 与 TCP 是<b>帧格式</b>选择而不是接口选择——RTU 完全可以跑在 TCP 串口隧道上，反之不成立，所以 Modbus TCP 只在网络接口下可用。</li>
                    <li><b>自环演示</b>：两台实例（或一台跑从站、另一台跑轮询）接在同一对串口/网络上即可对打；也可用「指令工厂 → Modbus RTU」手发一条请求看从站应答。</li>
                  </ul>
                </Section>
                <Section title="虚拟设备工坊：让软件扮演一台设备">
                  <p>面板在「+ 面板 → 数据接入」。设备 = 一份 JSON 规格：信号模型（常量/正弦/方波/三角/<b>一阶惯性对象</b>/镜像）+ 噪声/温漂 + 丢帧/卡死/毛刺故障 + 帧格式 + 命令匹配。启动即自动配套协议模板；运行中锁定编辑（停机再改）。内置两台：<b>温控炉</b>（HEAT ON/OFF 控温、SET DUTY 45 捕获数值直调加热功率，PID 整定模板的被控对象）与<b>虚拟 MPU6050</b>（维特 WIT 兼容帧 + 温漂 + 丢帧 + 毛刺）。设备库存档管理：载入库条目编辑后点<code>保存</code>原位更新（改名不产生重复；新建/内置/另存副本/导入均为未保存态，脏了按钮亮起）。</p>
                  <p><b>网络收发（像真设备一样在链路上）</b>：规格里可选 net 段——UDP 把帧逐字节发到指定 host:port（.255 自动广播，可加 ≤4 个额外目标一帧多投，可选监听端口收外部命令）；TCP 客户端拨出、TCP 服务端监听（≤8 客户端广播）；串口独占 COM 口直写（接收端可用 com0com 虚拟串口对）。命令去向：本机控制台/编排器与网络来令走同一匹配器，网络来令的应答原路返回。运行中状态行实时显示发出的帧数/收令数/客户端数与最近命令。</p>
                  <p><b>双机教学</b>：A 机启动温控炉开 UDP 发射 9010 → B 机数据接口选 UDP 服务端监听 9010 + 「+ 预设 → 虚拟设备·温控炉」→ 两台看到同一条曲线。绑 0.0.0.0 允许局域网接入（首次可能弹防火墙授权）。</p>
                </Section>
                <Section title="协议簇">
                  <p>一个协议可含多个帧型（如匿名 V7 的 22 种功能码）：左侧列表一行代表整簇，点行选中，点行首箭头展开帧型；簇内右键可复制/粘贴帧型。画布顶部页签与左侧联动。</p>
                </Section>
                <Section title="三种截帧模式与变长载荷">
                  <p>截帧方式在模板属性里选择，画布拖拽定义的字段按<b>固定偏移</b>解析：</p>
                  <ul className="help-ol">
                    <li><code>固定长度</code>：整帧字节数固定（如 11B），收满即成帧。</li>
                    <li><code>帧头＋长度字段</code>：帧内自带长度计数器，解析器读它算出本帧总长（总长 = 长度域原始值 + 修正）。把某格定义为「数据长度(LEN)」并选 u8/u16，其偏移与宽度自动同步为长度域配置；属性面板反向修改长度域同样会移动 LEN 字段。</li>
                    <li><code>帧头＋帧尾</code>：收到帧尾字节即成帧，中间数据长度天然不定。</li>
                  </ul>
                  <p>载荷长度逐帧可变的协议：把数据区字段勾选<code>延伸至载荷尾（自适应变长）</code>——字段从其偏移一直覆盖到校验/帧尾之前，随每帧实际长度伸缩，画布上该块带 ↔ 标记。再选<code>元素类型</code>（默认 float32 小端）：载荷区按元素宽度逐个解码，输出 <code>名称1..N</code> 动态数值变量（可绘图、可脚本引用，上限 64，随每帧实际长度自适应，缩放/字节序逐元素生效）；选「文本」则输出一整个 HEX/ASCII 字符串变量。均匀序列（三轴角度、N 点采样）用元素模式；混合结构请定义固定偏移字段，只把均匀的尾段交给自适应。图例中自适应字段的眼睛为组开关：一下开整组曲线，再点移除。</p>
                  <p><b>校验闭环</b>：画布上把某格定义为「和校验(CK1)」时即可选择算法（默认 sum8），<b>保存即启用</b>——覆盖范围自动设为帧首至校验域前，校验不过的帧直接被过滤；字段宽度自动匹配算法产出（sum8=1B、CRC16/SC+AC=2B、CRC32=4B），不一致会被模板校验拦下。CK2 仅是视觉标注位。校验块悬停可看当前算法与覆盖范围，未启用时会明确提示。<b>变长帧（长度字段/帧尾模式）的校验域自动锚定帧尾</b>：定位 = 帧长 − 校验宽度 − 帧尾字节数，字段的固定偏移仅作画布标注，随每帧长度自适应（Modbus RTU、MAVLink 即此布局）。</p>
                  <p><b>尾锚字段（负偏移）</b>：字段偏移支持负数=距帧尾（<code>−1</code> 即最后一字节，<code>−2</code> = 末两字节起始）。变长帧里位于尾部、位置随帧长浮动的数据（帧尾状态字节、帧计数、尾校验前的字段）用它定义，随每帧长度自适应。属性面板偏移直接填负数，或框选尾部字节后在字段对话框选「帧尾起算」。短帧放不下时该字段自动跳过。</p>
                </Section>
                <Section title="自适应文本帧（JustFloat 式）">
                  <p><code>＋ 新建 → 自适应文本帧</code>：设分隔符（, \ ;）与元素类型（float/uint8…），按每帧实际段数动态生成 通道1…通道N，各通道可单独绘图、供脚本引用。</p>
                </Section>
                <Section title="Modbus RTU / TCP 抓包">
                  <p><code>＋ 预设 → Modbus RTU / Modbus TCP</code> 一次导入整簇帧型（RTU 13 种 / TCP 15 种），无需自己画：</p>
                  <ul className="help-ol">
                    <li><b>整条总线一次收</b>：帧头写成 <code>?? FC</code>——首字节位掩码 0x00 = 通配，任意从站地址（含广播 0）都能解，不必逐台改模板。</li>
                    <li><b>寄存器区自动展开</b>：读响应按 byteCount 定帧，数据区按大端 uint16 展开为 <code>寄存器1..N</code>，每个都是可绘图、可脚本引用的数值变量。</li>
                    <li><b>线圈按位展开</b>：FC01/02 的长度域是「位数」，引擎按 0.125 倍率换算字节数，并把线圈区逐位展开为 <code>线圈1..N</code>（0/1 一通道，每字节低位在前）。</li>
                    <li><b>异常直接可读</b>：异常响应用 <code>FC &amp; 0x80</code> 位掩码一条覆盖所有功能码，异常码自带规范文字（表格显示 <code>2 非法数据地址</code>）。</li>
                    <li><b>TCP 无 CRC 也能分主从</b>：MBAP 长度域的奇偶就是方向标识（请求恒 6＝偶、响应 3+2N＝奇），嗅探 502 端口时主站请求与从站响应不会互相误判。</li>
                    <li><b>RS485 注意</b>：抓 485 半双工总线要把 USB 转串口接在<b>总线两端之外</b>（或用带接收的监听头），并注意 A/B 线反接时字节全是垃圾；3.5 字符静默在 USB 转串口上不可靠，因此本软件按<b>长度域 + CRC</b> 定帧，不依赖帧间隔。主站轮询与从站应答共用功能码，两条模板同时命中属正常，引擎会按有效行覆盖关系自动去掉噪声坏帧。</li>
                  </ul>
                </Section>
                <Section title="值标签（枚举注解）">
                  <p>字段属性里的<code>值标签</code>把状态码翻译成文字：填 <code>0=就绪; 1=运行; 2=故障</code>（支持 <code>0x</code> 十六进制），命中时数据表格、帧画布悬停、图例与 CSV/Excel 导出都会显示「数字 文字」。这是纯显示层能力——数值通道、曲线、变量、脚本仍拿到原始数字。</p>
                </Section>
                <Section title="骨架编辑">
                  <p>选中一个模板但还没有收到匹配数据时，画布显示骨架格（按模板定义推算长度）——此时就能框选定义字段；协议完全匹配后格子才切换为真实数据。帧头/帧尾格固定显示模板字节。</p>
                </Section>
              </>
            )}
            {tab === "plot3d" && (
              <>
                <p><b>3D 轨迹面板</b>支持<b>多组独立轨迹（默认三组）</b>（如惯导推算 / 实际导航 / 目标路径）叠加显示：每组各绑 X / Y（Z 可留空=平面轨迹）并独立选显示模式（实时定位 / 点集 / 连线），支持大坐标（经纬度）自动重锚（跨组并集）、双层 LOD 长跑不卡。工具栏「+ 面板」添加。</p>
                <Section title="轨迹组增删与显示模式">
                  <ol className="help-ol">
                    <li>左上<b>组托盘</b>默认三行（G1 / G2 / G3），底部可新增、行按钮可删除（本机确认）；组多时滚动：每行 = 可见性眼睛、组色点、名称、模式徽标、<b>X / Y / Z 三个绑定下拉</b>（红绿蓝侧条区分轴，Z 留空=平面轨迹）、<b>设置齿轮</b>。X/Y 绑齐该组才开始绘制；未绑齐的行置灰。</li>
                    <li>每组独立选择显示模式（<b>不提供混合模式</b>——不同组各选各的天然叠加）：<code>实时定位</code>=只显示最新点、零历史内存（看当前车位置）；<code>点集</code>=全部历史点不连线（看打点分布）；<code>连线</code>=按时间连线。</li>
                    <li>连线<b>平滑四档</b>：无（折线）/ <b>滑动平均</b>（奇数窗）/ <b>Catmull-Rom</b>（曲线穿过数据点，张力 0~1 + 细分 2~10 可调）/ <b>三次样条</b>（曲率连续）。平滑只作用于视觉几何——悬停读数、测距、CSV 导出、游标截断全部仍读原始数据点。</li>
                    <li>组设置弹层（齿轮 / 行右键菜单）：名称、颜色、模式、着色（按时间 / 按通道 / 组色实底）、渐隐窗口、点大小 / 透明度、最大点数（超限从最老端丢弃，0=不限）、点密度、数据配对与容差、备注。<b>确认一次 = 一步可撤销</b>（Ctrl+Z；面板右上也有撤销/重做钮）。</li>
                    <li>拖拽：把协议模板面板的<b>图例字段行直接拖到组行</b>=智能绑定（按 X→Y→Z 填第一个空槽；三槽已满会打开组设置让你手动改）。</li>
                    <li>行操作：双击组行 = 相机聚焦该组；行右键 = 设置 / 隐藏 / 聚焦 / 单组导出 CSV / <b>导入轨迹 CSV → 本组</b>（t,x,y[,z] 列→虚拟通道，重复导入替换旧的）/ 单组清空（<b>清空不可撤销</b>，有确认）。</li>
                    <li>三轴来自不同帧/不同采样率时，组设置里可切<b>配对模式</b>（插值/最近点）与容差，右下 HUD 有主组配对统计行；各组量级悬殊可切全局<b>逐轴独立缩放</b>（右键「设置」），避免小跨度组被压扁。</li>
                    <li>右上视角托盘（毛玻璃胶囊）：<b>俯视 / 侧视 / 正视 / 等轴</b>四预设、重置视角、聚焦最新点、跟随模式、自动旋转、<b>撤销/重做</b>、<b>打点</b>（录制中在当前时刻记标注：时间轴刻度+2D 虚线+3D 旗标三处同步，点旗标即跳游标）、椭球校准、<b>清空数据</b>（全部组清空，带确认）。左键拖动旋转、右键拖动平移、滚轮缩放。</li>
                    <li><code>跟随模式</code>：视角平滑锁定主组（按组顺序取首个可见且有数据的组）最新点；<code>自动旋转</code>：展台展示（两者互斥）。右键菜单按「组 / 模式 / 视图 / 测量 / 数据 / 设置」分组；悬停任意点显示所属组与真实坐标，可一键复制；右下 HUD 带<b>网格步长比例尺</b>读数。</li>
                  </ol>
                </Section>
                <Section title="惯导物理层（朝向 / 模型 / 坐标变换）">
                  <ol className="help-ol">
                    <li><b>车头朝向</b>四源：默认 +X / <b>速度方向</b>（轨迹差分自动转头）/ <b>航向角通道</b>（度，带修正角与顺逆翻转钮）/ <b>四元数</b>（qX/qY/qZ/qW 四通道绑定）。配合非「光点」的<b>显示模型</b>（球 / 箭头 / 车 / 锥 / 坐标轴 / <b>本地 GLTF·GLB</b>），一辆「车」就沿轨迹实时转向行驶；模型有缩放、旋转修正与高度偏移。</li>
                    <li><b>组坐标变换</b>（旋转 Z·Y·X + 平移 + 缩放）：解决 NED↔ENU 换系、传感器装歪、单位比例差异——各组不同来源的数据能拉进同一世界坐标对比。变换作用于显示/导出/测量全链同源；<b>校准采样恒用原始传感器值</b>，不受变换影响。</li>
                    <li><b>首点对齐原点</b>（组设置内一键）：把每个已绑组的第一个轨迹点平移到世界原点——惯导「推算 vs 实际 vs 目标」起点不同也能直接叠图看发散。</li>
                    <li><b>方向箭头</b>（连线模式每 N 点一支，0=关）沿前进方向指示；<b>起点标记</b>在最老点立光点，终点=最新点标记常显。</li>
                  </ol>
                </Section>
                <Section title="键盘飞行与缩放">
                  <ol className="help-ol">
                    <li>右键菜单「视图」开启<code>键盘飞行</code>后，鼠标悬停在画布上即可用键盘漫游（不悬停时不响应，不抢其他面板按键）。</li>
                    <li><code>W/A/S/D</code> 水平平移（相机朝向为准），<code>Q/E</code> 降/升，<code>方向键</code>绕目标旋转，<code>F</code> 切换跟随，<code>R</code> 重置视角。</li>
                    <li>飞行速度与视角距离成比例（越近越慢，精细贴近观察）。</li>
                    <li>右键菜单「视图」可开<code>缩放到光标</code>：滚轮朝指针位置缩放（默认关闭，绕视线中心缩放）。</li>
                  </ol>
                </Section>
                <Section title="时间条与回放">
                  <ol className="help-ol">
                    <li>底部时间条拖动即<code>时间游标</code>：轨迹截断显示到该时刻，可与 2D 曲线回放联动。</li>
                    <li>实时模式下双击时间条或使用菜单「数据 → 回到最新」清除定位游标；这不是把回放跳到末尾。</li>
                    <li><code>设置 → 通用 → 跨面板时间联动</code>控制 2D 时间横轴与 3D 的游标同步，本次运行有效。关闭后仍会跟随真实回放进度；回放定位会移动播放位置。</li>
                  </ol>
                </Section>
                <Section title="椭球校准（磁力计 / 加计九参数）">
                  <ol className="help-ol">
                    <li>用途：评估磁力计/加计的<b>硬磁偏置（offset）</b>与<b>软磁畸变（校正矩阵 W）</b>，输出九参数给固件做补偿。</li>
                    <li>流程：给<b>所选校准源组</b>绑定原始三轴（行右键可设为校准源；默认 g1，删源后不自动换源；切源清空临时校准状态）→ 右键「模式 → 椭球校准模式」（或工具栏 ◎ 按钮）→ 点<code>开始采样</code> → 缓慢翻滚传感器覆盖全空间（画 8 字）→ <code>拟合椭球</code>。校准 HUD 顶部可切「<b>椭球拟合</b>（磁/加通用）」与「<b>六面向导</b>（加计专用）」两个子页，切换会清空对方采样。</li>
                    <li>点云越接近球面越好；<b>象限覆盖 8/8</b> 才允许拟合（只转半圈会被拒绝并提示）；<code>CV</code> 校正后半径变异系数（&lt;3% 为优）、<code>RMS</code> 为球面残差。</li>
                    <li>拟合成功后点云自动<b>残差着色</b>（绿 = ±3% 内 / 黄 = ±8% 内 / 红 = 出界）；<code>显示：原始 / 校正后</code>一键对比——校正后点云应收缩为均匀球壳（附参考球线框）。</li>
                    <li><code>补偿预览</code>：拟合成功后实时绘制校正后幅值 r=|W·(x−offset)| 迷你图——转动传感器时曲线贴 1.0 线小幅抖动 = 校准有效，单轴靠近铁磁物会明显抬升/下凹；拟合后继续采样会挂起预览（灰显），重新拟合自动恢复。</li>
                    <li>结果可<code>复制 JSON</code> 或<code>复制 C 数组</code>（mag_offset[3] + mag_matrix[3][3]，直接贴进固件）。</li>
                    <li>采样中更换绑定/密度会清空重采；采到 20000 点自动停止；拟合后再采样，结果会标记「基于旧采样」。</li>
                    <li><b>六面向导（加计专用）</b>：利用重力先验，六个面依次<b>朝上静置</b>点「采集该面」（自动采 2 秒，晃动会被 σ 门拒绝）→ 六面齐后<code>计算参数</code> → 输出 acc_offset / acc_gain（校正后 ≈ 1g），附三轴尺度一致性 CV 与面偏差指标；顺序摆错（两面同轴）会被拒绝并提示。</li>
                    <li>退出校准模式即恢复原轨迹（数据不清空）；校准属于操作态，不会被打进 Operator 部署包。</li>
                  </ol>
                </Section>
                <Section title="指标分析与分析包">
                  <ol className="help-ol">
                    <li>通过「添加面板」打开指标面板，选择通道、轨迹组和窗口后手动刷新。可复制 2D 的 A/B 范围；改变选项不会自动重算已有结果。</li>
                    <li><code>设置 → 通用 → 分析包</code>提供全局入口，2D、3D 和数据表格保留局部入口。指标面板入口会带入已有结果的选区；普通入口需在对话框内选择缓存窗口。</li>
                    <li>分析包仅写入本地新目录，不上传、不覆盖已有包；指标基于原始缓存，不以显示平滑或 LOD 几何作为分析真值。已淘汰数据不能恢复。</li>
                    <li>AI 分析需显式发送摘要；组备注先预览再写入，期间备注若有变化会报告冲突，不覆盖新内容。</li>
                  </ol>
                </Section>
                <Section title="导出">
                  <ol className="help-ol">
                    <li><code>导出组 N 轨迹 CSV</code>（数据菜单 / 组行右键）：相对秒 t_s + 该组三个绑定通道全量数据（与显示严格同源，UTF-8 BOM，Excel 可直接打开）。</li>
                    <li><code>快照 PNG</code>：当前视角整帧截图保存。</li>
                  </ol>
                </Section>
              </>
            )}
            {tab === "orchestrator" && (
              <>
                <p><b>自动编排器</b>＝测试序列器（线性流程）× 触发器（事件驱动）：组是编排单元，头部事件槽挂事件块自动触发，组内块线性执行。工具栏「+ 面板」添加；编辑随时可做，运行中的实例不受影响（下次触发生效）。</p>
                <Section title="组与事件槽">
                  <ol className="help-ol">
                    <li>组头部：勾选框启用（禁用后事件不触发、运行按钮也不跑）、<b>运行</b>按钮手动跑一次（不受熔断限制）、复制整组、删除；双击标题重命名，标题行箭头折叠。</li>
                    <li>事件槽在标题下方独立一行：点徽标在右侧检查器编辑参数，「添加事件」挂事件，徽标可拖动排序，移除按钮删除。<b>事件块只能放进事件槽</b>——拖进块流会被拒绝并提示。</li>
                    <li>事件 12 类：手动 / 帧命中（可设 1/N 抽稀 stride）/ 坏帧命中 / 新帧型出现（逆向现场新固件上线瞬间报警）/ 阈值穿越（进入/回落 + 去抖）/ 通道值变化（可设最小间隔节流）/ 定时器（≥50ms）/ 会话开断 / 哨兵告警（warn/crit）/ 变量变更 / 自定义事件（配「发自定义事件」块做跨组解耦）/ 通信静默（超时无帧触发，数据恢复自动重武装）。</li>
                    <li>检查器里可为组设<code>触发冷却</code>（上次触发后 N ms 内新事件直接丢弃）与<code>满队列策略</code>（丢新 / 挤掉最旧 / 中止最旧）。</li>
                  </ol>
                </Section>
                <Section title="块：执行与逻辑">
                  <table className="help-table">
                    <tbody>
                      <tr><td>发送</td><td>HEX / ASCII / 命令库条目 / 指令工厂<b>多帧</b>（逐帧过令牌桶限速），内容支持 {"{var}"} 取编排变量</td></tr>
                      <tr><td>等待 / 等待帧</td><td>定时等待；等到匹配帧才继续（超时可填 <code>0</code>=一直等到匹配；失败可「继续」跳过或「中止」本组）</td></tr>
                      <tr><td>运行序列 / 运行组</td><td>调用测试序列器的套件，或把另一个编排组当子程序调用（均可选等待完成）；「运行组」不等待 = 触发</td></tr>
                      <tr><td>设置变量 / 通知 / 提示音</td><td>写变量（常量 / 通道值 / 表达式 / 事件字段）；弹提示（支持 $&#123;表达式&#125; 插值）；warn 单音 / crit 三连音</td></tr>
                      <tr><td>如果</td><td>多条件 AND 分支（通道比较 / 变量比较 / 表达式 / 事件字段 / 会话状态），成立走「那么」否则走「否则」</td></tr>
                      <tr><td>循环</td><td>按次数或按条件反复执行子流（≤1000 轮，可设轮间隔）；「跳出」结束最近一层循环，「中止」立即结束本组</td></tr>
                      <tr><td>子组</td><td>纯分组收纳容器（无触发语义），嵌套深度 ≤4</td></tr>
                      <tr><td>自动化工具箱</td><td>设控件（写控制画布变量）· 切开关（直接翻转开关卡档位）· 写 Modbus（FC05/06 编成 RTU 帧走发送路由）· 日志 · 截取曲线图存图片库 · 导出 CSV · 停止序列 · 发自定义事件（配「自定义事件」事件块跨组解耦）· 写剪贴板 · 复位变量（可静默不触发变量变更链）</td></tr>
                    </tbody>
                  </table>
                  <p className="help-tip">条件与赋值里的表达式在沙箱中求值（纯计算、无系统访问），支持四则/比较/逻辑与白名单函数 abs · floor · ceil · round · min · max · clamp · if · len · fmt，外加 <code>now</code>（当前毫秒，测时间间隔用，如 PID 整定数摆动周期）；「evt.字段」可读触发事件的载荷（如帧号、越限值）。每个块行首拖柄按住拖动排序（可拖入容器内、可跨组拖动），勾选框临时停用，块尾「中止/继续」标签点击切换失败策略；复制按钮克隆含子树。</p>
                </Section>
                <Section title="变量库与插值">
                  <ol className="help-ol">
                    <li>类型化全局变量（number / string / bool），勾「持久」跨重启保留当前值；上限 64 个。右侧检查器无选中块时即变量库视图。</li>
                    <li>引用方式：表达式（如果 / 循环条件 / 设置变量）直接写变量名；发送内容用 {"{var}"}；通知文本用 $&#123;表达式&#125;。</li>
                    <li>「变量变更」事件：变量值<b>实际变化</b>时触发组——可做链式编排（A 组算完写变量 → B 组接手）。检查器里可实时看到当前运行值。</li>
                  </ol>
                </Section>
                <Section title="PID 继电反馈自整定（内置模板）">
                  <p>「从模板新建」里有两套现成的<strong>继电反馈法（Åström-Hägglund 临界比例度法）</strong>整定模板——串口工具圈少有的自动调参能力，全部用现成块搭成：</p>
                  <ol className="help-ol">
                    <li><b>PID 继电反馈整定</b>（2 个组）：被控量高于 SP+hys → 发「关执行器」并记穿越时刻；低于 SP−hys → 发「开执行器」。上穿越间隔即摆动周期 Tu；攒满 6 个周期后自动算 <code>Ku=4d/(πa)</code>、按 Ziegler-Nichols 经典式给 <code>Kp=0.6Ku、Ti=Tu/2、Td=Tu/8</code>，并自动发送 PID 参数帧（<code>{"{Kp}"}</code> 插值）。</li>
                    <li><b>整定·阶跃验证</b>：整定完成后自动施加一次全量阶跃，配合 2D 曲线观察超调与稳定时间。</li>
                    <li>导入后按组备注检查 4 处：两个阈值事件的通道与值（SP±hys）、开关命令换成自己设备的指令、变量 <code>d</code>（继电输出步进）与 <code>amp</code>（摆幅，按曲线峰谷修正）。</li>
                    <li>运行时打开「变量库」可实时看到 Tu/Ku/Kp 的求解过程；跑完对 AI 说「<b>解读整定结果</b>」，AI 会读编排器快照给出参数解读与下一步建议。</li>
                    <li>无硬件练习：虚拟设备工坊载入「温控炉」（一阶加热对象，HEAT ON/OFF 命令）→ 导入 PID 模板 → 启用 + 总开关，看曲线进入等幅摆动、参数自动算出发送。</li>
                  </ol>
                </Section>
                <Section title="安全红线与互操作">
                  <ol className="help-ol">
                    <li>顶部<code>编排总开关</code>关闭后所有自动事件与手动运行都停止；顶部实时显示空闲 / 运行中实例数。</li>
                    <li>多重熔断：循环 ≤1000 轮、嵌套 ≤4 层、单实例超时自动中止、发送令牌桶限速、触发风暴全局熔断（帧流等高频事件本身不计入，只有实际触发组才计数）。</li>
                    <li>空画布上有「从模板新建」下拉：内置<b>报警通知 / 看门狗 / 定时轮询 / 收发握手 / PID 继电反馈整定</b>五套组模板，导入后<b>默认未启用</b>（参数是示意值，检查后再手动打开）；也可以点「让 AI 帮我搭」一句话生成整条编排。</li>
                    <li><code>从序列导入</code>：把测试序列器的套件转成一个编排组（onFrame 触发转成帧事件块、断言转成如果块），<b>导入后默认停用</b>——检查无误后手动勾选启用。</li>
                    <li>编排文档可<code>导入 / 导出 JSON</code> 备份或分享；条件与表达式在沙箱中求值（纯计算，无系统访问）。</li>
                  </ol>
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
                  <p>
                    <b>LED 灯 / 蜂鸣器</b>是变量驱动的显示控件：在控件属性里绑定一个解析变量与条件（如 变量「报警」 &gt; 0），脚本里 <code>set("报警", 1)</code> 后即点亮/鸣响，<code>set("报警", 0)</code> 恢复。用变量而非 setControl 驱动它们，可以保证状态来源唯一、不与解析数据打架。
                  </p>
                  <pre>{`// 例：解析帧到达 → 报警变量置位 → LED/蜂鸣器自动响应
set("报警", get("温度") > 60 ? 1 : 0);`}</pre>
                  <p className="help-tip">
                    键盘遥控/单键监控也可以被联动：<code>setControl("方向键盘", 0)</code> 等价于按下「上」。四个方向共享一个脚本，用 <code>dir</code>（0上/1下/2左/3右）与 <code>phase</code>（press/release）区分：
                  </p>
                  <pre>{`// 键盘遥控脚本示例：不同方向发不同指令
if (dir === 0) send("FWD:" + phase);
else if (dir === 1) send("BAK:" + phase);
else if (dir === 2) send("LFT:" + phase);
else send("RGT:" + phase);`}</pre>
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
                  <tr><td>Ctrl+K</td><td>AI 助手浮窗开关；AI 输入框内 <code>Enter</code> 发送、<code>Shift/Ctrl+Enter</code> 换行、<code>Ctrl+V</code> 粘贴截图</td></tr>
                  <tr><td>Agent 任务</td><td>输入框下方 pill 切换工作方式与授权档；任务运行中可「停止」，暂停后可「继续任务」就地续跑（已生效的步骤不重做）</td></tr>
                  <tr><td>Agent 审批卡</td><td>破坏性/覆盖/实车/命令行操作会就地弹批准卡：<b>批准只对同样参数这一次有效</b>，改了参数要重新批准</td></tr>
                  <tr><td>Ctrl+Z / Ctrl+Y</td><td>协议编辑撤销 / 重做（全局 50 步）；3D 轨迹面板内同样撤销/重做组配置（清空数据不可撤销）</td></tr>
                  <tr><td>M</td><td>录制/回放中给时间轴打标注（2D 曲线显示琥珀虚线，点击标注列表可 seek）</td></tr>
                  <tr><td>← / →</td><td>帧画布上一帧 / 下一帧</td></tr>
                  <tr><td>W/A/S/D · Q/E · 方向键</td><td>3D 轨迹面板键盘飞行（右键菜单「视图」开启，鼠标悬停画布才响应）；F 跟随、R 复位</td></tr>
                  <tr><td>双击</td><td>帧画布帧头/帧尾直接打开编辑框；2D 曲线图区=保形回实时；3D 时间条=回到最新</td></tr>
                  <tr><td>Esc</td><td>取消框选 / 关闭菜单 / 退出教学引导</td></tr>
                  <tr><td>左键拖拽</td><td>Hex/帧画布框选定义字段</td></tr>
                  <tr><td>右键</td><td>帧画布：字段/帧头/帧尾/簇 菜单；曲线区：更多设置；3D：视图/测量/模式/数据/设置</td></tr>
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
                      <tr><td>boundary.headerMask</td><td>帧头逐字节位掩码（与 headerBytes 等长）：按 <code>(字节 &amp; mask) == (值 &amp; mask)</code> 匹配，0xFF 精确 / 0x00 通配。省略即全精确。用于「任意从站地址」「任意异常功能码（bit7=1）」这类通配帧头</td></tr>
                      <tr><td>boundary.fixedLength</td><td>定长模式的帧总长（字节）</td></tr>
                      <tr><td>boundary.lengthOffset / lengthSize / lengthEndian / lengthAdjust</td><td>长度域模式的：域偏移 / 位宽 / 字节序 / 修正值（总帧长 = 原始值 × 倍率 + 修正）</td></tr>
                      <tr><td>boundary.lengthScale</td><td>长度域倍率（缺省 1）：长度域计的是「位数」等非常规单位时换算，如 Modbus FC01/02 读线圈响应 = ⌈位数/8⌉ 字节 → 0.125</td></tr>
                      <tr><td>boundary.footerBytes</td><td>帧尾模式：帧尾字节序列</td></tr>
                      <tr><td>boundary.maxLength</td><td>安全上限，超长候选帧直接丢弃重新同步</td></tr>
                      <tr><td>boundary.discs</td><td>帧识别字段列表：{"{ offset, value: number[], mask?: number[] }"}，用于同簇多帧型筛选；mask 同上可只比较某些 bit</td></tr>
                      <tr><td>checksum.algo</td><td>none / sum8 / sumadd / xor8 / crc16_modbus / crc16_ccitt / crc32</td></tr>
                      <tr><td>checksum.coverageStart / coverageEnd</td><td>校验覆盖区间；正数=帧头偏移，负数=距帧尾（-1 = 不含最后 1 字节）</td></tr>
                      <tr><td>checksum.endian</td><td>校验值存储字节序：little / big</td></tr>
                      <tr><td>fields[].role</td><td>header / addr / id / seq / length / data / payload / checksum / checksum2 / footer</td></tr>
                      <tr><td>fields[].type</td><td>uint8 / int8 / uint16 / int16 / uint32 / int32 / float32 / float64 / ascii / bcd / bits / csv</td></tr>
                      <tr><td>fields[].offset / endian</td><td>帧内字节偏移（负数=距帧尾）/ 解析字节序：little(DCBA) / big(ABCD) / big-word-swap(CDAB) / little-word-swap(BADC)，后两档用于 32 位量占两个 16 位寄存器的协议</td></tr>
                      <tr><td>fields[].scale / offsetValue / unit</td><td>物理值 = 原始值 × scale + offsetValue；unit 为显示单位</td></tr>
                      <tr><td>fields[].labels</td><td>值标签（枚举注解）：{"[{ v: 2, t: \"非法数据地址\" }]"}。命中时表格 / 悬停 / 导出显示「数字 文字」，数值通道与曲线仍用原始数字（属性面板「值标签」框可填 <code>2=非法数据地址</code>，多条用分号或换行分隔）</td></tr>
                      <tr><td>fields[].disc</td><td>帧识别值（本字段偏移处应有的固定字节串）</td></tr>
                      <tr><td>fields[].bits / csvDelim / csvType</td><td>位域：{"{ index, count }"}；文本帧：分隔符 / 元素类型</td></tr>
                      <tr><td>fields[].spanTail / spanElem</td><td>变长数组区：延伸至载荷尾（自动扣除校验域）+ 元素类型（uint8…float64），输出 <code>名称1..N</code> 数值变量；<code>spanElem: "bit"</code> 表示按位展开（一位一通道、每字节低位在前，如 Modbus 线圈区）</td></tr>
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
            {tab === "operator" && (
              <>
                <Section title="什么是 Operator 部署包（.uopk）">
                  <p><b>.uopk</b> 是 Uartix+ 的工作区发行物：把工程师在开发机上调好的<b>协议模板、控制页、命令库、面板布局与外观设置</b>打包成一个文件，交给现场操作员。操作员端导入后以<b>只读模式</b>运行——可以连接设备、发命令、看数据，但改不了任何配置，保证现场与调试环境一致、不误触。</p>
                </Section>
                <Section title="生成部署包（工程机）">
                  <ol className="help-ol">
                    <li>先把工作区调好：协议能解析、控制页与命令库可用、面板布局满意。</li>
                    <li>打开<code>设置 → 数据</code>，找到 <code>Operator 部署包（.uopk）</code> 块。</li>
                    <li>填<b>包名</b>与<b>说明</b>（会显示在操作员端横幅），勾选要进包的部件：协议模板 / 控制页 / 命令库 / 面板布局 / 外观设置 / 3D 面板设置——<b>至少勾一项</b>才能生成（空包等于把对方永久锁进只读）。</li>
                    <li>点<code>生成部署包</code>，保存为 <code>.uopk</code> 文件。</li>
                  </ol>
                  <p className="help-tip">随包的设置只含外观与交互子集（主题、语言、小数位、工作区预设、曲线配色、自动重连等）；AI 密钥、MCP 端口、窗口缩放等本机私有项不会进包。</p>
                </Section>
                <Section title="导入与运行（操作员机）">
                  <ol className="help-ol">
                    <li><b>方式一</b>：<code>设置 → 数据 → 导入并运行</code>，选择 .uopk 文件。</li>
                    <li><b>方式二</b>：直接<b>双击</b> .uopk 文件（安装版已注册文件关联）。应用未启动时会自动拉起；已启动时在当前窗口打开并聚焦，同一包不会重复导入。</li>
                    <li>导入后进入<b>只读模式</b>：标题栏横幅显示包名与退出按钮；协议、控制页、命令库替换为包内容；布局整屏应用。</li>
                    <li>重启应用会自动恢复该部署包（保持只读），直到点横幅上的<code>退出</code>。</li>
                  </ol>
                </Section>
                <Section title="只读模式：能做什么 / 不能做什么">
                  <table className="help-table">
                    <tbody>
                      <tr><td>能做</td><td>连接串口 / 网络 / BLE 设备；用控制页与命令库发指令；看帧画布、数据表格、2D 曲线、频谱等全部观测面板；哨兵监测照常运行；编排器<b>可运行</b>（运行按钮手动跑、组照常触发，向设备发数据）、3D 校准<b>操作</b>（采样/拟合/六面）放行</td></tr>
                      <tr><td>不能做</td><td>编辑/新建协议模板与字段；增删改控制页卡片、命令库与编排<b>结构</b>（组/事件/块/变量）；修改 3D 轴绑定与设置；修改设置；导入其它配置文件（改动都会被拦截并提示「Operator 模式：配置只读」——守卫在 store 层，AI/MCP/扩展面板等一切调用方同等受约束）</td></tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="退出只读模式">
                  <p>点标题栏横幅上的<code>退出</code>：解锁并清除持久化的部署包。<b>已导入的协议、控制页、命令库会保留在界面中</b>，此时可像普通工程模式一样继续编辑——适合把现场配置拿回来二改。</p>
                </Section>
              </>
            )}
            {tab === "market" && (
              <>
                <Section title="市场从哪来、什么时候联网">
                  <p>
                    货架上的清单来自一份<b>索引</b>：<code>{MARKET_BUNDLED_INDEX_URL}</code>（应用自带那份示例货架，同源、不出网），
                    或你在 <b>设置 → 插件管理</b> 里填的另一个地址。<b>只有你打开「插件市场」那一页时才会去取</b>——
                    启动路径、AI 的只读视图、命令行查状态都不替你联网（查不到就照实说没取过）。
                  </p>
                  <p>
                    取回来的清单<b>不缓存当现状</b>：这一页拉不到就显示失败页 + 真因 + 重试，
                    不拿上一份清单继续显示。对一份每天在长的货架来说，<b>过期答案不是降级，是错误</b>。
                  </p>
                  <p>
                    页面顶上那行状态的读法：<b>几条 · 几条被货架剔除 · 生成于哪天 · 耗时 · 走没走镜像</b>。
                    「被剔除」是索引里有、但没过契约的条目（一条坏投稿不该让整架空掉，但也不能静默少几支）。
                    同一个数在 AI 的 <code>app_read</code> 视图与市场页顶上这行里是同一份出处，不会两处各说一套。
                  </p>
                  <p className="help-tip">
                    市场页顶上那颗齿轮里是两行设置（索引地址 / 镜像前缀），旁边会当场告诉你<b>这一条会不会被用上、不会的话为什么</b>；
                    拉不到索引时它自己会摊开。远程地址的域必须在这个放行清单里：{MARKET_ALLOW_HOSTS.join(" / ")}——清单是从代码里读的，不是抄在这句话里的。
                  </p>
                  <p>
                    货架上一条包可以写 <code>npm</code> 那一节，意思是<b>字节放在 npm 官方 registry 上</b>（详情页的「出处」那行会照实标出来）。
                    这种情况我们取回的是那枚 tarball，<b>只从里面读出插件清单</b>：不装依赖、不跑包内任何脚本，取出来照样过同一个生产校验器，
                    哈希与字节数也仍是<b>按索引声明逐条比对</b>——索引仍是唯一的门，换来源没有让门变松。<b>镜像前缀对这类条目不生效</b>：换域等于换信任来源。
                  </p>
                </Section>
                <Section title="装进来归谁管：一颗按钮、一处落地、三个启停入口">
                  <ol className="help-ol">
                    <li>卡片与详情各一颗<b>「安装」</b>（或「更新到 v×」）。{MARKET_INSTALL_NOTE}</li>
                    <li><b>新装直接落地为停用态</b>，不再弹第二张卡；只有<b>覆盖本机已有版本</b>那种会停在右下角那张确认卡上等你点「装入」。命令行发起的装包停在<b>同一张卡</b>上，标题栏那颗拼图会亮「等你确认」——两个入口做的是同一件事，结论也只有一个来源。</li>
                    <li>启用与停用有三个地方：市场页的<b>「外观」页签</b>（主题那一类）、<b>插件库</b>（所有种类）、<b>设置 → 通用</b>的主题卡。三处调的是同一个 <code>setEnabled</code>，同一动作同一句话，不存在"在这儿启用与在那儿启用不同"。</li>
                    <li><b>主题互斥</b>：内置与插件主题同级，同时只有一枚在画；启用一枚主题会照实告诉你挤掉了谁。插件库里停用一枚包，它带的所有产物一起退出。</li>
                    <li>卸载只在<b>插件库</b>做（市场不提供删除本机内容的按钮），每条都要你确认。</li>
                  </ol>
                </Section>
                <Section title="AI 能提名，但落地永远是你点">
                  <p>
                    AI 先读 <code>app_read</code> 的 <code>market.entries</code>（<b>不联网</b>，读的是你打开那一页时取回的那份），
                    再用 <code>propose_market_install</code> 提名一支。这支工具做的事只有两件：把那枚包<b>下载下来按货架声明逐条比对</b>，
                    然后把"会装成什么"讲给你听——<b>它不装、不暂存、不启用，也不进插件库</b>。
                  </p>
                  <p>
                    它<b>每次都要求你在批准卡上点一次</b>（三档都一样），因为批准的内容是"允许我去下载一枚外部字节"这件事本身。
                    批准之后回执末尾会写明下一步去哪点：「插件市场」那一页那一支上的<b>「装入」</b>，或者终端里的 <code>uartix plugin install</code>。
                    「已提名」与「已装好」是两句不同的话——看到后者的字面就是它说错了。
                  </p>
                </Section>
                <Section title="它替你做了什么、没做什么">
                  <table className="help-table">
                    <tbody>
                      <tr>
                        <td>做了</td>
                        <td>
                          按索引声明<b>逐条比对</b>再入库：sha256、字节数、包里的 id、以及<b>版本</b>（货架写 1.2.0、包内是 1.1.0 就报 <code>version_mismatch</code> 拒绝，不给你装一个"名字对得上内容不对"的东西）；
                          再一遍<b>生产校验器</b>（与 AI 保存插件、导入文件包用的是同一个）；装进来是停用态。
                        </td>
                      </tr>
                      <tr>
                        <td>没做</td>
                        <td>
                          <b>不替你启用</b>，不替你启用那些要点名的能力（{autoEnableBlockedCaps().map((c) => CAP_LABEL[c].name).join("、")}）——这些永远要你自己点一次；
                          不替你决定"覆盖本机已有版本"（停在确认卡上）；也不替你判断这堆东西<b>好不好</b>——
                          {MARKET_NO_ENDORSE}
                        </td>
                      </tr>
                      <tr>
                        <td>镜像换不掉内容</td>
                        <td>镜像前缀只改「从哪台机器下载」。取回的字节仍然按索引里声明的哈希与字节数比对，过不了就是不过——所以换镜像不是开一条供应链后门。</td>
                      </tr>
                    </tbody>
                  </table>
                </Section>
                <Section title="怎么把你做的东西上架">
                  <p>
                    交<b>两样东西</b>：<code>market/pkg/&lt;名字&gt;.uartix.json</code>（或目录源 <code>market/pkg/&lt;名字&gt;/manifest.json</code> ＋旁挂真实文件）
                    和一份元数据 <code>market/entries/&lt;名字&gt;.json</code>。<b>不要写哈希与字节数</b>——那是生成器算的，作者写不了也不该写。
                  </p>
                  <p>
                    投稿前<b>离线一条命令</b>自检（不连应用、不联网、不读设置）：
                  </p>
                  <pre>{`npm run build:plugin-cli
node dist-cli/uartix-plugin.cjs validate market/pkg/<名字>.uartix.json
# 仓库里也可以：npm run market:validate -- market/pkg/<名字>`}</pre>
                  <p>
                    这条命令<b>跑的就是上架会跑的那几道</b>：包体过 <code>validateManifest</code>（生产校验器）、元数据与包体对账（id / 版本 / 能力）、
                    产物过索引契约 <code>parseEntry</code>。回执会列出<b>它跑了哪几道、用的哪一版校验器</b>，
                    跳过的也会照实说（比如你只给了一个孤零零的包、没给那份 entries）。
                    为什么强调"同一个"：如果投稿人本地跑的是另一套宽松点的检查，就会出现<b>本地绿、上架红</b>——那种失败最难查，因为报错的人看不到判据。
                  </p>
                  <p className="help-tip">
                    主题那一类要特别留意变量<b>键名</b>：写错一个键不会崩，只会"那一项没落地"。校验器拒未知键时会给出<b>相近的真名</b>（比如 <code>--panel</code> 你会写成 <code>--bg-panel</code>）。
                  </p>
                </Section>
              </>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span />
          <button className="btn primary" onClick={onClose}>{tx("开始使用", "Get Started")}</button>
        </div>
      </div>
    </div>
  );
}
