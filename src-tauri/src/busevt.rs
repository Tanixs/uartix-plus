//! 二进制 IPC 总线：替代 JSON 事件的字节级通道。
//!
//! Tauri 的 `emit` 事件永远走 JSON 序列化：结构化行（模板名/颜色/字段名等
//! 字符串每帧重复）+ base64 字节负载（+33% 体积）。本模块用 Tauri 2 的
//! `Channel` + `InvokeResponseBody::Raw` 直推 ArrayBuffer——JS 侧零
//! base64、零 JSON.parse，字符串经每批去重字典只传一次。
//!
//! 消息格式（小端）：
//! ```text
//! u8  msg_type            1=frames 2=rx 3=tx
//! [frames]
//!   u64 emit_ts, total, errors, dropped
//!   u16 dict_len; dict_len × { u16 len, utf8 bytes }
//!   u32 row_len; row × {
//!     u16 tpl_id, tpl_name, color          ← 字典索引
//!     u64 ts_ms, seq; u32 len
//!     u8 valid; u16 err_idx(0xFFFF=无); u8 has_bytes
//!     [has_bytes] u32 len, bytes           ← 原始字节，非 base64
//!     u16 field_len; field × {
//!       u16 id_idx, name_idx; f64 raw, value; u8 has_text
//!       [has_text] u16 text_idx }
//!   }
//! [rx]  u64 ts_first, ts_last, emit_ts; u32 len; bytes
//! [tx]  u64 ts; u32 len; bytes
//! ```
//!
//! 前端未注册 Channel（启动间隙）时回退旧 JSON 事件，二者不会同时生效：
//! 前端注册 Channel 的同时全部监听点已迁到本总线。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::parser::{FrameRow, FramesEvent};

const MSG_FRAMES: u8 = 1;
const MSG_RX: u8 = 2;
const MSG_TX: u8 = 3;
const NONE16: u16 = 0xFFFF;

/// 一次 flush 上限：正常 16ms 窗口远达不到，只在消费端卡死时兜底内存。
const MAX_PENDING_ROWS: usize = 8192;
const MAX_PENDING_RX: usize = 1024 * 1024;

/// 合批缓冲：frames 与 rx 各自积攒，flush 时各发一条消息。
struct Batcher {
    rows: Vec<FrameRow>,
    total: u64,
    errors: u64,
    dropped: u64,
    rx: Vec<u8>,
    rx_first: u64,
    rx_last: u64,
    since: Option<Instant>,
}

impl Batcher {
    const fn new() -> Self {
        Self {
            rows: Vec::new(),
            total: 0,
            errors: 0,
            dropped: 0,
            rx: Vec::new(),
            rx_first: 0,
            rx_last: 0,
            since: None,
        }
    }

    fn push_frames(&mut self, ev: FramesEvent) {
        if self.since.is_none() {
            self.since = Some(Instant::now());
        }
        self.rows.extend(ev.rows);
        self.total = ev.total;
        self.errors = ev.errors;
        self.dropped = ev.dropped;
    }

    fn push_rx(&mut self, ts_first: u64, ts_last: u64, bytes: &[u8]) {
        if self.since.is_none() {
            self.since = Some(Instant::now());
        }
        if self.rx.is_empty() {
            self.rx_first = ts_first;
        }
        self.rx_last = ts_last;
        self.rx.extend_from_slice(bytes);
    }

    fn is_empty(&self) -> bool {
        self.rows.is_empty() && self.rx.is_empty()
    }

    fn due(&self, window: Duration, now: Instant) -> bool {
        self.since
            .map_or(false, |t| now.saturating_duration_since(t) >= window)
    }

    fn over_cap(&self) -> bool {
        self.rows.len() >= MAX_PENDING_ROWS || self.rx.len() >= MAX_PENDING_RX
    }

