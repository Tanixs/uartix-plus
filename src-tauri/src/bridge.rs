//! MCP 内控桥（P64a）——Uartix+ 反向集成 AI IDE 的本地控制平面。
//!
//! 架构分工（详设 §1）：Rust 只做「socket + 鉴权 + 转发」哑管道，MCP 协议由
//! Node 桥（dist-cli/uartix-mcp.cjs）实现，业务执行全在前端（复用 store 与
//! runAppAction）。本模块：
//!   * 127.0.0.1:<port> 换行 JSON 服务器，首行 token 握手，单授权客户端；
//!   * `ping`/`state` 直答（webview 忙时也能探活），`call` 经 Tauri 事件转发
//!     前端执行端（reqId 关联，3s 超时）；
//!   * 启动时写发现文件 app_data_dir/mcp-endpoint.json（port/token/pid/version），
//!     停止即删——CLI 每次启动读它定位 app，端口可变不破坏配置。
//!
//! 性能红线：开关关闭 = 零线程零开销（一切由前端 invoke bridge_start 拉起）；
//! 无推送无轮询，纯请求-响应。std 线程实现，零新增依赖。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// call 转发到前端的超时：webview 忙时明确报错，不挂死 CLI
const CALL_TIMEOUT: Duration = Duration::from_millis(3000);
/// 单行长度上限（防畸形客户端撑爆内存）
const MAX_LINE: usize = 512 * 1024;
/// 探活读超时：既保证 stop 能及时关连接，又不让空闲连接吃 CPU
const READ_POLL: Duration = Duration::from_millis(1000);
const DISCOVER_FILE: &str = "mcp-endpoint.json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub running: bool,
    pub port: u16,
    pub clients: usize,
}

pub struct BridgeState {
    run_flag: Arc<AtomicBool>,
    cfg: Mutex<Option<BridgeCfg>>,
    /// 已授权客户端数（单客户端语义：>0 时新授权连接收 busy）
    clients: Arc<AtomicUsize>,
    /// reqId → 回传通道（bridge_respond 命令投递，accept 线程 recv_timeout）
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
}

#[derive(Clone)]
struct BridgeCfg {
    port: u16,
    token: String,
}

impl BridgeState {
    pub fn new() -> Self {
        Self {
            run_flag: Arc::new(AtomicBool::new(false)),
            cfg: Mutex::new(None),
            clients: Arc::new(AtomicUsize::new(0)),
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl Default for BridgeState {
    fn default() -> Self {
        Self::new()
    }
}

/* ================= 线协议（纯函数，单测覆盖） ================= */

/// 客户端请求行 → 结构化。畸形/超长一律 None（调用方回 err 并断开）。
#[derive(Debug, PartialEq)]
pub enum Req {
    Auth { token: String },
    Ping,
    State,
    Call { req_id: u64, kind: String, args: Value },
}

pub fn parse_req(line: &str) -> Option<Req> {
    if line.len() > MAX_LINE {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let op = v.get("op")?.as_str()?;
    match op {
        "auth" => Some(Req::Auth {
            token: v.get("token")?.as_str()?.to_string(),
        }),
        "ping" => Some(Req::Ping),
        "state" => Some(Req::State),
        "call" => Some(Req::Call {
            req_id: v.get("reqId")?.as_u64()?,
            kind: v.get("kind")?.as_str()?.to_string(),
            args: v.get("args").cloned().unwrap_or(Value::Null),
        }),
        _ => None,
    }
}

/// 统一响应行组装（err 恒为 string；data 任意 JSON）
pub fn resp_line(ok: bool, err: Option<&str>, data: Value) -> String {
    let mut v = json!({ "ok": ok });
    if let Some(e) = err {
        v["err"] = json!(e);
    } else {
        v["data"] = data;
    }
    v.to_string()
}

/* ================= Tauri 命令 ================= */

#[tauri::command]
pub fn bridge_start(
    port: u16,
    token: String,
    app: AppHandle,
    state: State<'_, BridgeState>,
) -> Result<BridgeInfo, String> {
    if token.len() < 16 {
        return Err("token 过短（≥16 字符）".into());
    }
    // 幂等重启：端口/token 变更后前端直接重调 start
    stop_inner(&app, &state);

    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("MCP 桥监听 127.0.0.1:{port} 失败：{e}（端口被占用可在设置改端口）"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞失败：{e}"))?;

    *state.cfg.lock().map_err(|_| "状态锁中毒")? = Some(BridgeCfg { port, token: token.clone() });
    state.run_flag.store(true, Ordering::SeqCst);

    write_discover(&app, port, &token)?;

    let run_flag = state.run_flag.clone();
    let cfg = Arc::new(Mutex::new(BridgeCfg { port, token }));
    let clients = state.clients.clone();
    let pending = state.pending.clone();
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("mcp-bridge".into())
        .spawn(move || accept_loop(listener, run_flag, cfg, clients, pending, app2))
        .map_err(|e| format!("启动 MCP 桥线程失败：{e}"))?;

    Ok(BridgeInfo {
        running: true,
        port,
        clients: 0,
    })
}

#[tauri::command]
pub fn bridge_stop(app: AppHandle, state: State<'_, BridgeState>) -> BridgeInfo {
    stop_inner(&app, &state);
    BridgeInfo {
        running: false,
        port: 0,
        clients: 0,
    }
}

#[tauri::command]
pub fn bridge_status(state: State<'_, BridgeState>) -> BridgeInfo {
    let port = state
        .cfg
        .lock()
        .ok()
        .and_then(|c| c.as_ref().map(|c| c.port))
        .unwrap_or(0);
    BridgeInfo {
        running: state.run_flag.load(Ordering::SeqCst),
        port,
        clients: state.clients.load(Ordering::SeqCst),
    }
}

/// 前端执行端回传 call 结果（reqId 关联 accept 线程的 recv_timeout）
#[tauri::command]
pub fn bridge_respond(
    req_id: u64,
    ok: bool,
    data: Value,
    err: Option<String>,
    state: State<'_, BridgeState>,
) -> bool {
    let sender = state
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&req_id));
    match sender {
        Some(tx) => {
            let mut v = json!({ "ok": ok, "reqId": req_id });
            if ok {
                v["data"] = data;
            } else {
                v["err"] = json!(err.unwrap_or_else(|| "未知错误".into()));
            }
            tx.send(v).is_ok()
        }
        None => false, // 已超时/客户端已断：静默丢弃
    }
}

fn stop_inner(app: &AppHandle, state: &BridgeState) {
    let was = state.run_flag.swap(false, Ordering::SeqCst);
    if let Ok(mut c) = state.cfg.lock() {
        *c = None;
    }
    // 唤醒所有等待中的 call（Sender drop → recv Disconnected → 回「服务已停止」）
    if let Ok(mut p) = state.pending.lock() {
        p.clear();
    }
    state.clients.store(0, Ordering::SeqCst);
    if was {
        if let Some(dir) = discover_dir(app) {
            let _ = std::fs::remove_file(dir.join(DISCOVER_FILE));
        }
        let _ = app.emit("mcp://clients", 0);
    }
}

/* ================= 发现文件 ================= */

fn discover_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok()
}

fn write_discover(app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
    let dir = discover_dir(app).ok_or("无法定位应用数据目录")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let v = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "version": app.package_info().version.to_string(),
        "ts": crate::serial::now_ms(),
    });
    std::fs::write(dir.join(DISCOVER_FILE), v.to_string())
        .map_err(|e| format!("写发现文件失败：{e}"))
}

