//! 插件体积与传输上限的**唯一来源**（Rust 侧）。
//!
//! TS 侧对应 `src/features/plugins/engine/limits.ts`。两边是同一组数字的两份投影：
//! 前端管"允许写进 IPC 的量"，这里管"真正落盘/出网/进进程的量"。
//! 改一处必须改另一处，否则前端那道过了、这里再拒，用户看到的是
//! `content_too_large` 这种指错方向的错误。
//!
//! 2026-11-03 用户口径：把插件的空间上限放开。单文件 16 MiB、单包 64 MiB，
//! 发布合计沿用既有 48 MiB（base64）。**旧构建里 256 KiB 的读取上限不会因为改源码而改变**：
//! 它只在新构建里生效，这一点交付说明里必须写清楚。

/// 单个文件上限（面板、main.mjs、包内任意文件）。
pub const PLUGIN_MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/// 一个插件包解压后的总字节上限（安装复制、解包累加的共同硬顶）。
pub const PLUGIN_MAX_PACKAGE_BYTES: usize = 64 * 1024 * 1024;

/// 一次发布 / 一次草稿批量写入的合计上限（base64 字符数，48 MiB ≈ 36 MiB 原文件）。
pub const PLUGIN_MAX_TRANSFER_B64_BYTES: usize = 48 * 1024 * 1024;

/// 发布单文件上限（base64 字符数）。16 MiB 原文件的 base64 约 21.3 MiB，
/// 再加一点 JSON/边界余量，取 22 MiB。**不能直接写 16 MiB**：那等于只允许 12 MiB 原文件，
/// 与"包内单文件 16 MiB"对不上。
pub const PLUGIN_MAX_PUBLISH_FILE_B64_BYTES: usize = 22 * 1024 * 1024;

/// 发布请求的响应上限。GitHub 的 `contents` GET 会把**整份文件**以 base64 回显，
/// 读一份 16 MiB 旧文件的 sha 需要 ~22.3 MiB 响应体。原来的 256 KiB 会让
/// "发布大文件"在取 sha 那一步就失败，现象与体积限制完全无关。
pub const PLUGIN_PUBLISH_RESPONSE_MAX_BYTES: usize = 24 * 1024 * 1024;

/// 发布请求超时（秒）。单文件 PUT 传 20 MiB base64，25 秒在慢网/代理下必然超时。
pub const PLUGIN_PUBLISH_TIMEOUT_SECS: u64 = 120;

/// 市场取回逐请求的绝对上限。与归档单文件上限同档。
pub const PLUGIN_MARKET_ABSOLUTE_MAX_BYTES: u64 = PLUGIN_MAX_FILE_BYTES as u64;

/// 市场取回超时（秒）。16 MiB 归档在慢网下 20 秒不够。
pub const PLUGIN_MARKET_TIMEOUT_SECS: u64 = 60;

/// 宿主 stdio 单行上限（`plugin_host_send` 的硬顶）。
pub const PLUGIN_HOST_LINE_MAX_BYTES: usize = PLUGIN_MAX_FILE_BYTES;
