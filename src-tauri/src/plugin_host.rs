//! P174-A3：扩展宿主进程的生命周期（起、写、读、停、空闲回收）。
//!
//! 这个模块**只搬字节**：不拼命令行参数（那是 `manifest.ts` 的 `buildHostNodeArgs` 的事，
//! 单一真相在 TS 侧，这里再拼一遍就成了两份会漂的规则），不解析协议语义（那是
//! `protocol.ts` 的事），只负责把一个 Node 子进程挂起来、把它的 stdout 按行推给前端。
//!
//! 三条刻意的"不宽松"：
//! 1. **停就是杀进程树**。Windows 上 `child.kill()` 只杀直接子进程，而扩展最常见的用途
//!    恰恰是起 python 训练——只杀 node 会留下一堆孤儿吃满 GPU。所以走 `taskkill /T /F`，
//!    失败再退回 `kill()`。这条不是洁癖，是"停不下来"会直接毁掉用户体验。
//! 2. **空闲 60s 挂起**。扩展按需启动，不用时不能常驻吃内存。判定抽成纯函数
//!    `idle_expired`，因为它要能被单测咬住（时间相关的判据最容易写成永真）。
//! 3. **handle 由调用方给**（插件 id），同一个 id 重复 start 会先停旧的——绝不出现
//!    两个 realm 同时在跑（与 `moduleBus` 的"同一 pkgId 不双开"同一条规矩）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// 空闲多久挂起。比面板交互周期长得多，又短到用户不会觉得"装了个东西一直在跑"。
const IDLE_TIMEOUT_MS: u64 = 60_000;
/// 巡检间隔。比超时短一个量级，保证最多晚 5s 回收。
const IDLE_SWEEP_MS: u64 = 5_000;

pub fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

/// 空闲判定。**独立成函数是为了能单测**：时间比较写成 `now - last > t` 很容易在
/// 时钟回拨时变成"永远空闲"或"永远不空闲"，而这两种都只在真机上偶发。
pub fn idle_expired(now_ms: u64, last_active_ms: u64, timeout_ms: u64) -> bool {
    // 时钟回拨（now < last）时不判空闲：宁可不回收，也不要莫名其妙杀掉正在用的进程
    if now_ms < last_active_ms {
        return false;
    }
    now_ms - last_active_ms >= timeout_ms
}

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    started_at: u64,
    last_active: Arc<AtomicU64>,
    /**
     * 「这条进程是我们自己停的」。stdout 关闭那一刻要靠它分清两种死法：
     * 自己停的（换页面、停用、空闲回收、同 id 重启）不该报 `ext://exit`，
     * 崩掉的才要报。少了这个旗子会出现一条**假失败**：
     * 刷新页面 ⇒ 新前端起新实例 ⇒ 老实例被替换 ⇒ 它的退出事件按 handle 找到的是**新实例**，
     * 于是界面刚把插件标成"启动失败"、用户看见一条没来由的报错（真机复现过）。
     */
    stopped_by_us: Arc<AtomicBool>,
    // 刻意不存 token：Rust 侧只按行搬字节、不解析消息（解析在 protocol.ts 里，单一真相）。
    // 存一份却从不读，是下一批最容易被误认为"这里做过校验"的假线索。
}

#[derive(Default, Clone)]
pub struct PluginHostState {
    /// `Arc` 是给巡检线程用的：它要一份能长期持有的句柄，而 `State<'_, _>` 借不出那种生命周期。
    hosts: Arc<Mutex<HashMap<String, Arc<Mutex<Host>>>>>,
}

type Shared = Arc<Mutex<Host>>;

fn lock<'a, T>(m: &'a Mutex<T>) -> std::sync::MutexGuard<'a, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}


/// 探测这个 node 认哪个权限开关。探不出来就按 `--permission` 试——真不认会立刻退出，
/// 至少比"悄悄不带权限跑起来"安全（后者等于全部权限敞开）。
fn permission_flag(node_path: &str) -> &'static str {
    let ok = Command::new(node_path)
        .args(["--permission", "-e", ""])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if ok {
        "--permission"
    } else {
        "--experimental-permission"
    }
}

/// 杀进程树。Windows 用 `taskkill /T`（含所有后代），失败再退回单杀。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let ok = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        // 进程可能已经退出，或者 taskkill 被策略挡住——退回单杀，不留悬空句柄
    }
}

#[cfg(not(windows))]
fn kill_tree(_pid: u32) {}

