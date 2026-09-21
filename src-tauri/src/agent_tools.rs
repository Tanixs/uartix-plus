//! P88e B1：Agent 通用工具的 Rust 执行面（fs_list / shell_exec / http_get）。
//!
//! 设计边界（详设 §B1）：
//! - fs 只有「读文本」（复用 files::read_text_file）与「列目录」，绝不暴露写/删/移动；
//!   白名单校验在前端 adapter（可信代码）完成——威胁模型是模型不可信，前端宿主可信；
//! - shell 每次由前端审批门批准后才调用；本命令只负责隔离执行：10s 硬超时 + kill、
//!   输出 64KB 截断、Windows 隐藏窗口；接受整条命令行（审批卡展示同一命令）；
//! - http GET 做 SSRF 基础防护：拒绝 localhost/内网段/链路本地地址，10s 超时，1MB 截断。
//!   （DNS 重绑定不在本层防护范围，桌面单用户场景风险可接受，文档如实说明。）

use base64::Engine as _;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const SHELL_TIMEOUT_SECS: u64 = 10;
const SHELL_OUTPUT_LIMIT: usize = 64 * 1024;
const HTTP_TIMEOUT_SECS: u64 = 15;
const HTTP_BODY_LIMIT: usize = 1024 * 1024;
const FS_LIST_MAX_ENTRIES: usize = 500;
const FS_READ_B64_MAX: usize = 8 * 1024 * 1024;
/// P94-G4：Agent 读文本的默认/最大单页字节数。旧实现直接复用 `files::read_text_file`
/// 全文返回，一份大日志就能把请求推过 ai.rs 的 2MiB 熔断，表现为"Agent 任务中途必败"。
const FS_READ_PAGE_MAX: usize = 64 * 1024;

/// 把索引向后吸附到 UTF-8 字符边界（不超过 `max`）。
fn snap_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// 把索引向前吸附到 UTF-8 字符边界（不小于 0）。
fn snap_char_boundary_back(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// 从 `from` 起取不超过 `cap` 字节的一页文本，返回下一页起点。
/// 纯函数，便于单测（字符边界与 hasMore 是这里的唯一难点）。
fn read_page(text: &str, from: usize, cap: usize) -> serde_json::Value {
    let total = text.len();
    let start = snap_char_boundary(text, from.min(total));
    let mut end = snap_char_boundary_back(text, (start + cap).min(total));
    // 极端情况：窗口右界落在一个多字节字符中间且向前吸附后等于起点 ⇒ 右移一个边界，保证有前进量
    if end <= start && start < total {
        end = snap_char_boundary(text, start + 1);
    }
    serde_json::json!({
        "text": &text[start..end],
        "from": start,
        "totalBytes": total,
        "hasMore": end < total,
        "nextFrom": end,
    })
}

/// SSRF 基础防护：host 为 localhost 或私网/链路本地地址时返回 true。
fn is_private_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']').to_lowercase();
    if h.is_empty() || h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h == "0.0.0.0" {
        return true;
    }
    // IPv6 本地/链路本地/ULA
    if h.contains(':') {
        let t = h.split('%').next().unwrap_or(""); // 去掉 zone id
        return t == "::1" || t.starts_with("fe80") || t.starts_with("fc") || t.starts_with("fd") || t.starts_with("::1");
    }
    // IPv4 点分：127/8、10/8、172.16-31、192.168/16、169.254/16
    let parts: Vec<&str> = h.split('.').collect();
    if parts.len() != 4 {
        return false; // 域名交给 DNS（本层不做解析后复查）
    }
    let n: Vec<u32> = parts.iter().filter_map(|p| p.parse::<u32>().ok()).collect();
    if n.len() != 4 || n.iter().any(|x| *x > 255) {
        return false;
    }
    let (a, b) = (n[0], n[1]);
    a == 127 || a == 10 || (a == 172 && (16..=31).contains(&b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
}

/// 从 URL 提取 host（scheme://host[:port]/…）。非法返回 None。
fn url_host(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1)?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority);
    let host = if host_port.starts_with('[') {
        // IPv6 [::1]:8080
        let close = host_port.find(']')?;
        &host_port[1..close]
    } else {
        host_port.split(':').next()?
    };
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

fn truncate_utf8(s: &str, limit: usize) -> String {
    if s.len() <= limit {
        return s.to_string();
    }
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…（已截断，原始 {} 字节）", &s[..end], s.len())
}

