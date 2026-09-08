//! 会话录制回放（.usess v1）——P1：帧录制 + 保存/打开 + 1×/全速回放全面板点亮。
//!
//! 架构（HANDOFF 十六 16.2 详设）：**回放引擎 = Rust 侧虚拟数据源，与 demo.rs
//! 完全同构**。回放线程按录制时的 emit_ts delta pacing 后逐批走 `send_frames`
//! 单点（busevt）——前端 9 处 onFrames 消费者零改动全面板点亮；录制 tap 同样
//! 在 `send_frames` 入口单点挂载，天然覆盖串口/网络/演示源等一切帧源。
//! rx/tx 段 v1 仅写占位计数 0，P2 启用（HexView/控制台倒带）。
//!
//! 文件格式（小端）：
//! ```text
//! magic "USESS" | u32 version = 1
//! meta 段  : u32 len + UTF-8 JSON { recordedAt, durationMs, frameCount,
//!            rxChunkCount, txChunkCount, port, tplRules }
//! frames 段: u32 batchCount + N × ( u32 len + encode_frames 二进制批次 )
//! rx 段    : u32 chunkCount + N × ( u64 tsMs + u32 len + bytes )   // v1 恒 0
//! tx 段    : 同 rx 段结构
//! ```
//!
//! 护栏：录制缓冲上限 2M 帧 / 512MB，触顶自动停止并通知前端（toast）；
//! 回放线程单写者无锁，abort 安全；读取端对一切截断/坏 magic 报友好错误。

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::busevt;
use crate::parser::FramesEvent;
use crate::serial::SerialManager;

const MAGIC: &[u8; 5] = b"USESS";
/// v2：新增 annotations 段（P3b 时间轴标注）；读端兼容 v1（无标注段）
const VERSION: u32 = 2;
/// 标注上限（防膨胀护栏）
const MAX_ANNOTATIONS: usize = 500;
/// 录制缓冲护栏：帧数上限
const MAX_FRAMES: u64 = 2_000_000;
/// 录制缓冲护栏：编码字节上限（512MB）
const MAX_BATCH_BYTES: u64 = 512 * 1024 * 1024;

/// 回放进行中的全局标记：串口/网络/演示源启动前必须检查（回放与真实连接互斥）
static PLAYING: AtomicBool = AtomicBool::new(false);

pub fn is_playing() -> bool {
    PLAYING.load(Ordering::SeqCst)
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub recorded_at: u64,
    pub duration_ms: u64,
    pub frame_count: u64,
    pub rx_chunk_count: u64,
    pub tx_chunk_count: u64,
    /// { kind, portName, baud } —— 仅展示，前端在录制开始时快照
    pub port: serde_json::Value,
    /// ParseRules 完整快照（前端 templateStore.rules 原样 JSON，P2 做导入防呆）
    pub tpl_rules: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecStats {
    pub frame_count: u64,
    pub duration_ms: u64,
    pub approx_bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// idle | recording | recorded | playing | paused
    pub state: String,
    pub frame_count: u64,
    pub duration_ms: u64,
    pub pos_ms: u64,
    pub frame_idx: u64,
    pub file_name: String,
    /// 桥接服务端（P3a 虚拟设备）
    pub bridge_listening: bool,
    pub bridge_port: u16,
    pub bridge_clients: usize,
    /// 时间线首/末事件 ts（前端标注跳转 ratio 换算用；无 loaded 时为 0）
    pub first_ts: u64,
    pub last_ts: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    pos_ms: u64,
    dur_ms: u64,
    frame_idx: u64,
}

/// 内存中的录制缓冲（recording 期间累加）
#[derive(Default)]
struct Rec {
    batches: Vec<Vec<u8>>,
    /// (ts, bytes) RX 原始块（send_rx tap，ingest 单点）
    rx: Vec<(u64, Vec<u8>)>,
    /// (ts, bytes) TX 块（send_tx tap；回放只回灌控制台，不外发）
    tx: Vec<(u64, Vec<u8>)>,
    frame_count: u64,
    approx_bytes: u64,
}

/// 回放时间线事件（Frames 引用批次下标；Rx/Tx 内联持有字节）
#[derive(Clone, Copy, Debug)]
enum ReplayEv {
    Frames(usize),
    Rx(usize),
    Tx(usize),
}

/// 一份可回放的会话（录制完成或从文件打开）
struct Loaded {
    meta: SessionMeta,
    batches: Vec<Vec<u8>>,
    rx: Vec<(u64, Vec<u8>)>,
    tx: Vec<(u64, Vec<u8>)>,
    /// (ts, text) 文件基线标注（P3b；运行时新增量在 Core.annotations）
    annotations: Vec<(u64, String)>,
    /// (ts, ev) 升序合并时间线；同 ts 时 rx/tx 先于 frames（镜像 ingest：先入环后发帧）
    timeline: Vec<(u64, ReplayEv)>,
    /// 时间线首事件 ts（pacing 基准）
    first_ts: u64,
    /// 时间线末事件 ts（seek 比例换算基准）
    last_ts: u64,
}

/// 合并三段数据为回放时间线（帧 emit_ts 用 peek 轻量提取，避免全量解码）
fn build_loaded(
    meta: SessionMeta,
    batches: Vec<Vec<u8>>,
    rx: Vec<(u64, Vec<u8>)>,
    tx: Vec<(u64, Vec<u8>)>,
    annotations: Vec<(u64, String)>,
) -> Loaded {
    let mut timeline: Vec<(u64, ReplayEv)> =
        Vec::with_capacity(batches.len() + rx.len() + tx.len());
    for (i, (ts, _)) in rx.iter().enumerate() {
        timeline.push((*ts, ReplayEv::Rx(i)));
    }
    for (i, (ts, _)) in tx.iter().enumerate() {
        timeline.push((*ts, ReplayEv::Tx(i)));
    }
    for (i, b) in batches.iter().enumerate() {
        let ts = busevt::peek_emit_ts(b).unwrap_or(0);
        timeline.push((ts, ReplayEv::Frames(i)));
    }
    timeline.sort_by_key(|(ts, _)| *ts);
    let first_ts = timeline.first().map(|(t, _)| *t).unwrap_or(0);
    let last_ts = timeline.last().map(|(t, _)| *t).unwrap_or(first_ts);
    Loaded {
        meta,
        batches,
        rx,
        tx,
        annotations,
        timeline,
        first_ts,
        last_ts,
    }
}

#[derive(Default)]
struct Core {
    rec_active: bool,
    rec: Rec,
    start_inst: Option<Instant>,
    /// 录制开始的 epoch ms（meta.recordedAt）
    start_ts: u64,
    port: serde_json::Value,
    rules: serde_json::Value,
    loaded: Option<Arc<Loaded>>,
    file_name: String,
    /// 运行时新增标注（P3b）：录制中/回放中打的。展示与保存 =
    /// loaded.annotations（文件/录制基线）++ 本列表（按 ts 排序）
    annotations: Vec<(u64, String)>,
}

pub struct SessionState {
    recording: AtomicBool,
    paused: Arc<AtomicBool>,
    abort: Arc<AtomicBool>,
    pos_ms: Arc<AtomicU64>,
    frame_idx: Arc<AtomicU64>,
    play_handle: Mutex<Option<JoinHandle<()>>>,
    core: Mutex<Core>,
    /// 回放桥接 TCP 服务端（P3a 虚拟设备；None = 未开桥）
    bridge: Mutex<Option<Bridge>>,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            recording: AtomicBool::new(false),
            paused: Arc::new(AtomicBool::new(false)),
            abort: Arc::new(AtomicBool::new(false)),
            pos_ms: Arc::new(AtomicU64::new(0)),
            frame_idx: Arc::new(AtomicU64::new(0)),
            play_handle: Mutex::new(None),
            core: Mutex::new(Core::default()),
            bridge: Mutex::new(None),
        }
    }
}

