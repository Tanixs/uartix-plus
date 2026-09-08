//! BLE 接口（central 主机角色）：扫描 → 连接 → notify 收数 → write 发送
//!
//! 数据流与 net.rs 完全同源：notification → `net::Batcher`(33ms/16KB) →
//! `pipeline::ingest` 单点；状态复用 `serial:state`，TX 复用 binbus `send_tx`
//! ——前端除接口栏外零改动。btleplug async API 跑在 `tauri::async_runtime`(tokio)。
//!
//! **Adapter 常驻**：WinRT 的设备缓存挂在 Adapter 实例上（扫描发现的设备只有
//! 同一 Adapter 的 `peripherals()` 能看到），因此 Manager/Adapter 惰性初始化一次
//! 存进 BleManager，扫描与连接共用。tokio Mutex 允许跨 await 持锁。

use btleplug::api::{
    CharPropFlags, Central, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures_util::StreamExt;
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use crate::net::Batcher;
use crate::pipeline::IngestCtx;
use crate::serial::{emit_state, now_ms};

/// Nordic UART Service 特征：RX=写（6e400002）、TX=通知（6e400003）
/// ——BLE 透传模块（nRF52/ESP32/NUS 类固件）事实标准
const NUS_RX: Uuid = Uuid::from_u128(0x6e400002_b5a3_f393_e0a9_e50e24dcca9e);
const NUS_TX: Uuid = Uuid::from_u128(0x6e400003_b5a3_f393_e0a9_e50e24dcca9e);

/// 写入分块：BLE 4.0 默认 ATT_MTU=23（单包净载 20B）兼容底线；
/// 协商了大 MTU 的设备也接受 20B 小包，兼容性优先
const WRITE_CHUNK: usize = 20;
const SCAN_POLL_MS: u64 = 1000;
/// 通知流静默超时：到点 flush 积压 + 检查连接存活
const NOTIFY_IDLE_MS: u64 = 20;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BleDeviceInfo {
    /// BDAddr 文本 "AA:BB:CC:DD:EE:FF"，作为设备唯一标识
    pub id: String,
    /// 广播名（可为空串——前端显示地址兜底）
    pub name: String,
    pub rssi: i16,
}

struct BleShared {
    peripheral: Option<Peripheral>,
    write_char: Option<btleplug::api::Characteristic>,
    write_type: WriteType,
}

pub struct BleManager {
    pub ctx: Arc<IngestCtx>,
    /// 常驻适配器（惰性初始化，扫描/连接共用——见模块注释）
    adapter: AsyncMutex<Option<Arc<Adapter>>>,
    shared: Arc<Mutex<BleShared>>,
    run_flag: Arc<AtomicBool>,
    scan_flag: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
}

impl BleManager {
    pub fn new(ctx: Arc<IngestCtx>) -> Self {
        Self {
            ctx,
            adapter: AsyncMutex::new(None),
            shared: Arc::new(Mutex::new(BleShared {
                peripheral: None,
                write_char: None,
                write_type: WriteType::WithoutResponse,
            })),
            run_flag: Arc::new(AtomicBool::new(false)),
            scan_flag: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    async fn adapter(&self) -> Result<Arc<Adapter>, String> {
        let mut g = self.adapter.lock().await;
        if g.is_none() {
            let manager = Manager::new()
                .await
                .map_err(|e| format!("蓝牙初始化失败: {e}"))?;
            let adapters = manager
                .adapters()
                .await
                .map_err(|e| format!("枚举蓝牙适配器失败: {e}"))?;
            let a = adapters
                .into_iter()
                .next()
                .ok_or("未找到蓝牙适配器，请确认本机蓝牙已开启")?;
            *g = Some(Arc::new(a));
        }
        Ok(g.as_ref().unwrap().clone())
    }
}

/// 通道选择（纯函数，可单测）：优先 Nordic UART（写 6e400002 + 通知 6e400003），
/// 否则首个「可写」特征 + 首个「可通知」特征；返回 (写特征, 写类型, 通知特征)
fn pick_chars(
    chars: &BTreeSet<btleplug::api::Characteristic>,
) -> Option<(btleplug::api::Characteristic, WriteType, btleplug::api::Characteristic)> {
    let can_write =
        |c: &btleplug::api::Characteristic| c.properties.intersects(CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE);
    let can_notify = |c: &btleplug::api::Characteristic| c.properties.intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE);
    let nus_w = chars.iter().find(|c| c.uuid == NUS_RX && can_write(c));
    let nus_n = chars.iter().find(|c| c.uuid == NUS_TX && can_notify(c));
    if let (Some(w), Some(n)) = (nus_w, nus_n) {
        return Some((
            w.clone(),
            WriteType::WithoutResponse,
            n.clone(),
        ));
    }
    let w = chars.iter().find(|c| can_write(c))?;
    let n = chars.iter().find(|c| can_notify(c))?;
    let wt = if c_write_wo_resp(w) {
        WriteType::WithoutResponse
    } else {
        WriteType::WithResponse
    };
    Some((w.clone(), wt, n.clone()))
}

fn c_write_wo_resp(c: &btleplug::api::Characteristic) -> bool {
    c.properties.contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
}

#[tauri::command]
pub async fn ble_scan_start(
    app: AppHandle,
    state: tauri::State<'_, BleManager>,
) -> Result<(), String> {
    if state.run_flag.load(Ordering::SeqCst) {
        return Err("BLE 设备已连接，断开后才能重新扫描".into());
    }
    if state.scan_flag.swap(true, Ordering::SeqCst) {
        return Ok(()); // 已在扫描中
    }
    let adapter = state.adapter().await?;
    let scan_flag = state.scan_flag.clone();
    let run_flag = state.run_flag.clone();
    tauri::async_runtime::spawn(async move {
        // 扫描失败不影响 scan_flag 复位（循环自然退出）
        let _ = adapter.start_scan(ScanFilter::default()).await;
        while scan_flag.load(Ordering::SeqCst) && !run_flag.load(Ordering::SeqCst) {
            let mut devs: Vec<BleDeviceInfo> = Vec::new();
            if let Ok(peripherals) = adapter.peripherals().await {
                for p in peripherals {
                    if let Ok(Some(props)) = p.properties().await {
                        devs.push(BleDeviceInfo {
                            id: props.address.to_string(),
                            name: props.local_name.unwrap_or_default(),
                            rssi: props.rssi.unwrap_or(i16::MIN),
                        });
                    }
                }
            }
            // 强信号优先；同名设备多份广播按 id 去重（保留最强 RSSI——已按 rssi 排序）
            devs.sort_by(|a, b| b.rssi.cmp(&a.rssi));
            devs.dedup_by(|a, b| a.id == b.id);
            let _ = app.emit("ble:devices", &devs);
            tokio::time::sleep(Duration::from_millis(SCAN_POLL_MS)).await;
        }
        let _ = adapter.stop_scan().await;
    });
    Ok(())
}

#[tauri::command]
pub async fn ble_scan_stop(state: tauri::State<'_, BleManager>) -> Result<(), String> {
    state.scan_flag.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn ble_connect(
    id: String,
    app: AppHandle,
    state: tauri::State<'_, BleManager>,
) -> Result<(), String> {
    // 回放与真实连接互斥：回放进行中禁止连接 BLE（避免双源混淆）
    if crate::session::is_playing() {
        return Err("回放进行中，请先停止回放再连接 BLE 设备".into());
    }
    if state.run_flag.load(Ordering::SeqCst) {
        return Err("BLE 设备已连接，请先断开当前连接".into());
    }
    let adapter = state.adapter().await?;
    state.scan_flag.store(false, Ordering::SeqCst); // 连接时停扫描
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.run_flag.store(true, Ordering::SeqCst);
    let my_epoch = state.epoch.load(Ordering::SeqCst);

    let ctx = state.ctx.clone();
    let shared = state.shared.clone();
    let run_flag = state.run_flag.clone();
    let epoch = state.epoch.clone();
    let app = app.clone();
    let id2 = id.clone();

    tauri::async_runtime::spawn(async move {
        let alive =
            || run_flag.load(Ordering::SeqCst) && epoch.load(Ordering::SeqCst) == my_epoch;
        let bail = |app: &AppHandle, msg: String| {
            run_flag.store(false, Ordering::SeqCst);
            emit_state(app, "disconnected", None, Some(msg));
        };

        // 在常驻适配器的已知设备里找目标（必须先扫描发现）
        let mut target: Option<Peripheral> = None;
        if let Ok(ps) = adapter.peripherals().await {
            for p in ps {
                if p.address().to_string() == id2 {
                    target = Some(p);
                    break;
                }
            }
        }
        let peripheral = match target {
            Some(p) => p,
            None => {
                if alive() {
                    bail(&app, "未找到该设备，请先扫描发现后再连接".into());
                }
                return;
            }
        };
        emit_state(&app, "reconnecting", Some(id2.clone()), Some("正在连接…".into()));

        if let Err(e) = peripheral.connect().await {
            if alive() {
                bail(&app, format!("连接失败: {e}"));
            }
            return;
        }
        if let Err(e) = peripheral.discover_services().await {
            if alive() {
                bail(&app, format!("服务发现失败: {e}"));
            }
            return;
        }
        let chars = peripheral.characteristics();
        let picked = match pick_chars(&chars) {
            Some(p) => p,
            None => {
                if alive() {
                    bail(&app, "未发现可写+可通知的特征对，设备不支持透传".into());
                }
                return;
            }
        };
        let (wchar, wtype, nchar) = picked;
        if let Err(e) = peripheral.subscribe(&nchar).await {
            if alive() {
                bail(&app, format!("订阅通知失败: {e}"));
            }
            return;
        }

        // 就绪：登记发送通道 + 广播 connected
        {
            let mut g = match shared.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            g.peripheral = Some(peripheral.clone());
            g.write_char = Some(wchar);
            g.write_type = wtype;
        }
        let props = peripheral.properties().await.ok().flatten();
        let name = props
            .as_ref()
            .and_then(|p| p.local_name.clone())
            .unwrap_or_default();
        let desc = if name.is_empty() {
            id2.clone()
        } else {
            format!("{name} ({id2})")
        };
        if !alive() {
            return;
        }
        emit_state(&app, "connected", Some(desc.clone()), None);

        // 通知流：到点 flush（20ms 静默）+ 存活检查；stream 结束 = 断连
        let mut notif = match peripheral.notifications().await {
            Ok(n) => n,
            Err(e) => {
                if alive() {
                    bail(&app, format!("通知流创建失败: {e}"));
                }
                return;
            }
        };
        let mut batcher = Batcher::new();
        loop {
            if !alive() {
                break;
            }
            match tokio::time::timeout(Duration::from_millis(NOTIFY_IDLE_MS), notif.next()).await {
                Ok(Some(v)) => batcher.push(&ctx, &app, &v.value),
                Ok(None) => {
                    // 通知流关闭：设备断开
                    break;
                }
                Err(_) => {
                    // 静默超时：flush 积压；顺带确认连接还在（WinRT 断连不一定关流）
                    batcher.flush(&ctx, &app);
                    if !alive() {
                        break;
                    }
                    if !peripheral.is_connected().await.unwrap_or(false) {
                        break;
                    }
                    continue;
                }
            }
            if !alive() {
                break;
            }
        }
        batcher.flush(&ctx, &app);
        {
            if let Ok(mut g) = shared.lock() {
                g.peripheral = None;
                g.write_char = None;
            }
        }
        if !alive() {
            return; // 主动断开：ble_disconnect 已发 disconnected，避免重复
        }
        run_flag.store(false, Ordering::SeqCst);
        emit_state(
            &app,
            "disconnected",
            None,
            Some(format!("{desc} 连接已断开")),
        );
    });
    // 任务异步执行；成败经由 serial:state 体现
    Ok(())
}

#[tauri::command]
pub async fn ble_disconnect(
    app: AppHandle,
    state: tauri::State<'_, BleManager>,
) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst); // 使所有后台任务失效
    state.run_flag.store(false, Ordering::SeqCst);
    state.scan_flag.store(false, Ordering::SeqCst);
    let peripheral = {
        let mut g = state.shared.lock().map_err(|_| "状态锁中毒")?;
        g.write_char = None;
        g.peripheral.take()
    };
    if let Some(p) = peripheral {
        // 通知流任务随 epoch 失效自行退出；这里主动断物理连接
        let _ = p.disconnect().await;
    }
    emit_state(&app, "disconnected", None, None);
    Ok(())
}

/// 发送路由：BLE 已连接则分块写入并返回 true；未连接返回 false（交回下一路由）
pub async fn try_send(state: &BleManager, bytes: &[u8]) -> Result<bool, String> {
    if !state.run_flag.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let (peripheral, wchar, wtype) = {
        let g = state.shared.lock().map_err(|_| "状态锁中毒")?;
        match (g.peripheral.as_ref(), g.write_char.as_ref()) {
            (Some(p), Some(c)) => (p.clone(), c.clone(), g.write_type),
            _ => return Err("BLE 通道尚未就绪，稍候再试".into()),
        }
    };
    for chunk in bytes.chunks(WRITE_CHUNK) {
        peripheral
            .write(&wchar, chunk, wtype)
            .await
            .map_err(|e| format!("BLE 发送失败: {e}"))?;
    }
    Ok(true)
}

/// 发送完成后由 send_data 调用：广播 serial:tx（前端计数走 binbus）
pub fn notify_tx(app: &AppHandle, bytes: &[u8]) {
    crate::busevt::send_tx(app, now_ms(), bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use btleplug::api::Characteristic;

    fn ch(uuid: &str, props: CharPropFlags) -> Characteristic {
        Characteristic {
            uuid: Uuid::parse_str(uuid).unwrap(),
            service_uuid: Uuid::parse_str("00001800-0000-1000-8000-00805f9b34fb").unwrap(),
            properties: props,
            descriptors: BTreeSet::new(),
        }
    }

    const NUS_SVC: &str = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";

    #[test]
    fn pick_chars_prefers_nordic_uart() {
        let mut chars = BTreeSet::new();
        chars.insert(ch("0000ffe1-0000-1000-8000-00805f9b34fb", CharPropFlags::NOTIFY | CharPropFlags::WRITE));
        chars.insert(ch("6e400002-b5a3-f393-e0a9-e50e24dcca9e", CharPropFlags::WRITE_WITHOUT_RESPONSE));
        chars.insert(ch("6e400003-b5a3-f393-e0a9-e50e24dcca9e", CharPropFlags::NOTIFY));
        let (w, wt, n) = pick_chars(&chars).unwrap();
        assert_eq!(w.uuid, NUS_RX);
        assert_eq!(n.uuid, NUS_TX);
        assert_eq!(wt, WriteType::WithoutResponse);
        let _ = NUS_SVC;
    }

    #[test]
    fn pick_chars_falls_back_to_generic_pair() {
        let mut chars = BTreeSet::new();
        chars.insert(ch("0000ffe1-0000-1000-8000-00805f9b34fb", CharPropFlags::NOTIFY));
        chars.insert(ch("0000ffe2-0000-1000-8000-00805f9b34fb", CharPropFlags::WRITE));
        let (w, wt, n) = pick_chars(&chars).unwrap();
        assert_eq!(w.uuid.to_string(), "0000ffe2-0000-1000-8000-00805f9b34fb");
        assert_eq!(n.uuid.to_string(), "0000ffe1-0000-1000-8000-00805f9b34fb");
        // 只有 WRITE（无 WRITE_WITHOUT_RESPONSE）→ WithResponse
        assert_eq!(wt, WriteType::WithResponse);
    }

    #[test]
    fn pick_chars_needs_both_sides() {
        let mut chars = BTreeSet::new();
        chars.insert(ch("0000ffe1-0000-1000-8000-00805f9b34fb", CharPropFlags::NOTIFY));
        assert!(pick_chars(&chars).is_none());
    }
}