    fn take_frames(&mut self) -> Option<FramesEvent> {
        if self.rows.is_empty() {
            return None;
        }
        Some(FramesEvent {
            rows: std::mem::take(&mut self.rows),
            total: self.total,
            errors: self.errors,
            dropped: self.dropped,
            emit_ts: ts_now(),
        })
    }

    fn take_rx(&mut self) -> Option<(u64, u64, Vec<u8>)> {
        if self.rx.is_empty() {
            return None;
        }
        Some((self.rx_first, self.rx_last, std::mem::take(&mut self.rx)))
    }
}

static PENDING: Mutex<Batcher> = Mutex::new(Batcher::new());
static FLUSHER: AtomicBool = AtomicBool::new(false);
static WINDOW_MS: OnceLock<u64> = OnceLock::new();

/// 默认 16ms（≈60Hz）；`UARTIX_IPC_BATCH_MS=0` 关闭合批，回到逐事件发送。
fn batch_window_ms() -> u64 {
    *WINDOW_MS.get_or_init(|| {
        std::env::var("UARTIX_IPC_BATCH_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(16)
    })
}

/// IPC 分段计数：只做观测，不参与发送决策。
struct IpcCounters {
    frames_in: AtomicU64,
    frames_rows_in: AtomicU64,
    frames_out: AtomicU64,
    frames_rows_out: AtomicU64,
    rx_in: AtomicU64,
    rx_bytes_in: AtomicU64,
    rx_out: AtomicU64,
    flushes: AtomicU64,
    send_us: AtomicU64,
    send_err: AtomicU64,
}

impl IpcCounters {
    const fn new() -> Self {
        Self {
            frames_in: AtomicU64::new(0),
            frames_rows_in: AtomicU64::new(0),
            frames_out: AtomicU64::new(0),
            frames_rows_out: AtomicU64::new(0),
            rx_in: AtomicU64::new(0),
            rx_bytes_in: AtomicU64::new(0),
            rx_out: AtomicU64::new(0),
            flushes: AtomicU64::new(0),
            send_us: AtomicU64::new(0),
            send_err: AtomicU64::new(0),
        }
    }
}

static IPC: IpcCounters = IpcCounters::new();

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcStatsOut {
    frames_in: u64,
    frames_rows_in: u64,
    frames_out: u64,
    frames_rows_out: u64,
    rx_in: u64,
    rx_bytes_in: u64,
    rx_out: u64,
    flushes: u64,
    send_us: u64,
    send_err: u64,
    batch_ms: u64,
    pending_rows: u64,
    pending_rx_bytes: u64,
    ingest_stage: u64,
    demo_stage: u64,
    demo_tick: u64,
    hex_fetches: u64,
    hex_fetch_us: u64,
    span_scans: u64,
}

/// 活体诊断：perf-live 通过 invoke 读取，判断冻结在发送端还是接收端。
#[tauri::command]
pub fn ipc_stats() -> IpcStatsOut {
    let (pending_rows, pending_rx_bytes) = PENDING
        .lock()
        .map(|b| (b.rows.len() as u64, b.rx.len() as u64))
        .unwrap_or((0, 0));
    IpcStatsOut {
        frames_in: IPC.frames_in.load(Ordering::Relaxed),
        frames_rows_in: IPC.frames_rows_in.load(Ordering::Relaxed),
        frames_out: IPC.frames_out.load(Ordering::Relaxed),
        frames_rows_out: IPC.frames_rows_out.load(Ordering::Relaxed),
        rx_in: IPC.rx_in.load(Ordering::Relaxed),
        rx_bytes_in: IPC.rx_bytes_in.load(Ordering::Relaxed),
        rx_out: IPC.rx_out.load(Ordering::Relaxed),
        flushes: IPC.flushes.load(Ordering::Relaxed),
        send_us: IPC.send_us.load(Ordering::Relaxed),
        send_err: IPC.send_err.load(Ordering::Relaxed),
        batch_ms: batch_window_ms(),
        pending_rows,
        pending_rx_bytes,
        ingest_stage: crate::pipeline::INGEST_STAGE.load(Ordering::Relaxed),
        demo_stage: crate::demo::DEMO_STAGE.load(Ordering::Relaxed),
        demo_tick: crate::demo::DEMO_TICK.load(Ordering::Relaxed),
        hex_fetches: crate::pipeline::HEX_FETCHES.load(Ordering::Relaxed),
        hex_fetch_us: crate::pipeline::HEX_FETCH_US.load(Ordering::Relaxed),
        span_scans: crate::pipeline::SPAN_SCANS.load(Ordering::Relaxed),
    }
}

/// 已注册的前端通道（注册即代表前端已全部迁移到二进制监听）
#[derive(Default)]
pub struct BinBus {
    ch: Mutex<Option<Channel>>,
}

#[tauri::command]
pub fn ipc_subscribe(channel: Channel, bus: State<BinBus>) {
    if let Ok(mut guard) = bus.ch.lock() {
        *guard = Some(channel);
    }
}

// ---------- 编码 ----------

struct Enc {
    buf: Vec<u8>,
}

impl Enc {
    fn new(t: u8) -> Self {
        Self { buf: vec![t] }
    }
    fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn f64(&mut self, v: f64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    fn raw(&mut self, b: &[u8]) {
        self.buf.extend_from_slice(b);
    }
}

fn dict_put<'a>(map: &mut HashMap<&'a str, u16>, dict: &mut Vec<&'a str>, s: &'a str) -> u16 {
    if let Some(i) = map.get(s) {
        return *i;
    }
    let i = dict.len() as u16;
    map.insert(s, i);
    dict.push(s);
    i
}

pub fn encode_frames(ev: &FramesEvent) -> Vec<u8> {
    // 先扫一遍建字典（模板名/颜色/字段名/错误文本按批去重）
    let mut map: HashMap<&str, u16> = HashMap::new();
    let mut dict: Vec<&str> = Vec::new();
    for r in &ev.rows {
        dict_put(&mut map, &mut dict, &r.tpl_id);
        dict_put(&mut map, &mut dict, &r.tpl_name);
        dict_put(&mut map, &mut dict, &r.color);
        if let Some(e) = &r.error {
            dict_put(&mut map, &mut dict, e);
        }
        for f in &r.fields {
            dict_put(&mut map, &mut dict, &f.id);
            dict_put(&mut map, &mut dict, &f.name);
            if let Some(t) = &f.text {
                dict_put(&mut map, &mut dict, t);
            }
        }
    }

    let mut e = Enc::new(MSG_FRAMES);
    e.u64(ev.emit_ts);
    e.u64(ev.total);
    e.u64(ev.errors);
    e.u64(ev.dropped);
    e.u16(dict.len() as u16);
    for s in &dict {
        e.u16(s.len() as u16);
        e.raw(s.as_bytes());
    }
    e.u32(ev.rows.len() as u32);
    for r in &ev.rows {
        e.u16(map[r.tpl_id.as_str()]);
        e.u16(map[r.tpl_name.as_str()]);
        e.u16(map[r.color.as_str()]);
        e.u64(r.ts_ms);
        e.u64(r.seq);
        e.u32(r.len as u32);
        e.u8(u8::from(r.valid));
        match &r.error {
            Some(s) => e.u16(map[s.as_str()]),
            None => e.u16(NONE16),
        }
        if r.bytes.is_empty() {
            e.u8(0);
        } else {
            e.u8(1);
            e.u32(r.bytes.len() as u32);
            e.raw(&r.bytes);
        }
        e.u16(r.fields.len() as u16);
        for f in &r.fields {
            e.u16(map[f.id.as_str()]);
            e.u16(map[f.name.as_str()]);
            e.f64(f.raw);
            e.f64(f.value);
            match &f.text {
                Some(t) => {
                    e.u8(1);
                    e.u16(map[t.as_str()]);
                }
                None => e.u8(0),
            }
        }
    }
    e.buf
}

/// 线格式读取器（decode_frames 专用；输入不可信时返回 None，绝不 panic）
struct Dec<'a> {
    b: &'a [u8],
    p: usize,
}

