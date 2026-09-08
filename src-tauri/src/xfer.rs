//! 文件传输：XMODEM / XMODEM-1K / YMODEM **发送方**（PC→设备，Bootloader 烧录场景）
//!
//! 集成点：
//! - TX 复用 `serial::route_send`（net → ble → serial，与控制台同一条路由）
//! - RX：传输激活期间 `pipeline::ingest` 头部 tap 把收到的字节喂给状态机
//!   （ACK/NAK/'C'/CAN 控制字节），且不再进解析/HexView/录制——Bootloader 模式下
//!   设备只回控制字节，吞掉避免污染帧管线、X-Ray 样本与会话录制
//! - 进度 10Hz `xfer:progress`，结束 `xfer:done`
//!
//! 协议要点（stop-and-wait，接收方驱动）：
//! - XMODEM 128B：SOH+idx+~idx+128B+校验（校验和=1B，CRC16=2B 大端）；末块补 0x1A；
//!   EOT 要发两次（第一次收 NAK、第二次收 ACK）
//! - XMODEM-1K：STX+1024B+CRC16，吞吐优先
//! - YMODEM：块 0 = 文件名\\0大小\\0（SOH-128，CRC16），数据块 STX-1K；结束后发
//!   全零块 0 结束批次；启动等待 'C'
//!
//! 队列共享：lib.rs manage **Arc\<XferManager\>**——ingest tap（ctx.xfer）与发送任务
//! （命令里 clone）指向同一实例。

use serde::Serialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::serial::SerialManager;

const SOH: u8 = 0x01;
const STX: u8 = 0x02;
const EOT: u8 = 0x04;
const ACK: u8 = 0x06;
const NAK: u8 = 0x15;
const CAN: u8 = 0x18;
const CHR_C: u8 = 0x43; // 'C'：接收方声明 CRC 模式 / YMODEM 就绪

