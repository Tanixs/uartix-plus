use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::parser::{FramesEvent, ParseRules, ParserEngine};
use crate::ring::RingBuffer;
use crate::serial::SerialManager;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: u64,
    pub len: u32,
    pub tpl_id: String,
    pub valid: bool,
}

pub struct SpanRing {
    spans: VecDeque<Span>,
    max: usize,
}

impl SpanRing {
    pub fn new(max: usize) -> Self {
        Self {
            spans: VecDeque::new(),
            max,
        }
    }

    pub fn push(&mut self, span: Span) {
        if self.spans.len() >= self.max {
            self.spans.pop_front();
        }
        self.spans.push_back(span);
    }

    pub fn prune(&mut self, before_seq: u64) {
        while let Some(front) = self.spans.front() {
            if front.start + front.len as u64 <= before_seq {
                self.spans.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn in_range(&self, start: u64, end: u64) -> Vec<Span> {
        self.spans
            .iter()
            .filter(|s| s.start < end && s.start + s.len as u64 > start)
            .cloned()
            .collect()
    }

    pub fn clear(&mut self) {
        self.spans.clear();
    }
}

pub struct Pipeline {
    pub ring: Mutex<RingBuffer>,
    pub spans: Mutex<SpanRing>,
    pub engine: Mutex<ParserEngine>,
}

impl Pipeline {
    pub fn new() -> Self {
        Self {
            ring: Mutex::new(RingBuffer::new(32 * 1024 * 1024)),
            spans: Mutex::new(SpanRing::new(200_000)),
            engine: Mutex::new(ParserEngine::new()),
        }
    }
}

pub struct IngestCtx {
    pub pipeline: Arc<Pipeline>,
    pub record: Arc<Mutex<Option<File>>>,
    pub rx_total: Arc<AtomicU64>,
}

pub fn ingest(ctx: &IngestCtx, app: &AppHandle, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let ts = ts_now();
    let start = {
        let mut ring = ctx.pipeline.ring.lock().unwrap();
        let s = ring.total();
        ring.append(data, ts);
        s
    };
    let rows = {
        let mut engine = ctx.pipeline.engine.lock().unwrap();
        engine.feed(data, start, ts)
    };
    if !rows.is_empty() {
        let mut spans = ctx.pipeline.spans.lock().unwrap();
        for r in &rows {
            spans.push(Span {
                start: r.seq,
                len: r.len as u32,
                tpl_id: r.tpl_id.clone(),
                valid: r.valid,
            });
        }
        let keep_from = ctx.pipeline.ring.lock().unwrap().start_seq();
        spans.prune(keep_from);
    }
    ctx.rx_total.fetch_add(data.len() as u64, Ordering::SeqCst);
    if let Ok(mut rec) = ctx.record.lock() {
        if let Some(f) = rec.as_mut() {
            let _ = f.write_all(data);
        }
    }
    crate::busevt::send_rx(app, ts, ts, data);
    if !rows.is_empty() {
        let (total, errors, dropped) = {
            let engine = ctx.pipeline.engine.lock().unwrap();
            (engine.total, engine.errors, engine.dropped)
        };
        crate::busevt::send_frames(
            app,
            &FramesEvent {
                rows,
                total,
                errors,
                dropped,
                emit_ts: ts_now(),
            },
        );
    }
}

fn ts_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpanOut {
    pub start: u64,
    pub len: u32,
    pub tpl_id: String,
    pub valid: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HexSlice {
    pub start: u64,
    pub total: u64,
    #[serde(with = "crate::b64")]
    pub bytes: Vec<u8>,
    pub ts_first: u64,
    pub ts_last: u64,
    pub spans: Vec<SpanOut>,
}

#[tauri::command]
pub fn parser_set_rules(
    rules: ParseRules,
    state: State<SerialManager>,
) -> Result<(), String> {
    state
        .ctx
        .pipeline
        .engine
        .lock()
        .map_err(|_| "解析引擎锁中毒")?
        .set_rules(rules)
}

#[tauri::command]
pub fn hex_clear(state: State<SerialManager>) {
    if let Ok(mut ring) = state.ctx.pipeline.ring.lock() {
        ring.clear();
    }
    if let Ok(mut spans) = state.ctx.pipeline.spans.lock() {
        spans.clear();
    }
    if let Ok(mut engine) = state.ctx.pipeline.engine.lock() {
        engine.reset_stats();
    }
}

#[tauri::command]
pub fn hex_fetch(start: u64, end: u64, state: State<SerialManager>) -> HexSlice {
    let ring = state.ctx.pipeline.ring.lock().unwrap();
    let (s, bytes) = ring.fetch(start, end);
    let ts_first = if bytes.is_empty() {
        0
    } else {
        ring.ts_at(s)
    };
    let ts_last = if bytes.is_empty() {
        0
    } else {
        ring.ts_at(s + bytes.len() as u64 - 1)
    };
    let spans = state
        .ctx
        .pipeline
        .spans
        .lock()
        .unwrap()
        .in_range(s, s + bytes.len() as u64)
        .into_iter()
        .map(|sp| SpanOut {
            start: sp.start,
            len: sp.len,
            tpl_id: sp.tpl_id,
            valid: sp.valid,
        })
        .collect();
    HexSlice {
        start: s,
        total: ring.total(),
        bytes,
        ts_first,
        ts_last,
        spans,
    }
}