/// P95-H3：头尾都留的摘录，返回 `(文本, 原始字节, 是否压缩过)`。
/// 只留头部对命令输出是错的——失败原因与退出摘要在**结尾**（旧实现 64KB 全从头切，
/// 长编译失败的报错恰好永远落在被丢掉的那一段）。中间省略量写进文案，模型据此决定
/// 要不要 `read_artifact` 取回原文。两端都按 UTF-8 边界退让，不切半个汉字。
fn squeeze_head_tail(s: &str, head: usize, tail: usize) -> (String, usize, bool) {
    let total = s.len();
    if total <= head + tail {
        return (s.to_string(), total, false);
    }
    let mut h = head;
    while h > 0 && !s.is_char_boundary(h) {
        h -= 1;
    }
    let mut t = total - tail;
    while t < total && !s.is_char_boundary(t) {
        t += 1;
    }
    (
        format!("{}\n…（中间省略 {} 字节，原始 {} 字节，全量可用 read_artifact 分页取回）…\n{}",
                &s[..h], t - h, total, &s[t..]),
        total,
        true,
    )
}

/// 列目录（depth 层，条目上限 500）。返回 JSON 树：{ entries: [{ name, type, size, children? }] }
#[tauri::command]
pub async fn agent_fs_list(path: String, depth: Option<u32>) -> Result<serde_json::Value, String> {
    let depth = depth.unwrap_or(2).clamp(1, 3);
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let root = PathBuf::from(&path);
        if !root.exists() {
            return Err(format!("路径不存在：{}", path));
        }
        let mut counter = 0usize;
        let entries = list_dir(&root, depth, &mut counter)?;
        Ok(serde_json::json!({ "path": path, "truncated": counter >= FS_LIST_MAX_ENTRIES, "entries": entries }))
    })
    .await
    .map_err(|e| format!("列目录任务失败：{e}"))?
}

/// 读图片文件为 base64（P88b-4 image_swatch 取色用；≤8MB，白名单校验在前端完成）。
#[tauri::command]
pub async fn agent_fs_read_b64(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| format!("无法读取文件 {path}：{e}"))?;
        if meta.is_dir() {
            return Err(format!("{path} 是目录，不是文件"));
        }
        if meta.len() > FS_READ_B64_MAX as u64 {
            return Err(format!("文件超过 8MB 上限（{} 字节）", meta.len()));
        }
        let mut f = std::fs::File::open(&p).map_err(|e| format!("无法打开 {path}：{e}"))?;
        let mut buf = Vec::with_capacity(meta.len() as usize);
        f.read_to_end(&mut buf).map_err(|e| format!("读取 {path} 失败：{e}"))?;
        Ok(serde_json::json!({
            "path": path,
            "bytes": buf.len(),
            "data": base64::engine::general_purpose::STANDARD.encode(&buf),
        }))
    })
    .await
    .map_err(|e| format!("读文件任务失败：{e}"))?
}

/// 分页读文本（P94-G4，fs_read 专用）：`from` 字节偏移 + 单页上限，白名单校验仍在前端。
#[tauri::command]
pub async fn agent_fs_read_text(
    path: String,
    from: Option<usize>,
    max_bytes: Option<usize>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let p = PathBuf::from(&path);
        let meta = std::fs::metadata(&p).map_err(|e| format!("无法读取文件 {path}：{e}"))?;
        if meta.is_dir() {
            return Err(format!("{path} 是目录，不是文件"));
        }
        if meta.len() > FS_READ_B64_MAX as u64 {
            return Err(format!("文件超过 8MB 上限（{} 字节）", meta.len()));
        }
        let text = std::fs::read_to_string(&p).map_err(|e| format!("读取 {path} 失败：{e}"))?;
        let cap = max_bytes.unwrap_or(FS_READ_PAGE_MAX).clamp(1, FS_READ_PAGE_MAX);
        let mut page = read_page(&text, from.unwrap_or(0), cap);
        page["path"] = serde_json::json!(path);
        Ok(page)
    })
    .await
    .map_err(|e| format!("读文件任务失败：{e}"))?
}

/// P97-I4：写文件前的"这里已经有东西吗"。`fs_write` 要靠它区分**新建**（直接放行）与
/// **覆盖**（逐条批准），所以必须是个独立的只读探针，不能让模型靠"读一次看报不报错"来猜。
/// 关键语义：**路径不存在不是错误**，回 `exists:false`——否则新建文件这条路永远走不通。
fn stat_json(path: &str) -> serde_json::Value {
    let p = PathBuf::from(path);
    match std::fs::metadata(&p) {
        Ok(meta) => serde_json::json!({
            "path": path,
            "exists": true,
            "isDir": meta.is_dir(),
            "bytes": if meta.is_file() { meta.len() } else { 0 },
            "modifiedMs": meta.modified().ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }),
        Err(_) => serde_json::json!({
            "path": path, "exists": false, "isDir": false, "bytes": 0, "modifiedMs": 0,
        }),
    }
}

