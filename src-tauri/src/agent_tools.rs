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
        Ok(serde_json::json!({
            "exitCode": status,
            "timedOut": timed_out,
            "stdout": truncate_utf8(&out, SHELL_OUTPUT_LIMIT),
            "stderr": truncate_utf8(&err, SHELL_OUTPUT_LIMIT),
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
}
