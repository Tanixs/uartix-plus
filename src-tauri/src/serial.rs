use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

use crate::pipeline::{ingest, IngestCtx, Pipeline};

const EMIT_INTERVAL_MS: u64 = 33;
const EMIT_MAX_BYTES: usize = 16384;
const READ_BUF_SIZE: usize = 4096;
const HOTPLUG_POLL_MS: u64 = 1500;
const RECONNECT_POLL_MS: u64 = 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    pub name: String,
    pub friendly: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnState {
    pub status: String,
    pub port: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RxEvent {
    #[serde(with = "crate::b64")]
    pub bytes: Vec<u8>,
    pub ts_first: u64,
    pub ts_last: u64,
    /// Rust 侧发出事件的时刻：前端用于测量 IPC 投递延迟（诊断事件积压）
    pub emit_ts: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TxEvent {
    #[serde(with = "crate::b64")]
    pub bytes: Vec<u8>,
    pub ts: u64,
}

struct Shared {
    port: Option<Box<dyn serialport::SerialPort>>,
    config: Option<SerialConfig>,
    /// P106：用户**显式**要过的电平（`None` = 从没碰过）。
    /// 记在 Rust 侧而不是只记在前端：重连/重开是在这条读线程里发生的，
    /// 等前端看到"已连接"再补一刀，中间那几百毫秒线是悬的 —— 板子就是在这时候被踢进 bootloader 的。
    dtr: Option<bool>,
    rts: Option<bool>,
}

/// 把记下来的目标电平施加到端口上：尽力而为，失败不改记忆（下次重开还会再试）。
fn apply_control_lines(port: &mut Box<dyn serialport::SerialPort>, dtr: Option<bool>, rts: Option<bool>) {
    if let Some(level) = dtr {
        let _ = port.write_data_terminal_ready(level);
    }
    if let Some(level) = rts {
        let _ = port.write_request_to_send(level);
    }
}

pub struct SerialManager {
    pub ctx: Arc<IngestCtx>,
    shared: Arc<Mutex<Shared>>,
    run_flag: Arc<AtomicBool>,
    reconnect_flag: Arc<AtomicBool>,
    pub demo_flag: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    /// TX 累计字节数（会话回放回灌时同步推进，状态栏保持一致）
    pub(crate) tx_total: Arc<AtomicU64>,
}

impl SerialManager {
    /// 串口是否已连接（vdev 互斥检查等跨模块用）
    pub fn serial_connected(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.port.is_some())
            .unwrap_or(false)
    }

    pub fn new() -> Self {
        Self {
            ctx: Arc::new(IngestCtx {
                pipeline: Arc::new(Pipeline::new()),
                record: Arc::new(Mutex::new(None)),
                rx_total: Arc::new(AtomicU64::new(0)),
                xfer: Arc::new(crate::xfer::XferManager::new()),
            }),
            shared: Arc::new(Mutex::new(Shared {
                port: None,
                config: None,
                dtr: None,
                rts: None,
            })),
            run_flag: Arc::new(AtomicBool::new(false)),
            reconnect_flag: Arc::new(AtomicBool::new(false)),
            demo_flag: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
            tx_total: Arc::new(AtomicU64::new(0)),
        }
    }

    /// 串口是否处于打开状态（会话回放前互斥检查用）
    pub fn is_open(&self) -> bool {
        self.shared
            .lock()
            .map(|s| s.port.is_some())
            .unwrap_or(false)
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn emit_state(app: &AppHandle, status: &str, port: Option<String>, error: Option<String>) {
    let _ = app.emit(
        "serial:state",
        ConnState {
            status: status.to_string(),
            port,
            error,
        },
    );
}

fn parse_parity(s: &str) -> Result<Parity, String> {
    match s {
        "none" => Ok(Parity::None),
        "even" => Ok(Parity::Even),
        "odd" => Ok(Parity::Odd),
        other => Err(format!("不支持的校验位: {other}")),
    }
}

fn open_with(config: &SerialConfig) -> Result<Box<dyn serialport::SerialPort>, String> {
    serialport::new(&config.port, config.baud)
        .data_bits(match config.data_bits {
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(parse_parity(&config.parity)?)
        .stop_bits(match config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        })
        .flow_control(FlowControl::None)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开 {} 失败: {e}", config.port))
}

fn parse_hex(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    for token in text.split([' ', ',', '\t', '\r', '\n']) {
        let t = token.trim();
        if t.is_empty() {
            continue;
        }
        let t = t
            .strip_prefix("0x")
            .or_else(|| t.strip_prefix("0X"))
            .unwrap_or(t);
        if t.is_empty() || !t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("无效的十六进制片段: {t}"));
        }
        if t.len() <= 2 {
            out.push(u8::from_str_radix(t, 16).map_err(|e| e.to_string())?);
        } else {
            if t.len() % 2 != 0 {
                return Err(format!("十六进制长度必须为偶数: {t}"));
            }
            for i in (0..t.len()).step_by(2) {
                out.push(u8::from_str_radix(&t[i..i + 2], 16).map_err(|e| e.to_string())?);
            }
        }
    }
    Ok(out)
}

fn list_infos() -> Vec<PortInfo> {
    let ports = match serialport::available_ports() {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    ports
        .into_iter()
        .map(|p| {
            let friendly = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    let parts: Vec<String> = [
                        info.product.clone(),
                        info.manufacturer.clone(),
                        info.serial_number.clone().map(|s| format!("SN:{s}")),
                    ]
                    .into_iter()
                    .flatten()
                    .collect();
                    if parts.is_empty() {
                        "USB 串行设备".to_string()
                    } else {
                        parts.join(" · ")
                    }
                }
                serialport::SerialPortType::BluetoothPort => "蓝牙串口".to_string(),
                serialport::SerialPortType::PciPort => "PCI 串口".to_string(),
                _ => "串口设备".to_string(),
            };
            PortInfo {
                name: p.port_name,
                friendly,
            }
        })
        .collect()
}

#[tauri::command]
pub async fn list_ports() -> Result<Vec<PortInfo>, String> {
    // available_ports 在 Windows 上走设备/注册表枚举：USB 设备异常或被拔出时
    // 可能阻塞数百毫秒。同步命令跑在主线程 → 拔线瞬间整窗无响应（实测卡死的
    // 直接元凶之一）。改 async + spawn_blocking 移到线程池执行。
    tauri::async_runtime::spawn_blocking(list_infos)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_port(
    config: SerialConfig,
    app: AppHandle,
    state: State<'_, SerialManager>,
) -> Result<(), String> {
    // 回放与真实连接互斥：回放进行中禁止打开串口（避免双源混淆）
    if crate::session::is_playing() {
        return Err("回放进行中，请先停止回放再打开串口".into());
    }
    // 虚拟设备与真实接口互斥：命令会被 vdev 拦截，绝不能混流
    if crate::vdev::running() {
        return Err("虚拟设备运行中：请先停止虚拟设备再连接真实接口".into());
    }
    {
        let shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        if shared.port.is_some() {
            return Err("串口已打开，请先关闭当前连接".into());
        }
    }
    // 打开串口（驱动握手）可能阻塞，同样移出主线程
    let cfg = config.clone();
    let mut port = tauri::async_runtime::spawn_blocking(move || open_with(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        // 先施加用户显式要过的电平（没要过 = 两条 None = 完全不碰线，这是默认）
        apply_control_lines(&mut port, shared.dtr, shared.rts);
        shared.port = Some(port);
        shared.config = Some(config.clone());
    }

    let my_epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    state.run_flag.store(true, Ordering::SeqCst);
    state.reconnect_flag.store(true, Ordering::SeqCst);

    spawn_read_thread(
        app.clone(),
        state.shared.clone(),
        state.ctx.clone(),
        state.run_flag.clone(),
        state.reconnect_flag.clone(),
        state.epoch.clone(),
        my_epoch,
    );

    emit_state(&app, "connected", Some(config.port), None);
    Ok(())
}

#[tauri::command]
pub async fn close_port(app: AppHandle, state: State<'_, SerialManager>) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.reconnect_flag.store(false, Ordering::SeqCst);
    state.run_flag.store(false, Ordering::SeqCst);
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        shared.port = None;
        shared.config = None;
    }
    if let Ok(mut rec) = state.ctx.record.lock() {
        if let Some(f) = rec.as_mut() {
            let _ = f.flush();
        }
        *rec = None;
    }
    emit_state(&app, "disconnected", None, None);
    Ok(())
}

#[tauri::command]
pub async fn send_data(
    mode: String,
    text: String,
    app: AppHandle,
    state: State<'_, SerialManager>,
    net: State<'_, crate::net::NetManager>,
    ble: State<'_, crate::ble::BleManager>,
) -> Result<(), String> {
    let bytes = match mode.as_str() {
        "hex" => parse_hex(&text)?,
        _ => text.into_bytes(),
    };
    if bytes.is_empty() {
        return Err("发送内容为空".into());
    }
    route_send(&app, &state, &net, &ble, &bytes).await
}

/// 串口直写（try_send 契约：Ok(false)=串口未接管）
pub(crate) fn try_send_serial(state: &SerialManager, bytes: &[u8]) -> Result<(), String> {
    let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
    let port = shared
        .port
        .as_mut()
        .ok_or_else(|| "串口未连接".to_string())?;
    port.write_all(bytes).map_err(|e| format!("发送失败: {e}"))?;
    port.flush().map_err(|e| format!("发送失败: {e}"))?;
    Ok(())
}

/// 统一发送路由：net → ble → serial；控制台 send_data 与文件传输（xfer.rs）共用。
/// 三处都未接管时返回最后的串口错误（「串口未连接」）
pub(crate) async fn route_send(
    app: &AppHandle,
    serial: &SerialManager,
    net: &crate::net::NetManager,
    ble: &crate::ble::BleManager,
    bytes: &[u8],
) -> Result<(), String> {
    // 虚拟设备运行时接管发送（像真设备收指令）：命中命令 → 改输入量/排队应答；
    // 未命中也按已消费处理。TX 照常入计数与日志（控制台/录制可见）。
    match crate::vdev::try_send(bytes) {
        Ok(true) => {
            serial.tx_total.fetch_add(bytes.len() as u64, Ordering::SeqCst);
            crate::busevt::send_tx(app, now_ms(), bytes);
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    match crate::net::try_send(net, bytes) {
        Ok(true) => {
            crate::net::notify_tx(app, net, bytes);
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    match crate::ble::try_send(ble, bytes).await {
        Ok(true) => {
            crate::ble::notify_tx(app, bytes);
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    try_send_serial(serial, bytes)?;
    serial.tx_total.fetch_add(bytes.len() as u64, Ordering::SeqCst);
    crate::busevt::send_tx(app, now_ms(), bytes);
    Ok(())
}

#[tauri::command]
pub async fn start_record(path: String, state: State<'_, SerialManager>) -> Result<(), String> {
    // 文件创建可能碰上杀软扫描/网络盘阻塞，移出主线程
    let file = tauri::async_runtime::spawn_blocking(move || File::create(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("创建日志文件失败: {e}"))?;
    *state
        .ctx
        .record
        .lock()
        .map_err(|_| "状态锁中毒")? = Some(file);
    Ok(())
}

#[tauri::command]
pub async fn stop_record(state: State<'_, SerialManager>) -> Result<(), String> {
    let mut rec = state.ctx.record.lock().map_err(|_| "状态锁中毒")?;
    if let Some(f) = rec.as_mut() {
        let _ = f.flush();
    }
    *rec = None;
    Ok(())
}

/* ---------------- P106 串口控制线：DTR / RTS / Break ----------------
 * 三条命令都守同一条原则：**打开串口时不主动碰线**（同类软件也一律不驱动这两条线，
 * 因为 ESP32/STM32 的自动烧录电路就是靠 DTR+RTS 的组合沿决定"复位跑固件"还是"进 bootloader"，
 * 一个"顺手给个默认电平"就能让用户的板子在连接那一刻被踢进烧录模式）。
 * 只有用户显式点过（`Some(..)`）才写线；`None` 那条一律不动。
 * 详设：docs/P106-串口控制线-详设.md
 */

/// Break 时长下限（ms）：给得起 LIN 唤醒（≥250 µs）这类短中断
pub const BREAK_MIN_MS: u32 = 1;
/// Break 时长上限（ms）：防手滑把总线按住不动
pub const BREAK_MAX_MS: u32 = 1000;
/// Break 默认时长（ms）：≈ 9600 8N1 的一帧多，够设备识别为中断又不吞后续帧
pub const BREAK_DEFAULT_MS: u32 = 20;

/// 收口 Break 时长：越界钳进区间而不是报错 —— 输入框越界是常事，静默钳比弹一个红字友好。
pub fn clamp_break_ms(requested: u32) -> u32 {
    requested.clamp(BREAK_MIN_MS, BREAK_MAX_MS)
}

/// 置 DTR / RTS 的目标电平。两条都 `None` = 什么都不做（不当错误处理）。
/// ⚠ 尽力而为、失败不回滚：半应用（DTR 已改、RTS 失败）是有状态可查的，
/// 而"回滚"可能把对端再踢进 bootloader —— 那比半应用更糟。
#[tauri::command]
pub async fn set_control_lines(
    dtr: Option<bool>,
    rts: Option<bool>,
    state: State<'_, SerialManager>,
) -> Result<(), String> {
    if dtr.is_none() && rts.is_none() {
        return Ok(());
    }
    let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
    {
        let port = shared
            .port
            .as_mut()
            .ok_or_else(|| "串口未连接".to_string())?;
        if let Some(level) = dtr {
            port.write_data_terminal_ready(level)
                .map_err(|e| format!("设置 DTR 失败: {e}"))?;
        }
        if let Some(level) = rts {
            port.write_request_to_send(level)
                .map_err(|e| format!("设置 RTS 失败: {e}"))?;
        }
    }
    // 端口借用结束之后再记：记下来的是"用户要过的电平"，重开/重连时由它复施加
    if dtr.is_some() {
        shared.dtr = dtr;
    }
    if rts.is_some() {
        shared.rts = rts;
    }
    Ok(())
}

/// 四条只读 modem 线。读不到的一律 `None`：界面必须能画出"未知"这个第三态，
/// 不能拿"低电平"糊过去（虚拟串口与部分 CH340 驱动根本不支持读 modem 线）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModemLines {
    pub cts: Option<bool>,
    pub dsr: Option<bool>,
    pub ri: Option<bool>,
    pub dcd: Option<bool>,
}

#[tauri::command]
pub async fn read_modem_lines(state: State<'_, SerialManager>) -> Result<ModemLines, String> {
    let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
    let port = shared
        .port
        .as_mut()
        .ok_or_else(|| "串口未连接".to_string())?;
    // 一次锁内读完四条：分四次取锁就是和读线程抢四次（读线程每轮最多持锁 50ms，即读超时）
    let ok = |r: Result<bool, serialport::Error>| r.ok();
    Ok(ModemLines {
        cts: ok(port.read_clear_to_send()),
        dsr: ok(port.read_data_set_ready()),
        ri: ok(port.read_ring_indicator()),
        dcd: ok(port.read_carrier_detect()),
    })
}

/// 同一时刻只允许一条 Break 在飞：两条的 `clear_break` 会随各自的 sleep 交错，
/// 谁先释放变成随机 —— 那不是"快一点"，那是不可复现的行为。
static BREAK_BUSY: AtomicBool = AtomicBool::new(false);

struct BreakGuard;

impl Drop for BreakGuard {
    fn drop(&mut self) {
        BREAK_BUSY.store(false, Ordering::SeqCst);
    }
}

/// `ms` 省略时用 [`BREAK_DEFAULT_MS`]：默认值只有这一处，前端不再抄一份。
#[tauri::command]
pub async fn send_break(ms: Option<u32>, state: State<'_, SerialManager>) -> Result<(), String> {
    // 与 open_port 同一条互斥口径：回放期间不碰真实接口
    if crate::session::is_playing() {
        return Err("回放进行中，无法发送 Break".into());
    }
    let dur = clamp_break_ms(ms.unwrap_or(BREAK_DEFAULT_MS));
    if BREAK_BUSY.swap(true, Ordering::SeqCst) {
        return Err("上一条 Break 还在进行".into());
    }
    let _guard = BreakGuard; // 任何返回路径（含错误）都要放行下一把
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        let port = shared
            .port
            .as_mut()
            .ok_or_else(|| "串口未连接".to_string())?;
        port.set_break().map_err(|e| format!("发送 Break 失败: {e}"))?;
    }
    // 关键：等待期间**不持锁**。持锁 sleep 等于把 RX 停摆这么多毫秒 —— 读线程抢不到锁，
    // 用户点一下 Break 就丢一段数据，那是这条命令最坏的写法。
    tokio::time::sleep(Duration::from_millis(dur as u64)).await;
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        // 中途串口被关掉：线已随句柄释放，静默返回。报"发送失败"是假错。
        if let Some(port) = shared.port.as_mut() {
            let _ = port.clear_break();
        }
    }
    Ok(())
}

#[cfg(test)]
mod control_line_tests {
    use super::{clamp_break_ms, BREAK_DEFAULT_MS, BREAK_MAX_MS, BREAK_MIN_MS};

    #[test]
    fn break_duration_is_clamped_not_rejected() {
        assert_eq!(clamp_break_ms(0), BREAK_MIN_MS, "0 要钳到下限，不能真的按住 0ms");
        assert_eq!(clamp_break_ms(BREAK_DEFAULT_MS), BREAK_DEFAULT_MS);
        assert_eq!(clamp_break_ms(BREAK_MAX_MS), BREAK_MAX_MS);
        assert_eq!(clamp_break_ms(BREAK_MAX_MS + 9000), BREAK_MAX_MS, "越界要钳住，不能放行");
        assert_eq!(clamp_break_ms(u32::MAX), BREAK_MAX_MS);
    }

    #[test]
    fn default_break_covers_one_frame_at_9600() {
        // 9600 8N1 一帧 = 10bit ≈ 1.04ms；默认值要明显大于一帧，否则设备认不出是中断
        assert!(BREAK_DEFAULT_MS >= 10, "默认 Break 短于一帧量级就没意义");
        assert!(BREAK_DEFAULT_MS <= 50, "默认值不该长到会吞掉后续帧");
    }
}

pub fn start_hotplug(app: AppHandle) {
    thread::spawn(move || {
        let mut last: Vec<String> = Vec::new();
        loop {
            thread::sleep(Duration::from_millis(HOTPLUG_POLL_MS));
            let infos = list_infos();
            let mut names: Vec<String> = infos.iter().map(|p| p.name.clone()).collect();
            names.sort();
            if names != last {
                last = names;
                let _ = app.emit("serial:ports-changed", infos);
            }
        }
    });
}

fn config_port_name(shared: &Arc<Mutex<Shared>>) -> Option<String> {
    shared
        .lock()
        .ok()
        .and_then(|g| g.config.as_ref().map(|c| c.port.clone()))
}

#[allow(clippy::too_many_arguments)]
fn spawn_read_thread(
    app: AppHandle,
    shared: Arc<Mutex<Shared>>,
    ctx: Arc<IngestCtx>,
    run_flag: Arc<AtomicBool>,
    reconnect_flag: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
) {
    thread::spawn(move || {
        let mut buf = [0u8; READ_BUF_SIZE];
        let mut pending: Vec<u8> = Vec::with_capacity(EMIT_MAX_BYTES);
        let mut last_emit = Instant::now();
        // 拔线守护：部分驱动（CH340/CP210x 某些状态）在设备移除后 read
        // 永远返回 Ok(0)/超时而不报错 → 永远走不到重连分支，界面停在
        // “已连接”且无数据。持续无数据时主动核对端口是否仍在系统中。
        let mut last_rx = Instant::now();

        loop {
            if !run_flag.load(Ordering::SeqCst) || epoch.load(Ordering::SeqCst) != my_epoch {
                break;
            }

            let read_result = {
                let mut guard = match shared.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                match guard.port.as_mut() {
                    Some(port) => port.read(&mut buf),
                    None => break,
                }
            };

            match read_result {
                // 个别驱动拔线后立即返回 Ok(0)：睡 1ms 防忙转吃满 CPU
                Ok(0) => {
                    thread::sleep(Duration::from_millis(1));
                }
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    last_rx = Instant::now();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => {
                    {
                        let mut guard = match shared.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        guard.port = None;
                    }
                    if !reconnect_flag.load(Ordering::SeqCst)
                        || epoch.load(Ordering::SeqCst) != my_epoch
                    {
                        break;
                    }
                    emit_state(&app, "reconnecting", config_port_name(&shared), None);
                    if !try_reconnect(
                        &shared,
                        &reconnect_flag,
                        &run_flag,
                        &epoch,
                        my_epoch,
                    ) {
                        break;
                    }
                    emit_state(&app, "connected", config_port_name(&shared), None);
                    pending.clear();
                    last_emit = Instant::now();
                    last_rx = Instant::now();
                    continue;
                }
            }

            // 拔线检测：2s 无数据时核对端口存在性（枚举失败不判定断开，避免误杀）
            if last_rx.elapsed() >= Duration::from_millis(2000) {
                last_rx = Instant::now();
                let port_gone = match config_port_name(&shared) {
                    Some(name) => match serialport::available_ports() {
                        Ok(ports) => !ports.iter().any(|p| p.port_name == name),
                        Err(_) => false,
                    },
                    None => false,
                };
                if port_gone {
                    {
                        let mut guard = match shared.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        guard.port = None;
                    }
                    if !reconnect_flag.load(Ordering::SeqCst)
                        || epoch.load(Ordering::SeqCst) != my_epoch
                    {
                        break;
                    }
                    emit_state(
                        &app,
                        "reconnecting",
                        config_port_name(&shared),
                        Some("串口设备已移除，等待重新接入…".into()),
                    );
                    if !try_reconnect(
                        &shared,
                        &reconnect_flag,
                        &run_flag,
                        &epoch,
                        my_epoch,
                    ) {
                        break;
                    }
                    emit_state(&app, "connected", config_port_name(&shared), None);
                    pending.clear();
                    last_emit = Instant::now();
                    last_rx = Instant::now();
                    continue;
                }
            }

            if !pending.is_empty()
                && (pending.len() >= EMIT_MAX_BYTES
                    || last_emit.elapsed() >= Duration::from_millis(EMIT_INTERVAL_MS))
            {
                ingest(&ctx, &app, &pending);
                pending = Vec::with_capacity(EMIT_MAX_BYTES);
                last_emit = Instant::now();
            }
        }
    });
}

fn try_reconnect(
    shared: &Arc<Mutex<Shared>>,
    reconnect_flag: &AtomicBool,
    run_flag: &AtomicBool,
    epoch: &AtomicU64,
    my_epoch: u64,
) -> bool {
    let config = match shared.lock().ok().and_then(|g| g.config.clone()) {
        Some(c) => c,
        None => return false,
    };
    while reconnect_flag.load(Ordering::SeqCst)
        && run_flag.load(Ordering::SeqCst)
        && epoch.load(Ordering::SeqCst) == my_epoch
    {
        let present = serialport::available_ports()
            .map(|ports| ports.iter().any(|p| p.port_name == config.port))
            .unwrap_or(false);
        if present {
            if let Ok(mut port) = open_with(&config) {
                if epoch.load(Ordering::SeqCst) != my_epoch {
                    drop(port);
                    return false;
                }
                let (dtr, rts) = shared.lock().map(|g| (g.dtr, g.rts)).unwrap_or((None, None));
                apply_control_lines(&mut port, dtr, rts);
                if let Ok(mut guard) = shared.lock() {
                    guard.port = Some(port);
                }
                return true;
            }
        }
        thread::sleep(Duration::from_millis(RECONNECT_POLL_MS));
    }
    false
}