impl<'a> Dec<'a> {
    fn need(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.p + n > self.b.len() {
            return None;
        }
        let s = &self.b[self.p..self.p + n];
        self.p += n;
        Some(s)
    }
    fn u8(&mut self) -> Option<u8> {
        self.need(1).map(|s| s[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.need(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.need(4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        self.need(8).map(|s| {
            u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
        })
    }
    fn f64(&mut self) -> Option<f64> {
        self.need(8).map(|s| {
            f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
        })
    }
}

/// encode_frames 的逆变换：`.usess` 回放线程用它把录制批次还原为
/// FramesEvent 后走 send_frames 单点重放（与真机同路径）。
pub fn decode_frames(buf: &[u8]) -> Option<FramesEvent> {
    let mut d = Dec { b: buf, p: 0 };
    if d.u8()? != MSG_FRAMES {
        return None;
    }
    let emit_ts = d.u64()?;
    let total = d.u64()?;
    let errors = d.u64()?;
    let dropped = d.u64()?;
    let dict_len = d.u16()? as usize;
    let mut dict: Vec<&str> = Vec::with_capacity(dict_len);
    for _ in 0..dict_len {
        let n = d.u16()? as usize;
        dict.push(std::str::from_utf8(d.need(n)?).ok()?);
    }
    let get = |i: u16, dict: &[&str]| -> Option<String> {
        dict.get(i as usize).map(|s| (*s).to_string())
    };
    let row_len = d.u32()? as usize;
    let mut rows = Vec::with_capacity(row_len);
    for _ in 0..row_len {
        let tpl_id = get(d.u16()?, &dict)?;
        let tpl_name = get(d.u16()?, &dict)?;
        let color = get(d.u16()?, &dict)?;
        let ts_ms = d.u64()?;
        let seq = d.u64()?;
        let len = d.u32()? as usize;
        let valid = d.u8()? != 0;
        let ei = d.u16()?;
        let error = if ei == NONE16 { None } else { Some(get(ei, &dict)?) };
        let bytes = if d.u8()? == 1 {
            let n = d.u32()? as usize;
            d.need(n)?.to_vec()
        } else {
            Vec::new()
        };
        let field_len = d.u16()? as usize;
        let mut fields = Vec::with_capacity(field_len);
        for _ in 0..field_len {
            let id = get(d.u16()?, &dict)?;
            let name = get(d.u16()?, &dict)?;
            let raw = d.f64()?;
            let value = d.f64()?;
            let text = if d.u8()? == 1 {
                Some(get(d.u16()?, &dict)?)
            } else {
                None
            };
            fields.push(crate::parser::FieldOut { id, name, raw, value, text });
        }
        rows.push(crate::parser::FrameRow {
            tpl_id,
            tpl_name,
            color,
            ts_ms,
            seq,
            len,
            valid,
            error,
            fields,
            bytes,
        });
    }
    Some(FramesEvent { rows, total, errors, dropped, emit_ts })
}

pub fn encode_rx(ts_first: u64, ts_last: u64, emit_ts: u64, bytes: &[u8]) -> Vec<u8> {
    let mut e = Enc::new(MSG_RX);
    e.u64(ts_first);
    e.u64(ts_last);
    e.u64(emit_ts);
    e.u32(bytes.len() as u32);
    e.raw(bytes);
    e.buf
}

pub fn encode_tx(ts: u64, bytes: &[u8]) -> Vec<u8> {
    let mut e = Enc::new(MSG_TX);
    e.u64(ts);
    e.u32(bytes.len() as u32);
    e.raw(bytes);
    e.buf
}

// ---------- 发送（带旧事件回退） ----------

fn take_channel(app: &AppHandle) -> Option<Channel> {
    let bus = app.state::<BinBus>();
    let guard = bus.ch.lock().ok()?;
    let ch = guard.clone();
    drop(guard);
    ch
}

fn flush(app: &AppHandle) {
    let (frames, rx) = match PENDING.lock() {
        Ok(mut b) => {
            let f = b.take_frames();
            let r = b.take_rx();
            if b.is_empty() {
                b.since = None;
            }
            (f, r)
        }
        Err(_) => (None, None),
    };
    if frames.is_none() && rx.is_none() {
        return;
    }
    IPC.flushes.fetch_add(1, Ordering::Relaxed);
    // 与逐事件时 ingest 的发送顺序一致：先 rx 再 frames。
    if let Some((first, last, bytes)) = rx {
        send_rx_now(app, first, last, &bytes);
    }
    if let Some(ev) = frames {
        send_frames_now(app, &ev);
    }
}

fn ensure_flusher(app: &AppHandle) {
    if FLUSHER.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(4));
        let window = batch_window_ms();
        if window == 0 {
            continue;
        }
        let due = PENDING
            .lock()
            .map(|b| !b.is_empty() && b.due(Duration::from_millis(window), Instant::now()))
            .unwrap_or(false);
        if due {
            flush(&app);
        }
    });
}

fn send_frames_now(app: &AppHandle, ev: &FramesEvent) {
    let t0 = Instant::now();
    let ok = if let Some(ch) = take_channel(app) {
        ch.send(InvokeResponseBody::Raw(encode_frames(ev))).is_ok()
    } else {
        app.emit("parser:frames", ev).is_ok()
    };
    IPC.frames_out.fetch_add(1, Ordering::Relaxed);
    IPC.frames_rows_out
        .fetch_add(ev.rows.len() as u64, Ordering::Relaxed);
    IPC.send_us
        .fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
    if !ok {
        IPC.send_err.fetch_add(1, Ordering::Relaxed);
    }
}

fn send_rx_now(app: &AppHandle, ts_first: u64, ts_last: u64, bytes: &[u8]) {
    let t0 = Instant::now();
    let ok = if let Some(ch) = take_channel(app) {
        let buf = encode_rx(ts_first, ts_last, ts_now(), bytes);
        ch.send(InvokeResponseBody::Raw(buf)).is_ok()
    } else {
        app.emit(
            "serial:rx",
            crate::serial::RxEvent {
                bytes: bytes.to_vec(),
                ts_first,
                ts_last,
                emit_ts: ts_now(),
            },
        )
        .is_ok()
    };
    IPC.rx_out.fetch_add(1, Ordering::Relaxed);
    IPC.send_us
        .fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
    if !ok {
        IPC.send_err.fetch_add(1, Ordering::Relaxed);
    }
}

pub fn send_frames(app: &AppHandle, ev: FramesEvent) {
    // 会话录制 tap（单点覆盖串口/网络/演示源等一切帧源；录制与回放互斥，
    // 回放经过此处时 recording 恒为 false，不会二次入库）
    crate::session::tap_frames(app, &ev);
    IPC.frames_in.fetch_add(1, Ordering::Relaxed);
    IPC.frames_rows_in
        .fetch_add(ev.rows.len() as u64, Ordering::Relaxed);
    if batch_window_ms() == 0 {
        send_frames_now(app, &ev);
        return;
    }
    let over = match PENDING.lock() {
        Ok(mut b) => {
            b.push_frames(ev);
            b.over_cap()
        }
        Err(_) => {
            send_frames_now(app, &ev);
            return;
        }
    };
    ensure_flusher(app);
    if over {
        flush(app);
    }
}

pub fn send_rx(app: &AppHandle, ts_first: u64, ts_last: u64, bytes: &[u8]) {
    // 会话录制 RX tap（ingest 单点覆盖一切帧源；回放重灌时 recording 恒 false）
    crate::session::tap_rx(app, ts_first, bytes);
    IPC.rx_in.fetch_add(1, Ordering::Relaxed);
    IPC.rx_bytes_in
        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
    if batch_window_ms() == 0 {
        send_rx_now(app, ts_first, ts_last, bytes);
        return;
    }
    let over = match PENDING.lock() {
        Ok(mut b) => {
            b.push_rx(ts_first, ts_last, bytes);
            b.over_cap()
        }
        Err(_) => {
            send_rx_now(app, ts_first, ts_last, bytes);
            return;
        }
    };
    ensure_flusher(app);
    if over {
        flush(app);
    }
}

pub fn send_tx(app: &AppHandle, ts: u64, bytes: &[u8]) {
    // 会话录制 TX tap（仅控制台气泡展示路径；回放时 TX 不外发端口）
    crate::session::tap_tx(app, ts, bytes);
    if let Some(ch) = take_channel(app) {
        let buf = encode_tx(ts, bytes);
        let _ = ch.send(InvokeResponseBody::Raw(buf));
    } else {
        let _ = app.emit("serial:tx", crate::serial::TxEvent { bytes: bytes.to_vec(), ts });
    }
}

/// 轻量提取批次 emit_ts（build_loaded 合并时间线用，避免全量解码）
pub fn peek_emit_ts(buf: &[u8]) -> Option<u64> {
    if buf.len() < 9 || buf[0] != MSG_FRAMES {
        return None;
    }
    let b: [u8; 8] = buf[1..9].try_into().ok()?;
    Some(u64::from_le_bytes(b))
}

fn ts_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{FieldOut, FrameRow};