fn core_of(sess: &SessionState) -> std::sync::MutexGuard<'_, Core> {
    // 锁中毒时取回内部数据继续（录制/回放不会因单次 panic 永久锁死）
    sess.core.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn base_name(path: &str) -> String {
    let p = Path::new(path);
    p.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn over_limit(frame_count: u64, approx_bytes: u64) -> bool {
    frame_count >= MAX_FRAMES || approx_bytes >= MAX_BATCH_BYTES
}

// ---------- 录制 tap（send_frames / send_rx / send_tx 入口调用） ----------

/// 触顶自动停止：结束录制、迁移缓冲、通知前端（三处 tap 共用）
fn auto_stop(app: &AppHandle, sess: &SessionState) {
    {
        let mut core = core_of(sess);
        if !core.rec_active {
            return;
        }
        core.rec_active = false;
    }
    sess.recording.store(false, Ordering::SeqCst);
    finalize_record(sess);
    let _ = app.emit("session:autostop", ());
}

pub fn tap_frames(app: &AppHandle, ev: &FramesEvent) {
    let Some(sess) = app.try_state::<SessionState>() else {
        return;
    };
    if !sess.recording.load(Ordering::SeqCst) {
        return;
    }
    let buf = busevt::encode_frames(ev);
    let over = {
        let mut core = core_of(&sess);
        if !core.rec_active {
            return;
        }
        core.rec.approx_bytes += buf.len() as u64;
        core.rec.batches.push(buf);
        core.rec.frame_count += ev.rows.len() as u64;
        over_limit(core.rec.frame_count, core.rec.approx_bytes)
    };
    if over {
        auto_stop(app, &sess);
    }
}

/// RX 原始块录制（send_rx 入口；ts = 块时间戳，回放时按它回灌环）
pub fn tap_rx(app: &AppHandle, ts: u64, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let Some(sess) = app.try_state::<SessionState>() else {
        return;
    };
    if !sess.recording.load(Ordering::SeqCst) {
        return;
    }
    let over = {
        let mut core = core_of(&sess);
        if !core.rec_active {
            return;
        }
        core.rec.approx_bytes += bytes.len() as u64 + 16;
        core.rec.rx.push((ts, bytes.to_vec()));
        over_limit(core.rec.frame_count, core.rec.approx_bytes)
    };
    if over {
        auto_stop(app, &sess);
    }
}

/// TX 块录制（send_tx 入口；回放时仅回灌控制台气泡，不外发端口）
pub fn tap_tx(app: &AppHandle, ts: u64, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let Some(sess) = app.try_state::<SessionState>() else {
        return;
    };
    if !sess.recording.load(Ordering::SeqCst) {
        return;
    }
    let over = {
        let mut core = core_of(&sess);
        if !core.rec_active {
            return;
        }
        core.rec.approx_bytes += bytes.len() as u64 + 16;
        core.rec.tx.push((ts, bytes.to_vec()));
        over_limit(core.rec.frame_count, core.rec.approx_bytes)
    };
    if over {
        auto_stop(app, &sess);
    }
}

/// 结束录制：内存缓冲迁移为可回放/可保存的 loaded 会话（时间线合并在此完成）
fn finalize_record(sess: &SessionState) {
    let mut core = core_of(sess);
    core.rec_active = false;
    let dur = core
        .start_inst
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0);
    let meta = SessionMeta {
        recorded_at: core.start_ts,
        duration_ms: dur,
        frame_count: core.rec.frame_count,
        rx_chunk_count: core.rec.rx.len() as u64,
        tx_chunk_count: core.rec.tx.len() as u64,
        port: core.port.clone(),
        tpl_rules: core.rules.clone(),
    };
    let batches = std::mem::take(&mut core.rec.batches);
    let rx = std::mem::take(&mut core.rec.rx);
    let tx = std::mem::take(&mut core.rec.tx);
    // 录制中打的标注随会话固化为文件基线（回放中再打的进 Core.annotations 增量）
    let anns = std::mem::take(&mut core.annotations);
    core.loaded = Some(Arc::new(build_loaded(meta, batches, rx, tx, anns)));
}

// ---------- 回放桥接（P3a 虚拟设备：录制会话对外当真机） ----------

