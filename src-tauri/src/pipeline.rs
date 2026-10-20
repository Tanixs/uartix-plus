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

    /// 二分定位与 [start, end) 相交的区间。spans 按 start 递增且互不重叠，
    /// 因此只需从左边界（第一个 end > start）扫到右边界（第一个 start >= end）。
    fn range_bounds(&self, start: u64, end: u64) -> (usize, usize) {
        if start >= end || self.spans.is_empty() {
            return (0, 0);
        }
        let n = self.spans.len();
        let mut lo = 0usize;
        let mut hi = n;
        while lo < hi {
            let mid = (lo + hi) / 2;
            let s = &self.spans[mid];
            if s.start + s.len as u64 <= start {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        let first = lo;
        let mut hi = n;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if self.spans[mid].start < end {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        (first, lo)
    }

    pub fn in_range(&self, start: u64, end: u64) -> Vec<Span> {
        let (first, last) = self.range_bounds(start, end);
        SPAN_SCANS.fetch_add((last - first) as u64, Ordering::Relaxed);
        self.spans.range(first..last).cloned().collect()
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

/// 诊断探针：ingest 最后到达的阶段（1 入口 / 2 读取状态后 / 3 环形缓冲后 /
/// 4 解析后 / 5 spans 后 / 6 录制后 / 7 rx 入队后 / 8 frames 入队后 / 9 返回）。
pub static INGEST_STAGE: AtomicU64 = AtomicU64::new(0);
/// Hex 窗口诊断：取片次数、取片总耗时、跨度表扫描量。
pub static HEX_FETCHES: AtomicU64 = AtomicU64::new(0);
pub static HEX_FETCH_US: AtomicU64 = AtomicU64::new(0);
pub static SPAN_SCANS: AtomicU64 = AtomicU64::new(0);

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
    /// 文件传输状态机（传输激活期间 RX 控制字节改喂状态机）
    pub xfer: Arc<crate::xfer::XferManager>,
}

pub fn ingest(ctx: &IngestCtx, app: &AppHandle, data: &[u8]) {
    INGEST_STAGE.store(1, Ordering::Relaxed);
    if data.is_empty() {
        return;
    }
    // 文件传输激活：RX 是 ACK/NAK/'C'/CAN 控制字节，只喂传输状态机并计数，
    // 不进解析/HexView/录制/X-Ray——Bootloader 模式下无业务数据，吞掉防污染
    if crate::xfer::is_active() {
        ctx.xfer.feed_rx(data);
        ctx.rx_total.fetch_add(data.len() as u64, Ordering::SeqCst);
        return;
    }
    let ts = ts_now();
    INGEST_STAGE.store(2, Ordering::Relaxed);
    let start = {
        let mut ring = ctx.pipeline.ring.lock().expect("环形缓冲锁中毒");
        let s = ring.total();
        ring.append(data, ts);
        s
    };
    INGEST_STAGE.store(3, Ordering::Relaxed);
    let rows = {
        let mut engine = ctx.pipeline.engine.lock().expect("解析引擎锁中毒");
        engine.feed(data, start, ts)
    };
    INGEST_STAGE.store(4, Ordering::Relaxed);
    if !rows.is_empty() {
        // 先取 keep_from 再锁 spans：ring/spans 不嵌套持有（hex_fetch 同序），
        // 否则 ingest（spans→ring）与 hex_fetch（ring→spans）会 ABBA 死锁。
        let keep_from = ctx
            .pipeline
            .ring
            .lock()
            .expect("环形缓冲锁中毒")
            .start_seq();
        let mut spans = ctx.pipeline.spans.lock().expect("帧区间锁中毒");
        for r in &rows {
            spans.push(Span {
                start: r.seq,
                len: r.len as u32,
                tpl_id: r.tpl_id.clone(),
                valid: r.valid,
            });
        }
        spans.prune(keep_from);
    }
    INGEST_STAGE.store(5, Ordering::Relaxed);
    ctx.rx_total.fetch_add(data.len() as u64, Ordering::SeqCst);
    if let Ok(mut rec) = ctx.record.lock() {
        if let Some(f) = rec.as_mut() {
            let _ = f.write_all(data);
        }
    }
    INGEST_STAGE.store(6, Ordering::Relaxed);
    crate::busevt::send_rx(app, ts, ts, data);
    INGEST_STAGE.store(7, Ordering::Relaxed);
    if !rows.is_empty() {
        let (total, errors, dropped) = {
            let engine = ctx.pipeline.engine.lock().expect("解析引擎锁中毒");
            (engine.total, engine.errors, engine.dropped)
        };
        crate::busevt::send_frames(
            app,
            FramesEvent {
                rows,
                total,
                errors,
                dropped,
                emit_ts: ts_now(),
            },
        );
        INGEST_STAGE.store(8, Ordering::Relaxed);
    }
    INGEST_STAGE.store(9, Ordering::Relaxed);
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

/// 会话回放前的 hex 视图复位（seq 从 0 对齐；语义同 hex_clear，回放线程专用）
pub fn replay_reset(ctx: &IngestCtx) {
    if let Ok(mut ring) = ctx.pipeline.ring.lock() {
        ring.clear();
    }
    if let Ok(mut spans) = ctx.pipeline.spans.lock() {
        spans.clear();
    }
    if let Ok(mut engine) = ctx.pipeline.engine.lock() {
        engine.reset_stats();
    }
}

/// 会话回放回灌：RX 原始块入 hex 环形缓冲（与 ingest 同序：先入环后发前端）
pub fn replay_rx(ctx: &IngestCtx, ts: u64, bytes: &[u8]) {
    let keep = {
        let mut ring = ctx.pipeline.ring.lock().expect("环形缓冲锁中毒");
        ring.append(bytes, ts);
        ring.start_seq()
    };
    if let Ok(mut spans) = ctx.pipeline.spans.lock() {
        spans.prune(keep);
    }
}

/// 会话回放：把已解析帧的区间作为 span 推入 hex 视图（seq 对齐回放中的 RX 环）
pub fn replay_spans(ctx: &IngestCtx, rows: &[crate::parser::FrameRow]) {
    if let Ok(mut spans) = ctx.pipeline.spans.lock() {
        for r in rows {
            spans.push(Span {
                start: r.seq,
                len: r.len as u32,
                tpl_id: r.tpl_id.clone(),
                valid: r.valid,
            });
        }
    }
}

#[tauri::command]
pub fn hex_fetch(start: u64, end: u64, state: State<SerialManager>) -> HexSlice {
    let t0 = std::time::Instant::now();
    HEX_FETCHES.fetch_add(1, Ordering::Relaxed);
    // ring 只在取字节/时间戳时短暂持有；随后释放再锁 spans（不嵌套，避免 ABBA）。
    let (s, bytes, total, ts_first, ts_last) = {
        let ring = state.ctx.pipeline.ring.lock().expect("环形缓冲锁中毒");
        let (s, bytes) = ring.fetch(start, end);
        let total = ring.total();
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
        (s, bytes, total, ts_first, ts_last)
    };
    let spans = state
        .ctx
        .pipeline
        .spans
        .lock()
        .expect("帧区间锁中毒")
        .in_range(s, s + bytes.len() as u64)
        .into_iter()
        .map(|sp| SpanOut {
            start: sp.start,
            len: sp.len,
            tpl_id: sp.tpl_id,
            valid: sp.valid,
        })
        .collect();
    let out = HexSlice {
        start: s,
        total,
        bytes,
        ts_first,
        ts_last,
        spans,
    };
    HEX_FETCH_US.fetch_add(t0.elapsed().as_micros() as u64, Ordering::Relaxed);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start: u64, len: u32) -> Span {
        Span {
            start,
            len,
            tpl_id: "tpl".into(),
            valid: true,
        }
    }

    fn table(n: usize) -> SpanRing {
        let mut r = SpanRing::new(n + 10);
        for i in 0..n {
            r.push(span(i as u64 * 10, 4));
        }
        r
    }

    #[test]
    fn span_range_returns_overlaps_only() {
        let r = table(100);
        assert_eq!(
            r.in_range(100, 130)
                .iter()
                .map(|s| s.start)
                .collect::<Vec<_>>(),
            vec![100, 110, 120]
        );
        // 查询起点落在 span 中间：前一个 span 仍应命中
        assert_eq!(
            r.in_range(102, 103)
                .iter()
                .map(|s| s.start)
                .collect::<Vec<_>>(),
            vec![100]
        );
        // 空洞：100 号 span 到 104 结束，104..109 无命中
        assert!(r.in_range(104, 109).is_empty());
    }

    #[test]
    fn span_range_does_not_scan_whole_table() {
        let r = table(10_000);
        assert_eq!(r.range_bounds(50_000, 50_020), (5000, 5002));
        assert_eq!(r.range_bounds(50_004, 50_011), (5001, 5002));
        assert_eq!(r.range_bounds(50_004, 50_009), (5001, 5001));
        assert!(r.range_bounds(50_000, 50_020).1 - r.range_bounds(50_000, 50_020).0 <= 4);
    }
}