    #[test]
    fn frames_encode_decode_roundtrip() {
        let ev = FramesEvent {
            rows: vec![
                FrameRow {
                    tpl_id: "tpl-1".into(),
                    tpl_name: "惯导 #帧头".into(),
                    color: "#4e9cef".into(),
                    ts_ms: 1_700_000_000_123,
                    seq: 42,
                    len: 11,
                    valid: true,
                    error: None,
                    fields: vec![
                        FieldOut { id: "roll".into(), name: "横滚".into(), raw: 12.5, value: 1.25, text: None },
                        FieldOut { id: "txt".into(), name: "文本".into(), raw: 0.0, value: 0.0, text: Some("OK\n,好".into()) },
                    ],
                    bytes: vec![0xAA, 0xFF, 0x03, 0x00, 1, 2, 3, 4, 5, 6, 0x55],
                },
                FrameRow {
                    tpl_id: "tpl-2".into(),
                    tpl_name: "坏帧".into(),
                    color: "#e5534b".into(),
                    ts_ms: 1_700_000_000_223,
                    seq: 53,
                    len: 4,
                    valid: false,
                    error: Some("校验和不匹配".into()),
                    fields: vec![],
                    bytes: vec![0x01, 0x02, 0x03, 0x04],
                },
                FrameRow {
                    tpl_id: "tpl-1".into(),
                    tpl_name: "无字节帧".into(),
                    color: "#333333".into(),
                    ts_ms: 9,
                    seq: 0,
                    len: 0,
                    valid: true,
                    error: None,
                    fields: vec![FieldOut { id: "a".into(), name: "b".into(), raw: f64::NAN, value: f64::INFINITY, text: None }],
                    bytes: vec![],
                },
            ],
            total: 100,
            errors: 3,
            dropped: 1,
            emit_ts: 1_700_000_000_999,
        };
        let enc = encode_frames(&ev);
        let dec = decode_frames(&enc).expect("decode should succeed");
        assert_eq!(dec.emit_ts, ev.emit_ts);
        assert_eq!(dec.total, ev.total);
        assert_eq!(dec.errors, ev.errors);
        assert_eq!(dec.dropped, ev.dropped);
        assert_eq!(dec.rows.len(), ev.rows.len());
        for (a, b) in dec.rows.iter().zip(ev.rows.iter()) {
            assert_eq!(a.tpl_id, b.tpl_id);
            assert_eq!(a.tpl_name, b.tpl_name);
            assert_eq!(a.color, b.color);
            assert_eq!(a.ts_ms, b.ts_ms);
            assert_eq!(a.seq, b.seq);
            assert_eq!(a.len, b.len);
            assert_eq!(a.valid, b.valid);
            assert_eq!(a.error, b.error);
            assert_eq!(a.bytes, b.bytes);
            assert_eq!(a.fields.len(), b.fields.len());
            for (fa, fb) in a.fields.iter().zip(b.fields.iter()) {
                assert_eq!(fa.id, fb.id);
                assert_eq!(fa.name, fb.name);
                assert_eq!(fa.text, fb.text);
                // NaN/Inf 仅做位型相等比较
                assert_eq!(fa.raw.to_bits(), fb.raw.to_bits());
                assert_eq!(fa.value.to_bits(), fb.value.to_bits());
            }
        }
    }

