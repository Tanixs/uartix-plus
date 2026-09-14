//! 可编程虚拟设备工坊（P78c）——Rust 侧「设备扮演」数据源。
//!
//! 与 demo.rs / 会话回放同构：仿真线程按规格生成帧 → `ingest()` 单点进管线
//! （红线：绝不另开第二条帧通道），Hex/控制台/录制/哨兵全家桶零改动点亮。
//! 与回放互补：回放是过去，虚拟设备是现在——像真设备一样「收指令做反应」：
//! `serial::route_send` 顶部挂钩 `try_send`，命令匹配 → 修改输入量 / 排队应答帧。
//!
//! 规格（JSON）由前端 normalize（vdevStore）后传入，Rust 侧只信任已校验的结构；
//! 解析失败一律返回用户可读中文错误。
//!
//! 互斥（状态机）：vdev 与 回放/真实接口 互为拒绝；vdev 启动时自动停演示源。
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::parser::crc16_modbus;
use crate::pipeline::{ingest, IngestCtx};
use crate::serial::SerialManager;

static FLAG: AtomicBool = AtomicBool::new(false);

static RUNTIME: Mutex<Option<VdevRuntime>> = Mutex::new(None);

pub fn running() -> bool {
    FLAG.load(Ordering::SeqCst)
}

struct VdevRuntime {
    spec: VDevSpec,
    sim: SimState,
    net: Option<NetHandle>,
}

/// 链路句柄 + 共享计数（读线程与仿真线程各持 Arc<NetCounters>）
pub struct NetHandle {
    link: NetLink,
    counters: Arc<NetCounters>,
}

#[derive(Default)]
pub struct NetCounters {
    out_sent: AtomicU64,
    out_bytes: AtomicU64,
    out_errs: AtomicU64,
    in_recv: AtomicU64,
    clients: AtomicU64,
    last_error: Mutex<String>,
    last_cmd: Mutex<String>,
}

impl NetCounters {
    fn set_err(&self, e: &str) {
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = e.to_string();
    }
    fn set_cmd(&self, c: &[u8]) {
        let text = String::from_utf8_lossy(c);
        let brief: String = text.chars().take(48).collect();
        *self.last_cmd.lock().unwrap_or_else(|p| p.into_inner()) = brief;
    }
}

enum NetLink {
    Udp {
        out: Vec<(UdpSocket, SocketAddr)>,
    },
    TcpClient {
        stream: TcpStream,
        peer: SocketAddr,
        peer_str: String,
        retry_at: Instant,
    },
    TcpServer {
        clients: Arc<Mutex<Vec<Arc<NetClient>>>>,
    },
    Serial {
        port: Box<dyn serialport::SerialPort>,
    },
}

pub struct NetClient {
    #[allow(dead_code)] // 诊断用：客户端地址（状态展示/日志的预留字段）
    addr: SocketAddr,
    stream: Mutex<TcpStream>,
}

/* ================= 规格 schema（与前端 vdevStore 同一形状，camelCase） ================= */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevSpec {
    pub name: String,
    // desc 由前端展示（Rust 侧不读，保留字段以对齐规格 schema）
    #[allow(dead_code)]
    #[serde(default)]
    pub desc: String,
    #[serde(default = "default_period")]
    pub period_ms: u64,
    pub frame: VDevFrame,
    #[serde(default)]
    pub inputs: Vec<VDevInput>,
    #[serde(default)]
    pub signals: Vec<VDevSignal>,
    #[serde(default)]
    pub faults: VDevFaults,
    #[serde(default)]
    pub commands: Vec<VDevCommand>,
    /// 网络收发（P79）：设备像真的一样在链路上吐帧/收令；缺省 = 纯本地仿真
    #[serde(default)]
    pub net: Option<VDevNet>,
}