/// 桥接广播集核心（可单测）：写失败/超时剔除客户端，绝不阻塞回放节奏
struct BridgeCore {
    /// (id, stream) 已连客户端（写端句柄）
    clients: Arc<Mutex<Vec<(u64, std::net::TcpStream)>>>,
    next_id: AtomicU64,
    stop: Arc<AtomicBool>,
    /// 监听端口（状态事件回显用；单测填 0）
    port: u16,
}

impl BridgeCore {
    fn new(port: u16) -> Self {
        Self {
            clients: Arc::new(Mutex::new(Vec::new())),
            next_id: AtomicU64::new(1),
            stop: Arc::new(AtomicBool::new(false)),
            port,
        }
    }

    /// 加入客户端：配 TCP_NODELAY + 50ms 写超时后登记；返回 (id, 读端克隆)
    /// —— 读克隆交给「上行丢弃」线程（v1 只做数据流重放，不模拟协议应答）
    fn add(&self, s: std::net::TcpStream) -> (u64, Option<std::net::TcpStream>) {
        let _ = s.set_nodelay(true);
        let _ = s.set_write_timeout(Some(Duration::from_millis(50)));
        let reader = s.try_clone().ok();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((id, s));
        (id, reader)
    }

    fn remove(&self, id: u64) {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(i, _)| *i != id);
    }

    /// 广播字节块；写失败（含 50ms 超时）即剔除该客户端。返回存活客户端数
    fn broadcast(&self, bytes: &[u8]) -> usize {
        let mut g = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_empty() {
            return 0;
        }
        let mut dead = Vec::new();
        for (i, (_, s)) in g.iter_mut().enumerate() {
            if s.write_all(bytes).is_err() {
                dead.push(i);
            }
        }
        for &i in dead.iter().rev() {
            g.swap_remove(i);
        }
        g.len()
    }

    fn count(&self) -> usize {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

/// 一座运行中的桥（accept 线程以 50ms 轮询非阻塞 accept，stop 置位即退出）
struct Bridge {
    core: Arc<BridgeCore>,
    accept_handle: Option<JoinHandle<()>>,
    port: u16,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BridgeState {
    listening: bool,
    port: u16,
    clients: usize,
}

fn emit_bridge(app: &AppHandle, listening: bool, port: u16, clients: usize) {
    let _ = app.emit(
        "session:bridge",
        BridgeState {
            listening,
            port,
            clients,
        },
    );
}

/// 关桥：停 accept（≤50ms）、断开全部客户端（clients drop → 各 TcpStream 关闭）、通知前端
fn bridge_stop(sess: &SessionState, app: &AppHandle) -> bool {
    let taken = sess.bridge.lock().ok().and_then(|mut g| g.take());
    let Some(b) = taken else {
        return false;
    };
    b.core.stop.store(true, Ordering::SeqCst);
    if let Some(h) = b.accept_handle {
        let _ = h.join();
    }
    emit_bridge(app, false, b.port, 0);
    true
}

// ---------- 回放线程 ----------

/// 回放线程：沿合并时间线逐事件重放。RX 回灌 hex 环（HexView 倒带）、
/// TX 仅回灌控制台气泡（不外发）、帧走 send_frames 单点全面板点亮。
/// pacing 用「锚点」绝对排程：target = anchor_inst + 暂停累计 + (ts-anchor_ts)/speed；
/// seek 快进段结束处在当前事件重锚，恢复节奏不爆发。
#[allow(clippy::too_many_arguments)]
fn play_loop(
    app: AppHandle,
    ctx: Arc<crate::pipeline::IngestCtx>,
    tx_total: Arc<AtomicU64>,
    data: Arc<Loaded>,
    speed: f64,
    seek_ts: u64,
    abort: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    pos_ms: Arc<AtomicU64>,
    frame_idx: Arc<AtomicU64>,
    bridge: Option<Arc<BridgeCore>>,
) {
    let full = speed <= 0.0;
    let base = data.first_ts;
    let mut seek_ts = seek_ts;
    let mut anchor_ts = base;
    let mut anchor_inst = Instant::now();
    let mut paused_total = Duration::ZERO;
    let mut pause_since: Option<Instant> = None;
    let mut done: u64 = 0;
    let mut last_emit = Instant::now();
    for (ts, ev) in &data.timeline {
        if abort.load(Ordering::SeqCst) {
            return;
        }
        if !full {
            if seek_ts > 0 && *ts < seek_ts {
                // 快进段：不带节奏立即发出（暂停在快进段不生效）
            } else {
                if seek_ts > 0 {
                    // 刚离开快进段：在此重锚，恢复正常节奏
                    seek_ts = 0;
                    anchor_ts = *ts;
                    anchor_inst = Instant::now();
                    paused_total = Duration::ZERO;
                }
                let target_rel = ((*ts).saturating_sub(anchor_ts) as f64 / speed) as u64;
                loop {
                    if abort.load(Ordering::SeqCst) {
                        return;
                    }
                    if paused.load(Ordering::SeqCst) {
                        if pause_since.is_none() {
                            pause_since = Some(Instant::now());
                        }
                        thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    if let Some(t0) = pause_since.take() {
                        paused_total += t0.elapsed();
                    }
                    let target = anchor_inst + paused_total + Duration::from_millis(target_rel);
                    let now = Instant::now();
                    if now >= target {
                        break;
                    }
                    thread::sleep(Duration::from_millis(4).min(target - now));
                }
            }
        } else {
            while paused.load(Ordering::SeqCst) {
                if abort.load(Ordering::SeqCst) {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
        match ev {
            ReplayEv::Frames(i) => {
                let Some(e) = busevt::decode_frames(&data.batches[*i]) else {
                    continue;
                };
                crate::pipeline::replay_spans(&ctx, &e.rows);
                crate::busevt::send_frames(&app, &e);
                done += e.rows.len() as u64;
                frame_idx.store(done, Ordering::SeqCst);
            }
            ReplayEv::Rx(i) => {
                let (rts, bytes) = &data.rx[*i];
                crate::pipeline::replay_rx(&ctx, *rts, bytes);
                ctx.rx_total.fetch_add(bytes.len() as u64, Ordering::SeqCst);
                // 桥接广播（P3a 虚拟设备）：把原始 RX 字节推给外部客户端；
                // 剔除断连后计数变化才 emit，避免每块都发事件
                if let Some(b) = &bridge {
                    let before = b.count();
                    let after = b.broadcast(bytes);
                    if after != before {
                        emit_bridge(&app, true, b.port, after);
                    }
                }
                crate::busevt::send_rx(&app, *rts, *rts, bytes);
            }
            ReplayEv::Tx(i) => {
                let (tts, bytes) = &data.tx[*i];
                tx_total.fetch_add(bytes.len() as u64, Ordering::SeqCst);
                crate::busevt::send_tx(&app, *tts, bytes);
            }
        }
        pos_ms.store(ts.saturating_sub(base), Ordering::SeqCst);
        if last_emit.elapsed() >= Duration::from_millis(100) {
            last_emit = Instant::now();
            let _ = app.emit(
                "session:progress",
                ProgressPayload {
                    pos_ms: ts.saturating_sub(base),
                    dur_ms: data.meta.duration_ms,
                    frame_idx: done,
                },
            );
        }
    }
    // 自然播完：复位状态并通知前端
    PLAYING.store(false, Ordering::SeqCst);
    pos_ms.store(data.meta.duration_ms, Ordering::SeqCst);
    let _ = app.emit("session:ended", ());
}

// ---------- Tauri 命令 ----------

#[tauri::command]
pub fn session_start_record(
    rules: serde_json::Value,
    port: serde_json::Value,
    app: AppHandle,
    sess: State<SessionState>,
) -> Result<(), String> {
    if is_playing() {
        return Err("回放进行中，无法开始录制".into());
    }
    if sess.recording.swap(true, Ordering::SeqCst) {
        return Err("已在录制中".into());
    }
    let mut core = core_of(&sess);
    core.rec = Rec::default();
    core.rec_active = true;
    core.start_inst = Some(Instant::now());
    core.start_ts = now_ms();
    core.rules = rules;
    core.port = port;
    core.file_name.clear();
    // 新录制覆盖旧载入（前端 UI 已防呆，此处兜底）；标注随会话走，一并清空
    core.loaded = None;
    core.annotations.clear();
    emit_annotations(&app, &[]);
    Ok(())
}

#[tauri::command]
pub fn session_stop_record(sess: State<SessionState>) -> Result<RecStats, String> {
    if !sess.recording.swap(false, Ordering::SeqCst) {
        return Err("没有进行中的录制".into());
    }
    let stats = {
        let core = core_of(&sess);
        RecStats {
            frame_count: core.rec.frame_count,
            duration_ms: core
                .start_inst
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0),
            approx_bytes: core.rec.approx_bytes,
        }
    };
    finalize_record(&sess);
    Ok(stats)
}

#[tauri::command]
pub fn session_save(path: String, sess: State<SessionState>) -> Result<(), String> {
    let loaded = {
        let core = core_of(&sess);
        core.loaded.clone().ok_or("没有可保存的会话（先录制或打开）")?
    };
    // 标注 = 基线 + 运行时新增（按 ts 排序）
    let anns = all_annotations(&sess);
    write_usess(&path, &loaded, &anns)?;
    core_of(&sess).file_name = base_name(&path);
    Ok(())
}

#[tauri::command]
pub fn session_open(
    path: String,
    app: AppHandle,
    sess: State<SessionState>,
) -> Result<SessionMeta, String> {
    if sess.recording.load(Ordering::SeqCst) || is_playing() {
        return Err("请先停止录制/回放再打开会话文件".into());
    }
    let loaded = read_usess(&path)?;
    let meta = loaded.meta.clone();
    let mut core = core_of(&sess);
    core.loaded = Some(Arc::new(loaded));
    core.file_name = base_name(&path);
    core.annotations.clear(); // 打开新会话 = 标注切换为文件基线
    emit_annotations(&app, &core.loaded.as_ref().unwrap().annotations);
    Ok(meta)
}

#[tauri::command]
pub fn session_discard(app: AppHandle, sess: State<SessionState>) -> Result<(), String> {
    if sess.recording.load(Ordering::SeqCst) || is_playing() {
        return Err("请先停止录制/回放再放弃会话".into());
    }
    let mut core = core_of(&sess);
    core.loaded = None;
    core.file_name.clear();
    core.annotations.clear();
    sess.pos_ms.store(0, Ordering::SeqCst);
    sess.frame_idx.store(0, Ordering::SeqCst);
    emit_annotations(&app, &[]);
    Ok(())
}

// ---------- 标注（P3b 时间轴标注） ----------

/// 展示/保存用合并列表：loaded 基线 ++ 运行时新增，按 ts 升序
fn all_annotations(sess: &SessionState) -> Vec<(u64, String)> {
    let core = core_of(sess);
    let mut v = core
        .loaded
        .as_ref()
        .map(|l| l.annotations.clone())
        .unwrap_or_default();
    v.extend(core.annotations.iter().cloned());
    v.sort_by_key(|(ts, _)| *ts);
    v
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AnnOut {
    pub ts: u64,
    pub text: String,
}

fn emit_annotations(app: &AppHandle, list: &[(u64, String)]) {
    let _ = app.emit(
        "session:annotations",
        list.iter()
            .map(|(ts, text)| AnnOut {
                ts: *ts,
                text: text.clone(),
            })
            .collect::<Vec<_>>(),
    );
}

/// 打标注（录制中/回放中均可）：ts 锚定录制经过时长或回放进度位置
#[tauri::command]
pub fn session_annotate(
    text: String,
    app: AppHandle,
    sess: State<SessionState>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }
    let ts = {
        let core = core_of(&sess);
        if sess.recording.load(Ordering::SeqCst) {
            core.start_ts + core
                .start_inst
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0)
        } else if is_playing() {
            let l = core
                .loaded
                .as_ref()
                .ok_or("没有可标注的会话（先录制或打开 .usess 文件）")?;
            l.first_ts + sess.pos_ms.load(Ordering::SeqCst)
        } else {
            return Err("仅在录制或回放中可打标注".into());
        }
    };
    let merged = {
        // 单锁内完成：上限检查 + push + 合并（all_annotations 会再取锁，持锁期间不可调用）
        let mut core = core_of(&sess);
        let base = core
            .loaded
            .as_ref()
            .map(|l| l.annotations.len())
            .unwrap_or(0);
        if base + core.annotations.len() >= MAX_ANNOTATIONS {
            return Err(format!("标注已达上限 {MAX_ANNOTATIONS} 条"));
        }
        core.annotations.push((ts, text));
        let mut merged: Vec<(u64, String)> = core
            .loaded
            .as_ref()
            .map(|l| l.annotations.clone())
            .unwrap_or_default();
        merged.extend(core.annotations.iter().cloned());
        merged.sort_by_key(|(t, _)| *t);
        merged
    };
    emit_annotations(&app, &merged);
    Ok(())
}

/// 查询当前标注（前端 init 时对账用；运行中走 session:annotations 事件）
#[tauri::command]
pub fn session_annotations(sess: State<SessionState>) -> Vec<AnnOut> {
    all_annotations(&sess)
        .into_iter()
        .map(|(ts, text)| AnnOut { ts, text })
        .collect()
}

/// speed：>0 = 倍速 pacing（0.25×/0.5×/1×/2×/4×），0/负 = 去节奏全速
#[tauri::command]
pub fn session_play(
    speed: f64,
    app: AppHandle,
    serial: State<SerialManager>,
    net: State<crate::net::NetManager>,
    sess: State<SessionState>,
) -> Result<(), String> {
    play_from(&app, &serial, &net, &sess, speed, 0)
}

/// 进度条跳转（v1 语义）：清空 hex 环 → 从头全速快进到目标点 → 恢复 speed 节奏。
/// 录制态拒绝；空闲(recorded)态可直接点进度条从该处开始播放。
#[tauri::command]
pub fn session_seek(
    ratio: f64,
    speed: f64,
    app: AppHandle,
    serial: State<SerialManager>,
    net: State<crate::net::NetManager>,
    sess: State<SessionState>,
) -> Result<(), String> {
    let data = {
        let core = core_of(&sess);
        core.loaded
            .clone()
            .ok_or_else(|| "未打开会话（先录制或打开 .usess 文件）".to_string())?
    };
    let r = ratio.clamp(0.0, 1.0);
    let span = data.last_ts.saturating_sub(data.first_ts);
    let target = data.first_ts + (span as f64 * r) as u64;
    play_from(&app, &serial, &net, &sess, speed, target)
}

/// 播放/跳转共用入口：互斥护栏 → 停旧线程 → hex 复位 → 起新回放线程
fn play_from(
    app: &AppHandle,
    serial: &SerialManager,
    net: &crate::net::NetManager,
    sess: &SessionState,
    speed: f64,
    seek_ts: u64,
) -> Result<(), String> {
    if sess.recording.load(Ordering::SeqCst) {
        return Err("录制进行中，无法回放".into());
    }
    if is_playing() {
        if seek_ts == 0 && sess.paused.load(Ordering::SeqCst) {
            // 暂停中再次播放 = 恢复（仅 session_play 路径；seek 总是重启）
            sess.paused.store(false, Ordering::SeqCst);
            return Ok(());
        }
        // seek / 播放中重启：先停当前线程
        sess.abort.store(true, Ordering::SeqCst);
        let handle = sess.play_handle.lock().ok().and_then(|mut h| h.take());
        if let Some(h) = handle {
            let _ = h.join();
        }
    }
    let data = {
        let core = core_of(sess);
        core.loaded
            .clone()
            .ok_or_else(|| "未打开会话（先录制或打开 .usess 文件）".to_string())?
    };
    // 回放与真实连接互斥（避免双源混淆）
    if serial.is_open() {
        return Err("回放前请先断开串口连接".into());
    }
    if serial.demo_flag.load(Ordering::SeqCst) {
        return Err("回放前请先停止演示数据源".into());
    }
    if crate::net::is_connected(net) {
        return Err("回放前请先断开网络连接".into());
    }
    sess.abort.store(false, Ordering::SeqCst);
    sess.paused.store(false, Ordering::SeqCst);
    sess.pos_ms
        .store(seek_ts.saturating_sub(data.first_ts), Ordering::SeqCst);
    sess.frame_idx.store(0, Ordering::SeqCst);
    // hex 视图复位：RX 回灌从 seq=0 对齐（帧 span 的 seq 依赖此不变量）
    crate::pipeline::replay_reset(&serial.ctx);
    PLAYING.store(true, Ordering::SeqCst);
    let sp = if speed.is_finite() && speed > 0.0 { speed } else { 0.0 };
    let abort = sess.abort.clone();
    let paused = sess.paused.clone();
    let pos = sess.pos_ms.clone();
    let idx = sess.frame_idx.clone();
    let ctx = serial.ctx.clone();
    let tx_total = serial.tx_total.clone();
    let app2 = app.clone();
    // 桥接客户端集快照（Arc）：桥在回放中关闭后此引用成孤儿、广播空转，无害
    let bridge = sess
        .bridge
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|b| b.core.clone()));
    let handle = thread::spawn(move || {
        play_loop(
            app2, ctx, tx_total, data, sp, seek_ts, abort, paused, pos, idx, bridge,
        )
    });
    if let Ok(mut h) = sess.play_handle.lock() {
        *h = Some(handle);
    }
    Ok(())
}

#[tauri::command]
pub fn session_pause(sess: State<SessionState>) -> Result<(), String> {
    if !is_playing() {
        return Err("没有进行中的回放".into());
    }
    sess.paused.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn session_resume(sess: State<SessionState>) -> Result<(), String> {
    if !is_playing() {
        return Err("没有进行中的回放".into());
    }
    sess.paused.store(false, Ordering::SeqCst);
    Ok(())
}

/// 停止回放（loaded 保留，可再次播放）；同时自动关桥（P3a：桥随回放会话生命周期）
#[tauri::command]
pub fn session_stop(app: AppHandle, sess: State<SessionState>) -> Result<(), String> {
    sess.abort.store(true, Ordering::SeqCst);
    let handle = sess.play_handle.lock().ok().and_then(|mut h| h.take());
    if let Some(h) = handle {
        let _ = h.join();
    }
    sess.abort.store(false, Ordering::SeqCst);
    PLAYING.store(false, Ordering::SeqCst);
    sess.paused.store(false, Ordering::SeqCst);
    bridge_stop(&sess, &app);
    Ok(())
}

#[tauri::command]
pub fn session_status(sess: State<SessionState>) -> SessionStatus {
    let core = core_of(&sess);
    let recording = sess.recording.load(Ordering::SeqCst);
    let paused = sess.paused.load(Ordering::SeqCst);
    let playing = is_playing();
    let state = if recording {
        "recording"
    } else if paused && playing {
        "paused"
    } else if playing {
        "playing"
    } else if core.loaded.is_some() {
        "recorded"
    } else {
        "idle"
    };
    let (frame_count, duration_ms, file_name) = if recording {
        (
            core.rec.frame_count,
            core.start_inst
                .map(|t| t.elapsed().as_millis() as u64)
                .unwrap_or(0),
            String::new(),
        )
    } else if let Some(l) = &core.loaded {
        (l.meta.frame_count, l.meta.duration_ms, core.file_name.clone())
    } else {
        (0, 0, String::new())
    };
    let (bridge_listening, bridge_port, bridge_clients) = {
        match sess.bridge.lock().ok().as_ref().and_then(|g| g.as_ref()) {
            Some(b) => (true, b.port, b.core.count()),
            None => (false, 0, 0),
        }
    };
    let (first_ts, last_ts) = core_of(&sess)
        .loaded
        .as_ref()
        .map(|l| (l.first_ts, l.last_ts))
        .unwrap_or((0, 0));
    SessionStatus {
        state: state.into(),
        frame_count,
        duration_ms,
        pos_ms: sess.pos_ms.load(Ordering::SeqCst),
        frame_idx: sess.frame_idx.load(Ordering::SeqCst),
        file_name,
        bridge_listening,
        bridge_port,
        bridge_clients,
        first_ts,
        last_ts,
    }
}

// ---------- 桥接命令（P3a 虚拟设备） ----------

/// 开桥：监听端口接受外部客户端连入（先开桥等客户端、再点播放是自然流程）。
/// 重复调用 = 换端口重开。播放时回放线程对客户端广播 RX 原始块。
#[tauri::command]
pub fn session_bridge_start(
    port: u16,
    app: AppHandle,
    sess: State<SessionState>,
) -> Result<(), String> {
    bridge_stop(&sess, &app); // 幂等重开
    let listener =
        std::net::TcpListener::bind(("0.0.0.0", port))
            .map_err(|e| format!("桥接端口 {port} 监听失败（被占用？）：{e}"))?;
    let core = Arc::new(BridgeCore::new(port));
    let handle = {
        let core = core.clone();
        let app = app.clone();
        thread::spawn(move || {
            let _ = listener.set_nonblocking(true);
            loop {
                if core.stop.load(Ordering::SeqCst) {
                    break;
                }
                match listener.accept() {
                    Ok((s, _addr)) => {
                        let (id, reader) = core.add(s);
                        emit_bridge(&app, true, core.port, core.count());
                        // 上行丢弃线程：防客户端发送缓冲塞满 + 断开自清
                        // （v1 不模拟协议应答，工具上行直接丢弃）
                        if let Some(r) = reader {
                            let core2 = core.clone();
                            thread::spawn(move || {
                                use std::io::Read as _;
                                let mut buf = [0u8; 1024];
                                loop {
                                    match (&r).read(&mut buf) {
                                        Ok(0) | Err(_) => break,
                                        Ok(_) => {}
                                    }
                                }
                                core2.remove(id);
                            });
                        }
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        })
    };
    if let Ok(mut g) = sess.bridge.lock() {
        *g = Some(Bridge {
            core,
            accept_handle: Some(handle),
            port,
        });
    }
    emit_bridge(&app, true, port, 0);
    Ok(())
}

/// 关桥（断开全部外部客户端）
#[tauri::command]
pub fn session_bridge_stop(app: AppHandle, sess: State<SessionState>) -> Result<(), String> {
    bridge_stop(&sess, &app);
    Ok(())
}

// ---------- .usess 文件 I/O ----------

fn write_usess(path: &str, l: &Loaded, anns: &[(u64, String)]) -> Result<(), String> {
    let we = |e: std::io::Error| format!("写入文件失败: {e}");
    let mut f = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {e}"))?;
    let mj = serde_json::to_vec(&l.meta).map_err(|e| format!("元数据序列化失败: {e}"))?;
    f.write_all(MAGIC).map_err(we)?;
    f.write_all(&VERSION.to_le_bytes()).map_err(we)?;
    f.write_all(&(mj.len() as u32).to_le_bytes()).map_err(we)?;
    f.write_all(&mj).map_err(we)?;
    f.write_all(&(l.batches.len() as u32).to_le_bytes()).map_err(we)?;
    for b in &l.batches {
        f.write_all(&(b.len() as u32).to_le_bytes()).map_err(we)?;
        f.write_all(b).map_err(we)?;
    }
    // rx 段：u32 chunkCount + N × ( u64 tsMs + u32 len + bytes )
    f.write_all(&(l.rx.len() as u32).to_le_bytes()).map_err(we)?;
    for (ts, b) in &l.rx {
        f.write_all(&ts.to_le_bytes()).map_err(we)?;
        f.write_all(&(b.len() as u32).to_le_bytes()).map_err(we)?;
        f.write_all(b).map_err(we)?;
    }
    // tx 段：同 rx 段结构
    f.write_all(&(l.tx.len() as u32).to_le_bytes()).map_err(we)?;
    for (ts, b) in &l.tx {
        f.write_all(&ts.to_le_bytes()).map_err(we)?;
        f.write_all(&(b.len() as u32).to_le_bytes()).map_err(we)?;
        f.write_all(b).map_err(we)?;
    }
    // v2 标注段：u32 count + N × ( u64 tsMs + u32 len + UTF-8 bytes )
    f.write_all(&(anns.len() as u32).to_le_bytes()).map_err(we)?;
    for (ts, text) in anns {
        f.write_all(&ts.to_le_bytes()).map_err(we)?;
        let tb = text.as_bytes();
        f.write_all(&(tb.len() as u32).to_le_bytes()).map_err(we)?;
        f.write_all(tb).map_err(we)?;
    }
    Ok(())
}

struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Cur<'a> {
    fn need(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.b.len() - self.p {
            return Err("会话文件不完整或已损坏".into());
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32, String> {
        let s = self.need(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Result<u64, String> {
        let s = self.need(8)?;
        Ok(u64::from_le_bytes([
            s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
        ]))
    }
}

fn read_usess(path: &str) -> Result<Loaded, String> {
    let data = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let mut r = Cur { b: &data, p: 0 };
    if r.need(5)? != MAGIC {
        return Err("不是有效的 .usess 会话文件".into());
    }
    let ver = r.u32()?;
    if ver > VERSION || ver < 1 {
        return Err(format!("会话文件版本不受支持: v{ver}"));
    }
    let mlen = r.u32()? as usize;
    let meta: SessionMeta = serde_json::from_slice(r.need(mlen)?)
        .map_err(|e| format!("会话元数据解析失败: {e}"))?;
    let n = r.u32()? as usize;
    let mut batches: Vec<Vec<u8>> = Vec::with_capacity(n.min(1_000_000));
    let mut total: u64 = 0;
    for _ in 0..n {
        let bl = r.u32()? as usize;
        let b = r.need(bl)?;
        total += bl as u64;
        batches.push(b.to_vec());
    }
    if total > MAX_BATCH_BYTES {
        return Err("会话文件过大（超过 512MB 护栏）".into());
    }
    // rx 段（P1 文件计数为 0，天然兼容）
    let mut rx: Vec<(u64, Vec<u8>)> = Vec::new();
    let nrx = r.u32()?;
    for _ in 0..nrx {
        let ts = r.u64()?;
        let l = r.u32()? as usize;
        let b = r.need(l)?;
        rx.push((ts, b.to_vec()));
    }
    // tx 段
    let mut tx: Vec<(u64, Vec<u8>)> = Vec::new();
    let ntx = r.u32()?;
    for _ in 0..ntx {
        let ts = r.u64()?;
        let l = r.u32()? as usize;
        let b = r.need(l)?;
        tx.push((ts, b.to_vec()));
    }
    // v2 标注段（v1 文件无此段 → 空列表）
    let mut anns: Vec<(u64, String)> = Vec::new();
    if ver >= 2 {
        let na = r.u32()?;
        for _ in 0..na {
            let ts = r.u64()?;
            let l = r.u32()? as usize;
            let b = r.need(l)?;
            anns.push((
                ts,
                String::from_utf8(b.to_vec())
                    .map_err(|_| "标注段不是有效的 UTF-8".to_string())?,
            ));
        }
    }
    Ok(build_loaded(meta, batches, rx, tx, anns))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{FieldOut, FrameRow};

    fn sample_event(first: bool) -> FramesEvent {
        FramesEvent {
            rows: vec![FrameRow {
                tpl_id: "tpl-1".into(),
                tpl_name: if first { "模板甲" } else { "模板乙" }.into(),
                color: "#4e9cef".into(),
                ts_ms: 1_700_000_000_000,
                seq: 7,
                len: 4,
                valid: true,
                error: None,
                fields: vec![FieldOut {
                    id: "v".into(),
                    name: "值".into(),
                    raw: 1.0,
                    value: 2.0,
                    text: None,
                }],
                bytes: vec![1, 2, 3, 4],
            }],
            total: 1,
            errors: 0,
            dropped: 0,
            emit_ts: 1_700_000_000_000,
        }
    }

    #[test]
    fn usess_round_trip() {
        let meta = SessionMeta {
            recorded_at: 1_700_000_000_000,
            duration_ms: 30_000,
            frame_count: 2,
            rx_chunk_count: 2,
            tx_chunk_count: 1,
            port: serde_json::json!({ "kind": "demo", "portName": null, "baud": null }),
            tpl_rules: serde_json::json!({ "templates": [{ "id": "tpl-1", "name": "模板甲" }] }),
        };
        // 帧 emit_ts=1_700_000_000_000；rx 同 ts 交错、tx 独立
        let l = Loaded {
            meta,
            batches: vec![
                busevt::encode_frames(&sample_event(true)),
                busevt::encode_frames(&sample_event(false)),
            ],
            rx: vec![
                (1_700_000_000_000, vec![0xAA, 0x01, 0x02]),
                (1_700_000_000_500, vec![0x03, 0x04]),
            ],
            tx: vec![(1_700_000_000_200, vec![0xDD, 0xEE])],
            annotations: vec![
                (1_700_000_000_100, "事件甲：按键".into()),
                (1_700_000_000_450, "事件乙：数据跳变".into()),
            ],
            timeline: Vec::new(),
            first_ts: 1_700_000_000_000,
            last_ts: 1_700_000_000_500,
        };
        let p = std::env::temp_dir().join("uartix_usess_roundtrip.usess");
        write_usess(p.to_str().unwrap(), &l, &l.annotations).unwrap();
        let back = read_usess(p.to_str().unwrap()).unwrap();
        assert_eq!(back.meta.recorded_at, 1_700_000_000_000);
        assert_eq!(back.meta.duration_ms, 30_000);
        assert_eq!(back.meta.frame_count, 2);
        assert_eq!(back.meta.port["kind"], "demo");
        assert_eq!(back.meta.tpl_rules["templates"][0]["name"], "模板甲");
        assert_eq!(back.batches.len(), 2);
        assert_eq!(back.batches[0], l.batches[0]);
        assert_eq!(back.rx.len(), 2);
        assert_eq!(back.rx[0], (1_700_000_000_000, vec![0xAA, 0x01, 0x02]));
        assert_eq!(back.rx[1].0, 1_700_000_000_500);
        assert_eq!(back.tx.len(), 1);
        assert_eq!(back.tx[0], (1_700_000_000_200, vec![0xDD, 0xEE]));
        // v2 标注段 round-trip（含中文 UTF-8）
        assert_eq!(back.annotations.len(), 2);
        assert_eq!(
            back.annotations[0],
            (1_700_000_000_100, "事件甲：按键".to_string())
        );
        assert_eq!(
            back.annotations[1],
            (1_700_000_000_450, "事件乙：数据跳变".to_string())
        );
        // 时间线合并（两帧 emit_ts 同为 1_700_000_000_000，稳定排序 rx 先于 frames）：
        // rx(0) → frames(0) → frames(0) → tx(200) → rx(500)
        let kinds: Vec<&str> = back
            .timeline
            .iter()
            .map(|(_, e)| match e {
                ReplayEv::Frames(_) => "F",
                ReplayEv::Rx(_) => "R",
                ReplayEv::Tx(_) => "T",
            })
            .collect();
        assert_eq!(kinds, vec!["R", "F", "F", "T", "R"]);
        assert_eq!(back.first_ts, 1_700_000_000_000);
        assert_eq!(back.last_ts, 1_700_000_000_500);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn p1_file_without_rx_tx_still_loads() {
        // P1 期写的文件（rx/tx 段计数为 0）必须可被 P2 读取
        let meta = SessionMeta {
            recorded_at: 1,
            duration_ms: 2,
            frame_count: 1,
            rx_chunk_count: 0,
            tx_chunk_count: 0,
            port: serde_json::json!(null),
            tpl_rules: serde_json::json!({ "templates": [] }),
        };
        let l = Loaded {
            meta,
            batches: vec![busevt::encode_frames(&sample_event(true))],
            rx: vec![],
            tx: vec![],
            annotations: vec![],
            timeline: Vec::new(),
            first_ts: 0,
            last_ts: 0,
        };
        let p = std::env::temp_dir().join("uartix_usess_p1_compat.usess");
        // 手写 P1(v1) 格式：meta + batches + 两个 0 计数段（无 v2 标注段）
        let mut out: Vec<u8> = Vec::new();
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&1u32.to_le_bytes());
        let mj = serde_json::to_vec(&l.meta).unwrap();
        out.extend_from_slice(&(mj.len() as u32).to_le_bytes());
        out.extend_from_slice(&mj);
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&(l.batches[0].len() as u32).to_le_bytes());
        out.extend_from_slice(&l.batches[0]);
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        std::fs::write(&p, &out).unwrap();
        let back = read_usess(p.to_str().unwrap()).unwrap();
        assert_eq!(back.batches.len(), 1);
        assert_eq!(back.rx.len(), 0);
        assert_eq!(back.tx.len(), 0);
        assert_eq!(back.timeline.len(), 1);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn pacing_monotonic_and_speed_scaled() {
        // 与 play_loop 内联锚点公式一致：target_rel = (ts - anchor_ts) / speed
        let plan = |first: u64, ts: &[u64], sp: f64| -> Vec<u64> {
            ts.iter().map(|t| ((t.saturating_sub(first)) as f64 / sp) as u64).collect()
        };
        let first = 1_000u64;
        let ts = [1_000u64, 1_100, 1_150, 1_300];
        for sp in [0.25f64, 1.0, 4.0] {
            let p = plan(first, &ts, sp);
            assert_eq!(p[0], 0);
            for w in p.windows(2) {
                assert!(w[0] <= w[1], "speed {sp} not monotonic: {p:?}");
            }
        }
        let slow = plan(first, &ts, 0.25);
        let fast = plan(first, &ts, 4.0);
        assert_eq!(slow[3], 1_200); // 300ms / 0.25
        assert_eq!(fast[3], 75); // 300ms / 4
    }

    #[test]
    fn limit_auto_stop() {
        assert!(!over_limit(10, 100));
        assert!(over_limit(MAX_FRAMES, 0));
        assert!(over_limit(0, MAX_BATCH_BYTES));
    }

    #[test]
    fn bad_file_rejected_friendly() {
        let p = std::env::temp_dir().join("uartix_usess_bad.usess");
        std::fs::write(&p, b"XXXXxgarbage-not-a-session").unwrap();
        let err = match read_usess(p.to_str().unwrap()) {
            Err(e) => e,
            Ok(_) => panic!("garbage file should be rejected"),
        };
        assert!(err.contains("usess"));
        // 截断的有效头部
        std::fs::write(&p, b"USESS\x01").unwrap();
        assert!(read_usess(p.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn bridge_broadcast_and_prune() {
        use std::io::Read as _;
        use std::net::Shutdown;
        let core = BridgeCore::new(0);
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let mut c1 = std::net::TcpStream::connect(addr).unwrap();
        let c2 = std::net::TcpStream::connect(addr).unwrap();
        let (s1, _) = l.accept().unwrap();
        let (s2, _) = l.accept().unwrap();
        let _ = core.add(s1);
        let _ = core.add(s2);
        assert_eq!(core.count(), 2);
        // 广播：两个客户端都收到
        assert_eq!(core.broadcast(b"\xAA\x55\x01\x02"), 2);
        let mut buf = [0u8; 4];
        c1.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        c1.read_exact(&mut buf).unwrap();
        assert_eq!(buf, [0xAA, 0x55, 0x01, 0x02]);
        // 客户端主动断开 → 写失败被剔除（对端 RST 前首次写可能仍入缓冲，多推几轮）
        c2.shutdown(Shutdown::Both).unwrap();
        let mut alive = core.count();
        for _ in 0..10 {
            alive = core.broadcast(b"x");
            if alive == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(alive, 1);
        assert_eq!(core.count(), 1);
        // remove 语义
        core.remove(999);
        assert_eq!(core.count(), 1);
    }
}
