use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, StopBits};
use std::collections::HashMap;
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
    /// P107：`none` / `software`(XON/XOFF) / `hardware`(RTS/CTS)。
    /// 给默认值是因为这个结构体在 **IPC 边界上**：边界上的新字段不给默认值，
    /// 就等于"两侧版本没对齐 ⇒ 连接直接报 missing field"。
    /// ⚠ P115-F13 起 TS 侧把这份配置落盘到 localStorage（带枚举/钳制清洗），但 Rust 侧
    /// 仍不读任何存档——这个默认值防的是未来的第二个生产者（MCP/插件代发），
    /// 不是一个现存的老存档 bug —— 别把它写成"修好了升级即坏"。
    #[serde(default = "default_flow")]
    pub flow: String,
}

fn default_flow() -> String {
    "none".to_string()
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

/// 一对控制线的记忆（P115-F12 起按端口名分档存放，见 `Shared::ctrl`）。
#[derive(Clone, Copy, Default, PartialEq, Debug)]
struct CtrlLines {
    dtr: Option<bool>,
    rts: Option<bool>,
}

impl CtrlLines {
    /// 只收 Some 的那条（与 set_control_lines 的口径一致：没点过的不覆盖）。
    fn merge(&mut self, dtr: Option<bool>, rts: Option<bool>) {
        if dtr.is_some() {
            self.dtr = dtr;
        }
        if rts.is_some() {
            self.rts = rts;
        }
    }
}

/// 取某个端口名下的记忆；没碰过的口 = (None, None) = 打开时完全不碰线。
fn remembered_for(map: &HashMap<String, CtrlLines>, port: &str) -> CtrlLines {
    map.get(port).copied().unwrap_or_default()
}

struct Shared {
    port: Option<Box<dyn serialport::SerialPort>>,
    config: Option<SerialConfig>,
    /// P106：用户**显式**要过的电平（`None` = 从没碰过）。
    /// 记在 Rust 侧而不是只记在前端：重连/重开是在这条读线程里发生的，
    /// 等前端看到"已连接"再补一刀，中间那几百毫秒线是悬的 —— 板子就是在这时候被踢进 bootloader 的。
    /// P115-F12：**按端口名分档**。整表一份的记忆会把 COM3 要过的电平在打开 COM4 时
    /// 复施加过去——板子进不进 bootloader 是按端口发生的事，记忆也必须按端口存。
    /// 仍是进程级、不落盘。
    ctrl: HashMap<String, CtrlLines>,
}

/// 把记下来的目标电平施加到端口上：尽力而为，失败不改记忆（下次重开还会再试）。
///
/// `flow` 不是装饰：**硬件流控之下 RTS 归驱动**（Windows `fRtsControl=Enable` + `fOutxCtsFlow`，
/// POSIX `CRTSCTS`）。这时再施加一次用户记过的电平，就是让 P106 的记忆去和驱动抢同一根线 ——
/// `write_request_to_send` 会返回 Ok，线随后被驱动拖回去，界面上什么错都没有。所以这里直接让路。
/// DTR 三档都不被流控接管，照旧施加。
fn apply_control_lines(
    port: &mut Box<dyn serialport::SerialPort>,
    dtr: Option<bool>,
    rts: Option<bool>,
    flow: FlowControl,
) {
    if let Some(level) = dtr {
        let _ = port.write_data_terminal_ready(level);
    }
    let rts = if matches!(flow, FlowControl::Hardware) {
        None
    } else {
        rts
    };
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
                ctrl: HashMap::new(),
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

/// P107 数据流控档位。口径与 `parse_parity` 一致：**非法值报错，不静默退回 `none`** ——
/// 用户以为开了 RTS/CTS 而实际没开，后果是安静地丢字节，那比打不开端口更难查。
fn parse_flow(s: &str) -> Result<FlowControl, String> {
    match s {
        "none" => Ok(FlowControl::None),
        "software" => Ok(FlowControl::Software),
        "hardware" => Ok(FlowControl::Hardware),
        other => Err(format!("不支持的数据流控: {other}")),
    }
}

/// 打开端口。返回里带上**生效的**流控档位：`apply_control_lines` 要据此决定 RTS 让不让路，
/// 而自己再 `parse_flow` 一遍就是第二个真相（两处解析早晚会分叉）。
fn open_with(config: &SerialConfig) -> Result<(Box<dyn serialport::SerialPort>, FlowControl), String> {
    let flow = parse_flow(&config.flow)?;
    let port = serialport::new(&config.port, config.baud)
        .data_bits(match config.data_bits {
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(parse_parity(&config.parity)?)
        .stop_bits(match config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        })
        .flow_control(flow)
        .timeout(Duration::from_millis(50))
        .open()
        .map_err(|e| format!("打开 {} 失败: {e}", config.port))?;
    Ok((port, flow))
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
    let (mut port, flow) = tauri::async_runtime::spawn_blocking(move || open_with(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        // 先施加"用户在这个口名下显式要过的电平"（没要过 = 完全不碰线，这是默认）。
        // P115-F12：按 config.port 取记忆——别的口要过的电平绝不施加到这个口上。
        let mem = remembered_for(&shared.ctrl, &config.port);
        apply_control_lines(&mut port, mem.dtr, mem.rts, flow);
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
 * 详设：docs/designs/P106-串口控制线-详设.md
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
    // 端口借用结束之后再记：记下来的是"用户要过的电平"，重开/重连时由它复施加。
    // P115-F12：记到当前打开的端口名下（config 与 port 同锁同写，这里必有）。
    if dtr.is_some() || rts.is_some() {
        if let Some(name) = shared.config.as_ref().map(|c| c.port.clone()) {
            shared.ctrl.entry(name).or_default().merge(dtr, rts);
        }
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

#[cfg(test)]
mod flow_tests {
    use super::{parse_flow, FlowControl, SerialConfig};

    /// 边界上的新字段必须带默认值。TS 侧 P115-F13 起把配置落盘（带清洗），但 Rust 侧
    /// 不读任何存档——这条防的是**两侧版本没对齐**：少一个键就报 `missing field flow`，
    /// 用户的现场表现是"点连接直接红字、连不上"。
    #[test]
    fn config_without_flow_key_still_deserializes() {
        let cfg: SerialConfig = serde_json::from_str(
            r#"{"port":"COM3","baud":115200,"dataBits":8,"parity":"none","stopBits":1}"#,
        )
        .expect("缺 flow 键的旧形状配置必须能反序列化");
        assert_eq!(cfg.flow, "none", "缺键要落到\"不开流控\"，不能落到硬件流控");
    }

    #[test]
    fn flow_names_match_the_ts_side() {
        // 这三枚字面量是与 TS `FlowMode` 的**唯一**约定，改一边就得在这里红
        assert!(matches!(parse_flow("none"), Ok(FlowControl::None)));
        assert!(matches!(parse_flow("software"), Ok(FlowControl::Software)));
        assert!(matches!(parse_flow("hardware"), Ok(FlowControl::Hardware)));
    }

    #[test]
    fn unknown_flow_is_rejected_not_fallen_back() {
        // 静默退回 none = 用户以为开了 RTS/CTS，实际在丢字节，且没有任何地方报错
        let err = parse_flow("rts").unwrap_err();
        assert!(err.contains("数据流控"), "报错要说清是哪一项：{err}");
    }

    #[test]
    fn bad_flow_fails_before_touching_hardware() {
        // 不碰真机也能验：parse_flow 在 `.open()` 之前，所以端口名是假的也无所谓 ——
        // 报的必须是"不支持的数据流控"，而不是"打开不存在端口失败"。
        // （不用 unwrap_err：`dyn SerialPort` 没有 Debug，Ok 侧过不了它的约束。）
        let cfg = SerialConfig {
            port: "COM-不-存在".into(),
            baud: 115200,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow: "both".into(),
        };
        match super::open_with(&cfg) {
            Err(e) => assert!(e.contains("不支持的数据流控"), "{e}"),
            Ok(_) => panic!("非法流控档位不该被打开，更不能靠\"端口不存在\"蒙混过去"),
        }
    }
}

#[cfg(test)]
mod ctrl_memory_tests {
    use super::{remembered_for, CtrlLines};
    use std::collections::HashMap;

    /// P115-F12 的判据：控制线记忆按端口名隔离。
    /// 事故：记忆整表一份，给 COM3 设过的 DTR=高 会在**打开 COM4** 时被复施加——
    /// ESP32/STM32 的自动烧录电路恰好趴在 DTR+RTS 上，串了口的电平就是事故。
    #[test]
    fn control_line_memory_is_per_port() {
        let mut map: HashMap<String, CtrlLines> = HashMap::new();
        map.insert("COM3".into(), CtrlLines { dtr: Some(true), rts: Some(false) });

        // COM3 自己记得住
        let m3 = remembered_for(&map, "COM3");
        assert_eq!(m3.dtr, Some(true));
        assert_eq!(m3.rts, Some(false));
        // 别的口必须一个字都不记得——打开 COM4 时两条线都不许被碰
        let m4 = remembered_for(&map, "COM4");
        assert_eq!(m4, CtrlLines::default(), "记忆串了端口：COM3 的电平会被复施加到 COM4");
        assert_eq!(remembered_for(&map, ""), CtrlLines::default(), "连口名都没选时同样一条不碰");
    }

    /// merge 的口径与 set_control_lines 一致：只收 Some 的那条，没点过的不覆盖旧记忆。
    #[test]
    fn merge_updates_only_the_lines_the_user_touched() {
        let mut mem = CtrlLines::default();
        mem.merge(Some(true), None);
        assert_eq!(mem, CtrlLines { dtr: Some(true), rts: None });
        mem.merge(None, Some(false));
        assert_eq!(mem, CtrlLines { dtr: Some(true), rts: Some(false) });
        mem.merge(Some(false), None);
        assert_eq!(mem, CtrlLines { dtr: Some(false), rts: Some(false) }, "显式再点要能翻转");
        mem.merge(None, None);
        assert_eq!(mem, CtrlLines { dtr: Some(false), rts: Some(false) }, "两条 None 是空操作，不许清掉记忆");
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
            if let Ok((mut port, flow)) = open_with(&config) {
                if epoch.load(Ordering::SeqCst) != my_epoch {
                    drop(port);
                    return false;
                }
                // P115-F12：重连是"同一个口"，仍按口名取记忆（与 open_port 同一条口径）
                let mem = shared.lock().map(|g| remembered_for(&g.ctrl, &config.port)).unwrap_or_default();
                apply_control_lines(&mut port, mem.dtr, mem.rts, flow);
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
