//! P99b-N1：市场取回通道（索引 JSON / 插件包 / 截图）。
//!
//! 为什么不复用 `agent_http_get`：那条的判定是"**挡私网**、其余放行"，
//! 而市场要的是"**只放白名单域**、其余一律拒"——形状相反，硬套等于把两条规则混进一个函数，
//! 以后改一条就会不小心改掉另一条（§8-36 的"同一能力两个门"的反面：同一个门两套规则）。
//! 但**私网判定与 URL 解析必须复用**（`agent_tools` 里那两份是逐条测过的，抄一份就会漂）。
//!
//! 三条刻意的"不宽松"：
//!  1. **只收 https**：包和图都可能被中间人替换，明文没有"看一下算了"的余地；
//!  2. **不跟重定向**（reqwest 未开 `redirect` feature，3xx 原样返回）→ 这里显式拒绝，
//!     否则白名单可以用一次 302 绕出去（与"白名单不折叠 `..` 就不是白名单"同族）；
//!  3. **字节上限是硬的**：先看 `content-length`，再逐块读、越线立刻停，不"信服务端报的数"。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

use crate::agent_tools::{is_private_host, url_host};

const MARKET_TIMEOUT: Duration = Duration::from_secs(20);
/// 再大的响应也不是市场该给的：这条比前端任何单项上限都宽，只挡"根本不讲理"的响应
const MARKET_ABSOLUTE_MAX: u64 = 8 * 1024 * 1024;

/// 精确或 `.` 边界子域。**空条目一律不放行**（`endsWith("")` 会把所有域放进名单）。
pub(crate) fn host_allowed(host: &str, allow: &[String]) -> bool {
    let h = host.trim().trim_end_matches('.').to_lowercase();
    if h.is_empty() {
        return false;
    }
    allow.iter().any(|a| {
        let base = a.trim().trim_start_matches('.').trim_end_matches('.').to_lowercase();
        !base.is_empty() && (h == base || h.ends_with(&format!(".{base}")))
    })
}

/// 前端可以要求更小，不能要求更大。
pub(crate) fn clamp_max(requested: u64) -> Result<u64, String> {
    if requested == 0 {
        return Err("字节上限必须大于 0".into());
    }
    Ok(if requested > MARKET_ABSOLUTE_MAX {
        MARKET_ABSOLUTE_MAX
    } else {
        requested
    })
}

/// 市场取回：白名单域 + https + 拒重定向 + 硬字节上限，返回 base64 与 sha256。
#[tauri::command]
pub async fn market_fetch(
    url: String,
    allow_hosts: Vec<String>,
    max_bytes: u64,
    proxy: Option<String>,
    no_proxy: Option<String>,
) -> Result<Value, String> {
    let cap = clamp_max(max_bytes)?;
    let lower = url.trim().to_lowercase();
    if !lower.starts_with("https://") {
        return Err("市场只走 https".into());
    }
    let host = url_host(&url).ok_or_else(|| "无法解析 URL 主机".to_string())?;
    if is_private_host(&host) {
        return Err(format!("拒绝访问内网/本机地址：{host}"));
    }
    if !host_allowed(&host, &allow_hosts) {
        return Err(format!("域不在市场白名单：{host}"));
    }

    let client = crate::ai::build_client(proxy.as_deref(), no_proxy.as_deref(), Some(MARKET_TIMEOUT))
        .map_err(|e| format!("建请求失败：{e}"))?;
    let started = Instant::now();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（{}s）", MARKET_TIMEOUT.as_secs())
            } else {
                format!("请求失败：{e}")
            }
        })?;
    let status = resp.status().as_u16();
    // 3xx 不在白名单语义里：跟过去就绕开了整道闸，所以直接拒并说清是哪个地址
    if (300..400).contains(&status) {
        return Err(format!("市场不跟重定向（{status}），请把索引/包地址填成最终地址：{url}"));
    }
    if status >= 400 {
        return Err(format!("远端返回 {status}"));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if let Some(len) = resp.content_length() {
        if len > cap {
            return Err(format!("响应 {} 字节，超过上限 {cap}（未下载）", len));
        }
    }

    let mut buf: Vec<u8> = Vec::new();
    let mut resp = resp;
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取失败：{e}"))? {
        if buf.len() + chunk.len() > cap as usize {
            return Err(format!("响应超过上限 {cap}（已中止）"));
        }
        buf.extend_from_slice(&chunk);
    }
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let digest = Sha256::digest(&buf);
    let sha256: String = digest.iter().map(|b| format!("{b:02x}")).collect();

    Ok(json!({
        "url": url,
        "host": host,
        "status": status,
        "contentType": content_type,
        "bytes": buf.len(),
        "sha256": sha256,
        "data": STANDARD.encode(&buf),
        "elapsedMs": elapsed_ms,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allowlist_is_exact_or_dot_bounded() {
        let a = hosts(&["raw.githubusercontent.com", "github.com"]);
        assert!(host_allowed("raw.githubusercontent.com", &a));
        assert!(host_allowed("RAW.GitHubusercontent.com", &a)); // 大小写不敏感
        assert!(host_allowed("codeload.github.com", &a));
        assert!(host_allowed("a.b.github.com", &a));
        // 这三条是白名单机制存在的全部理由
        assert!(!host_allowed("evilgithub.com", &a));
        assert!(!host_allowed("github.com.evil.io", &a));
        assert!(!host_allowed("", &a));
        assert!(!host_allowed("github.com", &hosts(&[""]))); // 空条目不许变成"放所有"
        assert!(!host_allowed("anything", &hosts(&[])));
    }

    #[test]
    fn credentials_in_url_cannot_smuggle_a_host_past_the_list() {
        // https://raw.githubusercontent.com@evil/x 的真实主机是 evil
        let h = url_host("https://raw.githubusercontent.com@evil.example/x").unwrap();
        assert_eq!(h, "evil.example");
        assert!(!host_allowed(&h, &hosts(&["github.com"])));
    }

    #[test]
    fn cap_is_bounded_below_the_absolute() {
        assert_eq!(clamp_max(1024).unwrap(), 1024);
        assert_eq!(clamp_max(u64::MAX).unwrap(), MARKET_ABSOLUTE_MAX);
        assert!(clamp_max(0).is_err());
    }

    #[test]
    fn private_targets_are_rejected_before_any_request() {
        assert!(is_private_host("127.0.0.1"));
        assert!(is_private_host("localhost"));
        assert!(is_private_host("169.254.1.1")); // 云元数据地址
        assert!(!is_private_host("raw.githubusercontent.com"));
    }
}
