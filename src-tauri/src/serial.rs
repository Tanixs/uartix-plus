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
}

pub struct SerialManager {
    pub ctx: Arc<IngestCtx>,
    shared: Arc<Mutex<Shared>>,
    run_flag: Arc<AtomicBool>,
    reconnect_flag: Arc<AtomicBool>,
    pub demo_flag: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    tx_total: Arc<AtomicU64>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            ctx: Arc::new(IngestCtx {
                pipeline: Arc::new(Pipeline::new()),
                record: Arc::new(Mutex::new(None)),
                rx_total: Arc::new(AtomicU64::new(0)),
            }),
            shared: Arc::new(Mutex::new(Shared {
                port: None,
                config: None,
            })),
            run_flag: Arc::new(AtomicBool::new(false)),
            reconnect_flag: Arc::new(AtomicBool::new(false)),
            demo_flag: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
            tx_total: Arc::new(AtomicU64::new(0)),
        }
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
    {
        let shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        if shared.port.is_some() {
            return Err("串口已打开，请先关闭当前连接".into());
        }
    }
    // 打开串口（驱动握手）可能阻塞，同样移出主线程
    let cfg = config.clone();
    let port = tauri::async_runtime::spawn_blocking(move || open_with(&cfg))
        .await
        .map_err(|e| e.to_string())??;
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
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
) -> Result<(), String> {
    let bytes = match mode.as_str() {
        "hex" => parse_hex(&text)?,
        _ => text.into_bytes(),
    };
    if bytes.is_empty() {
        return Err("发送内容为空".into());
    }
    // 网络接口已连接则优先走网络（串口路径不受影响）
    match crate::net::try_send(&net, &bytes) {
        Ok(true) => {
            crate::net::notify_tx(&app, &net, bytes);
            return Ok(());
        }
        Ok(false) => {}
        Err(e) => return Err(e),
    }
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        let port = shared.port.as_mut().ok_or("串口未连接")?;
        port.write_all(&bytes)
            .map_err(|e| format!("发送失败: {e}"))?;
        port.flush().map_err(|e| format!("发送失败: {e}"))?;
    }
    state.tx_total.fetch_add(bytes.len() as u64, Ordering::SeqCst);
    crate::busevt::send_tx(&app, now_ms(), &bytes);
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
            if let Ok(port) = open_with(&config) {
                if epoch.load(Ordering::SeqCst) != my_epoch {
                    drop(port);
                    return false;
                }
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
