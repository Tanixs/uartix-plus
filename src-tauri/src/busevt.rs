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

pub fn send_frames(app: &AppHandle, ev: &FramesEvent) {
    // 会话录制 tap（单点覆盖串口/网络/演示源等一切帧源；录制与回放互斥，
    // 回放经过此处时 recording 恒为 false，不会二次入库）
    crate::session::tap_frames(app, ev);
    if let Some(ch) = take_channel(app) {
        let buf = encode_frames(ev);
        let _ = ch.send(InvokeResponseBody::Raw(buf));
    } else {
        let _ = app.emit("parser:frames", ev);
    }
}

pub fn send_rx(app: &AppHandle, ts_first: u64, ts_last: u64, bytes: &[u8]) {
    // 会话录制 RX tap（ingest 单点覆盖一切帧源；回放重灌时 recording 恒 false）
    crate::session::tap_rx(app, ts_first, bytes);
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
        enc.truncate(n - 1); // 截断 → 溢出保护生效
        assert!(decode_frames(&enc).is_none());
    }
}
