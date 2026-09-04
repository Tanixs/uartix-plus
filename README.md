<div align="center">

# Uartix+

**嵌入式可视化上位机 —— 拖拽定义协议，双向闭环调试**

**A visual host-computer suite for embedded systems: define protocols by drag-and-drop, debug in a closed loop.**

[![Release](https://img.shields.io/github/v/release/Tanixs/uartix-plus?label=%E4%B8%8B%E8%BD%BD&logo=github)](https://github.com/Tanixs/uartix-plus/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)](https://github.com/Tanixs/uartix-plus/releases)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri)](https://v2.tauri.app/)

[下载安装包](https://github.com/Tanixs/uartix-plus/releases/latest) · [官网](https://larix.teuioe.cn/uartix-plus) · [问题反馈](https://github.com/Tanixs/uartix-plus/issues)

</div>

---

## 它是什么

Uartix+ 是一台跑在电脑上的**上位机**。向下，它连着单片机、惯导、云台、机器人这些下位机；向上，它把一串串看不懂的原始字节变成结构、数值、曲线和画面，再把你的操作回写成设备能够接受的指令。

它不是只会收发字符的串口助手。协议无需编写解析代码——在数据流上框选字节即可定义帧结构与字段含义；界面无需编写界面代码——拖拽控件就能拼出专属调试台。连接、校验、测量、可视化、脚本自动化与数据导出，在同一处完成闭环。

面向嵌入式与自动化方向的工程师：惯导 / 机器人 / 航模飞控 / 工业控制板的私有协议逆向与联调。

## 能力一览

### 协议解析引擎

在 Hex 数据流上用鼠标框选一段字节，右键即可把它定义为帧头 / 长度位 / 识别位 / 载荷 / 校验域，字段尺寸随所选类型自动伸缩，所见即所得。

真实的私有协议往往只靠帧头无法区分帧型，因此这里做了两级识别：任意字段都可以开启「帧识别位」，用功能码级别的多字节十六进制值精确匹配，全部条件成立才认定为一帧。多个协议模板可以对同一路数据流并行匹配，互不干扰，各走各的解析结果。

校验引擎内置 Sum8 / XOR8 / CRC16-Modbus / CRC16-CCITT / CRC32，覆盖区间支持负偏移，便于排除末尾的校验字节本身。字段类型涵盖 u8 / i8 / u16 / i16 / u32 / i32 / f32 / f64，另有 ASCII / BCD / 位域，大小端可随时切换，缩放与偏置改完立即生效。

逗号分隔的文本流同样被当作一种协议对待：帧头允许为空，按分隔符自适应切分出通道，通道数量随每帧实际段数动态变化。项目自带 WitMotion JY901、匿名 V7、Modbus、CSV 文本流等预设模板，也可将协议导出为 JSON 与同事互换。

### 数据可视化

解析出来的字段会自动注册为变量，点一下图例上的眼睛就能画成曲线。2D 曲线支持直线 / 阶梯 / 样条三种线型，配备时间尺与幅度尺两条独立游标做 A−B 差值测量，指针十字会贴近曲线交点显示原始读数。时间轴以相对秒呈现（0s / 60s / 1.2h），最新线始终锚定在曲线真实末点，Y 轴自动贴合视野，另有一次性的 Auto 键一步到位。长时间采集下由峰谷保形抽稀维持流畅，而游标、表格与导出使用的始终是全量数据。

3D 姿态面板支持欧拉角 / 四元数两种输入，可选六种旋转顺序与三轴取反，提供四轴飞行器与立方体两种模型，绑定变量时可以跨协议模板挑选字段。

图传面板把数据帧实时渲染成画面，支持网络图传源（TCP / UDP），可暂停 / 回看 / 保存单帧 / 镜像 / 翻转，帧定界规则单独设置。

此外还有帧画布（字节悬停查看属性，右键插入 / 删除帧格，协议簇可整体导出 JSON 分享包）、数据表格（虚拟列表、排序筛选、导出 CSV / Excel）与控制台（Hex / ASCII / 时间戳多视图，收发分色）。没有硬件时启动演示源，即可体验全部功能。

界面提供九套主题（海棠为默认，另有深蓝 / 浅蓝 / 护眼绿 / 琥珀 / 琉璃等），深浅色完整覆盖；中英双语深入各个面板，切换即时生效，而协议名、字段名这类用户数据保持原文不动。

### 下行控制

控制画布提供滑条 / 按钮 / 开关 / LED / 蜂鸣器 / 数值监视 / 摇杆等控件，拖拽时带落点幽灵框，碰撞检测加就近吸附，卡片之间永不重叠，支持复制粘贴。键盘遥控卡片锁定为 n×n 方阵，把物理按键映射成指令，脚本模式下可按方向分支发送不同内容，小车与云台的桌面调试里键盘就是遥控器。

指令工厂负责可视化组帧：内置 WIT 写寄存器（自动走完解锁 → 写入 → 保存三步）、匿名 V7 功能触发 / 参数读写、Modbus RTU、校验工具；「我的协议」允许你自建帧模板，把固定字节、变量字段、长度段与校验段拼在一起，并实时分段预览。快捷指令栏把常用命令做成芯片，点击即发，悬停可预览实际发送的字节。

类 C 脚本与变量系统把这一切串起来：解析字段自动成为变量，指令模板用 `%x` 占位，脚本里可以调用 `send` / `beep` / `delay_ms`。

### 连接与工程化

数据接口覆盖串口 / TCP 客户端 / TCP 服务端 / UDP，四者共用同一条解析管线，网络数据源享有完整功能。串口拔出后两秒内自动检测并断开，重插即可恢复，网络断联同样自动重连。

性能上，帧数据经二进制通道直推，绕开 base64 / JSON 开销；面板关闭即停止后台搬运，堆叠面板中的后台标签只缓冲不渲染；归档池按水位线回收，数十万帧的长跑采集不会越跑越卡。

工作区提供四套预设布局，也可以把当前布局另存为自定义槽位随时切换。协议 / 控制画布 / 命令库三者均可 JSON 互传，便于分享与备份。应用内置自动更新，下载地址永久固定。

### AI 助手

自 v0.3.6 起，AI 不再是聊天框里的问答，而是应用内的引擎。

**对话即创造**：它能生成协议模板 / 控制卡片 / 命令库 / 指令工厂协议 / 主题 / 全局样式 / 停靠面板 / 沙箱小部件 / 无边框挂件 / 直接执行动作 / 高权限脚本，共十种输出块，全部以确认卡片的形式一键安装。

**说出来即发生**：打开面板、切换布局、连接串口这类操作诉求，由 AI 直接执行而不只是给你文字步骤。动作走 27 个白名单，破坏性操作红标提示并保留人工确认。

**一切皆 API**：所有沙箱组件自动注入 `window.uartix`，键盘 / 光标监听、AI 思维链感知、向 AI 提问、自定义右键菜单、窗口控制、挂件互感广播、语音播报、主题订阅开箱可用。无边框形态支持透明窗口、按住即拖、松开吸附停靠与边界钳制，可以做悬浮仪表盘 / 通知条，也可以做一只桌面宠物——后者只是示例玩法，能力本身完全通用。

**过程可见且安全**：思维链多段流式展示，内容尚未生成完毕时不会出现安装按钮；沙箱组件实时跟随全局换肤，AI 生成的挂件与主界面配色始终一致。提示词采用轻底座加规范自取的架构，兼顾效果与 token 成本。

## 下载

以下链接永远指向最新版，发新版无需修改，可放心配到官网 / 导航页：

| 平台 | 固定地址 |
|---|---|
| Windows x64 安装包 | [Uartix-Plus-windows-x64-Setup.exe](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-windows-x64-Setup.exe) |
| Linux AppImage | [Uartix-Plus-linux-x64.AppImage](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.AppImage) |
| Linux deb | [Uartix-Plus-linux-x64.deb](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.deb) |

历史版本与完整变更说明见 [Releases 页面](https://github.com/Tanixs/uartix-plus/releases/latest)，教程 / 文档见 [官网](https://larix.teuioe.cn/uartix-plus)。

几点安装提示：Windows 首次运行若被 SmartScreen 拦截，点击「更多信息」再选「仍要运行」；Linux AppImage 需要系统装有 `libfuse2`（`sudo apt install libfuse2`），deb 包用 `sudo dpkg -i` 安装；已安装的用户直接在应用内「设置 → 检查更新」升级即可。

## 快速上手

1. 选择串口与波特率连接设备，或在顶部切换为 TCP / UDP 网络源；手边没有设备就启动演示源。
2. 在 Hex 数据流上拖拽框选一帧开头的固定字节，右键「设为帧头」。
3. 继续框选长度位、载荷与校验域，在右侧属性面板调整字节序 / 类型 / 缩放；功能码所在的字段可以开启「帧识别位」用来区分帧型。
4. 字段解析成功后会自动注册为变量，点图例上的眼睛即可画曲线，3D 面板绑定欧拉角就能看姿态。
5. 打开控制画布拖入控件做双向调试，或在控制台用指令工厂组帧下发寄存器命令。
6. 也可以直接把需求讲给 AI 助手，例如「帮我定义这个协议」或「做一个无边框悬浮温度计」，生成结果以卡片形式一键安装。

## 从源码构建

```bash
# 依赖：Node.js 18+ · Rust 1.77+ · WebView2 (Win) / WebKitGTK (Linux)
npm install
npm run tauri dev      # 开发
npm run tauri build    # 产出安装包 (src-tauri/target/release/bundle/)
```

Linux 构建依赖：

```bash
sudo dnf install libwebkit2gtk-4.1-devel build-essential libxdo-devel openssl-devel libayatana-appindicator3-devel librsvg2-devel
```

提交前请通过 `cargo test`（Rust 侧 20 个用例）与 `npx tsc --noEmit`。

## 项目结构

```
src/
  features/
    ai/             AI 助手：对话与流式渲染、十种块安装、uartix 注入桥、挂件宿主、扩展库、动作执行
    protocol/       协议模板引擎、拖拽框选定义、属性面板
    framecanvas/    Hex 帧画布（Canvas 渲染 + 虚拟化 + 归档池）
    controls/       控制画布、控件、命令库、脚本
    console/        控制台、快捷指令栏、指令工厂
    settings/       设置中心、布局槽位、导入导出
    serial/         串口 / 网络会话状态
    table/ plot/ view3d/ hexview/ video/ help/
  i18n/             中英双语（中心键 + 就近双语）
  panels/           dockview 面板注册表
  shell/            自绘标题栏、应用外壳
  shared/           图标、通用组件、字节解析工具
src-tauri/          Rust：串口、TCP / UDP、并行协议解析、校验、AI 流式转发、文件 IO、自动更新
```

## 贡献

Issue / PR 都欢迎。提交前请确保 `cargo test` 与 `npx tsc --noEmit` 均通过。

## 许可

[MIT](LICENSE)
