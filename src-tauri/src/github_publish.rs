//! P157-E3：插件一键发布到 GitHub 话题。
//!
//! 与市场取回（P99b-N1）同一套"不宽松"的口径，但方向相反：
//!  - **目标域固定**：只有 `https://api.github.com`，URL 由本模块拼，前端给不了主机名；
//!  - **不跟重定向**：同 `market_fetch`（reqwest 无 redirect feature），3xx 原样报错；
//!  - **token 永不入日志/错误**：只进 Authorization 头；错误只带状态码与 GitHub 的 `message`。
//!
//! 前端负责把文件内容压成 base64、把话题归一化；这里再校验一遍——
//! 门禁只能证明"前端怎么调自己"，真正要发出去的东西必须在 Rust 侧再挡一次。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const API: &str = "https://api.github.com";
const TIMEOUT: Duration = Duration::from_secs(25);
const MAX_BODY: usize = 256 * 1024;
const MAX_FILES: usize = 12;
const MAX_FILE_B64: usize = 6 * 1024 * 1024;
const MAX_TOTAL_B64: usize = 12 * 1024 * 1024;
const FORCED_TOPIC: &str = "uartix-plugin";
const MAX_TOPICS: usize = 20;

#[derive(Debug, Deserialize)]
pub struct PublishFile {
    pub path: String,
    pub content: String,
}

/// GitHub 账号/组织名：字母数字与连字符，首尾必须是字母数字，1~39 字。
fn valid_owner(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=39).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// 仓库名：字母数字与 `._-`，1~100 字，拒绝 `.` / `..`。
fn valid_repo(v: &str) -> bool {
    let b = v.as_bytes();
    (1..=100).contains(&b.len())
        && v != "."
        && v != ".."
        && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// 发布文件路径：相对路径，禁 `..`/`.`/空段/反斜杠/控制字符，总长 ≤180。
fn valid_rel_path(v: &str) -> bool {
    if v.is_empty() || v.len() > 180 || v.starts_with('/') || v.contains('\\') || v.contains('\0') {
        return false;
    }
    v.split('/').all(|seg| {
        !seg.is_empty()
            && seg != "."
            && seg != ".."
            && seg.len() <= 80
            && seg.chars().all(|c| !c.is_control())
    })
}

fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn encode_rel_path(path: &str) -> Option<String> {
    if !valid_rel_path(path) {
        return None;
    }
    Some(path.split('/').map(encode_segment).collect::<Vec<_>>().join("/"))
}

/// 话题归一化：小写、空格/下划线转连字符、只留字母数字与连字符，首字符必须是字母数字，≤50。
fn normalize_topic(raw: &str) -> Option<String> {
    let mut s = String::new();
    for ch in raw.trim().chars() {
        let c = match ch {
            ' ' | '_' => '-',
            _ => ch,
        };
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if c == '-' {
            s.push('-');
        }
    }
    let trimmed = s.trim_matches('-').to_string();
    if trimmed.is_empty() || trimmed.len() > 50 || !trimmed.as_bytes()[0].is_ascii_alphanumeric() {
        return None;
    }
    Some(trimmed)
}

/// 强制话题排第一；去重、最多 20 个。
fn merge_topics(input: &[String], forced: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |t: String, out: &mut Vec<String>| {
        if out.len() < MAX_TOPICS && !out.iter().any(|x| x == &t) {
            out.push(t);
        }
    };
    if let Some(f) = normalize_topic(forced) {
        push(f, &mut out);
    }
    for raw in input {
        if let Some(t) = normalize_topic(raw) {
            push(t, &mut out);
        }
    }
    out
}

/// 发布口的话题清单：强制并入 FORCED_TOPIC。
/// 单独一层是为了可测——测试钉的必须是"命令真的用了强制话题"，而不是"helper 被喂了它"。
fn topics_for_publish(input: &[String]) -> Vec<String> {
    merge_topics(input, FORCED_TOPIC)
}

fn brief(msg: &str) -> String {
    msg.chars().take(200).collect()
}

fn api_error(status: u16, body: &Value) -> String {
    let msg = brief(body["message"].as_str().unwrap_or(""));
    let tail = if msg.is_empty() { String::new() } else { format!("：{msg}") };
    match status {
        401 => "GitHub token 无效或已过期".into(),
        403 => format!("GitHub 拒绝（403：权限不足或触发限流）{tail}"),
        404 => format!("GitHub 找不到目标（404：仓库/组织不存在，或 token 无权限）{tail}"),
        415 => format!("GitHub 拒绝了话题请求的媒体类型（415）{tail}"),
        422 => format!("GitHub 拒绝该请求（422：名称冲突/内容不合法）{tail}"),
        300..=399 => format!("GitHub 返回 {status}（不跟随重定向）"),
        s if s >= 500 => format!("GitHub 服务暂时不可用（{s}），稍后再试"),
        s => format!("GitHub 返回 {s}{tail}"),
    }
}

/// 发请求并读回 JSON；响应体硬上限，错误只带状态与 `message`（绝不含 token）。
async fn send_json(req: reqwest::RequestBuilder) -> Result<(u16, Value), String> {
    let resp = req
        .header("User-Agent", "UartixPlus/0.5 (Tauri)")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求 GitHub 超时（{}s）", TIMEOUT.as_secs())
            } else {
                format!("请求 GitHub 失败：{e}")
            }
        })?;
    let status = resp.status().as_u16();
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取 GitHub 响应失败：{e}"))? {
        if buf.len() + chunk.len() > MAX_BODY {
            return Err("GitHub 响应异常（超过 256KB）".into());
        }
        buf.extend_from_slice(&chunk);
    }
    let value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
    Ok((status, value))
}

