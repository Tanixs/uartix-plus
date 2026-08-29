//! 网络接口：TCP 客户端 / TCP 服务端 / UDP
//!
//! 数据流与串口完全同源：收到数据 → `pipeline::ingest`（统一入口）→
//! 前端复用 `serial:rx` / `serial:state` / `serial:tx` 事件。
//! 串口模块（serial.rs）不受本模块影响；`send_data` 在网络连接建立时优先走网络。

use serde::Deserialize;
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::pipeline::{ingest, IngestCtx};
use crate::serial::{emit_state, now_ms, TxEvent};

const EMIT_INTERVAL_MS: u64 = 33;
const EMIT_MAX_BYTES: usize = 16384;
const READ_BUF_SIZE: usize = 4096;
const RECONNECT_POLL_MS: u64 = 1000;
const ACCEPT_POLL_MS: u64 = 20;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetConfig {
    /// "tcp-client" | "tcp-server" | "udp"
    pub kind: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
}

struct NetShared {
    /// TCP 客户端 / 服务端当前连接
    stream: Option<TcpStream>,
    /// UDP 套接字
    sock: Option<UdpSocket>,
}

pub struct NetManager {
    pub ctx: Arc<IngestCtx>,
    shared: Arc<Mutex<NetShared>>,
    run_flag: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    tx_total: Arc<AtomicU64>,
}