#[tauri::command]
pub async fn agent_fs_stat(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || Ok(stat_json(&path)))
        .await
        .map_err(|e| format!("stat 任务失败：{e}"))?
}

/* ================= Agent 写文件：白名单在 Rust 侧强制 ================= */

/// 路径归一化：分隔符统一、盘符大写、压重复分隔符、去尾分隔符，最后转小写用于比较。
/// 与前端 `generalTools.normPath` 同语义（两边各留一份是为纵深防御，测试向量两边一致）。
fn norm_path(p: &str) -> String {
    let mut s: String = p.trim().chars().map(|c| if c == '/' { '\\' } else { c }).collect();
    if s.len() >= 2 && s.as_bytes()[0].is_ascii_alphabetic() && s.as_bytes()[1] == b':' {
        let head = s[..2].to_uppercase();
        s = format!("{}{}", head, &s[2..]);
    }
    while s.contains("\\\\") {
        s = s.replace("\\\\", "\\");
    }
    while s.ends_with('\\') {
        s.pop();
    }
    s.to_lowercase()
}

/// 路径里是否出现 `.` / `..` 段。**必须在匹配白名单之前先拒**：
/// 归一化不折叠 `..`，所以 `D:\w\..\..\Windows\x` 会以 `D:\w\` 开头而通过前缀判定，
/// 实际写到根之外——旧的前端 `inWhitelist` 就有这个洞（P99a-A6 的新测试把它跑红了）。
fn has_traversal(p: &str) -> bool {
    p.split(['/', '\\']).any(|seg| seg == ".." || seg == ".")
}

/// 目标路径是否落在**宿主传入**的白名单根之内（分隔符边界匹配，防 `D:\Projects` 误配 `D:\ProjectsX`）。
pub fn path_in_roots(path: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return false;
    }
    if has_traversal(path) {
        return false;
    }
    let np = norm_path(path);
    if np.is_empty() {
        return false;
    }
    roots.iter().any(|r| {
        let nr = norm_path(r);
        !nr.is_empty() && (np == nr || np.starts_with(&format!("{nr}\\")))
    })
}

/// P99a-A6：Agent 写文件的**权威门**。
///
/// 旧路径是 `fs_write` → 通用 `save_text_file`（应用自身导出也在用，不带任何根判定），
/// 白名单判断只在 TS 侧（`generalTools.inWhitelist`）——渲染层一旦被突破，那道门就不存在了。
/// 现在 roots 由宿主传入并在**这里**规范化判定，越界一律拒；`save_text_file` 保持原样不动
/// （它服务于界面导出，那条路本来就该由用户点出来的路径写）。
#[tauri::command]
pub async fn agent_fs_write(
    path: String,
    content: String,
    roots: Vec<String>,
) -> Result<serde_json::Value, String> {
    const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("内容 {} 字节，超过单次写入上限 {}", content.len(), MAX_WRITE_BYTES));
    }
    if !path_in_roots(&path, &roots) {
        // 不回显归一化结果，避免把宿主路径规则当成信息泄露面
        return Err("path_outside_whitelist".to_string());
    }
    let bytes = content.len();
    let written = path.clone();
    tokio::task::spawn_blocking(move || {
        let target = PathBuf::from(&path);
        if let Some(dir) = target.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
            }
        }
        std::fs::write(&target, content.as_bytes()).map_err(|e| format!("写入文件失败：{e}"))
    })
    .await
    .map_err(|e| format!("写文件任务失败：{e}"))??;
    Ok(serde_json::json!({ "path": written, "bytes": bytes }))
}

fn list_dir(dir: &Path, depth: u32, counter: &mut usize) -> Result<serde_json::Value, String> {
    if *counter >= FS_LIST_MAX_ENTRIES {
        return Ok(serde_json::json!({ "note": "条目已达上限" }));
    }
    let mut out: Vec<serde_json::Value> = Vec::new();
    let rd = std::fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;
    for entry in rd.flatten() {
        if *counter >= FS_LIST_MAX_ENTRIES {
            break;
        }
        *counter += 1;
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let mut item = serde_json::json!({ "name": name, "type": if is_dir { "dir" } else { "file" } });
        if is_dir {
            if depth > 1 {
                if let Ok(children) = list_dir(&p, depth - 1, counter) {
                    item["children"] = children;
                }
            }
        } else if let Ok(meta) = entry.metadata() {
            item["size"] = serde_json::json!(meta.len());
        }
        out.push(item);
    }
    Ok(serde_json::Value::Array(out))
}

