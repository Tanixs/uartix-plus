<div align="center">

# Uartix+

**可视化串口协议分析仪 —— 拖拽定义协议，双向闭环调试**

**A visual serial protocol analyzer: define protocols by drag-and-drop, debug in closed loop.**

[![Release](https://img.shields.io/github/v/release/Tanixs/uartix-plus?label=%E4%B8%8B%E8%BD%BD&logo=github)](https://github.com/Tanixs/uartix-plus/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)](https://github.com/Tanixs/uartix-plus/releases)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri)](https://v2.tauri.app/)

[下载安装包](https://github.com/Tanixs/uartix-plus/releases/latest) · [官网](https://larix.teuioe.cn/uartix-plus) · [问题反馈](https://github.com/Tanixs/uartix-plus/issues)

</div>

---

面向嵌入式工程师（惯导 / 机器人 / 航模 / 自动控制）：在 Hex 数据流上**鼠标拖拽框选**即可定义私有协议帧结构，无需写一行解析代码。数据实时映射为物理量、二维曲线、3D 姿态；再通过可视化控件与指令工厂向下位机发送格式化指令，实现真正的双向闭环调试。

## 特性

**协议解析**

- 拖拽框选字节 → 右键定义为帧头 / 长度位 / 识别位 / 载荷 / 校验，所见即所得，字段尺寸随类型自动扩展
- 两级帧识别：除帧头外，任意字段可开启"帧识别位"（功能码级匹配，支持多字节十六进制值），全部匹配才认定为一帧
- 多协议模板对同一数据流并行匹配，互不干扰
- 校验引擎：Sum8 / XOR8 / CRC16-Modbus / CRC16-CCITT / CRC32，支持负偏移覆盖区间
- 字段类型：u8/i8/u16/i16/u32/i32/f32/f64 / ASCII / BCD / 位域，大小端可切，缩放偏置即时生效
- 内置 WitMotion JY901、匿名 V7、Modbus、CSV 文本流等预设，模板 JSON 导入导出

**可视化**

- 2D 曲线：图例点击即绘图，直线 / 阶梯 / 样条三种线型，实时采样率显示；双游标测量（时间尺 + 幅度尺，面板可拖拽、位置记忆）、指针十字贴近曲线交点显示原始读数、相对秒时间轴（0s / 60s / 1.2h）、最新线锚定、Y 轴自动贴合 + 一次性 Auto 键；峰谷保形抽稀，平坦通道不崎岖，长跑不卡
- 视频传输（图传）：把数据帧实时渲染为画面，支持网络图传源（TCP/UDP）、暂停 / 回看 / 保存帧 / 镜像 / 翻转、帧定界解析设置
- 3D 姿态：欧拉角（六种旋转顺序 + 三轴取反）/ 四元数双模式，四轴飞行器与立方体模型；变量支持跨模板选择
- 帧画布：字节悬停看属性，右键插入 / 删除帧格；Hex 数据流搜索高亮、字节属性面板
- 数据表格：虚拟列表、排序筛选、CSV / Excel 导出
- 控制台：Hex / ASCII / 时间戳多视图，收发分色；演示源无设备也可体验全部功能
- 六套主题（深蓝 / 浅蓝 / 护眼绿 / 琥珀 / 海棠 / 琉璃）色卡选择，深浅完整覆盖

**下行控制**

- 控制画布：滑条 / 按钮 / 开关 / LED / 蜂鸣器 / 数值监视 / 摇杆，拖拽带落点幽灵框（碰撞检测 + 就近吸附，永不重叠）；卡片复制粘贴，键盘遥控卡片锁定 n×n，脚本模式自动填充示例
- 指令工厂：可视化组帧，内置 WIT 写寄存器（自动解锁→写入→保存）、匿名 V7 功能触发 / 参数读写、Modbus RTU、校验工具；「我的协议」支持自定义帧模板（固定字节 + 变量字段 + 长度段 + 校验段），实时分段预览
- 快捷指令栏：命令芯片点击即发，悬浮预览实际发送内容
- 类 C 脚本与变量系统：解析字段自动注册变量，指令模板 `%x` 占位，脚本 `send` / `beep` / `delay_ms`

**连接与工程化**

- 数据接口：串口 / TCP 客户端 / TCP 服务端 / UDP，同一解析管线，网络数据源全功能可用
- 内置自动更新；四套预设布局工作区；协议 / 画布 / 命令库 JSON 互传
- 归档池水位线回收，38 万帧长跑不卡；深浅主题、中英双语、自动重连、热插拔监听

## 下载

**下载地址永久固定**——以下链接永远指向最新版，发新版无需修改（可放心配到官网/导航）：

| 平台 | 固定地址|
|---|---|
| Windows x64 安装包 | [Uartix-Plus-windows-x64-Setup.exe](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-windows-x64-Setup.exe) |
| Linux AppImage | [Uartix-Plus-linux-x64.AppImage](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.AppImage) |
| Linux deb | [Uartix-Plus-linux-x64.deb](https://github.com/Tanixs/uartix-plus/releases/latest/download/Uartix-Plus-linux-x64.deb) |

也可以前往 [Releases 页面](https://github.com/Tanixs/uartix-plus/releases/latest) 下载历史版本与完整变更说明。

**官网（教程 / 文档 / 动态）**：[larix.teuioe.cn/uartix-plus](https://larix.teuioe.cn/uartix-plus)

- Windows 首次运行如被 SmartScreen 拦截，点击「更多信息 → 仍要运行」
- Linux AppImage 需要 `libfuse2`（`sudo apt install libfuse2`）；deb 用 `sudo dpkg -i` 安装
- 已安装用户：应用内「设置 → 检查更新」可自动升级

## 快速上手

1. 选择串口与波特率连接设备（或顶部「数据接口」切换 TCP/UDP；没有设备就启动演示源）
2. 在 Hex 数据流拖拽框选一帧的固定帧头字节 → 右键「设为帧头」
3. 依次框选定义长度位、载荷、校验——右侧属性面板即时调整字节序 / 类型 / 缩放；功能码字段可开启「帧识别位」
4. 字段解析成功后自动注册变量：图例点眼睛画曲线，3D 面板绑欧拉角
5. 打开控制画布拖入控件双向调试；控制台 → 指令工厂组帧下发寄存器命令

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

验证：`cargo test`（Rust 侧 20 个用例）、`npx tsc --noEmit`。

## 项目结构

```
src/
  features/
    protocol/       协议模板引擎、拖拽框选、属性面板
    framecanvas/    Hex 帧画布（Canvas 渲染 + 虚拟化 + 归档池）
    controls/       控制画布、控件、命令库、脚本
    console/        控制台、快捷指令栏、指令工厂
    settings/       设置中心、i18n
    serial/         串口/网络会话状态
    table/ plot/ view3d/ hexview/
  shell/            自绘标题栏、App 外壳
  shared/           图标、通用组件
src-tauri/          Rust：串口、TCP/UDP、并行协议解析、校验、文件 IO、updater
```

## 贡献

Issue / PR 均欢迎，提交前请通过 `cargo test` 与 `npx tsc --noEmit`。

## 许可

[MIT](LICENSE)