    #[test]
    fn decode_rejects_garbage() {
        assert!(decode_frames(&[0x7F, 1, 2, 3]).is_none());
        assert!(decode_frames(&[]).is_none());
        let mut enc = encode_frames(&FramesEvent {
            rows: vec![],
            total: 0,
            errors: 0,
            dropped: 0,
            emit_ts: 0,
        });
        let n = enc.len();
        enc.truncate(n - 1); // 截断 → 解码必须无效
        assert!(decode_frames(&enc).is_none());
    }

    fn batcher_row(seq: u64) -> FrameRow {
        FrameRow {
            tpl_id: "tpl".into(),
            tpl_name: "模板".into(),
            color: "#000000".into(),
            ts_ms: seq,
            seq,
            len: 0,
            valid: true,
            error: None,
            fields: vec![],
            bytes: vec![],
        }
    }

    fn batcher_ev(rows: Vec<FrameRow>, total: u64, errors: u64, dropped: u64) -> FramesEvent {
        FramesEvent {
            rows,
            total,
            errors,
            dropped,
            emit_ts: 0,
        }
    }

    #[test]
    fn batcher_merges_frames_in_order_and_takes_latest_totals() {
        let mut b = Batcher::new();
        b.push_frames(batcher_ev(vec![batcher_row(1), batcher_row(2)], 10, 1, 0));
        b.push_frames(batcher_ev(vec![batcher_row(3)], 11, 2, 1));
        let out = b.take_frames().expect("应有一批帧");
        assert_eq!(
            out.rows.iter().map(|r| r.seq).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!((out.total, out.errors, out.dropped), (11, 2, 1));
        assert!(b.take_frames().is_none());
        assert!(b.is_empty());
    }

    #[test]
    fn batcher_merges_rx_bytes_and_keeps_ts_range() {
        let mut b = Batcher::new();
        b.push_rx(100, 101, b"ab");
        b.push_rx(102, 103, b"cd");
        let (first, last, bytes) = b.take_rx().expect("应有一段 rx");
        assert_eq!((first, last), (100, 103));
        assert_eq!(bytes, b"abcd");
        assert!(b.take_rx().is_none());
    }

    #[test]
    fn batcher_due_only_after_window() {
        let mut b = Batcher::new();
        b.push_frames(batcher_ev(vec![batcher_row(1)], 1, 0, 0));
        let t0 = Instant::now();
        assert!(!b.due(Duration::from_millis(16), t0));
        assert!(b.due(Duration::from_millis(16), t0 + Duration::from_millis(17)));
    }

    #[test]
    fn batcher_flags_caps() {
        let mut b = Batcher::new();
        let mut ev = batcher_ev(vec![], 0, 0, 0);
        ev.rows = (0..MAX_PENDING_ROWS)
            .map(|i| batcher_row(i as u64))
            .collect();
        b.push_frames(ev);
        assert!(b.over_cap());

        let mut b = Batcher::new();
        b.push_rx(0, 0, &vec![0u8; MAX_PENDING_RX]);
        assert!(b.over_cap());
    }
}