/// 执行 shell 命令（前端审批门批准后调用）：Windows cmd /C，隐藏窗口；10s 超时 kill。
/// 返回 { exitCode, stdout, stderr, timedOut }；输出截断至 64KB。
#[tauri::command]
pub async fn agent_shell_exec(command: String) -> Result<serde_json::Value, String> {
    if command.trim().is_empty() {
        return Err("命令为空".into());
    }
    tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        // 管道读线程先行，避免「父 wait / 子写满管道」的经典死锁；
        // kill/wait 循环结束后 join 读线程拿回 (stdout, stderr)。
        let (mut child, reader) = spawn_shell(&command)?;
        let start = std::time::Instant::now();
        let mut timed_out = false;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() >= Duration::from_secs(SHELL_TIMEOUT_SECS) {
                        timed_out = true;
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => return Err(format!("命令执行异常：{e}")),
            }
        }
        let (out, err) = reader
            .join()
            .map_err(|_| "输出收集线程异常退出".to_string())?;
        let status = child.try_wait().ok().flatten().and_then(|s| s.code()).unwrap_or(-1);
        // 头尾各留一半预算，并把"原始多少字节 / 是否压过"做成结构化字段（红线 A7：截断必须说真话，
        // 内联文案模型分不清是数据还是提示）。键名与前端 shrink.ts 的 `${k}Bytes/${k}Truncated` 同族。
        let (so, so_bytes, so_cut) = squeeze_head_tail(&out, SHELL_OUTPUT_LIMIT / 2, SHELL_OUTPUT_LIMIT / 2);
        let (se, se_bytes, se_cut) = squeeze_head_tail(&err, SHELL_OUTPUT_LIMIT / 2, SHELL_OUTPUT_LIMIT / 2);
        Ok(serde_json::json!({
            "exitCode": status,
            "timedOut": timed_out,
            "stdout": so,
            "stdoutBytes": so_bytes,
            "stdoutTruncated": so_cut,
            "stderr": se,
            "stderrBytes": se_bytes,
            "stderrTruncated": se_cut,
        }))
    })
    .await
    .map_err(|e| format!("命令任务失败：{e}"))?
}

fn spawn_shell(
    command: &str,
) -> Result<(std::process::Child, std::thread::JoinHandle<(String, String)>), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("cmd");
        cmd.arg("/C")
            .raw_arg(&command) // 原样拼接，避免二次引号转义破坏命令
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000); // CREATE_NO_WINDOW：不闪黑框
        spawn_piped(cmd)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command).stdout(Stdio::piped()).stderr(Stdio::piped());
        spawn_piped(cmd)
    }
}

fn spawn_piped(
    mut cmd: Command,
) -> Result<(std::process::Child, std::thread::JoinHandle<(String, String)>), String> {
    let mut child = cmd.spawn().map_err(|e| format!("命令启动失败：{e}"))?;
    let so = child.stdout.take();
    let se = child.stderr.take();
    let handle = std::thread::spawn(move || {
        let mut out = String::new();
        let mut err = String::new();
        if let Some(mut s) = so {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            out = String::from_utf8_lossy(&buf).to_string();
        }
        if let Some(mut s) = se {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            err = String::from_utf8_lossy(&buf).to_string();
        }
        (out, err)
    });
    Ok((child, handle))
}