fn teardown(handle: &str, host: &Shared) {
    let mut h = lock(host);
    let pid = h.child.id();
    // 旗子先立再杀：stdout 关闭那一刻读的就是它，晚一步就成了"插件自己崩了"
    h.stopped_by_us.store(true, Ordering::Relaxed);
    // 先 taskkill 树，再 kill 本体：顺序反了的话 node 一死，taskkill 就找不到那棵树的根
    #[cfg(windows)]
    kill_tree(pid);
    let _ = h.child.kill();
    let _ = h.child.wait();
    h.stdin = None;
    let _ = handle;
}

/// 起一个扩展宿主进程。
///
/// `args` 由前端用 `buildHostNodeArgs` 生成（含 `--permission` 那一串），这里一个字都不改，
/// 只原样转发——**权限参数只有一处来源**，否则"加了新权限但忘了给参数"这种事一定会发生。
#[tauri::command]
pub async fn plugin_host_start(
    app: AppHandle,
    state: State<'_, PluginHostState>,
    handle: String,
    node_path: String,
    args: Vec<String>,
    script_path: String,
    plugin_dir: String,
    cwd: String,
) -> Result<Value, String> {
    if handle.trim().is_empty() {
        return Err("handle 不能为空".into());
    }
    if node_path.trim().is_empty() {
        return Err("node 路径未配置：请在设置里指定，或安装自带运行时的版本".into());
    }

    // 同 id 先停旧的：绝不双开
    if let Some(old) = lock(&state.hosts).get(&handle).cloned() {
        teardown(&handle, &old);
        lock(&state.hosts).remove(&handle);
    }

    // Node 20 只认 `--experimental-permission`，22 起才把 `--permission` 转正。
    // 用户的 node 是哪个版本不由我们决定，所以**启动前探一次**，把参数换成它能认的那个。
    // 不探的后果：Node 20 上第一行就 `bad option: --permission`，而错误指向参数、不指向版本。
    let mut args = args;
    if let Some(pos) = args.iter().position(|a| a == "--permission") {
        args[pos] = permission_flag(&node_path).to_string();
    }

    let mut cmd = Command::new(&node_path);
    cmd.args(&args)
        .arg(&script_path)
        .arg(&plugin_dir)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不闪黑框
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("扩展宿主起不来（{node_path}）：{e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let started_at = wall_ms();
    let last_active = Arc::new(AtomicU64::new(started_at));
    let stopped_by_us = Arc::new(AtomicBool::new(false));

    let host: Shared = Arc::new(Mutex::new(Host {
        child,
        stdin,
        started_at,
        last_active: last_active.clone(),
        stopped_by_us: stopped_by_us.clone(),
    }));
    lock(&state.hosts).insert(handle.clone(), host.clone());

    /* ---- stdout / stderr：逐行推给前端 ---- */
    let h_out = handle.clone();
    let app_out = app.clone();
    if let Some(out) = stdout {
        std::thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        last_active.store(wall_ms(), Ordering::Relaxed);
                        let _ = app_out.emit("ext://line", json!({"handle": h_out, "stream": "stdout", "line": l}));
                    }
                    Err(_) => break,
                }
            }
            /* stdout 关闭 = 进程结束（或崩了）。如实报，不替它编原因。
               但**我们自己停的不报**：换页面 / 停用 / 空闲回收 / 同 id 重启都会走到这里，
               而那个 handle 此刻属于**新实例**——报了就是给新实例扣一顶"启动失败"。 */
            if !stopped_by_us.load(Ordering::Relaxed) {
                let _ = app_out.emit("ext://exit", json!({"handle": h_out}));
            }
        });
    }
    let h_err = handle.clone();
    let app_err = app.clone();
    if let Some(errout) = stderr {
        std::thread::spawn(move || {
            let reader = BufReader::new(errout);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app_err.emit("ext://line", json!({"handle": h_err, "stream": "stderr", "line": line}));
            }
        });
    }

    ensure_sweeper(app, state.inner().hosts.clone());

    Ok(json!({
        "handle": handle,
        "pid": pid,
        "startedAt": started_at,
        "idleTimeoutMs": IDLE_TIMEOUT_MS,
    }))
}