/// 一台设备一条链路（v1 不做多目标分发，避免组合爆炸的配置冗余）。
/// udp：host+port 发射，listenPort 可选收令；tcp-client：host+port 拨出（双向）；
/// tcp-server：bind+port 监听（多客户端广播，双向）；serial：path+baud 直写 COM（双向）。
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VDevNet {
    pub transport: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub bind: String,
    #[serde(default)]
    pub listen_port: u16,
    #[serde(default)]
    pub listen_bind: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub baud: u32,
    /// 仅 udp：额外发射目标（≤4；与主目标并列，一帧多投）
    #[serde(default)]
    pub extra_targets: Vec<VDevTarget>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VDevTarget {
    pub host: String,
    pub port: u16,
}

fn default_period() -> u64 {
    100
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevFrame {
    #[serde(default)]
    pub header: String,
    #[serde(default)]
    pub footer: String,
    #[serde(default)]
    pub checksum: String, // none | sum8 | xor8 | crc16_modbus
    #[serde(default)]
    pub fields: Vec<VDevField>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevField {
    pub signal: String,
    #[serde(rename = "type")]
    pub kind: String, // int8 uint8 int16 uint16 int32 uint32 float32 float64
    #[serde(default = "default_endian")]
    pub endian: String,
    #[serde(default = "default_scale")]
    pub scale: f64,
}

fn default_scale() -> f64 {
    1.0
}

fn default_endian() -> String {
    "little".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevInput {
    pub name: String,
    #[serde(default)]
    pub value: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevSignal {
    pub name: String,
    #[serde(flatten)]
    pub model: SignalModel,
    #[serde(default)]
    pub noise: f64,
    #[serde(default)]
    pub drift_per_min: f64,
}

#[derive(Deserialize)]
#[serde(tag = "model")]
pub enum SignalModel {
    #[serde(rename = "const")]
    Const { value: f64 },
    #[serde(rename = "sine")]
    Sine {
        amp: f64,
        #[serde(rename = "freqHz")]
        freq_hz: f64,
        #[serde(default)]
        offset: f64,
        #[serde(rename = "phaseDeg", default)]
        phase_deg: f64,
    },
    #[serde(rename = "square")]
    Square {
        amp: f64,
        #[serde(rename = "freqHz")]
        freq_hz: f64,
        #[serde(default)]
        offset: f64,
        #[serde(default = "default_duty")]
        duty: f64,
    },
    #[serde(rename = "triangle")]
    Triangle {
        amp: f64,
        #[serde(rename = "freqHz")]
        freq_hz: f64,
        #[serde(default)]
        offset: f64,
    },
    #[serde(rename = "firstOrder")]
    FirstOrder {
        from: String,
        gain: f64,
        tau: f64,
        #[serde(default)]
        ambient: f64,
        #[serde(default)]
        init: f64,
    },
    #[serde(rename = "mirror")]
    Mirror { of: String },
}

fn default_duty() -> f64 {
    0.5
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VDevFaults {
    pub drop_pct: f64,
    pub stuck_pct: f64,
    pub spike_pct: f64,
    pub spike_amp: f64,
    pub spike_signal: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VDevCommand {
    #[serde(rename = "match")]
    pub matcher: CommandMatch,
    #[serde(default)]
    pub set: BTreeMap<String, f64>,
    #[serde(default)]
    pub reply: Option<CommandReply>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandMatch {
    #[serde(rename = "type")]
    pub kind: String, // ascii | hex
    pub prefix: String,
    /// 捕获前缀后的数值写入 setInput（如 `SET HEAT 45` → heaterCmd=45）；
    /// 解析失败按未命中处理（像真设备拒收畸形帧）
    #[serde(default)]
    pub capture_number: bool,
    #[serde(default)]
    pub set_input: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandReply {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

/* ================= 仿真状态 ================= */

struct SimState {
    t: f64,
    vals: BTreeMap<String, f64>,
    inputs: BTreeMap<String, f64>,
    rng: u64,
    last_frame: Vec<u8>,
    pending_replies: Vec<Vec<u8>>,
}

impl SimState {
    fn rand(&mut self) -> f64 {
        self.rng = self
            .rng
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((self.rng >> 11) as f64) / ((1u64 << 53) as f64)
    }
}

/* ================= 规格解析 / 校验（错误一律用户可读中文） ================= */

fn parse_addr(host: &str, port: u16, what: &str) -> Result<SocketAddr, String> {
    let h = if host.trim().is_empty() { "127.0.0.1" } else { host.trim() };
    (h, port)
        .to_socket_addrs()
        .map_err(|_| format!("{what} 地址非法：{h}:{port}"))?
        .next()
        .ok_or_else(|| format!("{what} 地址无法解析：{h}:{port}"))
}

fn parse_hex_str(s: &str, what: &str) -> Result<Vec<u8>, String> {
    let clean: String = s.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() % 2 != 0 {
        return Err(format!("{what} 的 HEX 位数应为偶数：{s}"));
    }
    let mut out = Vec::with_capacity(clean.len() / 2);
    let b = clean.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16);
        let lo = (b[i + 1] as char).to_digit(16);
        match (hi, lo) {
            (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
            _ => return Err(format!("{what} 含非法 HEX 字符：{s}")),
        }
        i += 2;
    }
    Ok(out)
}

fn field_size(kind: &str) -> Result<usize, String> {
    Ok(match kind {
        "int8" | "uint8" => 1,
        "int16" | "uint16" | "float32" => 2,
        "int32" | "uint32" | "float64" => 4,
        other => return Err(format!("不支持的字段类型 {other}（可用 int8/uint8/int16/uint16/int32/uint32/float32/float64）")),
    })
}

fn checksum_len(kind: &str) -> Result<usize, String> {
    Ok(match kind {
        "" | "none" => 0,
        "sum8" | "xor8" => 1,
        "crc16_modbus" => 2,
        other => return Err(format!("不支持的校验算法 {other}（可用 none/sum8/xor8/crc16_modbus）")),
    })
}

fn validate(spec: &VDevSpec) -> Result<(), String> {
    if spec.name.trim().is_empty() {
        return Err("设备名不能为空".into());
    }
    if !(20..=5000).contains(&spec.period_ms) {
        return Err(format!("输出周期应为 20~5000ms（当前 {}）", spec.period_ms));
    }
    if spec.signals.is_empty() {
        return Err("至少定义一个信号".into());
    }
    let mut names: Vec<&str> = Vec::new();
    for s in &spec.signals {
        if s.name.trim().is_empty() {
            return Err("信号名不能为空".into());
        }
        if names.contains(&s.name.as_str()) {
            return Err(format!("信号名重复：{}", s.name));
        }
        names.push(&s.name);
    }
    for i in &spec.inputs {
        if i.name.trim().is_empty() {
            return Err("输入量名不能为空".into());
        }
    }
    for s in &spec.signals {
        match &s.model {
            SignalModel::FirstOrder { from, tau, .. } => {
                if !spec.inputs.iter().any(|i| i.name == *from) {
                    return Err(format!(
                        "信号 {} 的一阶模型引用了未声明的输入量 {}",
                        s.name, from
                    ));
                }
                if !(tau > &0.01) {
                    return Err(format!("信号 {} 的时间常数 τ 应 > 0.01s", s.name));
                }
            }
            SignalModel::Mirror { of } => {
                // 允许镜像另一信号或输入量（如 heater 镜像 heaterCmd 显示占空比）
                if !names.contains(&of.as_str()) && !spec.inputs.iter().any(|i| i.name == *of) {
                    return Err(format!("镜像信号 {} 引用了不存在的信号或输入量 {}", s.name, of));
                }
            }
            _ => {}
        }
    }
    let mut packed = 0usize;
    for f in &spec.frame.fields {
        if !names.contains(&f.signal.as_str()) {
            return Err(format!("帧字段引用了不存在的信号 {}", f.signal));
        }
        packed += field_size(&f.kind)?;
        if f.scale == 0.0 {
            return Err(format!("字段 {} 的 scale 不能为 0", f.signal));
        }
    }
    let header = parse_hex_str(&spec.frame.header, "帧头")?;
    let footer = parse_hex_str(&spec.frame.footer, "帧尾")?;
    if header.len() > 8 {
        return Err("帧头最长 8 字节".into());
    }
    if footer.len() > 8 {
        return Err("帧尾最长 8 字节".into());
    }
    let ck = checksum_len(&spec.frame.checksum)?;
    if header.len() + packed + footer.len() + ck > 512 {
        return Err(format!("帧总长 {} 字节超上限 512", header.len() + packed + footer.len() + ck));
    }
    if let Some(n) = &spec.net {
        match n.transport.as_str() {
            "udp" => {
                if n.port == 0 {
                    return Err("UDP 发射需要目标端口".into());
                }
                parse_addr(&n.host, n.port, "UDP 目标")?;
                if n.extra_targets.len() > 4 {
                    return Err("UDP 附加目标最多 4 个".into());
                }
                for t in &n.extra_targets {
                    if t.port == 0 {
                        return Err("UDP 附加目标端口非法".into());
                    }
                    parse_addr(&t.host, t.port, "UDP 附加目标")?;
                }
                if n.listen_port != 0 {
                    parse_addr(if n.listen_bind.is_empty() { "127.0.0.1" } else { &n.listen_bind }, n.listen_port, "UDP 监听")?;
                    if n.listen_port == n.port {
                        return Err("UDP 发射与监听端口不能相同（自环）".into());
                    }
                }
            }
            "tcp-client" => {
                if n.port == 0 {
                    return Err("TCP 客户端需要目标端口".into());
                }
                parse_addr(&n.host, n.port, "TCP 对端")?;
            }
            "tcp-server" => {
                if n.port == 0 {
                    return Err("TCP 服务端需要监听端口".into());
                }
                let bind = if n.bind.is_empty() { "127.0.0.1" } else { &n.bind };
                if bind != "127.0.0.1" && bind != "0.0.0.0" {
                    return Err("TCP 服务端监听地址仅支持 127.0.0.1 或 0.0.0.0".into());
                }
                parse_addr(bind, n.port, "TCP 监听")?;
            }
            "serial" => {
                if n.path.trim().is_empty() {
                    return Err("串口链路需要端口路径（如 COM5）".into());
                }
                if n.baud == 0 {
                    return Err("串口波特率非法".into());
                }
            }
            other => return Err(format!("不支持的网络链路类型 {other}（可用 udp/tcp-client/tcp-server/serial）")),
        }
    }
    for c in &spec.commands {
        if !matches!(c.matcher.kind.as_str(), "ascii" | "hex") {
            return Err(format!("命令匹配类型应为 ascii 或 hex（当前 {}）", c.matcher.kind));
        }
        if c.matcher.prefix.is_empty() {
            return Err("命令匹配前缀不能为空".into());
        }
        if c.matcher.capture_number {
            if c.matcher.kind != "ascii" {
                return Err("数值捕获仅支持 ascii 命令".into());
            }
            if c.matcher.set_input.trim().is_empty() {
                return Err("数值捕获需要目标输入量".into());
            }
            if !spec.inputs.iter().any(|i| i.name == c.matcher.set_input) {
                return Err(format!("数值捕获写入的输入量 {} 未声明", c.matcher.set_input));
            }
        }
        if c.matcher.kind == "hex" {
            parse_hex_str(&c.matcher.prefix, "命令前缀")?;
        }
        if let Some(r) = &c.reply {
            if !matches!(r.kind.as_str(), "ascii" | "hex") {
                return Err("应答类型应为 ascii 或 hex".into());
            }
        }
    }
    Ok(())
}

fn parse_spec(json: &str) -> Result<VdevRuntime, String> {
    let spec: VDevSpec =
        serde_json::from_str(json).map_err(|e| format!("虚拟设备规格解析失败：{e}"))?;
    validate(&spec)?;
    let mut inputs = BTreeMap::new();
    for i in &spec.inputs {
        inputs.insert(i.name.clone(), i.value);
    }
    let mut vals = BTreeMap::new();
    for s in &spec.signals {
        if let SignalModel::FirstOrder { init, .. } = &s.model {
            vals.insert(s.name.clone(), *init);
        }
    }
    Ok(VdevRuntime {
        spec,
        sim: SimState {
            t: 0.0,
            vals,
            inputs,
            rng: 0x9E3779B97F4A7C15,
            last_frame: Vec::new(),
            pending_replies: Vec::new(),
        },
        net: None,
    })
}

/* ================= 信号求值 / 帧生成 ================= */

/// 求值全部信号（按声明序：mirror/firstOrder 只引用更早声明的信号与输入量）。
/// spec 与 sim 分离借用，避免逐拍克隆信号表。
fn evaluate(spec: &VDevSpec, sim: &mut SimState, dt: f64) {
    let t = sim.t;
    let drift_t = t / 60.0;
    for s in &spec.signals {
        let mut v = match &s.model {
            SignalModel::Const { value } => *value,
            SignalModel::Sine {
                amp,
                freq_hz,
                offset,
                phase_deg,
            } => {
                offset
                    + amp * (2.0 * std::f64::consts::PI * freq_hz * t + phase_deg.to_radians()).sin()
            }
            SignalModel::Square {
                amp,
                freq_hz,
                offset,
                duty,
            } => {
                let frac = (t * freq_hz) % 1.0;
                offset + amp * if frac < *duty { 1.0 } else { -1.0 }
            }
            SignalModel::Triangle {
                amp,
                freq_hz,
                offset,
            } => {
                let frac = (t * freq_hz) % 1.0;
                offset + amp * (4.0 * (frac - 0.5).abs() - 1.0)
            }
            SignalModel::FirstOrder {
                from,
                gain,
                tau,
                ambient,
                ..
            } => {
                let v0 = sim.vals.get(&s.name).copied().unwrap_or(*ambient);
                let u = sim.inputs.get(from).copied().unwrap_or(0.0);
                v0 + (gain * u - (v0 - ambient)) / tau * dt
            }
            SignalModel::Mirror { of } => sim
                .vals
                .get(of)
                .or_else(|| sim.inputs.get(of))
                .copied()
                .unwrap_or(0.0),
        };
        if s.drift_per_min != 0.0 {
            v += s.drift_per_min * drift_t;
        }
        if s.noise > 0.0 {
            v += (sim.rand() * 2.0 - 1.0) * s.noise;
        }
        // 故障注入：毛刺
        if !spec.faults.spike_signal.is_empty()
            && spec.faults.spike_signal == s.name
            && spec.faults.spike_pct > 0.0
            && sim.rand() * 100.0 < spec.faults.spike_pct
        {
            v += spec.faults.spike_amp;
        }
        sim.vals.insert(s.name.clone(), v);
    }
    sim.t += dt;
}

fn write_le(v: f64, kind: &str, endian: &str, out: &mut Vec<u8>) -> Result<(), String> {
    match kind {
        "int8" => out.push(v as i8 as u8),
        "uint8" => out.push(v as u8),
        "int16" | "uint16" => {
            let raw = if kind == "int16" { (v as i16) as u16 } else { v as u16 };
            push_u16(raw, endian, out);
        }
        "int32" | "uint32" => {
            let raw = if kind == "int32" { (v as i32) as u32 } else { v as u32 };
            push_u32(raw, endian, out);
        }
        "float32" => push_u32((v as f32).to_bits(), endian, out),
        "float64" => {
            let b = v.to_bits();
            if endian == "big" {
                out.extend_from_slice(&b.to_be_bytes());
            } else {
                out.extend_from_slice(&b.to_le_bytes());
            }
        }
        other => return Err(format!("不支持的字段类型 {other}")),
    }
    Ok(())
}

fn push_u16(raw: u16, endian: &str, out: &mut Vec<u8>) {
    if endian == "big" {
        out.extend_from_slice(&raw.to_be_bytes());
    } else {
        out.extend_from_slice(&raw.to_le_bytes());
    }
}

fn push_u32(raw: u32, endian: &str, out: &mut Vec<u8>) {
    if endian == "big" {
        out.extend_from_slice(&raw.to_be_bytes());
    } else {
        out.extend_from_slice(&raw.to_le_bytes());
    }
}

/// 打包一帧（header + fields + footer + checksum）
fn pack_frame(spec: &VDevFrame, vals: &BTreeMap<String, f64>) -> Result<Vec<u8>, String> {
    let mut out = parse_hex_str(&spec.header, "帧头")?;
    for f in &spec.fields {
        let raw = vals.get(&f.signal).copied().unwrap_or(0.0);
        let v = if f.scale != 0.0 { raw / f.scale } else { raw };
        write_le(v, &f.kind, &f.endian, &mut out)?;
    }
    out.extend_from_slice(&parse_hex_str(&spec.footer, "帧尾")?);
    match spec.checksum.as_str() {
        "sum8" => out.push(out.iter().fold(0u8, |a, &b| a.wrapping_add(b))),
        "xor8" => out.push(out.iter().fold(0u8, |a, &b| a ^ b)),
        "crc16_modbus" => {
            let crc = crc16_modbus(&out);
            out.extend_from_slice(&crc.to_le_bytes());
        }
        _ => {}
    }
    Ok(out)
}

/// 生成下一拍输出：None = 该拍被丢帧
fn generate_tick(spec: &VDevSpec, sim: &mut SimState, dt: f64) -> Option<Vec<u8>> {
    evaluate(spec, sim, dt);
    let f = &spec.faults;
    if f.drop_pct > 0.0 && sim.rand() * 100.0 < f.drop_pct {
        return None;
    }
    let frame = pack_frame(&spec.frame, &sim.vals).ok()?;
    if f.stuck_pct > 0.0 && sim.rand() * 100.0 < f.stuck_pct && !sim.last_frame.is_empty() {
        return Some(sim.last_frame.clone());
    }
    sim.last_frame = frame.clone();
    Some(frame)
}

/* ================= 命令匹配（route_send 钩子） ================= */

/// 命令命中 → 改输入量 + 排队应答；未命中也按已消费处理（像真设备一样静默忽略
/// 未知帧）。纯函数 apply_command 供单测直调——std Mutex 不可重入，
/// 测试里绝不能持 RUNTIME 锁再进 try_send（P78 踩坑）。
pub fn try_send(bytes: &[u8]) -> Result<bool, String> {
    let mut guard = RUNTIME.lock().map_err(|_| "虚拟设备状态锁中毒")?;
    match guard.as_mut() {
        Some(rt) => {
            let reply = apply_command(rt, bytes)?;
            if let Some(r) = reply {
                rt.sim.pending_replies.push(r);
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 命中返回 Some(应答字节)（去向由调用方决定：本地 → ingest，网络 → 回发送方）；
/// 未命中也视为已消费（像真设备忽略未知帧），返回 None。
fn apply_command(rt: &mut VdevRuntime, bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    for c in &rt.spec.commands {
        let hit = match c.matcher.kind.as_str() {
            "hex" => {
                let pat = parse_hex_str(&c.matcher.prefix, "命令前缀")?;
                bytes.starts_with(&pat)
            }
            _ => bytes.starts_with(c.matcher.prefix.as_bytes()),
        };
        if !hit {
            continue;
        }
        if c.matcher.capture_number {
            let rest = &bytes[c.matcher.prefix.as_bytes().len()..];
            let text = String::from_utf8_lossy(rest);
            let token: String = text
                .trim_start()
                .chars()
                .take_while(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-' || *ch == '+')
                .collect();
            let Ok(n) = token.parse::<f64>() else { continue };
            if !n.is_finite() {
                continue;
            }
            if !c.matcher.set_input.is_empty() {
                rt.sim.inputs.insert(c.matcher.set_input.clone(), n);
            }
        }
        for (k, v) in &c.set {
            rt.sim.inputs.insert(k.clone(), *v);
        }
        if let Some(r) = &c.reply {
            let data = match r.kind.as_str() {
                "hex" => parse_hex_str(&r.text, "应答内容")?,
                _ => r.text.as_bytes().to_vec(),
            };
            return Ok(Some(data));
        }
        return Ok(None);
    }
    Ok(None)
}

/* ================= 仿真线程 ================= */

fn vdev_loop(app: AppHandle, ctx: std::sync::Arc<IngestCtx>, period_ms: u64) {
    let mut last = Instant::now();
    while FLAG.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(period_ms));
        let dt = last.elapsed().as_secs_f64();
        last = Instant::now();
        let (batch, replies) = {
            let mut guard = match RUNTIME.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            let rt = match guard.as_mut() {
                Some(rt) => rt,
                None => return,
            };
            let VdevRuntime { spec, sim, .. } = rt;
            let mut batch: Vec<u8> = Vec::new();
            if let Some(frame) = generate_tick(spec, sim, dt) {
                batch.extend_from_slice(&frame);
            }
            (batch, std::mem::take(&mut sim.pending_replies))
        };
        if !batch.is_empty() {
            ingest(&ctx, &app, &batch);
            let mut guard = match RUNTIME.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            if let Some(rt) = guard.as_mut() {
                net_emit(rt, &batch);
            }
        }
        for r in replies {
            ingest(&ctx, &app, &r);
        }
    }
}

/* ================= 网络链路（P79） ================= */

const WRITE_TIMEOUT: Duration = Duration::from_millis(50);
const READ_TIMEOUT: Duration = Duration::from_millis(200);
const NET_CLIENT_MAX: usize = 8;

/// 启动时建链（绑定/连接/开串口失败 → vdev_start 直接 Err，不留半开状态）；
/// 读线程随 FLAG 退出。仿真主循环只碰 emit——全部非阻塞/短超时，绝不拖节拍。
fn open_net(spec: &VDevNet) -> Result<(NetLink, Arc<NetCounters>), String> {
    let counters = Arc::new(NetCounters::default());
    match spec.transport.as_str() {
        "udp" => {
            let target = parse_addr(&spec.host, spec.port, "UDP 目标")?;
            let mut out = vec![make_udp_sock(&target)?];
            for (i, t) in spec.extra_targets.iter().take(4).enumerate() {
                let a2 = parse_addr(&t.host, t.port, &format!("UDP 附加目标 {i}"))?;
                out.push(make_udp_sock(&a2)?);
            }
            if spec.listen_port != 0 {
                let lb = if spec.listen_bind.is_empty() { "127.0.0.1".to_string() } else { spec.listen_bind.clone() };
                let bind = parse_addr(&lb, spec.listen_port, "UDP 监听")?;
                let c = counters.clone();
                std::thread::spawn(move || {
                    let sock = match UdpSocket::bind(bind) {
                        Ok(s) => s,
                        Err(e) => {
                            c.set_err(&format!("监听 {bind} 失败：{e}"));
                            return;
                        }
                    };
                    let _ = sock.set_read_timeout(Some(READ_TIMEOUT));
                    let mut buf = [0u8; 2048];
                    while FLAG.load(Ordering::SeqCst) {
                        match sock.recv_from(&mut buf) {
                            Ok((0, _)) => continue,
                            Ok((n, peer)) => {
                                handle_command(&c, &buf[..n], |reply| {
                                    let _ = sock.send_to(reply, peer);
                                });
                            }
                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
                            Err(_) => break,
                        }
                    }
                });
            }
            Ok((NetLink::Udp { out }, counters))
        }
        "tcp-client" => {
            let peer = parse_addr(&spec.host, spec.port, "TCP 对端")?;
            let stream = TcpStream::connect_timeout(&peer, Duration::from_millis(800))
                .map_err(|e| format!("TCP 连接 {peer} 失败：{e}（对端需先监听）"))?;
            configure_tcp(&stream);
            let reader = stream.try_clone().map_err(|e| e.to_string())?;
            let c = counters.clone();
            std::thread::spawn(move || tcp_reader(reader, c));
            Ok((
                NetLink::TcpClient { stream, peer, peer_str: peer.to_string(), retry_at: Instant::now() },
                counters,
            ))
        }
        "tcp-server" => {
            let bind = if spec.bind.is_empty() { "127.0.0.1".to_string() } else { spec.bind.clone() };
            let addr = parse_addr(&bind, spec.port, "TCP 监听")?;
            let listener = TcpListener::bind(addr).map_err(|e| format!("TCP 监听 {addr} 失败：{e}（端口占用？）"))?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let clients: Arc<Mutex<Vec<Arc<NetClient>>>> = Arc::new(Mutex::new(Vec::new()));
            let c = counters.clone();
            let cl = clients.clone();
            std::thread::spawn(move || {
                while FLAG.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, peer)) => {
                            if cl.lock().map(|v| v.len()).unwrap_or(0) >= NET_CLIENT_MAX {
                                c.set_err(&format!("客户端数已达上限 {NET_CLIENT_MAX}，拒绝 {peer}"));
                                continue;
                            }
                            configure_tcp(&stream);
                            let client = Arc::new(NetClient { addr: peer, stream: Mutex::new(stream) });
                            if let Ok(mut v) = cl.lock() {
                                v.push(client.clone());
                            }
                            let cc = c.clone();
                            let cl2 = cl.clone();
                            std::thread::spawn(move || {
                                let mut reader = client
                                    .stream
                                    .lock()
                                    .ok()
                                    .and_then(|g| g.try_clone().ok());
                                if let Some(ref mut r) = reader {
                                    let mut buf = [0u8; 2048];
                                    while FLAG.load(Ordering::SeqCst) {
                                        match r.read(&mut buf) {
                                            Ok(0) => break,
                                            Ok(n) => handle_command(&cc, &buf[..n], |reply| {
                                                if let Ok(mut w) = client.stream.lock() {
                                                    let _ = w.write_all(reply);
                                                }
                                            }),
                                            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
                                            Err(_) => break,
                                        }
                                    }
                                }
                                if let Ok(mut v) = cl2.lock() {
                                    v.retain(|x| !Arc::ptr_eq(x, &client));
                                }
                            });
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        Err(_) => break,
                    }
                }
            });
            Ok((NetLink::TcpServer { clients }, counters))
        }
        "serial" => {
            let baud = if spec.baud == 0 { 115200 } else { spec.baud };
            let port = serialport::new(spec.path.trim(), baud)
                .timeout(WRITE_TIMEOUT)
                .open()
                .map_err(|e| format!("打开串口 {} 失败：{e}（被占用或不存在？）", spec.path))?;
            // 读线程持有自己的克隆句柄：读命令 + 回写应答都在它手里；主循环用原句柄发帧
            let mut reader = port.try_clone().map_err(|e| e.to_string())?;
            let c = counters.clone();
            std::thread::spawn(move || {
                let _ = reader.set_timeout(READ_TIMEOUT);
                let mut buf = [0u8; 512];
                while FLAG.load(Ordering::SeqCst) {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let mut sink = reader.try_clone().ok();
                            handle_command(&c, &buf[..n], move |reply| {
                                if let Some(s) = &mut sink {
                                    let _ = s.write_all(reply);
                                }
                            });
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(_) => break,
                    }
                }
            });
            Ok((NetLink::Serial { port }, counters))
        }
        other => Err(format!("不支持的网络链路类型 {other}")),
    }
}

fn make_udp_sock(target: &SocketAddr) -> Result<(UdpSocket, SocketAddr), String> {
    let sock = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("UDP 本地套接字失败：{e}"))?;
    if target.ip().to_string().ends_with(".255") {
        let _ = sock.set_broadcast(true);
    }
    sock.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok((sock, *target))
}

fn configure_tcp(stream: &TcpStream) {
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_nodelay(true);
}

fn tcp_reader(mut stream: TcpStream, counters: Arc<NetCounters>) {
    let mut buf = [0u8; 2048];
    while FLAG.load(Ordering::SeqCst) {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let mut sink = stream.try_clone().ok();
                handle_command(&counters, &buf[..n], move |reply| {
                    if let Some(s) = &mut sink {
                        let _ = s.write_all(reply);
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => break,
        }
    }
}

/// 命令处理：RUNTIME 锁内 apply，锁外写回应答（reply_sink 由链路决定去向）。
fn handle_command(counters: &Arc<NetCounters>, bytes: &[u8], reply_sink: impl FnOnce(&[u8])) {
    counters.in_recv.fetch_add(1, Ordering::Relaxed);
    counters.set_cmd(bytes);
    let reply = {
        let mut guard = match RUNTIME.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_mut() {
            Some(rt) => apply_command(rt, bytes).unwrap_or(None),
            None => None,
        }
    };
    if let Some(r) = reply {
        reply_sink(&r);
    }
}

/// 每拍发射：非阻塞/短超时，失败只计数不阻塞仿真循环
fn net_emit(rt: &mut VdevRuntime, frame: &[u8]) {
    let Some(handle) = &mut rt.net else { return };
    let c = handle.counters.clone();
    match &mut handle.link {
        NetLink::Udp { out } => {
            let mut sent_any = false;
            for (sock, addr) in out.iter() {
                match sock.send_to(frame, *addr) {
                    Ok(n) => {
                        sent_any = true;
                        c.out_bytes.fetch_add(n as u64, Ordering::Relaxed);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        c.out_errs.fetch_add(1, Ordering::Relaxed);
                        c.set_err("UDP 发送缓冲满，丢帧");
                    }
                    Err(e) => {
                        c.out_errs.fetch_add(1, Ordering::Relaxed);
                        c.set_err(&e.to_string());
                    }
                }
            }
            if sent_any {
                c.out_sent.fetch_add(1, Ordering::Relaxed);
            }
        }
        NetLink::TcpClient { stream, peer, peer_str, retry_at } => {
            match stream.write_all(frame) {
                Ok(()) => {
                    c.out_sent.fetch_add(1, Ordering::Relaxed);
                    c.out_bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    c.out_errs.fetch_add(1, Ordering::Relaxed);
                    c.set_err(&format!("TCP 对端 {peer_str}：{e}"));
                    let now = Instant::now();
                    if now >= *retry_at {
                        *retry_at = now + Duration::from_secs(1);
                        if let Ok(s) = TcpStream::connect_timeout(peer, Duration::from_millis(80)) {
                            configure_tcp(&s);
                            if let Ok(r) = s.try_clone() {
                                let cc = c.clone();
                                std::thread::spawn(move || tcp_reader(r, cc));
                            }
                            *stream = s;
                        }
                    }
                }
            }
        }
        NetLink::TcpServer { clients } => {
            let mut sent_any = false;
            if let Ok(mut v) = clients.lock() {
                v.retain(|cl| {
                    let ok = match cl.stream.lock() {
                        Ok(mut st) => st.write_all(frame).is_ok(),
                        Err(_) => false,
                    };
                    if ok {
                        sent_any = true;
                    }
                    ok
                });
                c.clients.store(v.len() as u64, Ordering::Relaxed);
            }
            if sent_any {
                c.out_sent.fetch_add(1, Ordering::Relaxed);
                c.out_bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
            }
        }
        NetLink::Serial { port } => {
            match port.write_all(frame) {
                Ok(()) => {
                    c.out_sent.fetch_add(1, Ordering::Relaxed);
                    c.out_bytes.fetch_add(frame.len() as u64, Ordering::Relaxed);
                }
                Err(e) => {
                    c.out_errs.fetch_add(1, Ordering::Relaxed);
                    c.set_err(&format!("串口写失败：{e}"));
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VdevStatus {
    pub running: bool,
    pub device: Option<String>,
    pub net: Option<NetStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    pub transport: String,
    pub target: String,
    pub out_sent: u64,
    pub out_bytes: u64,
    pub out_errs: u64,
    pub in_recv: u64,
    pub clients: u64,
    pub last_error: Option<String>,
    pub last_cmd: Option<String>,
}

fn net_target(spec: &VDevNet) -> String {
    match spec.transport.as_str() {
        "udp" => {
            let base = format!("{}:{}", if spec.host.is_empty() { "127.0.0.1" } else { &spec.host }, spec.port);
            let mut t = format!("发 {base}");
            if !spec.extra_targets.is_empty() {
                t.push_str(&format!(" +{}", spec.extra_targets.len()));
            }
            if spec.listen_port != 0 {
                t.push_str(&format!(" · 听 {}:{}", if spec.listen_bind.is_empty() { "127.0.0.1" } else { &spec.listen_bind }, spec.listen_port));
            }
            t
        }
        "tcp-client" => format!("连 {}:{}", spec.host, spec.port),
        "tcp-server" => format!("听 {}:{}", if spec.bind.is_empty() { "127.0.0.1" } else { &spec.bind }, spec.port),
        "serial" => format!("{} @{}", spec.path, if spec.baud == 0 { 115200 } else { spec.baud }),
        _ => String::new(),
    }
}

/* ================= Tauri 命令 ================= */

#[tauri::command]
pub fn vdev_start(
    spec: String,
    app: AppHandle,
    state: State<'_, SerialManager>,
) -> Result<(), String> {
    if FLAG.load(Ordering::SeqCst) {
        return Err("虚拟设备已在运行".into());
    }
    // 与回放互斥（同一 ingest 入口的双源防御）
    if crate::session::is_playing() {
        return Err("回放进行中，请先停止回放再启动虚拟设备".into());
    }
    if state.serial_connected() {
        return Err("串口已连接：虚拟设备与真实接口互斥，请先断开连接".into());
    }
    let mut rt = parse_spec(&spec)?;
    let period = rt.spec.period_ms;
    // 建链失败（端口占用/对端不通/串口被占）→ 启动即失败，不留半开状态
    if let Some(net) = &rt.spec.net {
        let (link, counters) = open_net(net)?;
        rt.net = Some(NetHandle { link, counters });
    }
    // 虚拟设备与演示源同为本地数据源：启动虚拟设备时自动停演示源（前端会 toast 提示）
    crate::demo::stop_demo(&state.demo_flag);
    *RUNTIME.lock().map_err(|_| "虚拟设备状态锁中毒")? = Some(rt);
    FLAG.store(true, Ordering::SeqCst);
    let ctx = state.ctx.clone();
    std::thread::spawn(move || vdev_loop(app, ctx, period));
    Ok(())
}

#[tauri::command]
pub fn vdev_stop() {
    FLAG.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = RUNTIME.lock() {
        *guard = None;
    }
}

#[tauri::command]
pub fn vdev_running() -> bool {
    running()
}

/// 面板/AI 轮询：运行态 + 网络链路计数与最近错误（纯读锁，开销可忽略）
#[tauri::command]
pub fn vdev_status() -> VdevStatus {
    let guard = match RUNTIME.lock() {
        Ok(g) => g,
        Err(_) => return VdevStatus { running: false, device: None, net: None },
    };
    let rt = match guard.as_ref() {
        Some(rt) => rt,
        None => return VdevStatus { running: false, device: None, net: None },
    };
    let net = match (&rt.spec.net, rt.net.as_ref()) {
        (Some(spec), Some(handle)) => {
            let c = &handle.counters;
            let ld = c.last_error.lock().ok().map(|g| g.clone()).filter(|x| !x.is_empty());
            let lc = c.last_cmd.lock().ok().map(|g| g.clone()).filter(|x| !x.is_empty());
            Some(NetStatus {
                transport: spec.transport.clone(),
                target: net_target(spec),
                out_sent: c.out_sent.load(Ordering::Relaxed),
                out_bytes: c.out_bytes.load(Ordering::Relaxed),
                out_errs: c.out_errs.load(Ordering::Relaxed),
                in_recv: c.in_recv.load(Ordering::Relaxed),
                clients: c.clients.load(Ordering::Relaxed),
                last_error: ld,
                last_cmd: lc,
            })
        }
        _ => None,
    };
    VdevStatus { running: true, device: Some(rt.spec.name.clone()), net }
}

/* ================= 单测 ================= */

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_json() -> String {
        r#"{
          "name": "温控炉", "periodMs": 100,
          "frame": {
            "header": "54 4D",
            "fields": [
              {"signal": "temp", "type": "int16", "endian": "little", "scale": 0.1},
              {"signal": "heater", "type": "uint8"}
            ],
            "checksum": "sum8"
          },
          "inputs": [{"name": "heaterCmd", "value": 0}],
          "signals": [
            {"name": "heater", "model": "mirror", "of": "heaterCmd"},
            {"name": "temp", "model": "firstOrder", "from": "heaterCmd", "gain": 35, "tau": 2, "ambient": 25, "init": 25}
          ],
          "commands": [
            {"match": {"type": "ascii", "prefix": "HEAT ON"}, "set": {"heaterCmd": 1}, "reply": {"type": "ascii", "text": "OK\n"}},
            {"match": {"type": "ascii", "prefix": "HEAT OFF"}, "set": {"heaterCmd": 0}}
          ]
        }"#
        .to_string()
    }

    #[test]
    fn spec_parses_and_validates() {
        let rt = parse_spec(&spec_json()).unwrap();
        assert_eq!(rt.spec.signals.len(), 2);
        assert_eq!(rt.sim.inputs.get("heaterCmd"), Some(&0.0));
        assert!(parse_spec("{\"name\":\"x\",\"periodMs\":5,\"frame\":{\"fields\":[]},\"signals\":[]}").is_err());
        // 引用不存在的输入量 / 信号名重复 都必须被拒绝
        assert!(parse_spec(r#"{"name":"x","frame":{"fields":[]},"inputs":[],"signals":[{"name":"a","model":"firstOrder","from":"ghost","gain":1,"tau":1}]}"#).is_err());
        assert!(parse_spec(r#"{"name":"x","frame":{"fields":[]},"signals":[{"name":"a","model":"const","value":0},{"name":"a","model":"const","value":1}]}"#).is_err());
    }

    #[test]
    fn first_order_converges_to_gain_times_input() {
        let rt = parse_spec(&spec_json()).unwrap();
        let mut sim = rt.sim;
        sim.inputs.insert("heaterCmd".into(), 1.0);
        let dt = 0.1;
        for _ in 0..2000 {
            evaluate(&rt.spec, &mut sim, dt);
        }
        let temp = sim.vals.get("temp").unwrap();
        assert!(
            (temp - 60.0).abs() < 0.5,
            "一阶模型应收敛到 ambient+gain·u=60（实测 {temp}）"
        );
    }

    #[test]
    fn sine_hits_offset_and_amp() {
        let json = r#"{"name":"s","periodMs":100,
            "frame":{"header":"AA","fields":[{"signal":"x","type":"float32"}],"checksum":"none"},
            "signals":[{"name":"x","model":"sine","amp":2,"freqHz":1,"offset":5}]}"#;
        let rt = parse_spec(json).unwrap();
        let mut sim = rt.sim;
        evaluate(&rt.spec, &mut sim, 0.0);
        assert!((sim.vals["x"] - 5.0).abs() < 1e-6, "t=0 相位 0 → offset");
        sim.t = 0.25;
        evaluate(&rt.spec, &mut sim, 0.0);
        assert!((sim.vals["x"] - 7.0).abs() < 1e-6, "1Hz 四分之一周期 → offset+amp");
    }

    #[test]
    fn frame_packing_with_scale_and_sum8() {
        let rt = parse_spec(&spec_json()).unwrap();
        let mut vals = BTreeMap::new();
        vals.insert("temp".to_string(), 257.0); // 0.1 刻度 → 2570
        vals.insert("heater".to_string(), 1.0);
        let f = pack_frame(&rt.spec.frame, &vals).unwrap();
        assert_eq!(f[0], 0x54);
        assert_eq!(f[1], 0x4D);
        assert_eq!(&f[2..4], &0x0A0Au16.to_le_bytes(), "257/0.1=2570=0x0A0A 小端");
        assert_eq!(f[4], 1);
        let sum = f[..f.len() - 1].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        assert_eq!(f[5], sum, "末字节应为 sum8");
    }

    #[test]
    fn commands_match_set_and_reply() {
        let mut rt = parse_spec(&spec_json()).unwrap();
        let reply = apply_command(&mut rt, b"HEAT ON\n").unwrap();
        assert_eq!(reply, Some(b"OK\n".to_vec()));
        assert_eq!(*rt.sim.inputs.get("heaterCmd").unwrap(), 1.0);
        assert!(rt.sim.pending_replies.is_empty()); // 去向由调用方决定，apply 不直接入队
        assert_eq!(apply_command(&mut rt, b"HEAT OFF\n").unwrap(), None);
        assert_eq!(*rt.sim.inputs.get("heaterCmd").unwrap(), 0.0);
        // 未知命令静默消费（像真设备忽略）
        assert_eq!(apply_command(&mut rt, b"???\n").unwrap(), None);
    }

    #[test]
    fn hex_prefix_match_and_stuck_fault() {
        let json = r#"{"name":"h","periodMs":100,
            "frame":{"header":"AA","fields":[{"signal":"x","type":"uint8"}],"checksum":"none"},
            "signals":[{"name":"x","model":"const","value":7}],
            "faults":{"stuckPct":100},
            "commands":[{"match":{"type":"hex","prefix":"A0 01"},"set":{"tgt":9}}]}"#;
        let mut rt = parse_spec(json).unwrap();
        assert_eq!(apply_command(&mut rt, &[0xA0, 0x01, 0xFF]).unwrap(), None);
        assert_eq!(*rt.sim.inputs.get("tgt").unwrap(), 9.0);
        // stuck=100%：第一拍产出真值帧，第二拍重发旧帧
        let VdevRuntime { spec, sim, .. } = &mut rt;
        let f1 = generate_tick(spec, sim, 0.1).unwrap();
        let f2 = generate_tick(spec, sim, 0.1).unwrap();
        assert_eq!(f1, f2);
    }

    #[test]
    fn net_validation() {
        let base = r#"{"name":"n","frame":{"fields":[{"signal":"x","type":"uint8"}]},"signals":[{"name":"x","model":"const","value":0}],"net":"#;
        assert!(parse_spec(&format!(r#"{base}{{"transport":"udp","port":0}}}}"#)).is_err(), "UDP 缺目标端口");
        assert!(parse_spec(&format!(r#"{base}{{"transport":"tcp-server","bind":"0.0.0.1","port":9}}}}"#)).is_err(), "bind 白名单");
        assert!(parse_spec(&format!(r#"{base}{{"transport":"udp","host":"127.0.0.1","port":9,"listenPort":9}}}}"#)).is_err(), "发射=监听自环");
        assert!(parse_spec(&format!(r#"{base}{{"transport":"carrier-pigeon"}}}}"#)).is_err(), "未知链路");
        // 串口只校验不实际开端口
        assert!(parse_spec(&format!(r#"{base}{{"transport":"serial","path":"COM9","baud":115200}}}}"#)).is_ok());
    }

    #[test]
    fn command_capture_number_and_validation() {
        let json = r#"{"name":"c","periodMs":100,
            "frame":{"header":"AA","fields":[{"signal":"x","type":"uint8"}],"checksum":"none"},
            "inputs":[{"name":"duty","value":0}],
            "signals":[{"name":"x","model":"const","value":7}],
            "commands":[{"match":{"type":"ascii","prefix":"SET DUTY ","captureNumber":true,"setInput":"duty"},"reply":{"type":"ascii","text":"OK\n"}}]}"#;
        let mut rt = parse_spec(json).unwrap();
        assert_eq!(apply_command(&mut rt, b"SET DUTY 45\r\n").unwrap(), Some(b"OK\n".to_vec()));
        assert_eq!(*rt.sim.inputs.get("duty").unwrap(), 45.0);
        // 畸形数值：按未命中处理（像真设备拒收）
        assert_eq!(apply_command(&mut rt, b"SET DUTY abc").unwrap(), None);
        assert_eq!(*rt.sim.inputs.get("duty").unwrap(), 45.0);
        // 校验：捕获必须 ascii + 已声明输入量
        let base = r#"{"name":"c","frame":{"fields":[{"signal":"x","type":"uint8"}]},"inputs":[],"signals":[{"name":"x","model":"const","value":0}],"commands":[{"match":{"type":"ascii","prefix":"S","captureNumber":true,"setInput":"ghost"}}]}"#;
        assert!(parse_spec(base).is_err());
        let base2 = r#"{"name":"c","frame":{"fields":[{"signal":"x","type":"uint8"}]},"inputs":[{"name":"duty","value":0}],"signals":[{"name":"x","model":"const","value":0}],"commands":[{"match":{"type":"hex","prefix":"A0","captureNumber":true,"setInput":"duty"}}]}"#;
        assert!(parse_spec(base2).is_err());
    }

    #[test]
    fn udp_multi_target_delivers_to_all() {
        let rx1 = UdpSocket::bind("127.0.0.1:0").unwrap();
        let rx2 = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx1.set_read_timeout(Some(Duration::from_millis(800))).unwrap();
        rx2.set_read_timeout(Some(Duration::from_millis(800))).unwrap();
        let a1 = rx1.local_addr().unwrap();
        let a2 = rx2.local_addr().unwrap();
        let json = format!(
            r#"{{"name":"m","periodMs":50,"frame":{{"header":"AA","fields":[{{"signal":"x","type":"uint8"}}],"checksum":"none"}},"signals":[{{"name":"x","model":"const","value":9}}],"net":{{"transport":"udp","host":"127.0.0.1","port":{},"extraTargets":[{{"host":"127.0.0.1","port":{}}}]}}}}"#,
            a1.port(),
            a2.port()
        );
        let mut rt = parse_spec(&json).unwrap();
        let (link, counters) = open_net(rt.spec.net.as_ref().unwrap()).unwrap();
        rt.net = Some(NetHandle { link, counters });
        let frame = pack_frame(&rt.spec.frame, &rt.sim.vals).unwrap();
        net_emit(&mut rt, &frame);
        let mut b1 = [0u8; 64];
        let mut b2 = [0u8; 64];
        assert_eq!(rx1.recv(&mut b1).unwrap(), frame.len());
        assert_eq!(rx2.recv(&mut b2).unwrap(), frame.len());
        assert_eq!(&b1[..frame.len()], &frame[..]);
        assert_eq!(&b2[..frame.len()], &frame[..]);
        assert_eq!(rt.net.as_ref().unwrap().counters.out_sent.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn udp_out_delivers_frames() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(Duration::from_millis(800))).unwrap();
        let addr = rx.local_addr().unwrap();
        let json = format!(
            r#"{{"name":"n","periodMs":50,"frame":{{"header":"AA","fields":[{{"signal":"x","type":"uint8"}}],"checksum":"none"}},"signals":[{{"name":"x","model":"const","value":7}}],"net":{{"transport":"udp","host":"127.0.0.1","port":{}}}}}"#,
            addr.port()
        );
        let mut rt = parse_spec(&json).unwrap();
        let (link, counters) = open_net(rt.spec.net.as_ref().unwrap()).unwrap();
        rt.net = Some(NetHandle { link, counters });
        let frame = pack_frame(&rt.spec.frame, &rt.sim.vals).unwrap();
        net_emit(&mut rt, &frame);
        let mut buf = [0u8; 64];
        let n = rx.recv(&mut buf).unwrap();
        assert_eq!(&buf[..n], &frame[..], "UDP 收到的字节应与 ingest 帧逐字节相同");
        assert_eq!(rt.net.as_ref().unwrap().counters.out_sent.load(Ordering::Relaxed), 1);
    }
}