const START_TIMEOUT: Duration = Duration::from_secs(60); // Bootloader 启动可能慢
const BYTE_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_RETRIES: u32 = 10;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum XferProto {
    /// XMODEM 128B：校验方式由启动字节决定（NAK=校验和 / 'C'=CRC16）
    Xmodem,
    /// XMODEM-1K：STX 1024B + CRC16
    Xmodem1k,
    /// YMODEM：块 0 批次头 + STX 1K 数据块 + 全零块 0 收尾
    Ymodem,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XferProgress {
    /// waiting | sending | done | error | aborted
    pub phase: String,
    pub block: u32,
    pub blocks: u32,
    pub bytes: u64,
    pub total: u64,
    pub retries: u32,
    /// B/s（整型，前端格式化）
    pub bps: u64,
    pub msg: String,
}

#[derive(Serialize, Clone)]
pub struct XferDone {
    pub ok: bool,
    pub msg: String,
}

pub struct XferManager {
    abort: AtomicBool,
    rx: Mutex<VecDeque<u8>>,
    notify: Arc<tokio::sync::Notify>,
}

/// 传输激活标志：ingest tap / 回放护栏的廉价检查（进程级单例语义）
static XFER_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_active() -> bool {
    XFER_ACTIVE.load(Ordering::SeqCst)
}

impl XferManager {
    pub fn new() -> Self {
        Self {
            abort: AtomicBool::new(false),
            rx: Mutex::new(VecDeque::new()),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    /// ingest tap：把控制字节塞进队列并唤醒等待方
    pub fn feed_rx(&self, data: &[u8]) {
        if let Ok(mut q) = self.rx.lock() {
            q.extend(data.iter().copied());
        }
        self.notify.notify_one();
    }

    fn drain_rx(&self) {
        if let Ok(mut q) = self.rx.lock() {
            q.clear();
        }
    }

    /// 取走取消标志（仅发送任务消费）
    fn take_abort(&self) -> bool {
        self.abort.swap(false, Ordering::SeqCst)
    }

    /// 等一个控制字节；deadline 到返回 None
    async fn wait_byte(&self, deadline: Instant) -> Option<u8> {
        loop {
            if let Ok(mut q) = self.rx.lock() {
                if let Some(b) = q.pop_front() {
                    return Some(b);
                }
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            // notify_one 在 push 后必达（permit 常驻），唤醒后再查队列，无竞态窗口
            match tokio::time::timeout(deadline - now, self.notify.notified()).await {
                Ok(()) => continue,
                Err(_) => return None,
            }
        }
    }
}

// ---------- 块构建（纯函数，可单测） ----------

/// XMODEM CRC16（CCITT，poly 0x1021，初值 0）
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// SOH + idx + !idx + 128B（补 0）+ 校验和或 CRC16（大端）
fn build_block(idx: u8, payload: &[u8], crc: bool) -> Vec<u8> {
    let mut blk = Vec::with_capacity(133);
    blk.push(SOH);
    blk.push(idx);
    blk.push(!idx);
    blk.extend_from_slice(payload);
    blk.resize(3 + 128, 0);
    if crc {
        let c = crc16_xmodem(&blk[3..]);
        blk.push((c >> 8) as u8);
        blk.push(c as u8);
    } else {
        let sum: u8 = blk[3..].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        blk.push(sum);
    }
    blk
}

/// STX + idx + !idx + 1024B + CRC16（大端）
fn build_block1k(idx: u8, payload: &[u8]) -> Vec<u8> {
    let mut blk = Vec::with_capacity(1029);
    blk.push(STX);
    blk.push(idx);
    blk.push(!idx);
    blk.extend_from_slice(payload);
    blk.resize(3 + 1024, 0);
    let c = crc16_xmodem(&blk[3..]);
    blk.push((c >> 8) as u8);
    blk.push(c as u8);
    blk
}

/// YMODEM 块 0：文件名\\0大小\\0，128B 填充 0
fn ymodem_header0(name: &str, size: u64) -> Vec<u8> {
    let mut hdr = format!("{name}\0{size}\0").into_bytes();
    hdr.resize(128, 0);
    hdr
}

// ---------- 状态机 ----------

/// 发一块并等确认。Ok(true)=ACK；Ok(false)=NAK/超时（重发）；Err=设备取消/发送路由错误
async fn send_and_wait_ack(
    app: &AppHandle,
    serial: &SerialManager,
    net: &crate::net::NetManager,
    ble: &crate::ble::BleManager,
    mgr: &XferManager,
    blk: &[u8],
) -> Result<bool, String> {
    crate::serial::route_send(app, serial, net, ble, blk).await?;
    loop {
        match mgr.wait_byte(Instant::now() + BYTE_TIMEOUT).await {
            Some(ACK) => return Ok(true),
            Some(NAK) | Some(CHR_C) => return Ok(false), // 迟到的 'C' 当 NAK 重发
            Some(CAN) => {
                if let Some(CAN) =
                    mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await
                {
                    return Err("设备已取消传输（CAN）".into());
                }
                return Ok(false);
            }
            Some(_) => continue, // 噪声字节忽略
            None => return Ok(false),
        }
    }
}

/// EOT：XMODEM/YMODEM 双 EOT 规则（第一次 NAK、第二次 ACK）
async fn send_eot(
    app: &AppHandle,
    serial: &SerialManager,
    net: &crate::net::NetManager,
    ble: &crate::ble::BleManager,
    mgr: &XferManager,
) -> Result<(), String> {
    let mut first = true;
    for _ in 0..MAX_RETRIES {
        crate::serial::route_send(app, serial, net, ble, &[EOT]).await?;
        match mgr.wait_byte(Instant::now() + BYTE_TIMEOUT).await {
            Some(NAK) => {
                if first {
                    first = false; // 第一轮 NAK 是协议规定动作，再发一次收 ACK
                } else {
                    continue; // 之后 NAK 重发 EOT
                }
            }
            Some(ACK) => return Ok(()),
            Some(CAN) => {
                if let Some(CAN) =
                    mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await
                {
                    return Err("设备已取消传输（CAN）".into());
                }
            }
            _ => {}
        }
    }
    Err("EOT 未被确认".into())
}

async fn run_sender(
    app: AppHandle,
    proto: XferProto,
    file_name: String,
    data: Vec<u8>,
    mgr: Arc<XferManager>,
) {
    let started = Instant::now();
    let total = data.len() as u64;
    let blocks = match proto {
        XferProto::Xmodem => total.div_ceil(128),
        _ => total.div_ceil(1024),
    } as u32
        + u32::from(proto == XferProto::Ymodem);

    let finish = |ok: bool, msg: String| {
        XFER_ACTIVE.store(false, Ordering::SeqCst);
        let _ = app.emit("xfer:done", XferDone { ok, msg });
    };

    let serial = app.state::<SerialManager>();
    let net = app.state::<crate::net::NetManager>();
    let ble = app.state::<crate::ble::BleManager>();

    let mut retries: u32 = 0;
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let mut emit_prog =
        |phase: &str, block: u32, bytes: u64, retries: u32, msg: &str, force: bool| {
            let now = Instant::now();
            if !force && now.duration_since(last_emit) < PROGRESS_INTERVAL {
                return;
            }
            last_emit = now;
            let _ = app.emit(
                "xfer:progress",
                XferProgress {
                    phase: phase.into(),
                    block,
                    blocks,
                    bytes,
                    total,
                    retries,
                    bps: (bytes as f64 / started.elapsed().as_secs_f64().max(1e-6)) as u64,
                    msg: msg.into(),
                },
            );
        };

    mgr.drain_rx();
    emit_prog("waiting", 0, 0, 0, "等待设备就绪…", true);

    // 启动：等 NAK（校验和模式）/ 'C'（CRC 模式）；YMODEM 只要 'C'
    let mut crc = true;
    let mut got_start = false;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if mgr.take_abort() {
            finish(false, "已取消".into());
            return;
        }
        match mgr.wait_byte(deadline).await {
            Some(NAK) if proto != XferProto::Ymodem => {
                crc = false;
                got_start = true;
                break;
            }
            Some(CHR_C) => {
                crc = true;
                got_start = true;
                break;
            }
            Some(CAN) => {
                if let Some(CAN) =
                    mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await
                {
                    finish(false, "设备已取消传输（CAN）".into());
                    return;
                }
            }
            Some(_) => {}
            None => break,
        }
    }
    if !got_start {
        finish(false, "设备未就绪（60s 内未收到 NAK/'C'，确认已进入 Bootloader）".into());
        return;
    }

    // YMODEM 块 0：文件名+大小 → ACK → 'C'
    if proto == XferProto::Ymodem {
        let blk = build_block(0, &ymodem_header0(&file_name, total), true);
        let mut confirmed0 = false;
        for _ in 0..MAX_RETRIES {
            if mgr.take_abort() {
                finish(false, "已取消".into());
                return;
            }
            match send_and_wait_ack(&app, &serial, &net, &ble, &mgr, &blk).await {
                Ok(true) => {
                    // ACK 后要等 'C' 才进数据块；没等到 → 重发块 0
                    if mgr.wait_byte(Instant::now() + BYTE_TIMEOUT).await == Some(CHR_C) {
                        confirmed0 = true;
                        break;
                    }
                    retries += 1;
                }
                Ok(false) => retries += 1,
                Err(e) => {
                    finish(false, e);
                    return;
                }
            }
        }
        if !confirmed0 {
            finish(false, "块 0 未被确认（文件名/大小未 ACK+'C'）".into());
            return;
        }
    }

    // 数据块
    let chunk_len = if proto == XferProto::Xmodem { 128 } else { 1024 };
    let mut idx: u8 = 0;
    for (ci, chunk) in data.chunks(chunk_len).enumerate() {
        idx = idx.wrapping_add(1);
        if idx == 0 {
            idx = 1; // 块号 0 保留，回绕跳过
        }
        let blk = match proto {
            XferProto::Xmodem => build_block(idx, chunk, crc),
            _ => build_block1k(idx, chunk),
        };
        let mut ok = false;
        let mut stop_msg: Option<String> = None;
        for _ in 0..=MAX_RETRIES {
            if mgr.take_abort() {
                stop_msg = Some("已取消".into());
                break;
            }
            match send_and_wait_ack(&app, &serial, &net, &ble, &mgr, &blk).await {
                Ok(true) => {
                    ok = true;
                    break;
                }
                Ok(false) => {
                    retries += 1;
                    let c = (ci * chunk_len).min(total as usize) as u64;
                    emit_prog("sending", ci as u32, c, retries, "重发中…", false);
                }
                Err(e) => {
                    stop_msg = Some(e);
                    break;
                }
            }
        }
        if !ok {
            let msg = stop_msg
                .unwrap_or_else(|| format!("块 {idx} 重试 {MAX_RETRIES} 次仍失败"));
            let phase = if msg == "已取消" { "aborted" } else { "error" };
            let c = (ci * chunk_len).min(total as usize) as u64;
            emit_prog(phase, ci as u32, c, retries, &msg, true);
            finish(false, msg);
            return;
        }
        let c = ((ci + 1) * chunk_len).min(total as usize) as u64;
        emit_prog("sending", (ci + 1) as u32, c, retries, "", false);
    }

    // EOT（XMODEM/YMODEM 同规则）
    if let Err(e) = send_eot(&app, &serial, &net, &ble, &mgr).await {
        emit_prog("error", blocks, total, retries, &e, true);
        finish(false, e);
        return;
    }

    // YMODEM 批次收尾：全零块 0 → ACK（未确认不影响文件本身，按成功收尾）
    if proto == XferProto::Ymodem {
        let blk = build_block(0, &[0u8; 128], true);
        let mut end_ok = false;
        for _ in 0..MAX_RETRIES {
            if mgr.take_abort() {
                break;
            }
            match send_and_wait_ack(&app, &serial, &net, &ble, &mgr, &blk).await {
                Ok(true) => {
                    end_ok = true;
                    break;
                }
                Ok(false) => continue,
                Err(_) => break,
            }
        }
        let tail = if end_ok {
            String::new()
        } else {
            "（批次结束块未确认，文件本身已传完）".to_string()
        };
        emit_prog("done", blocks, total, retries, "传输完成", true);
        finish(true, format!("传输完成：{file_name}（{retries} 次重试）{tail}"));
        return;
    }

    emit_prog("done", blocks, total, retries, "传输完成", true);
    finish(true, format!("传输完成：{file_name}（{retries} 次重试）"));
}

// ---------- 命令 ----------

#[tauri::command]
pub async fn xfer_start(
    proto: String,
    path: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<XferManager>>,
) -> Result<(), String> {
    if is_active() {
        return Err("已有文件传输在进行中".into());
    }
    if crate::session::is_playing() {
        return Err("回放进行中，请先停止回放再传输".into());
    }
    let kind = match proto.as_str() {
        "xmodem" => XferProto::Xmodem,
        "xmodem1k" => XferProto::Xmodem1k,
        "ymodem" => XferProto::Ymodem,
        _ => return Err(format!("未知传输协议: {proto}")),
    };
    // 连接预检：三个接口都没接管 → 提示先连接
    let serial_ok = app.state::<SerialManager>().is_open();
    let net_ok = crate::net::is_connected(&app.state::<crate::net::NetManager>());
    let ble_ok = app.state::<crate::ble::BleManager>().is_connected();
    if !serial_ok && !net_ok && !ble_ok {
        return Err("请先连接接口（串口 / TCP / UDP / BLE）".into());
    }
    let file_name = PathBuf::from(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "firmware.bin".into());
    // 文件读取走 blocking（AV 扫描可能卡几百 ms）
    let p = path.clone();
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(&p))
        .await
        .map_err(|e| format!("读取文件失败: {e}"))?
        .map_err(|e| format!("读取文件失败: {e}"))?;
    if bytes.is_empty() {
        return Err("文件为空".into());
    }

    let mgr = state.inner().clone();
    mgr.abort.store(false, Ordering::SeqCst);
    mgr.drain_rx();
    XFER_ACTIVE.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(run_sender(app, kind, file_name, bytes, mgr));
    Ok(())
}

#[tauri::command]
pub async fn xfer_abort(
    app: AppHandle,
    state: tauri::State<'_, Arc<XferManager>>,
) -> Result<(), String> {
    if !is_active() {
        return Ok(());
    }
    state.abort.store(true, Ordering::SeqCst);
    // 尽力发 CAN CAN 通知设备停止（接口可能已关，忽略错误）
    let serial = app.state::<SerialManager>();
    let net = app.state::<crate::net::NetManager>();
    let ble = app.state::<crate::ble::BleManager>();
    let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc16_xmodem_known_vectors() {
        // 经典校验向量："123456789" → 0x31C3
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
        assert_eq!(crc16_xmodem(b""), 0x0000);
    }

    #[test]
    fn build_block_checksum_layout() {
        let blk = build_block(1, &[0xAA; 128], false);
        // 校验和帧 = 1+1+1+128+1 = 132 字节
        assert_eq!(blk.len(), 132);
        assert_eq!(blk[0], SOH);
        assert_eq!(blk[1], 1);
        assert_eq!(blk[2], 254);
        // 校验和 = 128 个 0xAA 之和的低 8 位 = 0x00
        assert_eq!(blk[131], 0x00);
    }

    #[test]
    fn build_block_crc_layout() {
        let payload = b"hello";
        let blk = build_block(2, payload, true);
        assert_eq!(blk.len(), 133);
        assert_eq!(blk[1], 2);
        assert_eq!(blk[2], 253);
        let c = crc16_xmodem(&blk[3..131]); // 数据区 128B（含 0 补齐）
        assert_eq!(((blk[131] as u16) << 8) | blk[132] as u16, c);
    }

    #[test]
    fn build_block1k_layout() {
        let blk = build_block1k(3, &[0x55; 1024]);
        assert_eq!(blk.len(), 1029);
        assert_eq!(blk[0], STX);
        assert_eq!(blk[1], 3);
        assert_eq!(blk[2], 252);
        let c = crc16_xmodem(&blk[3..1027]); // 数据区 1024B（不含已附加的 CRC）
        assert_eq!(((blk[1027] as u16) << 8) | blk[1028] as u16, c);
    }

    #[test]
    fn ymodem_header0_layout() {
        let hdr = ymodem_header0("app.bin", 1024);
        assert_eq!(hdr.len(), 128);
        assert!(hdr.starts_with(b"app.bin\01024\0"));
        assert!(hdr[15..].iter().all(|&b| b == 0));
    }
}