impl NetManager {
    pub fn new(ctx: Arc<IngestCtx>) -> Self {
        Self {
            ctx,
            shared: Arc::new(Mutex::new(NetShared {
                stream: None,
                sock: None,
            })),
            run_flag: Arc::new(AtomicBool::new(false)),
            epoch: Arc::new(AtomicU64::new(0)),
            tx_total: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[allow(dead_code)]
pub fn is_connected(state: &NetManager) -> bool {
    state.run_flag.load(Ordering::SeqCst)
}

fn set_tx(state: &NetManager, n: usize) {
    state.tx_total.fetch_add(n as u64, Ordering::SeqCst);
}

/// 发送路由：网络已连接则写入网络并返回 true；未连接返回 false（交回串口）
pub fn try_send(state: &NetManager, bytes: &[u8]) -> Result<bool, String> {
    if !state.run_flag.load(Ordering::SeqCst) {
        return Ok(false);
    }
    let shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
    if let Some(sock) = shared.sock.as_ref() {
        // UDP
        sock.send(bytes).map_err(|e| format!("发送失败: {e}"))?;
        return Ok(true);
    }
    if let Some(stream) = shared.stream.as_ref() {
        let mut w = stream;
        w.write_all(bytes).map_err(|e| format!("发送失败: {e}"))?;
        w.flush().map_err(|e| format!("发送失败: {e}"))?;
        return Ok(true);
    }
    // 网络接口已打开但通道未就绪（TCP 连接中/重连中/对端未接入）
    Err("网络连接尚未就绪：TCP 正在连接/重连，或服务端还没有客户端接入，稍候再试".into())
}

use std::io::Write;

fn desc_of(cfg: &NetConfig) -> String {
    match cfg.kind.as_str() {
        "tcp-server" => format!("0.0.0.0:{}", cfg.local_port),
        _ => format!("{}:{}", cfg.remote_host, cfg.remote_port),
    }
}

#[tauri::command]
pub fn open_net(
    config: NetConfig,
    app: AppHandle,
    state: tauri::State<NetManager>,
) -> Result<(), String> {
    if state.run_flag.load(Ordering::SeqCst) {
        return Err("网络接口已打开，请先关闭当前连接".into());
    }
    if !matches!(config.kind.as_str(), "tcp-client" | "tcp-server" | "udp") {
        return Err(format!("不支持的网络接口类型: {}", config.kind));
    }
    if config.kind != "tcp-server" && config.remote_host.trim().is_empty() {
        return Err("远程地址不能为空".into());
    }
    if config.kind != "tcp-client" && config.local_port == 0 {
        return Err("本地端口不能为 0".into());
    }

    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.run_flag.store(true, Ordering::SeqCst);
    let my_epoch = state.epoch.load(Ordering::SeqCst);

    let desc = desc_of(&config);
    let ok = match config.kind.as_str() {
        "tcp-client" => spawn_tcp_client(&app, &state, config.clone(), my_epoch),
        "tcp-server" => spawn_tcp_server(&app, &state, config.clone(), my_epoch),
        _ => spawn_udp(&app, &state, config.clone(), my_epoch),
    };
    if !ok {
        state.run_flag.store(false, Ordering::SeqCst);
        return Err(format!("打开 {desc} 失败，请检查地址与端口"));
    }
    // 客户端/服务端/UDP 线程各自在就绪后发 connected；这里不发，避免状态超前
    let _ = desc;
    Ok(())
}

#[tauri::command]
pub fn close_net(app: AppHandle, state: tauri::State<NetManager>) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    state.run_flag.store(false, Ordering::SeqCst);
    {
        let mut shared = state.shared.lock().map_err(|_| "状态锁中毒")?;
        shared.stream = None;
        shared.sock = None;
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

/// 收数批处理：33ms / 16KB 合并后进 ingest（与串口读线程一致）
struct Batcher {
    pending: Vec<u8>,
    last: Instant,
}

impl Batcher {
    fn new() -> Self {
        Self {
            pending: Vec::with_capacity(EMIT_MAX_BYTES),
            last: Instant::now(),
        }
    }
    fn push(&mut self, ctx: &Arc<IngestCtx>, app: &AppHandle, data: &[u8]) {
        self.pending.extend_from_slice(data);
        if self.pending.len() >= EMIT_MAX_BYTES
            || self.last.elapsed() >= Duration::from_millis(EMIT_INTERVAL_MS)
        {
            ingest(ctx, app, &self.pending);
            self.pending = Vec::with_capacity(EMIT_MAX_BYTES);
            self.last = Instant::now();
        }
    }
    fn flush(&mut self, ctx: &Arc<IngestCtx>, app: &AppHandle) {
        if !self.pending.is_empty() {
            ingest(ctx, app, &self.pending);
            self.pending = Vec::with_capacity(EMIT_MAX_BYTES);
            self.last = Instant::now();
        }
    }
}

fn read_stream_batches(
    stream: &mut TcpStream,
    ctx: &Arc<IngestCtx>,
    app: &AppHandle,
    batcher: &mut Batcher,
    alive: impl Fn() -> bool,
) -> bool {
    let mut buf = [0u8; READ_BUF_SIZE];
    loop {
        if !alive() {
            return false;
        }
        match stream.read(&mut buf) {
            Ok(0) => return false, // 对端正常关闭
            Ok(n) => batcher.push(ctx, app, &buf[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => return true,
            Err(_) => return false,
        }
    }
}

use std::io::Read;

fn spawn_tcp_client(
    app: &AppHandle,
    state: &tauri::State<NetManager>,
    cfg: NetConfig,
    my_epoch: u64,
) -> bool {
    let app = app.clone();
    let ctx = state.ctx.clone();
    let shared = state.shared.clone();
    let run_flag = state.run_flag.clone();
    let epoch = state.epoch.clone();
    let addr = (cfg.remote_host.clone(), cfg.remote_port);
    let desc = desc_of(&cfg);
    thread::spawn(move || {
        let alive = || run_flag.load(Ordering::SeqCst) && epoch.load(Ordering::SeqCst) == my_epoch;
        loop {
            if !alive() {
                break;
            }
            match TcpStream::connect(addr.clone()) {
                Ok(stream) => {
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let write_half = match stream.try_clone() {
                        Ok(s) => s,
                        Err(_) => break,
                    };
                    {
                        let mut g = match shared.lock() {
                            Ok(g) => g,
                            Err(_) => break,
                        };
                        g.stream = Some(write_half);
                        g.sock = None;
                    }
                    emit_state(&app, "connected", Some(desc.clone()), None);
                    let mut stream = stream;
                    let mut batcher = Batcher::new();
                    let mut lost = false;
                    loop {
                        if !alive() {
                            break;
                        }
                        if !read_stream_batches(&mut stream, &ctx, &app, &mut batcher, alive) {
                            lost = true;
                        }
                        batcher.flush(&ctx, &app);
                        if lost {
                            break;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    batcher.flush(&ctx, &app);
                    {
                        if let Ok(mut g) = shared.lock() {
                            g.stream = None;
                        }
                    }
                    if !alive() {
                        break;
                    }
                    emit_state(&app, "reconnecting", Some(desc.clone()), None);
                    thread::sleep(Duration::from_millis(RECONNECT_POLL_MS));
                }
                Err(e) => {
                    if !alive() {
                        break;
                    }
                    emit_state(
                        &app,
                        "reconnecting",
                        Some(desc.clone()),
                        Some(format!("连接失败: {e}")),
                    );
                    thread::sleep(Duration::from_millis(RECONNECT_POLL_MS));
                }
            }
        }
    });
    true // 线程已启动；连接失败会在状态事件中体现
}

fn spawn_tcp_server(
    app: &AppHandle,
    state: &tauri::State<NetManager>,
    cfg: NetConfig,
    my_epoch: u64,
) -> bool {
    let listener = match TcpListener::bind(("0.0.0.0", cfg.local_port)) {
        Ok(l) => l,
        Err(e) => {
            let _ = e;
            return false;
        }
    };
    let _ = listener.set_nonblocking(true);
    let app = app.clone();
    let ctx = state.ctx.clone();
    let shared = state.shared.clone();
    let run_flag = state.run_flag.clone();
    let epoch = state.epoch.clone();
    let desc = desc_of(&cfg);
    thread::spawn(move || {
        let alive = || run_flag.load(Ordering::SeqCst) && epoch.load(Ordering::SeqCst) == my_epoch;
        emit_state(&app, "connected", Some(desc.clone()), None);
        let mut batcher = Batcher::new();
        let mut current: Option<TcpStream> = None;
        loop {
            if !alive() {
                break;
            }
            // 接受新连接（新连接替换旧连接）
            match listener.accept() {
                Ok((stream, addr)) => {
                    let _ = stream.set_nodelay(true);
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
                    let write_half = stream.try_clone().ok();
                    if let Some(w) = &write_half {
                        let _ = w;
                    }
                    {
                        if let Ok(mut g) = shared.lock() {
                            g.stream = write_half;
                        }
                    }
                    current = Some(stream);
                    batcher.flush(&ctx, &app);
                    emit_state(&app, "connected", Some(desc.clone()), None);
                    let _ = addr;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(_) => break,
            }
            // 读取当前客户端
            if let Some(stream) = current.as_mut() {
                let ok = read_stream_batches(stream, &ctx, &app, &mut batcher, alive);
                batcher.flush(&ctx, &app);
                if !ok {
                    if let Ok(mut g) = shared.lock() {
                        g.stream = None;
                    }
                    current = None;
                    emit_state(&app, "connected", Some(desc.clone()), None);
                }
            }
            if !alive() {
                break;
            }
            thread::sleep(Duration::from_millis(ACCEPT_POLL_MS));
        }
        batcher.flush(&ctx, &app);
        if let Ok(mut g) = shared.lock() {
            g.stream = None;
        }
    });
    true
}

fn spawn_udp(
    app: &AppHandle,
    state: &tauri::State<NetManager>,
    cfg: NetConfig,
    my_epoch: u64,
) -> bool {
    let sock = match UdpSocket::bind(("0.0.0.0", cfg.local_port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(100)));
    // connect 仅设置默认对端，不影响接收任意来源
    let _ = sock.connect((cfg.remote_host.as_str(), cfg.remote_port));
    let write_sock = match sock.try_clone() {
        Ok(s) => s,
        Err(_) => return false,
    };
    {
        let mut g = match state.shared.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };
        g.sock = Some(write_sock);
        g.stream = None;
    }
    let app = app.clone();
    let ctx = state.ctx.clone();
    let shared = state.shared.clone();
    let run_flag = state.run_flag.clone();
    let epoch = state.epoch.clone();
    let desc = desc_of(&cfg);
    thread::spawn(move || {
        let alive = || run_flag.load(Ordering::SeqCst) && epoch.load(Ordering::SeqCst) == my_epoch;
        emit_state(&app, "connected", Some(desc.clone()), None);
        let sock = sock;
        let mut batcher = Batcher::new();
        let mut buf = [0u8; READ_BUF_SIZE];
        loop {
            if !alive() {
                break;
            }
            match sock.recv_from(&mut buf) {
                Ok((0, _)) => {}
                Ok((n, _)) => batcher.push(&ctx, &app, &buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
            batcher.flush(&ctx, &app);
        }
        batcher.flush(&ctx, &app);
        if let Ok(mut g) = shared.lock() {
            g.sock = None;
        }
    });
    true
}

/// 发送完成后由 send_data 调用：更新 tx 计数并广播 serial:tx
pub fn notify_tx(app: &AppHandle, state: &NetManager, bytes: Vec<u8>) {
    set_tx(state, bytes.len());
    let _ = app.emit("serial:tx", TxEvent { bytes, ts: now_ms() });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_config_deserializes_camel_case() {
        let raw = r#"{"kind":"tcp-client","remoteHost":"127.0.0.1","remotePort":1346,"localPort":1347}"#;
        let cfg: NetConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.kind, "tcp-client");
        assert_eq!(cfg.remote_port, 1346);
        assert_eq!(cfg.local_port, 1347);
    }

    #[test]
    fn try_send_returns_false_when_closed() {
        // 不启动 Tauri：直接构造管理器（ctx 仅在发送成功路径才使用）
        let mgr = NetManager::new(Arc::new(IngestCtx {
            pipeline: Arc::new(crate::pipeline::Pipeline::new()),
            record: Arc::new(Mutex::new(None)),
            rx_total: Arc::new(AtomicU64::new(0)),
        }));
        assert!(!is_connected(&mgr));
        assert!(!try_send(&mgr, b"AB").unwrap());
    }

    #[test]
    fn udp_loopback_send_recv() {
        // 验证 UDP 收发通路（不依赖 Tauri 运行时）
        let rx = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let port = rx.local_addr().unwrap().port();
        let tx = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        tx.send_to(b"PING", ("127.0.0.1", port)).unwrap();
        let mut buf = [0u8; 16];
        let (n, _) = rx.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"PING");
    }

    #[test]
    fn tcp_loopback_write_and_read() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.write_all(b"HELLO").unwrap();
        let mut buf = [0u8; 16];
        let n = server.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"HELLO");
    }

    #[test]
    fn try_send_writes_through_shared_stream() {
        // 端到端验证 NetManager 发送路径：shared.stream 里的写半体 → 对端收到
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let mgr = NetManager::new(Arc::new(IngestCtx {
            pipeline: Arc::new(crate::pipeline::Pipeline::new()),
            record: Arc::new(Mutex::new(None)),
            rx_total: Arc::new(AtomicU64::new(0)),
        }));
        mgr.run_flag.store(true, Ordering::SeqCst);
        let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        {
            let mut g = mgr.shared.lock().unwrap();
            g.stream = Some(client);
        }
        assert!(try_send(&mgr, b"PING!").unwrap());
        let (mut server, _) = listener.accept().unwrap();
        let mut buf = [0u8; 16];
        let n = server.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"PING!");
    }

    #[test]
    fn try_send_errs_when_net_open_but_no_channel() {
        let mgr = NetManager::new(Arc::new(IngestCtx {
            pipeline: Arc::new(crate::pipeline::Pipeline::new()),
            record: Arc::new(Mutex::new(None)),
            rx_total: Arc::new(AtomicU64::new(0)),
        }));
        mgr.run_flag.store(true, Ordering::SeqCst);
        // 已连接但 TCP 通道未就绪 → 明确报错（而不是静默回落串口）
        assert!(try_send(&mgr, b"A").is_err());
    }
}