/// 写一行到扩展的 stdin。**调用方负责编码**（`encodeMessage` 保证不带裸换行）。
#[tauri::command]
pub async fn plugin_host_send(
    state: State<'_, PluginHostState>,
    handle: String,
    line: String,
) -> Result<Value, String> {
    if line.len() > 8 * 1024 * 1024 {
        return Err("单条消息过大".into());
    }
    if line.contains('\n') || line.contains('\r') {
        return Err("line 不许含裸换行（会破坏 JSONL 分帧）".into());
    }
    let host = {
        let map = lock(&state.hosts);
        map.get(&handle).cloned().ok_or_else(|| format!("没有在运行的扩展宿主：{handle}"))?
    };
    let mut h = lock(&host);
    let stdin = h.stdin.as_mut().ok_or("宿主 stdin 已关闭")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| format!("写入扩展宿主失败：{e}"))?;
    let now = wall_ms();
    h.last_active.store(now, Ordering::Relaxed);
    Ok(json!({"ok": true, "at": now}))
}

/// 前端每次有交互就调一次，重置空闲计时（"用着的东西不能被回收"）。
#[tauri::command]
pub async fn plugin_host_touch(state: State<'_, PluginHostState>, handle: String) -> Result<Value, String> {
    let host = {
        let map = lock(&state.hosts);
        map.get(&handle).cloned().ok_or_else(|| format!("没有在运行的扩展宿主：{handle}"))?
    };
    let now = wall_ms();
    lock(&host).last_active.store(now, Ordering::Relaxed);
    Ok(json!({"ok": true, "at": now}))
}

/// 停。杀进程树，并从表里移除。
#[tauri::command]
pub async fn plugin_host_stop(state: State<'_, PluginHostState>, handle: String) -> Result<Value, String> {
    let host = {
        let mut map = lock(&state.hosts);
        map.remove(&handle).ok_or_else(|| format!("没有在运行的扩展宿主：{handle}"))?
    };
    teardown(&handle, &host);
    Ok(json!({"ok": true, "handle": handle}))
}

/// 状态查询（不返回 token——那是运行时秘密，前端自己存着）。
#[tauri::command]
pub async fn plugin_host_status(app: AppHandle, state: State<'_, PluginHostState>) -> Result<Value, String> {
    let _ = app;
    let map = lock(&state.hosts);
    let now = wall_ms();
    let items: Vec<Value> = map
        .iter()
        .map(|(k, v)| {
            let h = lock(v);
            json!({
                "handle": k,
                "pid": h.child.id(),
                "startedAt": h.started_at,
                "idleMs": now.saturating_sub(h.last_active.load(Ordering::Relaxed)),
            })
        })
        .collect();
    Ok(json!({"hosts": items, "count": items.len()}))
}

/// 巡检线程：只起一次。到点把空闲超时的宿主停掉，并推 `ext://idle`。
///
/// 表用 `Arc<Mutex<..>>` 而不是直接塞 State：线程要一份能长期持有的句柄，
/// 而 `State<'_, _>` 借不出那种生命周期。
fn ensure_sweeper(app: AppHandle, hosts: Arc<Mutex<HashMap<String, Shared>>>) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(IDLE_SWEEP_MS));
        let now = wall_ms();
        // 先算名单再动手：持锁期间不杀进程（teardown 会 wait，可能几百毫秒）
        let idle: Vec<String> = {
            let map = lock(&hosts);
            map.iter()
                .filter(|(_, v)| {
                    let h = lock(v);
                    idle_expired(now, h.last_active.load(Ordering::Relaxed), IDLE_TIMEOUT_MS)
                })
                .map(|(k, _)| k.clone())
                .collect()
        };
        for handle in idle {
            let removed = lock(&hosts).remove(&handle);
            if let Some(h) = removed {
                teardown(&handle, &h);
                let _ = app.emit("ext://idle", json!({"handle": handle, "reason": "idle"}));
            }
        }
    });
}

/// 单测只钉判据，不真起进程（CI 上没有稳定的 node 路径）。
#[cfg(test)]
mod tests {
    use super::idle_expired;

    #[test]
    fn idle_expired_basic() {
        assert!(!idle_expired(1000, 900, 60_000));
        assert!(!idle_expired(60_999, 1_000, 60_000));
        assert!(idle_expired(61_000, 1_000, 60_000));
        assert!(idle_expired(120_000, 1_000, 60_000));
    }

    #[test]
    fn idle_expired_clock_backwards_is_not_idle() {
        // 时钟回拨：宁可不回收，也不要杀掉正在用的进程
        assert!(!idle_expired(500, 10_000, 1));
    }
}