fn api(path: &str) -> String {
    format!("{API}{path}")
}

/// 一键发布：验票 → 查/建仓库 → 逐文件 PUT（带 sha 覆盖）→ 强制并入话题。
#[tauri::command]
pub async fn github_publish(
    token: String,
    owner: Option<String>,
    repo: String,
    description: String,
    is_private: bool,
    files: Vec<PublishFile>,
    topics: Vec<String>,
    proxy: Option<String>,
    no_proxy: Option<String>,
) -> Result<Value, String> {
    let token = token.trim().to_string();
    if token.len() < 20 || token.len() > 200 {
        return Err("GitHub token 为空或长度异常".into());
    }
    let repo = repo.trim().to_string();
    if !valid_repo(&repo) {
        return Err("仓库名不合法（允许字母/数字/._-，1~100 字）".into());
    }
    let owner_in = owner.as_deref().unwrap_or("").trim().to_string();
    if !owner_in.is_empty() && !valid_owner(&owner_in) {
        return Err("属主不合法（GitHub 用户名或组织名）".into());
    }
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(format!("发布文件数必须在 1~{MAX_FILES} 之间"));
    }
    let mut total = 0usize;
    for f in &files {
        if encode_rel_path(&f.path).is_none() {
            return Err(format!("非法文件路径：{}", f.path));
        }
        if f.content.len() > MAX_FILE_B64 {
            return Err(format!("文件 {} 超过上限（{} 字节 content）", f.path, f.content.len()));
        }
        total += f.content.len();
    }
    if total > MAX_TOTAL_B64 {
        return Err(format!("发布内容合计 {total} 字节，超过上限 {MAX_TOTAL_B64}"));
    }

    let client = crate::ai::build_client(proxy.as_deref(), no_proxy.as_deref(), Some(TIMEOUT))?;

    // 1) 验票：401 就是 401，别让后面的 404 把"没登录"伪装成"仓库不存在"
    let (status, body) = send_json(client.get(api("/user")).bearer_auth(&token)).await?;
    if status == 401 {
        return Err("GitHub token 无效或已过期".into());
    }
    if status != 200 {
        return Err(api_error(status, &body));
    }
    let login = body["login"].as_str().unwrap_or("").to_string();
    if login.is_empty() {
        return Err("GitHub 未返回账号名".into());
    }
    let owner = if owner_in.is_empty() { login.clone() } else { owner_in };
    let repo_path = format!("/repos/{owner}/{repo}");

    // 2) 仓库存在就复用，404 才建；建仓权限与"组织存在"要分开说
    let mut created = false;
    let mut html_url;
    let (status, body) = send_json(client.get(api(&repo_path)).bearer_auth(&token)).await?;
    match status {
        200 => {
            html_url = body["html_url"].as_str().unwrap_or("").to_string();
        }
        404 => {
            let create_path = if owner.eq_ignore_ascii_case(&login) {
                "/user/repos".to_string()
            } else {
                format!("/orgs/{owner}/repos")
            };
            let payload = json!({
                "name": repo,
                "description": brief(&description),
                "private": is_private,
                "auto_init": false,
            });
            let (status, body) = send_json(
                client
                    .post(api(&create_path))
                    .bearer_auth(&token)
                    .header("Content-Type", "application/json")
                    .body(payload.to_string()),
            )
            .await?;
            match status {
                201 => {
                    created = true;
                    html_url = body["html_url"].as_str().unwrap_or("").to_string();
                }
                404 => return Err(format!("组织 {owner} 不存在，或 token 没有建仓权限")),
                422 => return Err(format!("建仓被拒（422：仓库名冲突或参数不合法）{}", api_error(422, &body))),
                s => return Err(api_error(s, &body)),
            }
        }
        s => return Err(api_error(s, &body)),
    }
    if html_url.is_empty() {
        html_url = format!("https://github.com/{owner}/{repo}");
    }

    // 3) 逐文件上传：先取 sha（覆盖已有文件），再 PUT
    let mut changed: Vec<String> = Vec::new();
    for f in &files {
        let enc = encode_rel_path(&f.path).ok_or_else(|| format!("非法文件路径：{}", f.path))?;
        let contents_url = api(&format!("{repo_path}/contents/{enc}"));
        let (status, body) = send_json(client.get(&contents_url).bearer_auth(&token)).await?;
        let sha = match status {
            200 => body["sha"].as_str().map(|s| s.to_string()),
            404 => None,
            s => return Err(api_error(s, &body)),
        };
        let mut payload = json!({
            "message": "Publish via Uartix+",
            "content": f.content,
        });
        if let Some(sha) = sha {
            payload["sha"] = json!(sha);
        }
        let (status, body) = send_json(
            client
                .put(&contents_url)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .body(payload.to_string()),
        )
        .await?;
        if status != 200 && status != 201 {
            return Err(api_error(status, &body));
        }
        changed.push(f.path.clone());
    }

    // 4) 话题：仓库已经就绪，这里失败只报警告，不把"上传成功"改判成失败
    let names = topics_for_publish(&topics);
    let mut warning = String::new();
    let mut final_topics = names.clone();
    let (status, body) = send_json(
        client
            .put(api(&format!("{repo_path}/topics")))
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .header("Content-Type", "application/json")
            .body(json!({ "names": names }).to_string()),
    )
    .await?;
    if status == 200 {
        if let Some(arr) = body["names"].as_array() {
            let got: Vec<String> = arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
            if !got.is_empty() {
                final_topics = got;
            }
        }
    } else {
        warning = format!("仓库已更新，但话题设置失败：{}", api_error(status, &body));
    }

    Ok(json!({
        "login": login,
        "owner": owner,
        "repo": repo,
        "repoUrl": html_url,
        "topicUrl": final_topics.first().map(|t| format!("https://github.com/topics/{t}")).unwrap_or_default(),
        "topics": final_topics,
        "created": created,
        "files": changed,
        "warning": warning,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_and_repo_are_strict() {
        assert!(valid_owner("Tanixs"));
        assert!(valid_owner("uartix-org"));
        assert!(!valid_owner(""));
        assert!(!valid_owner("-bad"));
        assert!(!valid_owner("bad-"));
        assert!(!valid_owner("has space"));
        assert!(!valid_owner("x".repeat(40).as_str()));

        assert!(valid_repo("uartix-plugin-link"));
        assert!(valid_repo("a.b_c-1"));
        assert!(!valid_repo(""));
        assert!(!valid_repo("."));
        assert!(!valid_repo(".."));
        assert!(!valid_repo("a/b"));
        assert!(!valid_repo("x".repeat(101).as_str()));
    }

    #[test]
    fn publish_paths_cannot_escape_the_repo() {
        assert!(valid_rel_path("plugin.uartix.json"));
        assert!(valid_rel_path("sub/dir/cover.png"));
        assert!(!valid_rel_path("../evil.json"));
        assert!(!valid_rel_path("/etc/passwd"));
        assert!(!valid_rel_path("a//b"));
        assert!(!valid_rel_path("a\\b"));
        assert!(!valid_rel_path("a/../b"));
        assert_eq!(encode_rel_path("my file.png").unwrap(), "my%20file.png");
        assert_eq!(encode_rel_path("插件.json").unwrap(), "%E6%8F%92%E4%BB%B6.json");
        assert!(encode_rel_path("../x").is_none());
    }

    #[test]
    fn topics_are_normalized_forced_first_and_capped() {
        assert_eq!(normalize_topic("  Uartix Plugin ").unwrap(), "uartix-plugin");
        assert_eq!(normalize_topic("uartix_plugin").unwrap(), "uartix-plugin");
        assert_eq!(normalize_topic("--x--").unwrap(), "x");
        assert!(normalize_topic("中文").is_none());
        assert!(normalize_topic("   ").is_none());

        // 输入里**故意不含**强制话题：这样"命令忘了并入 uartix-plugin"会当场红
        let merged = topics_for_publish(&["Serial Tool".into(), "Serial_Tool".into()]);
        assert_eq!(merged[0], "uartix-plugin");
        assert_eq!(merged, vec!["uartix-plugin", "serial-tool"]);

        let many: Vec<String> = (0..30).map(|i| format!("t{i}")).collect();
        assert_eq!(topics_for_publish(&many).len(), MAX_TOPICS);
    }

    #[test]
    fn errors_are_classified_without_leaking_anything() {
        let body = json!({ "message": "Bad credentials" });
        assert!(api_error(401, &body).contains("token 无效"));
        assert!(api_error(403, &json!({})).contains("403"));
        assert!(api_error(404, &json!({})).contains("404"));
        assert!(api_error(422, &json!({ "message": "name already exists" })).contains("already exists"));
        assert!(api_error(302, &json!({})).contains("不跟随重定向"));
        assert!(api_error(502, &json!({})).contains("暂时不可用"));
        assert!(!api_error(403, &json!({ "message": "x".repeat(500).as_str() })).contains(&"x".repeat(201)));
    }

    #[test]
    fn base64_helper_is_standard_alphabet() {
        assert_eq!(STANDARD.encode(b"abc"), "YWJj");
    }
}