/* ================= 连接处理 ================= */

fn accept_loop(
    listener: TcpListener,
    run_flag: Arc<AtomicBool>,
    cfg: Arc<Mutex<BridgeCfg>>,
    clients: Arc<AtomicUsize>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    app: AppHandle,
) {
    while run_flag.load(Ordering::SeqCst) {
        // 非阻塞轮询：150ms 粒度即可及时响应 stop（空闲时 CPU 占用可忽略）
        match listener.accept() {
            Ok((stream, _)) => {
                let run2 = run_flag.clone();
                let cfg2 = cfg.clone();
                let cl2 = clients.clone();
                let pd2 = pending.clone();
                let app2 = app.clone();
                let _ = std::thread::Builder::new()
                    .name("mcp-conn".into())
                    .spawn(move || handle_client(stream, run2, cfg2, cl2, pd2, app2));
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(_) => {
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
}

fn handle_client(
    stream: TcpStream,
    run_flag: Arc<AtomicBool>,
    cfg: Arc<Mutex<BridgeCfg>>,
    clients: Arc<AtomicUsize>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    app: AppHandle,
) {
    let _ = stream.set_read_timeout(Some(READ_POLL));
    let _ = stream.set_nodelay(true);
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);

    // ---- 首行握手 ----
    let mut line = String::new();
    match read_line_capped(&mut reader, &mut line, &run_flag) {
        Ok(true) => {}
        _ => return, // 超时/EOF/停止/超长：静默断开
    }
    let expect = cfg.lock().map(|c| c.token.clone()).unwrap_or_default();
    match parse_req(line.trim_end()) {
        Some(Req::Auth { token }) if token == expect => {}
        _ => {
            let _ = writeln!(writer, "{}", resp_line(false, Some("unauthorized"), Value::Null));
            return;
        }
    }
    // 单客户端语义：已有授权连接在线则拒新（MCP 桥一次只有一个会话）
    if clients.fetch_add(1, Ordering::SeqCst) >= 1 {
        let _ = writeln!(writer, "{}", resp_line(false, Some("busy"), Value::Null));
        clients.fetch_sub(1, Ordering::SeqCst);
        return;
    }
    let _ = app.emit("mcp://clients", clients.load(Ordering::SeqCst));
    let _ = writeln!(writer, "{}", resp_line(true, None, json!({ "proto": 1 })));

    // ---- 请求循环 ----
    loop {
        let mut line = String::new();
        match read_line_capped(&mut reader, &mut line, &run_flag) {
            Ok(true) => {}
            _ => break,
        }
        match parse_req(line.trim_end()) {
            Some(Req::Ping) => {
                let _ = writeln!(
                    writer,
                    "{}",
                    resp_line(true, None, json!({ "pong": true, "ts": crate::serial::now_ms() }))
                );
            }
            Some(Req::State) => {
                let _ = writeln!(writer, "{}", resp_line(true, None, rust_state(&app)));
            }
            Some(Req::Call { req_id, kind, args }) => {
                let out = forward_call(&app, &pending, req_id, &kind, args);
                let _ = writeln!(writer, "{out}");
            }
            _ => {
                let _ = writeln!(
                    writer,
                    "{}",
                    resp_line(false, Some("bad request"), Value::Null)
                );
                break;
            }
        }
    }

    let n = clients.fetch_sub(1, Ordering::SeqCst);
    if n <= 1 {
        let _ = app.emit("mcp://clients", 0);
    }
}

/// 带停止感知的读行：1s 读超时轮询 run_flag；EOF/错误/超长返回 false
fn read_line_capped(
    reader: &mut BufReader<TcpStream>,
    out: &mut String,
    run_flag: &AtomicBool,
) -> Result<bool, ()> {
    loop {
        if !run_flag.load(Ordering::SeqCst) {
            return Err(());
        }
        // read_line 遇读超时返回 WouldBlock；已缓冲的部分行保留在 BufReader，可续读
        match reader.read_line(out) {
            Ok(0) => return Err(()), // EOF
            Ok(_) => {
                if out.len() > MAX_LINE {
                    return Err(());
                }
                return Ok(true);
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(_) => return Err(()),
        }
    }
}

/// Rust 直答的极简状态（webview 忙时也可探活；完整状态走 call/get_status）
fn rust_state(app: &AppHandle) -> Value {
    let mgr = app.state::<crate::serial::SerialManager>();
    json!({
        "connected": mgr.is_open(),
        "rxTotal": mgr.ctx.rx_total.load(Ordering::Relaxed),
        "txTotal": mgr.tx_total.load(Ordering::Relaxed),
        "ts": crate::serial::now_ms(),
    })
}

/// call → 前端执行端：emit mcp://call，等 bridge_respond，3s 超时
fn forward_call(
    app: &AppHandle,
    pending: &Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    req_id: u64,
    kind: &str,
    args: Value,
) -> String {
    let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
    {
        let mut p = match pending.lock() {
            Ok(p) => p,
            Err(_) => return resp_line(false, Some("内部错误：状态锁"), Value::Null),
        };
        if p.contains_key(&req_id) {
            return resp_line(false, Some("reqId 冲突"), Value::Null);
        }
        p.insert(req_id, tx);
    }
    let _ = app.emit(
        "mcp://call",
        json!({ "reqId": req_id, "kind": kind, "args": args }),
    );
    let out = match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(v) => {
            let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
            let err = v.get("err").and_then(|e| e.as_str()).map(String::from);
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            resp_line(ok, err.as_deref(), data)
        }
        // stop_inner 清表 → Sender 全部 drop → Disconnected：明确区分「已停止」与「超时」
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            resp_line(false, Some("MCP 桥已停止"), Value::Null)
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            resp_line(false, Some("主窗口未响应（call 超时 3s）"), Value::Null)
        }
    };
    // 超时路径也要清登记，防 pending 表泄漏
    if let Ok(mut p) = pending.lock() {
        p.remove(&req_id);
    }
    out
}

/* ================= 单测 ================= */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_req_ok() {
        assert_eq!(
            parse_req(r#"{"op":"auth","token":"abc"}"#),
            Some(Req::Auth { token: "abc".into() })
        );
        assert_eq!(parse_req(r#"{"op":"ping"}"#), Some(Req::Ping));
        assert_eq!(parse_req(r#"{"op":"state"}"#), Some(Req::State));
        assert_eq!(
            parse_req(r#"{"op":"call","reqId":7,"kind":"get_status","args":{"a":1}}"#),
            Some(Req::Call { req_id: 7, kind: "get_status".into(), args: json!({"a":1}) })
        );
        // args 缺省 → Null
        assert_eq!(
            parse_req(r#"{"op":"call","reqId":1,"kind":"x"}"#),
            Some(Req::Call { req_id: 1, kind: "x".into(), args: Value::Null })
        );
    }

    #[test]
    fn parse_req_rejects_garbage() {
        assert!(parse_req("").is_none());
        assert!(parse_req("not json").is_none());
        assert!(parse_req(r#"{"op":"nope"}"#).is_none());
        assert!(parse_req(r#"{"op":"call"}"#).is_none()); // 缺 reqId/kind
        assert!(parse_req(r#"{"op":"auth"}"#).is_none()); // 缺 token
        assert!(parse_req(&"x".repeat(MAX_LINE + 1)).is_none()); // 超长
    }

    #[test]
    fn resp_line_shape() {
        let ok = resp_line(true, None, json!({"v":1}));
        assert!(ok.contains(r#""ok":true"#) && ok.contains(r#""v":1"#) && !ok.contains("err"));
        let bad = resp_line(false, Some("boom"), Value::Null);
        assert!(bad.contains(r#""ok":false"#) && bad.contains("boom") && !bad.contains("data"));
    }
}
