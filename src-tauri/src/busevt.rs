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
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::parser::FramesEvent;

const MSG_FRAMES: u8 = 1;
const MSG_RX: u8 = 2;
const MSG_TX: u8 = 3;
const NONE16: u16 = 0xFFFF;

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

pub fn send_frames(app: &AppHandle, ev: &FramesEvent) {
    if let Some(ch) = take_channel(app) {
        let buf = encode_frames(ev);
        let _ = ch.send(InvokeResponseBody::Raw(buf));
    } else {
        let _ = app.emit("parser:frames", ev);
    }
}

pub fn send_rx(app: &AppHandle, ts_first: u64, ts_last: u64, bytes: &[u8]) {
    if let Some(ch) = take_channel(app) {
        let buf = encode_rx(ts_first, ts_last, ts_now(), bytes);
        let _ = ch.send(InvokeResponseBody::Raw(buf));
    } else {
        let _ = app.emit(
            "serial:rx",
            crate::serial::RxEvent {
                bytes: bytes.to_vec(),
                ts_first,
                ts_last,
                emit_ts: ts_now(),
            },
        );
    }
}

pub fn send_tx(app: &AppHandle, ts: u64, bytes: &[u8]) {
    if let Some(ch) = take_channel(app) {
        let buf = encode_tx(ts, bytes);
        let _ = ch.send(InvokeResponseBody::Raw(buf));
    } else {
        let _ = app.emit("serial:tx", crate::serial::TxEvent { bytes: bytes.to_vec(), ts });
    }
}

fn ts_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
