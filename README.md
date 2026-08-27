# Uartix+

[![Release](https://img.shields.io/github/v/release/Tanixs/uartix-plus?label=%E4%B8%8B%E8%BD%BD&logo=github)](https://github.com/Tanixs/uartix-plus/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](https://github.com/Tanixs/uartix-plus/releases)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB?logo=tauri)](https://v2.tauri.app/)

**A high-flexibility visual serial protocol analyzer for embedded engineers.**
**面向嵌入式工程师（惯导 / 机器人 / 航模 / 自动控制）的高自由度可视化串口协议分析仪。**

在 Hex 数据流上**鼠标拖拽框选**即可定义私有协议帧结构——无需写一行解析代码。数据实时映射为物理量、二维曲线、3D 姿态；再通过可视化控件（滑条 / 按钮 / 开关 / 摇杆 / 类 C 脚本）向下位机发送格式化指令，实现真正的**双向闭环调试**。

## ✨ 特性一览

### 协议解析
- **协议零代码定义**：拖拽框选字节 → 右键定义为帧头 / 长度位 / 识别位 / 载荷 / 校验，所见即所得
- **多协议并行路由**：多个协议模板按帧头（含通配识别位）同时对同一数据流并行匹配，互不干扰
- **校验引擎**：Sum8 / XOR8 / CRC16-Modbus / CRC16-CCITT / CRC32，支持负偏移覆盖区间
- **字段类型**：u8/i8/u16/i16/u32/i32/f32/f64 / ASCII / BCD / 位域，大小端可切，缩放偏置即时生效
- **协议簇与模板**：模板分组管理、协议簇一键新建、JSON 导入导出，内置 WitMotion JY901 等常见协议预设
- **CSV 文本流**：逗号分隔 ASCII 数据自动识别通道数

### 可视化
- **2D 曲线**：图例点击即绘图，每通道独立缓冲（万点不卡），框选缩放 / 平移 / 双击复位，X 轴可挂时间、序号或任意变量
- **3D 姿态**：欧拉角（六种旋转顺序 + 三轴取反）/ 四元数双模式，四轴飞行器与立方体模型，slerp 平滑
- **数据表格**：虚拟列表、排序筛选、暂停刷新、CSV / Excel 导出
- **控制台**：Hex / ASCII / 时间戳多视图，直接收发

### 下行控制
- **控制画布**：滑条 / 按钮 / 开关 / 多档开关 / LED / 数值监视 / 摇杆，正方形网格吸附自由布局，多页签、画布锁、N×M 行列数与格尺寸可调
- **命令库**：树形分组管理常用指令，点击即发，拖拽部署到控件
- **类 C 脚本**：控件与命令均可挂脚本（`send` / `beep` / `delay_ms` / 变量读写）
- **变量系统**：解析字段自动注册为变量，指令模板 `%x` 占位与脚本中直接引用实时数据

### 工程化
- **布局工作区**：协议调试 / 数据分析 / 姿态监视 / 控制台四套预设布局，一键切换
- **导入导出**：协议模板 / 控制画布 / 命令库 三件套 JSON 互传
- **性能面板**：帧率 / 长任务 / 渲染计数内置诊断
- **深浅主题**、中文界面、自动重连、热插拔监听

## 📥 下载

前往 [Releases](https://github.com/Tanixs/uartix-plus/releases/latest) 下载 Windows x64 安装包（`*-setup.exe`）。

> 首次运行如被 SmartScreen 拦截，点击「更多信息 → 仍要运行」。

## 🚀 快速上手

1. 选择串口与波特率，连接设备（或用顶部「数据接口」切换 TCP/UDP）
2. 在 **帧解析** 页签让数据流动，拖拽框选一帧的固定帧头字节 → 右键「设为帧头」
3. 依次框选定义长度位、载荷、校验——右侧属性面板即时调整字节序 / 类型 / 缩放
4. 字段解析成功后自动注册变量：图例点眼睛画曲线，3D 面板绑欧拉角
5. 打开 **控制画布**，拖入滑条绑定变量，双向调试

内置模板：`文件 → 设置 → 导入/导出` 可导入导出协议；预设模板含 WitMotion JY901（10 帧型）与 CSV 演示。

## 🛠️ 从源码构建

```bash
# 依赖：Node.js 18+ · Rust 1.77+ · WebView2
npm install
npm run tauri dev      # 开发
npm run tauri build    # 产出 NSIS 安装包 (src-tauri/target/release/bundle/nsis/)
```

## 📐 架构

```
src/
  features/
    protocol/    # 协议模板引擎、拖拽框选、属性面板
    framecanvas/ # Hex 帧画布（Canvas 渲染 + 虚拟化）
    controls/    # 控制画布、控件、命令库、脚本
    settings/    # 设置中心、i18n
    serial/      # 串口会话状态
    table/ plot/ view3d/ console/ hexview/
  shell/         # 自绘标题栏、App 外壳
  shared/        # 图标、通用组件
src-tauri/       # Rust：串口、并行协议解析、校验、文件 IO
```

## 🤝 贡献

Issue / PR 均欢迎。提交前请跑 `npx tsc --noEmit` 与 `cargo test`。

## 📄 许可

[MIT](LICENSE)