/// Agent HTTP GET（web_fetch / web_search 复用）：SSRF 基础防护 + 15s 超时 + 1MB 截断。
/// 返回 { url, status, contentType, body, truncated }。
#[tauri::command]
pub async fn agent_http_get(
    url: String,
    proxy: Option<String>,
    no_proxy: Option<String>,
) -> Result<serde_json::Value, String> {
    let lower = url.trim().to_lowercase();
    if !lower.starts_with("https://") && !lower.starts_with("http://") {
        return Err("仅支持 http/https 地址".into());
    }
    let host = url_host(&url).ok_or_else(|| "无法解析 URL 主机".to_string())?;
    if is_private_host(&host) {
        return Err(format!("拒绝访问内网/本机地址：{host}"));
    }
    let client = crate::ai::build_client(
        proxy.as_deref(),
        no_proxy.as_deref(),
        Some(Duration::from_secs(HTTP_TIMEOUT_SECS)),
    )?;
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (compatible; UartixAgent/1.0)")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "请求超时（15s）".to_string()
            } else {
                format!("请求失败：{e}")
            }
        })?;
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // 手动限量读取，防止超大响应吃内存
    let mut body = Vec::new();
    let mut truncated = false;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
        let chunk = chunk.map_err(|e| format!("读取响应失败：{e}"))?;
        if body.len() + chunk.len() > HTTP_BODY_LIMIT {
            body.extend_from_slice(&chunk[..HTTP_BODY_LIMIT - body.len()]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&body).to_string();
    Ok(serde_json::json!({
        "url": url,
        "status": status,
        "contentType": content_type,
        "body": truncate_utf8(&text, HTTP_BODY_LIMIT),
        "truncated": truncated,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P99a-A6：白名单判定搬到 Rust 后的边界测试。**向量与前端
    /// `generalTools.test.ts` 的 inWhitelist 用例逐条一致**——两道门各说一套就是新的漂移源。
    #[test]
    fn agent_write_roots_match_frontend_semantics() {
        let roots = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<String>>();

        // 空白名单＝功能关闭，一律拒
        assert!(!path_in_roots("D:\\Projects\\a.txt", &roots(&[])));
        // 分隔符边界：前缀目录不得误配
        assert!(path_in_roots("D:\\Projects\\a.txt", &roots(&["D:\\Projects"])));
        assert!(!path_in_roots("D:\\ProjectsX\\a.txt", &roots(&["D:\\Projects"])));
        assert!(path_in_roots("D:\\Projects", &roots(&["D:\\Projects"])));
        // 正斜杠 / 盘符大小写 / 重复分隔符归一化
        assert!(path_in_roots("d:/projects/sub/b.md", &roots(&["d:\\projects"])));
        assert!(path_in_roots("D:\\\\DATA\\\\x.json", &roots(&["d:/data"])));
        assert!(!path_in_roots("C:\\Windows\\system32\\x.dll", &roots(&["D:\\Projects"])));
        // 归一化后再判：`..` 不参与折叠，但越出根的路径必然不匹配前缀，因此被拒
        assert!(!path_in_roots("D:\\Projects\\..\\..\\Windows\\a.dll", &roots(&["D:\\Projects"])));
        // 空路径 / 只有分隔符
        assert!(!path_in_roots("", &roots(&["D:\\Projects"])));
        assert!(!path_in_roots("\\", &roots(&["D:\\Projects"])));
    }

    #[test]
    fn private_host_covers_loopback_and_ranges() {
        assert!(is_private_host("localhost"));
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("10.1.2.3"));
        assert!(is_private_host("172.16.0.1"));
        assert!(is_private_host("172.31.255.1"));
        assert!(is_private_host("192.168.1.1"));
        assert!(is_private_host("169.254.1.1"));
        assert!(is_private_host("::1"));
        assert!(is_private_host("0.0.0.0"));
        assert!(!is_private_host("example.com"));
        assert!(!is_private_host("8.8.8.8"));
        assert!(!is_private_host("172.32.0.1"));
    }

    #[test]
    fn url_host_parses_ipv6_and_port() {
        assert_eq!(url_host("https://example.com/a").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://127.0.0.1:3080/x").as_deref(), Some("127.0.0.1"));
        assert_eq!(url_host("http://[::1]:80/").as_deref(), Some("::1"));
        assert_eq!(url_host("http://user:pw@example.com").as_deref(), Some("example.com"));
        assert_eq!(url_host("example.com"), None); // 无 scheme
        assert_eq!(url_host("https://"), None); // 空 authority
    }

    #[test]
    fn truncate_keeps_char_boundary() {
        let s = "中文".repeat(100);
        let t = truncate_utf8(&s, 10);
        assert!(t.contains("已截断"));
        assert!(!t.contains('\u{FFFD}'));
    }

    #[test]
    fn squeeze_head_tail_keeps_the_error_at_the_end() {
        // P95-H3：命令输出的失败原因在结尾——只留头部等于永远看不见它
        let s = "START".to_string() + &"x".repeat(1000) + "ERR at line 999: boom";
        let (out, bytes, cut) = squeeze_head_tail(&s, 100, 100);
        assert_eq!(bytes, s.len());
        assert!(cut);
        assert!(out.starts_with("START"));
        assert!(out.ends_with("ERR at line 999: boom"));
        assert!(out.contains("中间省略 826 字节"), "省略量要写进文案：{out}");
        assert!(out.len() < s.len());
        // 短输入原样通过（不造标记、不改数据）
        let (same, sb, scut) = squeeze_head_tail("echo", 100, 100);
        assert_eq!(same, "echo");
        assert_eq!(sb, 4);
        assert!(!scut);
        // 两端都按 UTF-8 边界退让：切不到半个汉字
        let cn = "编".repeat(400);
        let (co, cb, ccut) = squeeze_head_tail(&cn, 101, 101);
        assert_eq!(cb, 1200);
        assert!(ccut);
        assert!(std::str::from_utf8(co.as_bytes()).is_ok());
        assert!(co.starts_with("编") && co.ends_with("编"));
    }

    #[test]
    fn read_page_pages_and_reassembles() {
        let s = "中文字符测试".repeat(10); // 6 字 × 3 字节 × 10 = 180 字节
        let mut joined = String::new();
        let mut from = 0usize;
        for _ in 0..60 {
            let page = read_page(&s, from, 10);
            let text = page["text"].as_str().unwrap().to_string();
            assert!(!text.is_empty(), "每页必须有前进量，否则模型会死循环在同一页");
            assert_eq!(text.len(), page["nextFrom"].as_u64().unwrap() as usize - from);
            joined += &text;
            if !page["hasMore"].as_bool().unwrap() {
                break;
            }
            from = page["nextFrom"].as_u64().unwrap() as usize;
        }
        assert_eq!(joined, s); // 分页拼接与原文逐字节一致
    }

    #[test]
    fn read_page_bounds_are_safe() {
        let s = "abc中文"; // 3 + 3 + 3 = 9 字节，字符边界在 0/3/6/9
        let p = read_page(s, 100, 8); // from 超总长 → 夹到末尾：空页、无 more、不 panic
        assert_eq!(p["text"].as_str().unwrap(), "");
        assert_eq!(p["hasMore"].as_bool().unwrap(), false);
        assert_eq!(p["from"].as_u64().unwrap(), 9);
        let q = read_page(s, 3, 2); // 窗口右界落在「中」中间 ⇒ 向前吸附会退回起点，故改向后取下一边界保证有前进量
        assert_eq!(q["text"].as_str().unwrap(), "中");
        assert_eq!(q["nextFrom"].as_u64().unwrap(), 6);
        assert_eq!(q["hasMore"].as_bool().unwrap(), true);
        let r = read_page("", 0, 64);
        assert_eq!(r["totalBytes"].as_u64().unwrap(), 0);
        assert_eq!(r["hasMore"].as_bool().unwrap(), false);
    }

    #[test]
    fn stat_json_missing_path_is_not_an_error() {
        // P97-I4：fs_write 要靠它分「新建」与「覆盖」。把"不存在"当错误抛，
        // 新建这条路每次都会在探针上先红一次，模型只能靠猜。
        let ghost = std::env::temp_dir().join("larix_p97_stat_absolutely_missing_file.dat");
        let _ = std::fs::remove_file(&ghost);
        let v = stat_json(&ghost.to_string_lossy());
        assert_eq!(v["exists"].as_bool().unwrap(), false);
        assert_eq!(v["isDir"].as_bool().unwrap(), false);
        assert_eq!(v["bytes"].as_u64().unwrap(), 0);

        let f = std::env::temp_dir().join(format!("larix_p97_stat_{}.dat", std::process::id()));
        std::fs::write(&f, b"1234567").expect("写临时文件失败");
        let v = stat_json(&f.to_string_lossy());
        assert_eq!(v["exists"].as_bool().unwrap(), true);
        assert_eq!(v["isDir"].as_bool().unwrap(), false);
        assert_eq!(v["bytes"].as_u64().unwrap(), 7);
        assert!(v["modifiedMs"].as_u64().unwrap() > 0);

        let d = std::env::temp_dir();
        let v = stat_json(&d.to_string_lossy());
        assert_eq!(v["exists"].as_bool().unwrap(), true);
        assert_eq!(v["isDir"].as_bool().unwrap(), true);
        assert_eq!(v["bytes"].as_u64().unwrap(), 0); // 目录没有"自身字节数"，报 0 而不是猜一个
        assert_eq!(v["path"].as_str().unwrap(), d.to_string_lossy());
        let _ = std::fs::remove_file(&f);
    }
}
