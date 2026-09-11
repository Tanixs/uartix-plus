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
use std::io::Write as _;
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
const CHR_G: u8 = 0x47; // 'G'：接收方声明 YMODEM-G（流式，不逐块 ACK）

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
    /// YMODEM-G：批次头仍握手，**数据块流式连发不等 ACK**（吞吐极限，无重试）；
    /// 接收方出错直接 CAN CAN 取消
    YmodemG,
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

    /// 等一个控制字节；deadline 到返回 None。
    /// 取消标志置位时立即返回 None（发送/接收方的循环顶部都有 take_abort 检查，
    /// 借此把取消延迟从「最长等待窗口」压到毫秒级）
    async fn wait_byte(&self, deadline: Instant) -> Option<u8> {
        loop {
            if self.abort.load(Ordering::SeqCst) {
                return None;
            }
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
        + u32::from(matches!(proto, XferProto::Ymodem | XferProto::YmodemG));

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

    // 启动：等 NAK（校验和模式，仅 XMODEM-128）/ 'C'（CRC）/ 'G'（YMODEM-G）
    let mut crc = true;
    let mut got_start = false;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if mgr.take_abort() {
            finish(false, "已取消".into());
            return;
        }
        match mgr.wait_byte(deadline).await {
            Some(CHR_G) if proto == XferProto::YmodemG => {
                got_start = true;
                break;
            }
            Some(NAK) | Some(CHR_C) if proto == XferProto::YmodemG => {
                finish(
                    false,
                    "设备应答的是普通 YMODEM 握手（'C'/NAK），与 YMODEM-G 不匹配——请把协议改回普通 YMODEM".into(),
                );
                return;
            }
            Some(NAK) if proto == XferProto::Xmodem => {
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
        if mgr.take_abort() {
            finish(false, "已取消".into());
            return;
        }
        let want = if proto == XferProto::YmodemG { "'G'" } else { "NAK/'C'" };
        finish(
            false,
            format!("设备未就绪（60s 内未收到 {want}，确认设备已进入等待接收状态）"),
        );
        return;
    }

    // YMODEM/YMODEM-G 块 0：文件名+大小 → ACK → 'C'（G 模式为 'G'）
    if matches!(proto, XferProto::Ymodem | XferProto::YmodemG) {
        let blk = build_block(0, &ymodem_header0(&file_name, total), true);
        let mut confirmed0 = false;
        let want_ready = if proto == XferProto::YmodemG { CHR_G } else { CHR_C };
        for _ in 0..MAX_RETRIES {
            if mgr.take_abort() {
                finish(false, "已取消".into());
                return;
            }
            match send_and_wait_ack(&app, &serial, &net, &ble, &mgr, &blk).await {
                Ok(true) => {
                    // ACK 后要等 'C'/'G' 才进数据块；没等到 → 重发块 0
                    if mgr.wait_byte(Instant::now() + BYTE_TIMEOUT).await == Some(want_ready) {
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
            finish(false, "块 0 未被确认（文件名/大小未 ACK+就绪字节）".into());
            return;
        }
    }

    // 数据块
    let chunk_len = if proto == XferProto::Xmodem { 128 } else { 1024 };
    let mut idx: u8 = 0;
    if proto == XferProto::YmodemG {
        // 流式连发（YMODEM-G 核心）：不等 ACK 不重试；接收方出错会连发 CAN CAN
        for (ci, chunk) in data.chunks(1024).enumerate() {
            if mgr.take_abort() {
                let c = (ci * 1024).min(total as usize) as u64;
                emit_prog("aborted", ci as u32, c, retries, "已取消", true);
                finish(false, "已取消".into());
                return;
            }
            idx = idx.wrapping_add(1);
            if idx == 0 {
                idx = 1; // 块号 0 保留，回绕跳过
            }
            if let Err(e) =
                crate::serial::route_send(&app, &serial, &net, &ble, &build_block1k(idx, chunk))
                    .await
            {
                let c = (ci * 1024).min(total as usize) as u64;
                emit_prog("error", ci as u32, c, retries, &e, true);
                finish(false, e);
                return;
            }
            // 非阻塞嗅探 CAN CAN（接收方取消）；迟到的 ACK/NAK/'C' 一律忽略
            if mgr.wait_byte(Instant::now()).await == Some(CAN)
                && mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await == Some(CAN)
            {
                let c = (ci * 1024).min(total as usize) as u64;
                let msg = "设备已取消传输（CAN CAN）".to_string();
                emit_prog("error", ci as u32, c, retries, &msg, true);
                finish(false, msg);
                return;
            }
            let c = ((ci + 1) * 1024).min(total as usize) as u64;
            emit_prog("sending", (ci + 1) as u32, c, retries, "", false);
        }
    } else {
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
    } // else：非 G（stop-and-wait）分支

    // EOT（XMODEM/YMODEM 同规则；G 模式接收方直接 ACK，无第一次 NAK）
    if let Err(e) = send_eot(&app, &serial, &net, &ble, &mgr).await {
        emit_prog("error", blocks, total, retries, &e, true);
        finish(false, e);
        return;
    }

    // YMODEM/YMODEM-G 批次收尾：全零块 0 → ACK（未确认不影响文件本身，按成功收尾）
    if matches!(proto, XferProto::Ymodem | XferProto::YmodemG) {
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

// ---------- 接收方（设备 → PC，P49 遗留补全） ----------

const RECV_HANDSHAKE_GAP: Duration = Duration::from_secs(1);
const RECV_BLOCK_TIMEOUT: Duration = Duration::from_secs(10);
const RECV_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const RECV_TAIL_TIMEOUT: Duration = Duration::from_secs(10);

/// 解析 YMODEM 块 0 批次头：`文件名\0大小\0`（大小缺省 0 = 未知；全零块返回 None）
fn parse_ymodem_header(data: &[u8]) -> Option<(String, u64)> {
    let nend = data.iter().position(|&b| b == 0)?;
    let name = std::str::from_utf8(&data[..nend]).ok()?;
    if name.is_empty() {
        return None;
    }
    let rest = &data[nend + 1..];
    let send = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    let size = std::str::from_utf8(&rest[..send]).ok()?.parse().unwrap_or(0);
    Some((name.to_string(), size))
}

/// 接收方块校验：SOH/STX + 块号 + ~块号 + 数据 + CRC16（接收方以 'C'/'G' 握手，固定 CRC 模式）。
/// 返回 (块号, 数据区)。
fn validate_block(blk: &[u8]) -> Option<(u8, &[u8])> {
    if blk.len() < 5 || blk[1] ^ blk[2] != 0xFF {
        return None;
    }
    let (data_len, crc_at) = if blk[0] == STX {
        (1024usize, 1027usize)
    } else {
        (128usize, 131usize)
    };
    if blk.len() < crc_at + 2 {
        return None;
    }
    let data = &blk[3..3 + data_len];
    let want = crc16_xmodem(data);
    let got = ((blk[crc_at] as u16) << 8) | blk[crc_at + 1] as u16;
    (got == want).then_some((blk[1], data))
}

/// 收一个完整块。Ok(Some(b))=块 / 单字节 EOT、CAN、噪声；Ok(None)=窗口内无块；
/// Err=已取消 / CAN CAN（设备取消）
async fn next_block(mgr: &XferManager, wait: Duration) -> Result<Option<Vec<u8>>, String> {
    let head = match mgr.wait_byte(Instant::now() + wait).await {
        Some(b) => b,
        None => return Ok(None),
    };
    let body = match head {
        SOH => 132usize, // idx+~idx+128B+CRC16
        STX => 1028usize,
        _ => return Ok(Some(vec![head])), // EOT / CAN / 噪声单字节
    };
    let deadline = Instant::now() + RECV_BLOCK_TIMEOUT;
    let mut buf = Vec::with_capacity(1 + body);
    buf.push(head);
    for _ in 0..body {
        match mgr.wait_byte(deadline).await {
            Some(b) => buf.push(b),
            None => return Ok(None), // 块中途断流——按无块处理（调用方 NAK 重试）
        }
    }
    Ok(Some(buf))
}

async fn run_receiver(app: AppHandle, proto: XferProto, save_path: String, mgr: Arc<XferManager>) {
    let started = Instant::now();
    let g_mode = proto == XferProto::YmodemG;
    let ymodem = matches!(proto, XferProto::Ymodem | XferProto::YmodemG);
    let save_name = PathBuf::from(&save_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "received.bin".into());

    let finish = |ok: bool, msg: String| {
        XFER_ACTIVE.store(false, Ordering::SeqCst);
        let _ = app.emit("xfer:done", XferDone { ok, msg });
    };

    let serial = app.state::<SerialManager>();
    let net = app.state::<crate::net::NetManager>();
    let ble = app.state::<crate::ble::BleManager>();

    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let mut emit_prog =
        |phase: &str, got: u64, blocks: u32, retries: u32, total: u64, msg: &str, force: bool| {
            let now = Instant::now();
            if !force && now.duration_since(last_emit) < PROGRESS_INTERVAL {
                return;
            }
            last_emit = now;
            let _ = app.emit(
                "xfer:progress",
                XferProgress {
                    phase: phase.into(),
                    block: blocks,
                    blocks: if total > 0 { total.div_ceil(1024) as u32 + 2 } else { 0 },
                    bytes: got,
                    total,
                    retries,
                    bps: (got as f64 / started.elapsed().as_secs_f64().max(1e-6)) as u64,
                    msg: msg.into(),
                },
            );
        };

    // 打开保存文件（blocking：磁盘/杀软扫描可能卡几百 ms）
    let p = PathBuf::from(&save_path);
    let mut file = match tokio::task::spawn_blocking(move || std::fs::File::create(&p)).await {
        Ok(Ok(f)) => std::io::BufWriter::new(f),
        Ok(Err(e)) => {
            finish(false, format!("无法创建保存文件「{save_path}」: {e}"));
            return;
        }
        Err(e) => {
            finish(false, format!("无法创建保存文件: {e}"));
            return;
        }
    };

    mgr.drain_rx();
    emit_prog("waiting", 0, 0, 0, 0, "等待设备开始发送…", true);

    // 就绪握手：每秒重发就绪字节（'C'=CRC / 'G'=流式），直到首个有效块
    let ready: u8 = if g_mode { CHR_G } else { CHR_C };
    let hs_deadline = Instant::now() + START_TIMEOUT;
    let mut cur: Vec<u8> = loop {
        if mgr.take_abort() {
            finish(false, "已取消".into());
            return;
        }
        if Instant::now() >= hs_deadline {
            finish(
                false,
                "设备未开始发送（60s 内未收到数据块，确认设备已进入发送模式）".into(),
            );
            return;
        }
        if let Err(e) = crate::serial::route_send(&app, &serial, &net, &ble, &[ready]).await {
            finish(false, format!("发送就绪信号失败: {e}"));
            return;
        }
        match next_block(&mgr, RECV_HANDSHAKE_GAP).await {
            Err(e) => {
                finish(false, e);
                return;
            }
            Ok(None) => continue, // 1s 无块 → 重发就绪字节
            Ok(Some(b)) if b.len() == 1 && b[0] == CAN => {
                if mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await == Some(CAN) {
                    finish(false, "设备已取消传输（CAN CAN）".into());
                    return;
                }
            }
            Ok(Some(b)) if b.len() == 1 && b[0] == EOT => {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
                // 过早 EOT：NAK 后继续等
            }
            Ok(Some(b)) if b.len() == 1 => {} // 噪声
            Ok(Some(b)) => break b,
        }
    };
    emit_prog("receiving", 0, 0, 0, 0, "", true);

    let mut total: u64 = 0; // YMODEM 块 0 给出确切大小；XMODEM 未知（前端只显示字节）
    let mut got: u64 = 0;
    let mut blocks: u32 = 0;
    let mut retries: u32 = 0;
    let mut tail_1a: usize = 0; // 流末尾连续 0x1A 数（XMODEM 无大小时据此裁填充）
    let mut expect: u8 = if ymodem { 0 } else { 1 };
    let mut in_header = ymodem; // 等待 YMODEM 批次头（块 0）
    let mut eot_seen = false; // 非 G：首个 EOT 已按协议 NAK，等第二个
    let mut batch_tail = false; // EOT 已 ACK：等收尾批次（全零块 0）
    let mut tail_deadline = Instant::now();
    let mut last_rx = Instant::now();
    let mut rx_name = String::new();

    loop {
        // ---- 等待新块 ----
        if cur.is_empty() {
            if mgr.take_abort() {
                finish(false, "已取消".into());
                return;
            }
            if batch_tail {
                if Instant::now() >= tail_deadline {
                    // 设备迟迟不发收尾批次：按单文件完成收尾
                    let _ = file.flush();
                    finish(true, format!("接收完成：{rx_name}（{got} B，设备未发收尾批次头）"));
                    return;
                }
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ready]).await;
                match next_block(&mgr, RECV_HANDSHAKE_GAP).await {
                    Err(e) => {
                        finish(false, e);
                        return;
                    }
                    Ok(None) => continue,
                    Ok(Some(b)) if b.len() == 1 => continue, // 重复 EOT/噪声：已 ACK 过，忽略
                    Ok(Some(b)) => {
                        cur = b;
                        last_rx = Instant::now();
                    }
                }
            } else {
                if Instant::now().duration_since(last_rx) > RECV_IDLE_TIMEOUT {
                    finish(false, "接收超时（30s 未收到数据，设备可能已停止）".into());
                    return;
                }
                let silent = if g_mode { RECV_HANDSHAKE_GAP } else { Duration::from_secs(3) };
                match next_block(&mgr, silent).await {
                    Err(e) => {
                        finish(false, e);
                        return;
                    }
                    Ok(None) => {
                        // 非流式模式主动 NAK 防双端互等死锁；G 模式无重试语义只能继续等
                        if !g_mode {
                            retries += 1;
                            let _ =
                                crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
                        }
                        continue;
                    }
                    Ok(Some(b)) if b.len() == 1 && b[0] == CAN => {
                        if mgr.wait_byte(Instant::now() + Duration::from_millis(200)).await
                            == Some(CAN)
                        {
                            finish(false, "设备已取消传输（CAN CAN）".into());
                            return;
                        }
                    }
                    Ok(Some(b)) if b.len() == 1 && b[0] == EOT => {
                        cur = b;
                        last_rx = Instant::now();
                    }
                    Ok(Some(b)) if b.len() == 1 => {} // 噪声
                    Ok(Some(b)) => {
                        cur = b;
                        last_rx = Instant::now();
                    }
                }
            }
        }

        // ---- 处理当前块 ----
        let blk = std::mem::take(&mut cur);
        if blk[0] == EOT {
            if g_mode {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
            } else if !eot_seen {
                eot_seen = true;
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
                continue; // 协议规定动作：首个 EOT 回 NAK
            } else {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
            }
            if !ymodem {
                // XMODEM：EOT ACK 即结束（裁掉末尾 0x1A 填充）
                let _ = file.flush();
                if tail_1a > 0 {
                    let _ = file.get_ref().set_len(got - tail_1a as u64);
                }
                finish(true, format!("接收完成：{save_name}（{got} B）"));
                return;
            }
            batch_tail = true;
            tail_deadline = Instant::now() + RECV_TAIL_TIMEOUT;
            continue;
        }

        let Some((idx, data)) = validate_block(&blk) else {
            if g_mode {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
                finish(false, "数据块 CRC 校验失败（YMODEM-G 无重试机制，已通知设备取消）".into());
                return;
            }
            retries += 1;
            emit_prog("receiving", got, blocks, retries, total, "块校验失败，已请求重发", false);
            let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
            continue;
        };

        if batch_tail {
            // 收尾批次：块 0 全零 = 结束；非零 = 下一文件头（单文件模式，礼貌停批次）
            let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
            let _ = file.flush();
            if data.iter().all(|&b| b == 0) {
                finish(true, format!("接收完成：{rx_name}（{got} B，{blocks} 数据块，{retries} 次重试）"));
            } else {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
                finish(true, format!("接收完成：{rx_name}（{got} B；后续文件批次未支持，已通知设备停止）"));
            }
            return;
        }

        if in_header {
            match parse_ymodem_header(data) {
                Some((name, size)) => {
                    rx_name = name;
                    total = size;
                    in_header = false;
                    expect = 1;
                    if !g_mode {
                        let _ =
                            crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
                    }
                    // ACK 后要就绪字节（'C'/'G'）设备才发数据块
                    let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ready]).await;
                    emit_prog("receiving", 0, 0, retries, total, &format!("接收中：{rx_name}"), true);
                }
                None => {
                    if g_mode {
                        let _ =
                            crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
                        finish(false, "批次头解析失败（YMODEM-G 无重试机制）".into());
                        return;
                    }
                    retries += 1;
                    let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
                }
            }
            continue;
        }

        // 数据块：重复块再 ACK 不重写
        if idx != expect {
            if idx == expect.wrapping_sub(1) && idx != 0 {
                if g_mode {
                    let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
                    finish(false, "收到重复数据块（YMODEM-G 流已错乱）".into());
                    return;
                }
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
                continue;
            }
            if g_mode {
                let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[CAN, CAN]).await;
                finish(false, "数据块序号错乱（YMODEM-G 流已错乱）".into());
                return;
            }
            retries += 1;
            let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[NAK]).await;
            continue;
        }

        let take = if total > 0 {
            (data.len() as u64).min(total - got)
        } else {
            data.len() as u64
        } as usize;
        if take > 0 {
            if let Err(e) = file.write_all(&data[..take]) {
                finish(false, format!("写入文件失败: {e}"));
                return;
            }
            if total == 0 {
                let trailing = data[..take].iter().rev().take_while(|&&b| b == 0x1A).count();
                tail_1a = if trailing == take { tail_1a + trailing } else { trailing };
            }
        }
        got += take as u64;
        blocks += 1;
        expect = expect.wrapping_add(1);
        if expect == 0 {
            expect = 1; // 块号 0 保留，回绕跳过
        }
        if !g_mode {
            let _ = crate::serial::route_send(&app, &serial, &net, &ble, &[ACK]).await;
        }
        emit_prog("receiving", got, blocks, retries, total, "", false);
    }
}

// ---------- 命令 ----------

/// 连接预检（发送/接收共用）：三个接口都没接管 → 提示先连接
fn check_connected(app: &AppHandle) -> Result<(), String> {
    let serial_ok = app.state::<SerialManager>().is_open();
    let net_ok = crate::net::is_connected(&app.state::<crate::net::NetManager>());
    let ble_ok = app.state::<crate::ble::BleManager>().is_connected();
    if !serial_ok && !net_ok && !ble_ok {
        return Err("请先连接接口（串口 / TCP / UDP / BLE）".into());
    }
    Ok(())
}

fn parse_proto(proto: &str) -> Result<XferProto, String> {
    match proto {
        "xmodem" => Ok(XferProto::Xmodem),
        "xmodem1k" => Ok(XferProto::Xmodem1k),
        "ymodem" => Ok(XferProto::Ymodem),
        "ymodemg" => Ok(XferProto::YmodemG),
        _ => Err(format!("未知传输协议: {proto}")),
    }
}

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
    let kind = parse_proto(&proto)?;
    // 连接预检：三个接口都没接管 → 提示先连接
    check_connected(&app)?;
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

/// 接收（设备 → PC）：path 为保存目标。就绪握手/块校验/写盘全在 Rust 侧，
/// RX 数据块经 ingest tap（XFER_ACTIVE 截流）进队列，不污染帧管线/录制。
#[tauri::command]
pub async fn xfer_receive_start(
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
    let kind = parse_proto(&proto)?;
    check_connected(&app)?;
    let mgr = state.inner().clone();
    mgr.abort.store(false, Ordering::SeqCst);
    mgr.drain_rx();
    XFER_ACTIVE.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(run_receiver(app, kind, path, mgr));
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

    #[test]
    fn ymodem_header_parse_roundtrip() {
        let blk = build_block(0, &ymodem_header0("fw.bin", 2048), true);
        let (idx, data) = validate_block(&blk).expect("批次头块应校验通过");
        assert_eq!(idx, 0);
        let (name, size) = parse_ymodem_header(data).expect("批次头应可解析");
        assert_eq!(name, "fw.bin");
        assert_eq!(size, 2048);
    }

    #[test]
    fn parse_ymodem_header_edge_cases() {
        assert!(parse_ymodem_header(&[0u8; 128]).is_none()); // 全零 = 收尾批次头
        let (name, size) = parse_ymodem_header(b"onlyname\0").expect("无大小区也应可解析");
        assert_eq!(name, "onlyname");
        assert_eq!(size, 0);
    }

    #[test]
    fn validate_block_rejects_corruption() {
        let mut blk = build_block(1, &[0x55; 128], true);
        blk[132] ^= 0xFF; // 破坏 CRC 高字节
        assert!(validate_block(&blk).is_none());
        let mut blk = build_block(2, &[0x55; 128], true);
        blk[2] = blk[1]; // 破坏 ~idx
        assert!(validate_block(&blk).is_none());
        let mut blk = build_block1k(3, &[0xAA; 1024]);
        blk[1028] ^= 0x01; // 破坏 1K 块 CRC 低字节
        assert!(validate_block(&blk).is_none());
        let blk1k = build_block1k(4, &[0xAA; 1024]);
        let (idx, data) = validate_block(&blk1k).expect("1K 块应通过");
        assert_eq!(idx, 4);
        assert_eq!(data.len(), 1024);
    }
}
