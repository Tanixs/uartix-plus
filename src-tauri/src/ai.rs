use futures_util::StreamExt;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub struct AiState {
    aborts: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for AiState {
    fn default() -> Self {
        Self {
            aborts: Mutex::new(HashMap::new()),
        }
    }
}

/// 聊天消息：content 为字符串或 OpenAI 风格 parts 数组（[{type:"text",text},
/// {type:"image_url",image_url:{url:"data:image/...;base64,..."}}]）。
/// 请求体按 format 各自转换（anthropic/responses 的 parts 语法不同）
#[derive(serde::Serialize, Deserialize)]
pub struct AiMessage {
    pub role: String,
    pub content: serde_json::Value,
}

/// 提取纯文本（system 提示/摘要用）：字符串原样；parts 数组拼接 text 段
fn content_text(v: &serde_json::Value) -> String {
    if let Some(s) = v.as_str() {
        return s.to_string();
    }
    if let Some(arr) = v.as_array() {
        let mut s = String::new();
        for p in arr {
            if p.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                    s.push_str(t);
                }
            }
        }
        return s;
    }
    String::new()
}

/// data URL（data:image/png;base64,xxx）→ (media_type, base64 数据)；非法返回 None
fn split_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(",")?;
    let mt = meta.strip_suffix(";base64")?;
    Some((mt.to_string(), data.to_string()))
}

/// OpenAI 风格 parts → 目标格式 content
fn convert_content(v: &serde_json::Value, fmt: &str) -> serde_json::Value {
    if v.is_string() {
        return v.clone();
    }
    let arr = match v.as_array() {
        Some(a) => a,
        None => return serde_json::Value::String(String::new()),
    };
    let out: Vec<serde_json::Value> = arr
        .iter()
        .filter_map(|p| {
            let ty = p.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match (fmt, ty) {
                ("anthropic", "text") => Some(serde_json::json!({
                    "type": "text",
                    "text": p.get("text").cloned().unwrap_or_default(),
                })),
                ("anthropic", "image_url") => {
                    let url = p
                        .get("image_url")
                        .and_then(|i| i.get("url"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("");
                    split_data_url(url).map(|(mt, data)| {
                        serde_json::json!({
                            "type": "image",
                            "source": { "type": "base64", "media_type": mt, "data": data },
                        })
                    })
                }
                ("responses", "text") => Some(serde_json::json!({
                    "type": "input_text",
                    "text": p.get("text").cloned().unwrap_or_default(),
                })),
                ("responses", "image_url") => {
                    let url = p
                        .get("image_url")
                        .and_then(|i| i.get("url"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("");
                    Some(serde_json::json!({ "type": "input_image", "image_url": url }))
                }
                _ => Some(p.clone()), // openai 兼容：原样透传
            }
        })
        .collect();
    serde_json::Value::Array(out)
}

fn classify_error(status: u16, body: &str) -> String {
    let snippet: String = body.chars().take(220).collect();
    match status {
        401 | 403 => format!("API Key 无效或无权限（{}）。请到 设置 → AI 服务 检查 Key。", status),
        402 => format!("账户额度不足（{}）。请到服务商控制台充值或更换模型。", status),
        404 => format!("接口或模型不存在（{}）。请检查 Base URL、接口格式与模型名。{}", status, snippet),
        429 => format!("请求过于频繁或额度受限（{}）。请稍后再试。", status),
        500..=599 => format!("服务商服务端错误（{}）。请稍后再试。{}", status, snippet),
        _ => format!("请求失败（HTTP {}）。{}", status, snippet),
    }
}

/// P88e B1：pub(crate) 供 agent_tools::agent_http_get 复用（同一代理/超时策略）。
pub(crate) fn build_client(
    proxy: Option<&str>,
    no_proxy: Option<&str>,
    timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));
    b = match timeout {
        Some(t) => b.read_timeout(t).timeout(t),
        None => b.read_timeout(Duration::from_secs(60)),
    };
    with_proxy(b, proxy, no_proxy)?.build().map_err(|e| format!("网络客户端初始化失败：{}", e))
}

/// P96-K4：流式读空闲的默认上限（前端设置项 `streamIdleSecs` 可覆盖，范围 30..600）。
const DEFAULT_STREAM_IDLE_SECS: u64 = 120;

/// 流式专用客户端（P91 A1）：只约束连接与「单次读空闲」，**不设总时长**——
/// Agent 单轮正常就能跑几分钟，总时长上限会把健康长流掐死成"超时"。
fn build_stream_client(
    proxy: Option<&str>,
    no_proxy: Option<&str>,
    idle: Duration,
) -> Result<reqwest::Client, String> {
    // reqwest 0.12 异步 builder 默认即「无总时长上限」，只显式设连接与读空闲
    let b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(idle);
    with_proxy(b, proxy, no_proxy)?.build().map_err(|e| format!("网络客户端初始化失败：{}", e))
}

fn with_proxy(
    b: reqwest::ClientBuilder,
    proxy: Option<&str>,
    no_proxy: Option<&str>,
) -> Result<reqwest::ClientBuilder, String> {
    if let Some(p) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        let mut px = reqwest::Proxy::all(p).map_err(|e| format!("代理地址无效：{}", e))?;
        if let Some(np) = no_proxy.map(str::trim).filter(|s| !s.is_empty()) {
            px = px.no_proxy(reqwest::NoProxy::from_string(np));
        }
        return Ok(b.proxy(px));
    }
    Ok(b)
}

/// 连接层失败 → 机器可读（P91 A3：超时/断连属可重试，交给 loop 退避重试）
fn net_err(e: &reqwest::Error) -> TurnErr {
    if e.is_timeout() {
        TurnErr {
            code: "timeout",
            msg: "模型推理超时（读空闲窗口内没有任何字节）；可在 设置 → AI 服务 调大「流式读空闲超时」，或关掉「深度思考」/换更快的模型后重试".into(),
            retryable: true,
            shrink: true,
        }
    } else if e.is_connect() {
        TurnErr {
            code: "connect",
            msg: "网络连接失败；若访问的是国外服务，请到 设置 → AI 服务 填写 HTTP 代理（如 http://127.0.0.1:7897）".into(),
            retryable: true,
            shrink: false,
        }
    } else {
        TurnErr {
            code: "network",
            msg: format!("网络请求失败：{e}"),
            retryable: true,
            shrink: false,
        }
    }
}

/// 非 2xx → 复用聊天的 classify_error。P91 A2 实锤：旧 Agent 通道把响应体整个丢了，
/// 只报一个裸 HTTP 码，"max_tokens 超出模型上限"这类可直接行动的 400 提示用户一个字都看不到。
fn http_err(code: u16, body: &str) -> TurnErr {
    let (c, retryable, shrink) = match code {
        429 => ("rate_limited", true, false),
        408 | 409 | 425 => ("http_retryable", true, false),
        500..=599 => ("upstream", true, false),
        // 400 常见成因就是 max_tokens/上下文超出模型上限 → 降一档预算再试一次值得
        400 => ("bad_request", true, true),
        401 | 402 | 403 | 404 => ("config", false, false),
        _ => ("http_error", false, false),
    };
    TurnErr { code: c, msg: classify_error(code, body), retryable, shrink }
}

/// SSE 行协议切分喂聚合器（P91 A1）。只认 `data:` 行——三协议的增量事件都把类型写在
/// JSON 自身的 `type` 字段里，`event:` 行可忽略；跨 chunk 的残行留在缓冲等下一批。
fn drain_sse_lines(buf: &mut Vec<u8>, agg: &mut AgentAgg, format: &str) {
    while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let s = String::from_utf8_lossy(&line);
        let s = s.trim_end();
        let Some(rest) = s.strip_prefix("data:") else { continue };
        let data = rest.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            agg.feed(format, &v);
        }
    }
}

fn endpoint_url(base: &str, format: &str) -> String {
    let base = base.trim_end_matches('/');
    match format {
        "anthropic" => {
            if base.ends_with("/messages") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
        "responses" => {
            if base.ends_with("/responses") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/responses", base)
            } else {
                format!("{}/v1/responses", base)
            }
        }
        _ => format!("{}/chat/completions", base),
    }
}

fn split_system(messages: &[AiMessage]) -> (Option<String>, Vec<&AiMessage>) {
    let mut system = None;
    let mut rest = Vec::new();
    for m in messages {
        if m.role == "system" && system.is_none() {
            system = Some(content_text(&m.content));
        } else {
            rest.push(m);
        }
    }
    (system, rest)
}

fn extract_delta(format: &str, v: &serde_json::Value) -> (Option<String>, Option<String>, bool) {
    match format {
        "anthropic" => {
            match v.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    let dt = v.get("delta").cloned().unwrap_or(serde_json::Value::Null);
                    let kind = dt.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if kind == "thinking_delta" {
                        (
                            None,
                            dt.get("thinking").and_then(|t| t.as_str()).map(|s| s.to_string()),
                            false,
                        )
                    } else {
                        (
                            dt.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()),
                            None,
                            false,
                        )
                    }
                }
                Some("message_stop") => (None, None, true),
                _ => (None, None, false),
            }
        }
        "responses" => {
            match v.get("type").and_then(|t| t.as_str()) {
                Some("response.output_text.delta") => (
                    v.get("delta").and_then(|t| t.as_str()).map(|s| s.to_string()),
                    None,
                    false,
                ),
                Some("response.completed") => (None, None, true),
                _ => (None, None, false),
            }
        }
        _ => {
            if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
                if let Some(choice) = choices.first() {
                    let delta = choice.get("delta").cloned().unwrap_or(serde_json::Value::Null);
                    let content = delta
                        .get("content")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                    let reasoning = delta
                        .get("reasoning_content")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string());
                    let done = choice
                        .get("finish_reason")
                        .map(|f| !f.is_null())
                        .unwrap_or(false);
                    return (content, reasoning, done);
                }
            }
            (None, None, false)
        }
    }
}

fn done_json(req_id: &str, aborted: bool, usage: Option<(u64, u64)>) -> serde_json::Value {
    let mut v = serde_json::json!({ "reqId": req_id, "aborted": aborted });
    if let Some((p, c)) = usage {
        v["usage"] = serde_json::json!({ "prompt": p, "completion": c });
    }
    v
}

/// 从 SSE chunk 的 usage 字段提取 token 用量（chat/anthropic/responses 三种格式兼容）。
/// 输入/输出 token 分开合并，避免 anthropic 的 message_delta 只带 output 时丢失 input。
fn extract_usage(v: &serde_json::Value, last: &mut Option<(u64, u64)>) {
    if let Some(u) = v.get("usage") {
        let p = u
            .get("prompt_tokens")
            .and_then(|x| x.as_u64())
            .or_else(|| u.get("input_tokens").and_then(|x| x.as_u64()));
        let c = u
            .get("completion_tokens")
            .and_then(|x| x.as_u64())
            .or_else(|| u.get("output_tokens").and_then(|x| x.as_u64()));
        let (cp, cc) = last.unwrap_or((0, 0));
        let np = p.unwrap_or(cp);
        let nc = c.unwrap_or(cc);
        if np > 0 || nc > 0 {
            *last = Some((np, nc));
        }
    }
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AiState>,
    req_id: String,
    base_url: String,
    api_key: String,
    model: String,
    temperature: f64,
    format: String,
    proxy: Option<String>,
    no_proxy: Option<String>,
    messages: Vec<AiMessage>,
    thinking: Option<bool>,
) -> Result<(), String> {
    let fmt = format.as_str();
    let url = endpoint_url(&base_url, fmt);
    // anthropic/responses 的 parts 语法与 OpenAI 不同，逐条转换 content；
    // openai 兼容格式原样透传（字符串保持字符串，parts 数组直接序列化）
    let converted: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": convert_content(&m.content, fmt),
            })
        })
        .collect();
    let body = match fmt {
        "anthropic" => {
            let (system, rest) = split_system(&messages);
            let mut b = serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "temperature": temperature,
                "stream": true,
                "messages": converted
                    .iter()
                    .zip(rest.iter())
                    .filter(|(_, m)| m.role != "system")
                    .map(|(v, _)| v.clone())
                    .collect::<Vec<_>>(),
            });
            if let Some(s) = system {
                b["system"] = serde_json::Value::String(s);
            }
            // 扩展思考（思维链）：开启后响应含 thinking_delta 事件，前端思考区才有内容
            apply_anthropic_thinking(&mut b, thinking.unwrap_or(false));
            b
        }
        "responses" => {
            let (system, rest) = split_system(&messages);
            let mut b = serde_json::json!({
                "model": model,
                "temperature": temperature,
                "stream": true,
                "input": converted
                    .iter()
                    .zip(rest.iter())
                    .filter(|(_, m)| m.role != "system")
                    .map(|(v, _)| v.clone())
                    .collect::<Vec<_>>(),
            });
            if let Some(s) = system {
                b["instructions"] = serde_json::Value::String(s);
            }
            b
        }
        _ => serde_json::json!({
            "model": model,
            "temperature": temperature,
            "stream": true,
            "messages": converted,
        }),
    };

    let flag = Arc::new(AtomicBool::new(false));
    state
        .aborts
        .lock()
        .ok()
        .map(|mut m| m.insert(req_id.clone(), flag.clone()));

    let client = match build_client(proxy.as_deref(), no_proxy.as_deref(), None) {
        Ok(c) => c,
        Err(msg) => {
            state
                .aborts
                .lock()
                .ok()
                .map(|mut m| m.remove(&req_id));
            let _ = app.emit("ai:error", serde_json::json!({ "reqId": req_id, "msg": msg }));
            return Ok(());
        }
    };

    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body);
    if !api_key.is_empty() {
        req = if fmt == "anthropic" {
            req.header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
        } else {
            req.bearer_auth(&api_key)
        };
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            if flag.load(Ordering::Relaxed) {
                let _ = app.emit("ai:done", done_json(&req_id, true, None));
                return Ok(());
            }
            state
                .aborts
                .lock()
                .ok()
                .map(|mut m| m.remove(&req_id));
            let msg = if e.is_connect() || e.is_timeout() {
                format!(
                    "网络连接失败（{}）。若访问的是国外服务，请到 设置 → AI 服务 填写 HTTP 代理（如 http://127.0.0.1:7897）；留空时将跟随系统代理。",
                    e
                )
            } else {
                format!("网络请求失败：{}", e)
            };
            let _ = app.emit(
                "ai:error",
                serde_json::json!({ "reqId": req_id, "msg": msg }),
            );
            return Ok(());
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let text = resp.text().await.unwrap_or_default();
        state
            .aborts
            .lock()
            .ok()
            .map(|mut m| m.remove(&req_id));
        let _ = app.emit(
            "ai:error",
            serde_json::json!({ "reqId": req_id, "msg": classify_error(code, &text) }),
        );
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let mut last_usage: Option<(u64, u64)> = None;

    loop {
        if flag.load(Ordering::Relaxed) {
            break;
        }
        let item = stream.next().await;
        match item {
            None => break,
            Some(Err(e)) => {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                state
                    .aborts
                    .lock()
                    .ok()
                    .map(|mut m| m.remove(&req_id));
                let _ = app.emit(
                    "ai:error",
                    serde_json::json!({ "reqId": req_id, "msg": format!("流式连接中断：{}", e) }),
                );
                return Ok(());
            }
            Some(Ok(bytes)) => {
                buf.extend_from_slice(&bytes);
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line: Vec<u8> = buf.drain(..=pos).collect();
                    let s = String::from_utf8_lossy(&line);
                    let s = s.trim();
                    if !s.starts_with("data:") {
                        continue;
                    }
                    let data = s[5..].trim();
                    if data == "[DONE]" {
                        state
                            .aborts
                            .lock()
                            .ok()
                            .map(|mut m| m.remove(&req_id));
                        let _ = app.emit(
                            "ai:done",
                            done_json(&req_id, false, last_usage),
                        );
                        return Ok(());
                    }
                    let v: serde_json::Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    extract_usage(&v, &mut last_usage);
                    let (delta, reasoning, done) = extract_delta(fmt, &v);
                    if let Some(text) = delta {
                        if !text.is_empty() {
                            let _ = app.emit(
                                "ai:chunk",
                                serde_json::json!({ "reqId": req_id, "delta": text }),
                            );
                        }
                    }
                    if let Some(text) = reasoning {
                        if !text.is_empty() {
                            let _ = app.emit(
                                "ai:chunk",
                                serde_json::json!({ "reqId": req_id, "reasoning": text }),
                            );
                        }
                    }
                    if done {
                        state
                            .aborts
                            .lock()
                            .ok()
                            .map(|mut m| m.remove(&req_id));
                        let _ = app.emit(
                            "ai:done",
                            done_json(&req_id, false, last_usage),
                        );
                        return Ok(());
                    }
                }
            }
        }
    }

    state
        .aborts
        .lock()
        .ok()
        .map(|mut m| m.remove(&req_id));
    let _ = app.emit(
        "ai:done",
        done_json(&req_id, flag.load(Ordering::Relaxed), last_usage),
    );
    Ok(())
}

#[tauri::command]
pub fn ai_abort(state: State<'_, AiState>, req_id: String) {
    if let Some(mut m) = state.aborts.lock().ok() {
        if let Some(f) = m.remove(&req_id) {
            f.store(true, Ordering::Relaxed);
        }
    }
}

// P88b: bounded, structured turns use complete native protocol responses; never parse Markdown.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCall { call_id: String, name: String, arguments: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMessage {
    role: String, content: String,
    #[serde(default)] calls: Vec<AgentCall>,
    call_id: Option<String>,
    /** P90 B6：随该条消息附带的图片（data URL，前端已压缩）；仅 user 消息使用 */
    #[serde(default)] images: Vec<String>,
}
#[derive(Deserialize)]
pub struct AgentTool { name: String, description: String, parameters: serde_json::Value }

/// anthropic 扩展思考：开启后响应才有 thinking 块；官方约束 temperature 必须为 1。
/// 流式对话（ai_chat）与 Agent 单轮（ai_agent_turn）共用，避免两处形状漂移。
fn apply_anthropic_thinking(b: &mut serde_json::Value, on: bool) {
    if !on { return; }
    b["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": 4096 });
    b["temperature"] = serde_json::Value::from(1.0);
}

/// data URL → (media_type, base64 正文)；非 data URL 或畸形返回 None（该图静默丢弃）
fn data_url_parts(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    if data.is_empty() { return None; }
    let media = meta.split(';').next().unwrap_or("image/png");
    if !media.starts_with("image/") { return None; }
    Some((media.to_string(), data.to_string()))
}

fn agent_body(format: &str, model: &str, messages: &[AgentMessage], tools: &[AgentTool], thinking: bool, max_tokens: u32) -> serde_json::Value {
    use serde_json::json;
    let mut converted = Vec::new();
    let mut system = String::new();
    for m in messages {
        if m.role == "system" && format != "chat" { system.push_str(&m.content); continue; }
        match format {
            "anthropic" => {
                let mut content = Vec::new();
                if m.role == "tool" { content.push(json!({"type":"tool_result", "tool_use_id":m.call_id, "content":m.content})); }
                else {
                    if !m.content.is_empty() { content.push(json!({"type":"text", "text":m.content})); }
                    for u in &m.images {
                        if let Some((media, data)) = data_url_parts(u) {
                            content.push(json!({"type":"image","source":{"type":"base64","media_type":media,"data":data}}));
                        }
                    }
                    for c in &m.calls { content.push(json!({"type":"tool_use", "id":c.call_id, "name":c.name, "input":serde_json::from_str::<serde_json::Value>(&c.arguments).unwrap_or(json!({}))})); }
                }
                converted.push(json!({"role":if m.role == "tool" {"user"} else {&m.role}, "content":content}));
            }
            "responses" => {
                if m.role == "tool" { converted.push(json!({"type":"function_call_output", "call_id":m.call_id, "output":m.content})); }
                else {
                    if m.images.is_empty() {
                        if !m.content.is_empty() { converted.push(json!({"role":m.role, "content":m.content})); }
                    } else {
                        let mut parts = Vec::new();
                        if !m.content.is_empty() { parts.push(json!({"type":"input_text","text":m.content})); }
                        for u in &m.images { if data_url_parts(u).is_some() { parts.push(json!({"type":"input_image","image_url":u})); } }
                        converted.push(json!({"role":m.role,"content":parts}));
                    }
                    for c in &m.calls { converted.push(json!({"type":"function_call", "call_id":c.call_id, "name":c.name, "arguments":c.arguments})); }
                }
            }
            _ => {
                let mut msg = json!({"role":m.role, "content":m.content});
                if !m.images.is_empty() {
                    let mut parts = Vec::new();
                    if !m.content.is_empty() { parts.push(json!({"type":"text","text":m.content})); }
                    for u in &m.images { if data_url_parts(u).is_some() { parts.push(json!({"type":"image_url","image_url":{"url":u}})); } }
                    msg["content"] = json!(parts);
                }
                if m.role == "tool" { msg["tool_call_id"] = json!(m.call_id); }
                if !m.calls.is_empty() { msg["tool_calls"] = json!(m.calls.iter().map(|c| json!({"id":c.call_id, "type":"function", "function":{"name":c.name,"arguments":c.arguments}})).collect::<Vec<_>>()); }
                converted.push(msg);
            }
        }
    }
    let definitions: Vec<_> = tools.iter().map(|t| match format {
        "anthropic" => json!({"name":t.name,"description":t.description,"input_schema":t.parameters}),
        "responses" => json!({"type":"function","name":t.name,"description":t.description,"parameters":t.parameters,"strict":false}),
        _ => json!({"type":"function","function":{"name":t.name,"description":t.description,"parameters":t.parameters}}),
    }).collect();
    // P91 A1：Agent 单轮改**流式**。非流式要求网关整包缓冲完再返回，推理模型长正文
    // 必撞上游生成超时，而多数 OpenAI 兼容网关此时仍回 HTTP 200、只在 body 里给
    // finish_reason:"error"（带内错误）——这就是 P90 真机"每次第 2~3 轮必败"的主因
    // （聊天通道一直走流式，所以只有 Agent 犯）。
    // max_tokens 由调用方给并可逐级下调（截断时降档重试，见 ai_agent_turn）。
    let mut body = match format {
        "anthropic" => json!({"model":model,"system":system,"messages":converted,"tools":definitions,"max_tokens":max_tokens,"stream":true}),
        "responses" => json!({"model":model,"instructions":system,"input":converted,"tools":definitions,"max_output_tokens":max_tokens,"stream":true,"store":false}),
        _ => json!({"model":model,"messages":converted,"tools":definitions,"max_tokens":max_tokens,"stream":true}),
    };
    // P90 B1：Agent 通道也要产思维链——anthropic 不开 thinking 就永远没有思考块
    if format == "anthropic" { apply_anthropic_thinking(&mut body, thinking); }
    body
}

/// 单轮失败的机器可读形状（P91 A2/A3）。旧实现把 `{:?}` 的 Rust Debug 串
/// （`Some("error")`）直接甩到界面上，用户看到的不是错误而是内部类型；
/// 且前端无法区分"该重试"与"该定因失败"。
/// Tauri IPC 错误通道只有 String，故以 JSON 传输；provider.ts 解不动时整串当文案显示。
#[derive(Debug, Clone, PartialEq)]
struct TurnErr {
    code: &'static str,
    msg: String,
    /// 可重试：带内 error / 超时 / 断连 / 429 / 5xx
    retryable: bool,
    /// 重试前应下调 max_tokens（截断类、以及"max_tokens 超模型上限"的 400）
    shrink: bool,
}

impl TurnErr {
    fn to_json(&self) -> String {
        serde_json::json!({
            "agentError": 1, "code": self.code, "msg": self.msg,
            "retryable": self.retryable, "shrink": self.shrink,
            // P95-H1：输入侧超限（前端已按 80% 软顶自查过一轮，走到这里说明确实放不下）。
            // 它**不能**复用 shrink 语义：shrink=降输出预算，对"发出去的包太大"毫无作用。
            "shrinkInput": self.code == "context_overflow",
        })
        .to_string()
    }
    fn plain(code: &'static str, msg: impl Into<String>) -> Self {
        TurnErr { code, msg: msg.into(), retryable: false, shrink: false }
    }
}

/// 请求体硬上限（防失控兜底；模型自身窗口通常远小于此）。
/// 前端 `agent/context.ts:REQUEST_SOFT_LIMIT` 取其 ~80% 做发送前自查，两边靠这个数字对齐。
const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;

/// 超限判定单独成函数：给得出**实测字节数**的文案（旧实现只说"超限"，用户与模型都不知道差多少、
/// 该砍哪一块），且可被单测直接覆盖。
fn assert_request_size(body: &serde_json::Value) -> Result<(), TurnErr> {
    let bytes = body.to_string().len();
    if bytes <= MAX_REQUEST_BYTES {
        return Ok(());
    }
    Err(TurnErr::plain(
        "context_overflow",
        format!(
            "任务上下文 {} KB，超上限 {} KB；系统已去掉历史附图并收紧折叠仍放不下。请把目标拆成几次任务，或减少勾选的附加上下文。",
            bytes / 1024,
            MAX_REQUEST_BYTES / 1024
        ),
    ))
}

/// 非正常收尾 → 中文可读 + 机器码 + 重试策略（P91 A2：三协议共用一份映射，
/// 避免协议语义在两处漂移）。
fn stop_err(stop: Option<&str>, events: usize) -> TurnErr {
    match stop {
        Some(r @ ("max_tokens" | "length" | "incomplete")) => TurnErr {
            code: "truncated",
            msg: format!("模型输出达长度上限被截断（{r}）；未执行工具"),
            retryable: true,
            shrink: true,
        },
        Some("content_filter") | Some("sensitive") | Some("sensitive_word") => {
            TurnErr::plain("content_filter", "模型回复被内容审核中断；请调整目标描述后重试")
        }
        Some("refusal") => {
            TurnErr::plain("refusal", "模型拒绝回答本次请求；请换一种说法或更换模型")
        }
        Some("error") | Some("failed") => TurnErr {
            code: "provider_error",
            msg: "模型服务在生成过程中返回错误（网关带内错误，多为上游空闲超时或过载）；未执行工具。重试时会降低输出预算并关掉深度思考".into(),
            retryable: true,
            // P96-K4：以前这里是 false ⇒ loop 原样重发同一份巨请求，于是**再撞一次同一个上游超时**
            // （真机表现：第 3、4 轮各失败一次、白等两遍）。带内错误与"没给结束标记即断流"
            // 的共同点是本轮输出太大/静默太久，降预算 + 关思考是我们这侧唯一有效的杠杆。
            shrink: true,
        },
        None if events > 0 => TurnErr {
            code: "no_stop",
            msg: "模型未给出结束标记即断流；未执行工具。重试时会降低输出预算并关掉深度思考".into(),
            retryable: true,
            shrink: true,
        },
        None => TurnErr {
            code: "no_output",
            msg: "模型无输出（响应体无 choices/content 或协议字段不匹配）；请检查接口格式与模型名".into(),
            retryable: true,
            shrink: false,
        },
        Some(other) => TurnErr {
            code: "unknown_stop",
            msg: format!("模型回复未正常结束（服务返回 {other}）；未执行工具"),
            retryable: true,
            shrink: false,
        },
    }
}

/// 收尾裁决：流式与非流式共用（P91 A1）。校验工具调用、限长思维链、产出统一形状。
fn turn_finish(
    format: &str,
    stop: Option<&str>,
    text: String,
    reasoning: String,
    calls: Vec<serde_json::Value>,
) -> Result<serde_json::Value, TurnErr> {
    use serde_json::json;
    let ok = match format {
        "anthropic" => matches!(stop, Some("end_turn") | Some("tool_use")),
        "responses" => stop == Some("completed"),
        _ => matches!(stop, Some("stop") | Some("tool_calls")),
    };
    if !ok {
        return Err(stop_err(stop, 0));
    }
    if text.trim().is_empty() && calls.is_empty() {
        return Err(TurnErr {
            code: "empty_reply",
            msg: "模型回复为空；未执行工具".into(),
            retryable: true,
            shrink: false,
        });
    }
    if calls.len() > 64 {
        return Err(TurnErr::plain("too_many_calls", "工具调用超限"));
    }
    for call in &calls {
        if call["callId"].as_str().filter(|s| !s.is_empty() && s.len() <= 256).is_none()
            || call["name"].as_str().filter(|s| !s.is_empty() && s.len() <= 128).is_none()
            || call["arguments"]
                .as_str()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .filter(|v| v.is_object())
                .is_none()
        {
            return Err(TurnErr::plain("bad_arguments", "工具参数无效；未执行"));
        }
    }
    // 思维链仅用于展示：限长防 IPC 膨胀，且不回灌模型历史（loop 侧不落 messages）
    let reasoning_brief: String = reasoning.chars().take(8000).collect();
    Ok(json!({"content": text, "calls": calls, "reasoning": reasoning_brief}))
}

/// 非流式整包 JSON 解析（P91 A1 后作为**回退路径**保留：部分网关忽略 stream:true
/// 仍回普通 JSON，见 ai_agent_turn 的 `agg.events == 0` 分支）。
fn agent_result(format: &str, value: &serde_json::Value) -> Result<serde_json::Value, TurnErr> {
    use serde_json::json;
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut calls: Vec<serde_json::Value> = Vec::new();
    let stop = match format {
        "anthropic" => {
            if let Some(blocks) = value["content"].as_array() {
                for block in blocks {
                    if block["type"] == "text" { text.push_str(block["text"].as_str().unwrap_or("")); }
                    // 扩展思考块（需请求带 thinking 才会有；缺失即空串，绝不报错中断任务）
                    if block["type"] == "thinking" { reasoning.push_str(block["thinking"].as_str().unwrap_or("")); }
                    if block["type"] == "tool_use" { calls.push(json!({"callId":block["id"],"name":block["name"],"arguments":block["input"].to_string()})); }
                }
            }
            value["stop_reason"].as_str()
        }
        "responses" => {
            if let Some(items) = value["output"].as_array() {
                for item in items {
                    if item["type"] == "function_call" { calls.push(json!({"callId":item["call_id"],"name":item["name"],"arguments":item["arguments"]})); }
                    if let Some(content) = item["content"].as_array() { for block in content { if block["type"] == "output_text" { text.push_str(block["text"].as_str().unwrap_or("")); } } }
                    if item["type"] == "reasoning" {
                        if let Some(sum) = item["summary"].as_array() {
                            for s in sum { if s["type"] == "summary_text" { reasoning.push_str(s["text"].as_str().unwrap_or("")); } }
                        }
                    }
                }
            }
            value["status"].as_str()
        }
        _ => {
            let choice = &value["choices"][0];
            let msg = &choice["message"];
            text.push_str(msg["content"].as_str().unwrap_or(""));
            // OpenAI 兼容生态的推理字段名不统一：deepseek-r1 系用 reasoning_content，
            // 部分网关用 reasoning；取不到就是空串（R3：绝不因缺字段报错）
            let r1 = msg["reasoning_content"].as_str().unwrap_or("");
            let r2 = msg["reasoning"].as_str().unwrap_or("");
            reasoning.push_str(if !r1.is_empty() { r1 } else { r2 });
            if let Some(items) = msg["tool_calls"].as_array() { for c in items { calls.push(json!({"callId":c["id"],"name":c["function"]["name"],"arguments":c["function"]["arguments"]})); } }
            choice["finish_reason"].as_str()
        }
    };
    turn_finish(format, stop, text, reasoning, calls)
}

/// 流式分片归并出的一支工具调用（参数是分片，必须按槽位拼接）
#[derive(Default, Clone)]
struct AggCall {
    id: String,
    name: String,
    args: String,
}

/// P91 A1：Agent 单轮 SSE 聚合器。三协议的增量事件喂进来，收尾产出与 `agent_result`
/// 同形状的字段。工具调用的归并口径按协议不同：chat 按 `tool_calls[].index`、
/// anthropic 按 content block 序号（block_start 建槽）、responses 按 `item_id`。
#[derive(Default)]
struct AgentAgg {
    text: String,
    reasoning: String,
    calls: Vec<AggCall>,
    /// 协议侧标识 → calls 下标（anthropic 用 "b{blockIndex}"，responses 用 item id）
    by_item: Vec<(String, usize)>,
    stop: Option<String>,
    /// 带内错误：网关在 200 的流里回 error 事件（P90 必败的直接表现）
    in_band: Option<String>,
    events: usize,
}

impl AgentAgg {
    fn slot(&mut self, idx: usize) -> &mut AggCall {
        while self.calls.len() <= idx {
            self.calls.push(AggCall::default());
        }
        &mut self.calls[idx]
    }

    fn of_item(&self, key: &str) -> Option<usize> {
        self.by_item.iter().find(|(k, _)| k == key).map(|(_, i)| *i)
    }

    fn feed(&mut self, format: &str, v: &serde_json::Value) {
        self.events += 1;
        if self.in_band.is_none() {
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                let m = err.get("message").and_then(|s| s.as_str()).unwrap_or("");
                let c = err
                    .get("code")
                    .and_then(|s| s.as_str())
                    .or_else(|| err.get("type").and_then(|s| s.as_str()))
                    .unwrap_or("");
                let joined = match (m.is_empty(), c.is_empty()) {
                    (true, true) => String::new(),
                    (false, true) => m.to_string(),
                    (true, false) => c.to_string(),
                    (false, false) => format!("{m}（{c}）"),
                };
                if !joined.is_empty() {
                    self.in_band = Some(joined);
                }
            }
        }
        match format {
            "anthropic" => self.feed_anthropic(v),
            "responses" => self.feed_responses(v),
            _ => self.feed_chat(v),
        }
    }

    fn feed_chat(&mut self, v: &serde_json::Value) {
        let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|a| a.first()).cloned() else { return };
        if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            self.stop = Some(fr.to_string());
        }
        let delta = choice.get("delta").cloned().unwrap_or(serde_json::Value::Null);
        if let Some(t) = delta.get("content").and_then(|c| c.as_str()) {
            self.text.push_str(t);
        }
        let r = delta
            .get("reasoning_content")
            .and_then(|c| c.as_str())
            .or_else(|| delta.get("reasoning").and_then(|c| c.as_str()));
        if let Some(t) = r {
            self.reasoning.push_str(t);
        }
        if let Some(items) = delta.get("tool_calls").and_then(|t| t.as_array()).cloned() {
            for tc in items {
                let idx = tc
                    .get("index")
                    .and_then(|i| i.as_u64())
                    .unwrap_or(self.calls.len() as u64) as usize;
                if let Some(id) = tc.get("id").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                    self.slot(idx).id = id.to_string();
                }
                let Some(f) = tc.get("function") else { continue };
                if let Some(n) = f.get("name").and_then(|s| s.as_str()).filter(|s| !s.is_empty()) {
                    self.slot(idx).name.push_str(n);
                }
                if let Some(a) = f.get("arguments").and_then(|s| s.as_str()) {
                    self.slot(idx).args.push_str(a);
                }
            }
        }
    }

    fn feed_anthropic(&mut self, v: &serde_json::Value) {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "content_block_start" => {
                let block = v.get("content_block").cloned().unwrap_or(serde_json::Value::Null);
                if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                    let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                    let slot = self.calls.len();
                    self.calls.push(AggCall {
                        id: block.get("id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        name: block.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        args: String::new(),
                    });
                    self.by_item.push((format!("b{idx}"), slot));
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let d = v.get("delta").cloned().unwrap_or(serde_json::Value::Null);
                match d.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = d.get("text").and_then(|s| s.as_str()) { self.text.push_str(t); }
                    }
                    "thinking_delta" => {
                        if let Some(t) = d.get("thinking").and_then(|s| s.as_str()) { self.reasoning.push_str(t); }
                    }
                    "input_json_delta" => {
                        if let Some(i) = self.of_item(&format!("b{idx}")) {
                            if let Some(t) = d.get("partial_json").and_then(|s| s.as_str()) {
                                self.calls[i].args.push_str(t);
                            }
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(s) = v.get("delta").and_then(|d| d.get("stop_reason")).and_then(|s| s.as_str()) {
                    self.stop = Some(s.to_string());
                }
            }
            "message_stop" => {
                if self.stop.is_none() {
                    self.stop = Some("end_turn".to_string());
                }
            }
            _ => {}
        }
    }

    fn feed_responses(&mut self, v: &serde_json::Value) {
        let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match ty {
            "response.output_item.added" => {
                let item = v.get("item").cloned().unwrap_or(serde_json::Value::Null);
                if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                    let slot = self.calls.len();
                    self.calls.push(AggCall {
                        id: item.get("call_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        name: item.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        args: String::new(),
                    });
                    if let Some(i) = item.get("id").and_then(|s| s.as_str()) {
                        self.by_item.push((i.to_string(), slot));
                    }
                }
            }
            "response.output_text.delta" => {
                if let Some(t) = v.get("delta").and_then(|d| d.as_str()) { self.text.push_str(t); }
            }
            "response.reasoning_summary_text.delta" | "response.reason_text.delta" => {
                if let Some(t) = v.get("delta").and_then(|d| d.as_str()) { self.reasoning.push_str(t); }
            }
            "response.function_call_arguments.delta" => {
                let found = v
                    .get("item_id")
                    .and_then(|i| i.as_str())
                    .and_then(|id| self.of_item(id));
                if let Some(i) = found {
                    if let Some(t) = v.get("delta").and_then(|d| d.as_str()) {
                        self.calls[i].args.push_str(t);
                    }
                }
            }
            "response.completed" => self.stop = Some("completed".to_string()),
            "response.incomplete" => self.stop = Some("incomplete".to_string()),
            "response.failed" => self.stop = Some("failed".to_string()),
            _ => {}
        }
    }

    /// 收尾：带内错误优先（它意味着这一轮根本不可信），否则交统一裁决。
    fn finish(&mut self, format: &str) -> Result<serde_json::Value, TurnErr> {
        use serde_json::json;
        if let Some(m) = self.in_band.take() {
            return Err(TurnErr {
                code: "provider_error",
                msg: format!("模型服务在回复中途返回错误：{m}；未执行工具。重试时会降低输出预算并关掉深度思考"),
                retryable: true,
                // P96-K4：与 stop_err 的 provider_error 同口径（原样重发只会再撞一次上游空闲超时）
                shrink: true,
            });
        }
        let calls: Vec<serde_json::Value> = self
            .calls
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.name.is_empty() || !c.args.trim().is_empty())
            .map(|(i, c)| {
                json!({
                    // 分片流里 id 可能整段缺失（网关只给 index），补合成 id 让它可执行；
                    // 非流式路径恒有 id，故此兜底不改变原语义
                    "callId": if c.id.is_empty() { format!("agg_{i}") } else { c.id.clone() },
                    "name": c.name.clone(),
                    // 空参数分片归一化为 "{}"，否则对象校验会误杀"无参调用"
                    "arguments": if c.args.trim().is_empty() { "{}".to_string() } else { c.args.clone() },
                })
            })
            .collect();
        let text = std::mem::take(&mut self.text);
        let reasoning = std::mem::take(&mut self.reasoning);
        let stop = self.stop.clone();
        let events = self.events;
        turn_finish(format, stop.as_deref(), text, reasoning, calls).map_err(|mut e| {
            // 流式已经收到事件却没等到结束标记 = 断流，而不是"协议字段不匹配"
            if e.code == "no_output" && events > 0 {
                e = stop_err(None, events);
            }
            e
        })
    }
}

#[tauri::command]
pub async fn ai_agent_turn(
    app: AppHandle, state: State<'_, AiState>, req_id: String, base_url: String, api_key: String,
    model: String, format: String, proxy: Option<String>, no_proxy: Option<String>,
    messages: Vec<AgentMessage>, tools: Vec<AgentTool>, thinking: Option<bool>,
    max_tokens: Option<u32>, stream_idle_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    if !["chat", "anthropic", "responses"].contains(&format.as_str()) {
        return Err(TurnErr::plain("bad_format", "不支持执行模式协议").to_json());
    }
    // 输出预算：默认 16384（思维链吃输出预算，给小必截断）；前端可按 shrink 逐级下调重试
    let budget = max_tokens.unwrap_or(16384).clamp(1024, 32768);
    let body = agent_body(&format, &model, &messages, &tools, thinking.unwrap_or(false), budget);
    // P95-H1：阈值常量化，前端 `REQUEST_SOFT_LIMIT` 就是按这个数取 80% 的
    if let Err(e) = assert_request_size(&body) {
        return Err(e.to_json());
    }
    // P91 A1：流式下不设「总时长」上限（健康长流会被掐死），只约束连接与单次读空闲。
    // P96-K4：读空闲上限改成设置项（30..600s，默认 120）——它管得到的是"我们这侧肯等多久"，
    // 上游网关自己掐断的（截图里那句 Upstream idle timeout）只能靠 shrink/关思考绕。
    let idle = stream_idle_secs.unwrap_or(DEFAULT_STREAM_IDLE_SECS).clamp(30, 600);
    let client = build_stream_client(proxy.as_deref(), no_proxy.as_deref(), Duration::from_secs(idle))
        .map_err(|e| TurnErr { code: "client", msg: e, retryable: false, shrink: false }.to_json())?;
    let mut req = client.post(endpoint_url(&base_url, &format)).json(&body);
    if format == "anthropic" { req = req.header("x-api-key", api_key).header("anthropic-version", "2023-06-01"); }
    else if !api_key.is_empty() { req = req.bearer_auth(api_key); }
    let flag = Arc::new(AtomicBool::new(false));
    state.aborts.lock()
        .map_err(|_| TurnErr::plain("abort_unavailable", "取消服务不可用").to_json())?
        .insert(req_id.clone(), flag.clone());
    let operation = async {
        let response = req.send().await.map_err(|e| net_err(&e))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(http_err(status.as_u16(), &text));
        }
        let mut stream = response.bytes_stream();
        let mut buf: Vec<u8> = Vec::new(); // 行切分用（会 drain）
        let mut raw: Vec<u8> = Vec::new(); // 整包回退用（只追加）
        let mut agg = AgentAgg::default();
        let mut sent_text = 0usize;
        let mut sent_rea = 0usize;
        let mut overflow = false;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| net_err(&e))?;
            if raw.len() + chunk.len() > 4 * 1024 * 1024 { overflow = true; break; }
            if flag.load(Ordering::Relaxed) { break; }
            raw.extend_from_slice(&chunk);
            buf.extend_from_slice(&chunk);
            drain_sse_lines(&mut buf, &mut agg, &format);
            // 实时进度：只发增量，前端覆盖式拼到 live 缓冲（P91 A1 边到边显示思维链）
            let t = agg.text.chars().count();
            if t > sent_text {
                let delta: String = agg.text.chars().skip(sent_text).collect();
                sent_text = t;
                let _ = app.emit("agent:delta", serde_json::json!({ "reqId": req_id, "text": delta }));
            }
            let r = agg.reasoning.chars().count();
            if r > sent_rea {
                let delta: String = agg.reasoning.chars().skip(sent_rea).collect();
                sent_rea = r;
                let _ = app.emit("agent:delta", serde_json::json!({ "reqId": req_id, "reasoning": delta }));
            }
        }
        if overflow {
            return Err(TurnErr::plain("response_overflow", "模型响应超限；未执行工具"));
        }
        // 收尾：末行可能没有换行符
        if !buf.is_empty() {
            let s = String::from_utf8_lossy(&buf).trim_end().to_string();
            if let Some(rest) = s.strip_prefix("data:") {
                let data = rest.trim();
                if !data.is_empty() && data != "[DONE]" {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                        agg.feed(&format, &v);
                    }
                }
            }
        }
        if agg.events == 0 {
            // 网关忽略 stream:true、仍回普通 JSON：整包解析兜底
            let value = serde_json::from_slice(&raw).map_err(|_| TurnErr {
                code: "bad_json",
                msg: "模型未返回有效 JSON（响应既不是 SSE 也不是 JSON）".into(),
                retryable: true,
                shrink: false,
            })?;
            return agent_result(&format, &value);
        }
        agg.finish(&format)
    };
    let cancelled = async {
        loop { if flag.load(Ordering::Relaxed) { break; } tokio::time::sleep(Duration::from_millis(25)).await; }
        Err(TurnErr::plain("cancelled", "已停止；未派发后续工具"))
    };
    let result = match futures_util::future::select(Box::pin(operation), Box::pin(cancelled)).await {
        futures_util::future::Either::Left((r, _)) | futures_util::future::Either::Right((r, _)) => r,
    };
    if let Ok(mut map) = state.aborts.lock() { map.remove(&req_id); }
    result.map_err(|e| e.to_json())
}

#[tauri::command]
pub async fn ai_upload_report(
    endpoint: String,
    body: String,
    proxy: Option<String>,
    no_proxy: Option<String>,
) -> Result<String, String> {
    let client = build_client(proxy.as_deref(), no_proxy.as_deref(), Some(Duration::from_secs(20)))?;
    let resp = client
        .post(&endpoint)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("服务器返回 HTTP {}", status.as_u16()));
    }
    let snippet: String = text.chars().take(200).collect();
    Ok(snippet)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_data_url_parses_media_and_payload() {
        let (mt, data) = split_data_url("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(mt, "image/png");
        assert_eq!(data, "aGVsbG8=");
        assert!(split_data_url("https://example.com/a.png").is_none());
        assert!(split_data_url("data:image/jpeg,aGVsbG8=").is_none()); // 非 base64 声明
    }

    #[test]
    fn convert_content_anthropic_image_and_text() {
        let v = serde_json::json!([
            { "type": "text", "text": "看图" },
            { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,QUJD" } },
        ]);
        let out = convert_content(&v, "anthropic");
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[1]["type"], "image");
        assert_eq!(arr[1]["source"]["type"], "base64");
        assert_eq!(arr[1]["source"]["media_type"], "image/jpeg");
        assert_eq!(arr[1]["source"]["data"], "QUJD");
    }

    #[test]
    fn convert_content_openai_passthrough_and_string() {
        let s = serde_json::json!("纯文本");
        assert_eq!(convert_content(&s, "openai"), s);
        let v = serde_json::json!([
            { "type": "text", "text": "hi" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,QQ==" } },
        ]);
        assert_eq!(convert_content(&v, "openai"), v);
    }

    #[test]
    fn convert_content_responses_syntax() {
        let v = serde_json::json!([
            { "type": "text", "text": "hi" },
            { "type": "image_url", "image_url": { "url": "https://x/a.png" } },
        ]);
        let out = convert_content(&v, "responses");
        let arr = out.as_array().unwrap();
        assert_eq!(arr[0]["type"], "input_text");
        assert_eq!(arr[1]["type"], "input_image");
        assert_eq!(arr[1]["image_url"], "https://x/a.png");
    }

    #[test]
    fn content_text_concatenates_text_parts() {
        let v = serde_json::json!([
            { "type": "text", "text": "a" },
            { "type": "image_url", "image_url": { "url": "data:image/png;base64,QQ==" } },
            { "type": "text", "text": "b" },
        ]);
        assert_eq!(content_text(&v), "ab");
        assert_eq!(content_text(&serde_json::json!("直接")), "直接");
    }

    /* ============ P88b：agent 轮次请求/响应转换 ============ */

    fn amsg(role: &str, content: &str) -> AgentMessage {
        AgentMessage { role: role.into(), content: content.into(), calls: vec![], call_id: None, images: vec![] }
    }
    fn amsg_imgs(role: &str, content: &str, images: Vec<String>) -> AgentMessage {
        AgentMessage { role: role.into(), content: content.into(), calls: vec![], call_id: None, images }
    }
    fn acall(id: &str, name: &str, args: &str) -> AgentCall {
        AgentCall { call_id: id.into(), name: name.into(), arguments: args.into() }
    }
    fn atool() -> Vec<AgentTool> {
        vec![AgentTool {
            name: "settings_apply".into(),
            description: "d".into(),
            parameters: serde_json::json!({ "type": "object" }),
        }]
    }
    fn agent_turn_messages() -> Vec<AgentMessage> {
        vec![
            amsg("system", "sys"),
            amsg("user", "把字号调大"),
            AgentMessage {
                role: "assistant".into(),
                content: String::new(),
                calls: vec![acall("c1", "settings_apply", "{\"zoom\":110}")],
                call_id: None,
                images: vec![],
            },
            AgentMessage {
                role: "tool".into(),
                content: "{\"ok\":true}".into(),
                calls: vec![],
                call_id: Some("c1".into()),
                images: vec![],
            },
        ]
    }

    #[test]
    fn agent_body_chat_keeps_system_message_and_tool_calls_shape() {
        let body = agent_body("chat", "m1", &agent_turn_messages(), &atool(), false, 16384);
        assert_eq!(body["model"], "m1");
        assert_eq!(body["stream"], true); // P91 A1：Agent 单轮走流式
        assert_eq!(body["max_tokens"], 16384);
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system"); // chat 保留 system 消息原位
        assert_eq!(msgs[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["name"], "settings_apply");
        assert_eq!(msgs[2]["tool_calls"][0]["function"]["arguments"], "{\"zoom\":110}");
        assert_eq!(msgs[3]["tool_call_id"], "c1");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "settings_apply");
        assert_eq!(body["tools"][0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn agent_body_anthropic_extracts_system_and_maps_tool_blocks() {
        let body = agent_body("anthropic", "m2", &agent_turn_messages(), &atool(), false, 16384);
        assert_eq!(body["system"], "sys"); // system 抽离到顶层字段
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3); // system 不再出现在 messages 里
        // user 轮次只有 text 块；assistant 轮次只有 tool_use 块（content 空不产 text）
        let user_text = msgs.iter().find(|m| m["role"] == "user" && m["content"][0]["type"] == "text").unwrap();
        assert_eq!(user_text["content"][0]["text"], "把字号调大");
        let with_use = msgs.iter().find(|m| m["content"][0]["type"] == "tool_use").unwrap();
        assert_eq!(with_use["role"], "assistant");
        assert_eq!(with_use["content"][0]["id"], "c1");
        assert_eq!(with_use["content"][0]["name"], "settings_apply");
        assert_eq!(with_use["content"][0]["input"]["zoom"], 110);
        // tool 消息 → user 角色的 tool_result 块
        let result_block = msgs.iter().find(|m| m["content"][0]["type"] == "tool_result").unwrap();
        assert_eq!(result_block["role"], "user");
        assert_eq!(result_block["content"][0]["tool_use_id"], "c1");
        assert_eq!(result_block["content"][0]["content"], "{\"ok\":true}");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert!(body["tools"][0].get("function").is_none());
    }

    #[test]
    fn agent_body_anthropic_bad_arguments_json_degrades_to_empty_input() {
        // 出站：参数不是合法 JSON 时按 {} 上送；接收侧（agent_result）仍拒绝非法回填
        let messages = vec![AgentMessage {
            role: "assistant".into(),
            content: String::new(),
            calls: vec![acall("c1", "n", "{not json")],
            call_id: None,
            images: vec![],
        }];
        let body = agent_body("anthropic", "m", &messages, &[], false, 16384);
        assert_eq!(body["messages"][0]["content"][0]["input"], serde_json::json!({}));
    }

    #[test]
    fn agent_body_responses_maps_items_and_instructions() {
        let body = agent_body("responses", "m3", &agent_turn_messages(), &atool(), false, 16384);
        assert_eq!(body["instructions"], "sys");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert_eq!(body["max_output_tokens"], 16384);
        let items = body["input"].as_array().unwrap();
        // 空 content 的 assistant 只产生 function_call 项
        assert_eq!(items[1]["type"], "function_call");
        assert_eq!(items[1]["call_id"], "c1");
        assert_eq!(items[1]["arguments"], "{\"zoom\":110}");
        assert_eq!(items[2]["type"], "function_call_output");
        assert_eq!(items[2]["call_id"], "c1");
        assert_eq!(items[2]["output"], "{\"ok\":true}");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["name"], "settings_apply");
        assert_eq!(body["tools"][0]["strict"], false);
    }

    #[test]
    fn agent_body_context_grows_beyond_command_limit_for_oversized_payloads() {
        // ai_agent_turn 用 body.to_string().len() > 2MiB 拒绝；钉住该判定对本构造生效
        let big = "x".repeat(2 * 1024 * 1024 + 8);
        let messages = vec![amsg("user", &big)];
        let body = agent_body("chat", "m", &messages, &[], false, 16384);
        assert!(body.to_string().len() > 2 * 1024 * 1024);
    }

    #[test]
    fn agent_body_anthropic_thinking_shape_and_temperature() {
        // P90 B1：Agent 通道开思考——anthropic 约束 temperature 必须为 1（R3 红线）
        let on = agent_body("anthropic", "m", &[amsg("user", "x")], &[], true, 4096);
        assert_eq!(on["thinking"]["type"], "enabled");
        assert_eq!(on["thinking"]["budget_tokens"], 4096);
        assert_eq!(on["temperature"], 1.0);
        let off = agent_body("anthropic", "m", &[amsg("user", "x")], &[], false, 4096);
        assert!(off.get("thinking").is_none());
        assert!(off.get("temperature").is_none());
    }

    #[test]
    fn agent_result_extracts_reasoning_across_protocols() {
        // chat：deepseek-r1 系用 reasoning_content，部分网关用 reasoning
        let chat = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"答","reasoning_content":"想了一下"}}]});
        assert_eq!(agent_result("chat", &chat).unwrap()["reasoning"], "想了一下");
        let alt = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"答","reasoning":"另一种"}}]});
        assert_eq!(agent_result("chat", &alt).unwrap()["reasoning"], "另一种");
        // 模型不产思维链 → 空串且绝不报错中断任务（R3 静默降级）
        let none = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"答"}}]});
        assert_eq!(agent_result("chat", &none).unwrap()["reasoning"], "");
        // anthropic：thinking 块与 text 块分离
        let anth = serde_json::json!({"stop_reason":"end_turn","content":[
            {"type":"thinking","thinking":"先读设置"},
            {"type":"text","text":"完成"}]});
        let r = agent_result("anthropic", &anth).unwrap();
        assert_eq!(r["content"], "完成");
        assert_eq!(r["reasoning"], "先读设置");
        // responses：reasoning 项的 summary_text
        let resp = serde_json::json!({"status":"completed","output":[
            {"type":"reasoning","summary":[{"type":"summary_text","text":"逐步推理"}]},
            {"type":"message","content":[{"type":"output_text","text":"ok"}]}]});
        let r = agent_result("responses", &resp).unwrap();
        assert_eq!(r["content"], "ok");
        assert_eq!(r["reasoning"], "逐步推理");
    }

    #[test]
    fn agent_body_maps_images_per_protocol_and_drops_malformed() {
        // P90 B6：Agent 任务带图（data URL），三协议各自形状；畸形项丢弃
        let imgs = vec!["data:image/png;base64,AAAA".to_string(), "not-a-data-url".to_string()];
        let messages = vec![amsg_imgs("user", "看这张图", imgs)];
        let chat = agent_body("chat", "m", &messages, &[], false, 16384);
        let parts = chat["messages"][0]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");
        let anth = agent_body("anthropic", "m", &messages, &[], false, 16384);
        let blocks = anth["messages"][0]["content"].as_array().unwrap();
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["source"]["data"], "AAAA");
        let resp = agent_body("responses", "m", &messages, &[], false, 16384);
        let items = resp["input"].as_array().unwrap();
        assert_eq!(items[0]["content"][0]["type"], "input_text");
        assert_eq!(items[0]["content"][1]["type"], "input_image");
    }

    #[test]
    fn agent_result_chat_stop_and_tool_calls() {
        let v = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{
            "content":"执行中",
            "tool_calls":[{"id":"c1","function":{"name":"n","arguments":"{\"k\":1}"}}]
        }}]});
        let r = agent_result("chat", &v).unwrap();
        assert_eq!(r["content"], "执行中");
        assert_eq!(r["calls"][0]["callId"], "c1");
        assert_eq!(r["calls"][0]["name"], "n");
        assert_eq!(r["calls"][0]["arguments"], "{\"k\":1}");
        // 纯文本回答（无调用）合法
        let plain = serde_json::json!({"choices":[{"finish_reason":"stop","message":{"content":"好了"}}]});
        let r = agent_result("chat", &plain).unwrap();
        assert!(r["calls"].as_array().unwrap().is_empty());
    }

    #[test]
    fn agent_result_chat_rejects_truncated_and_malformed() {
        // 截断（length）→ 单独报因（P88d：区分"模型没说完"与其他未完整结束）
        let trunc = serde_json::json!({"choices":[{"finish_reason":"length","message":{"content":"半句"}}]});
        assert_eq!(agent_result("chat", &trunc).unwrap_err().msg, "模型输出达长度上限被截断（length）；未执行工具");
        assert!(agent_result("chat", &trunc).unwrap_err().shrink, "截断应触发降预算重试");
        // 内容审核：可读中文、不可重试、且绝不出现 Rust Debug 串
        let cf = serde_json::json!({"choices":[{"finish_reason":"content_filter","message":{"content":"x"}}]});
        let e = agent_result("chat", &cf).unwrap_err();
        assert_eq!(e.code, "content_filter");
        assert!(e.msg.starts_with("模型回复被内容审核中断"));
        assert!(!e.retryable);
        // 网关带内 error（P90 真机必败形态）：可重试，且文案里没有 Some("error")
        let err = serde_json::json!({"choices":[{"finish_reason":"error","message":{"content":""}}]});
        let e = agent_result("chat", &err).unwrap_err();
        assert!(e.retryable);
        assert!(!e.msg.contains("Some("), "禁止把 Rust Debug 串甩给用户");
        // 无 choices
        assert!(agent_result("chat", &serde_json::json!({})).is_err());
        // 参数 JSON 未闭合 → 拒绝（分片/半截参数不允许执行）
        let bad = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[
            {"id":"c1","function":{"name":"n","arguments":"{\"zoom\":1"}}]}}]});
        assert_eq!(agent_result("chat", &bad).unwrap_err().msg, "工具参数无效；未执行");
        let arr = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[
            {"id":"c1","function":{"name":"n","arguments":"[1,2]"}}]}}]});
        assert!(agent_result("chat", &arr).is_err());
        // 空调用名
        let anon = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[
            {"id":"c1","function":{"name":"","arguments":"{}"}}]}}]});
        assert!(agent_result("chat", &anon).is_err());
    }

    #[test]
    fn agent_result_anthropic_blocks_and_stop_reasons() {
        let v = serde_json::json!({"stop_reason":"tool_use","content":[
            {"type":"text","text":"先看"},
            {"type":"tool_use","id":"t1","name":"n","input":{"x":1}}
        ]});
        let r = agent_result("anthropic", &v).unwrap();
        assert_eq!(r["content"], "先看");
        assert_eq!(r["calls"][0]["callId"], "t1");
        assert!(serde_json::from_str::<serde_json::Value>(r["calls"][0]["arguments"].as_str().unwrap())
            .unwrap()
            .is_object());
        let done = serde_json::json!({"stop_reason":"end_turn","content":[{"type":"text","text":"完成"}]});
        let r = agent_result("anthropic", &done).unwrap();
        assert!(r["calls"].as_array().unwrap().is_empty());
        // max_tokens 截断 → 拒绝
        let trunc = serde_json::json!({"stop_reason":"max_tokens","content":[]});
        assert!(agent_result("anthropic", &trunc).is_err());
        // stop_reason 合法但无 content 数组 → 空回复（可重试，不再报"无模型输出"）
        let empty = serde_json::json!({"stop_reason":"tool_use"});
        let e = agent_result("anthropic", &empty).unwrap_err();
        assert_eq!(e.code, "empty_reply");
        assert!(e.retryable);
    }

    #[test]
    fn agent_result_responses_status_gate() {
        let v = serde_json::json!({"status":"completed","output":[
            {"type":"function_call","call_id":"c9","name":"n","arguments":"{}"},
            {"type":"message","content":[{"type":"output_text","text":"hi"}]}
        ]});
        let r = agent_result("responses", &v).unwrap();
        assert_eq!(r["content"], "hi");
        assert_eq!(r["calls"][0]["callId"], "c9");
        // incomplete → 拒绝执行工具
        let inc = serde_json::json!({"status":"incomplete","output":[]});
        assert!(agent_result("responses", &inc).is_err());
        // arguments 非字符串同样被拒
        let obj = serde_json::json!({"status":"completed","output":[
            {"type":"function_call","call_id":"c9","name":"n","arguments":{"a":1}}
        ]});
        assert!(agent_result("responses", &obj).is_err());
    }

    #[test]
    fn agent_result_bounds_call_count() {
        // 64 次上限：65 个调用 → 工具调用超限
        let calls: Vec<_> = (0..65)
            .map(|i| serde_json::json!({"id":format!("c{i}"),"function":{"name":"n","arguments":"{}"}}))
            .collect();
        let v = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":calls}}]});
        assert_eq!(agent_result("chat", &v).unwrap_err().msg, "工具调用超限");
    }

    /// 把 SSE 文本喂进与 ai_agent_turn 同一条解析路径（行切分 + 聚合器）
    fn agg_from(format: &str, sse: &str) -> Result<serde_json::Value, TurnErr> {
        let mut buf: Vec<u8> = Vec::new();
        let mut agg = AgentAgg::default();
        for line in sse.as_bytes() {
            buf.push(*line);
            drain_sse_lines(&mut buf, &mut agg, format);
        }
        if !buf.is_empty() {
            let s = String::from_utf8_lossy(&buf).trim_end().to_string();
            if let Some(rest) = s.strip_prefix("data:") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(rest.trim()) {
                    agg.feed(format, &v);
                }
            }
        }
        agg.finish(format)
    }

    #[test]
    fn agent_stream_chat_merges_deltas_and_fragmented_tool_arguments() {
        // 正文/思维链分片 + tool_calls 按 index 分片拼参数（半截参数绝不能执行，P88d 同源风险）
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"先想\",\"content\":\"好的\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"一下\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"theme_patch\",\"arguments\":\"{\\\"a\\\"\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\":1}\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: [DONE]\n",
        );
        let r = agg_from("chat", sse).unwrap();
        assert_eq!(r["content"], "好的");
        assert_eq!(r["reasoning"], "先想一下");
        assert_eq!(r["calls"][0]["callId"], "c1");
        assert_eq!(r["calls"][0]["name"], "theme_patch");
        assert_eq!(r["calls"][0]["arguments"], "{\"a\":1}");
    }

    #[test]
    fn agent_stream_chat_synthesizes_missing_call_id() {
        // 有些网关只给 index 不给 id：补合成 id 让调用可执行，而不是整轮判死
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"n\",\"arguments\":\"{}\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n",
        );
        let r = agg_from("chat", sse).unwrap();
        assert_eq!(r["calls"][0]["callId"], "agg_0");
    }

    #[test]
    fn agent_stream_anthropic_blocks_and_thinking() {
        let sse = concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"读现状\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"先看\"}}\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"n\"}}\n",
            "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"x\\\":1}\"}}\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n",
            "data: {\"type\":\"message_stop\"}\n",
        );
        let r = agg_from("anthropic", sse).unwrap();
        assert_eq!(r["content"], "先看");
        assert_eq!(r["reasoning"], "读现状");
        // 文本块占 index 0、工具块占 index 1 → 不能按 block index 开出空槽（会被参数校验误杀）
        assert_eq!(r["calls"].as_array().unwrap().len(), 1);
        assert_eq!(r["calls"][0]["callId"], "t1");
        assert_eq!(r["calls"][0]["arguments"], "{\"x\":1}");
    }

    #[test]
    fn agent_stream_responses_maps_items_and_status() {
        let sse = concat!(
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"i1\",\"call_id\":\"c9\",\"name\":\"n\"}}\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"i1\",\"delta\":\"{\\\"k\\\"\"}\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"i1\",\"delta\":\":2}\"}\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"摘要\"}\n",
            "data: {\"type\":\"response.completed\"}\n",
        );
        let r = agg_from("responses", sse).unwrap();
        assert_eq!(r["content"], "hi");
        assert_eq!(r["reasoning"], "摘要");
        assert_eq!(r["calls"][0]["callId"], "c9");
        assert_eq!(r["calls"][0]["arguments"], "{\"k\":2}");
    }

    #[test]
    fn agent_stream_in_band_error_is_retryable_and_blocks_tools() {
        // P90 真机形态：HTTP 200 的流里回 error → 整轮不可信，工具一支都不许执行
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"半句\"}}]}\n",
            "data: {\"error\":{\"message\":\"upstream timeout\",\"code\":\"timeout\"}}\n",
        );
        let e = agg_from("chat", sse).unwrap_err();
        assert!(e.retryable);
        assert!(e.msg.contains("upstream timeout"));
        assert!(e.msg.contains("timeout"));
    }

    #[test]
    fn agent_stream_truncated_and_no_stop_are_reported_per_kind() {
        let t = agg_from("chat", "data: {\"choices\":[{\"delta\":{\"content\":\"半句\"},\"finish_reason\":\"length\"}]}\n");
        let e = t.unwrap_err();
        assert_eq!(e.code, "truncated");
        assert!(e.shrink);
        // 有事件却没有结束标记 = 断流（可重试），不是"协议字段不匹配"
        let n = agg_from("chat", "data: {\"choices\":[{\"delta\":{\"content\":\"半句\"}}]}\n");
        let e = n.unwrap_err();
        assert_eq!(e.code, "no_stop");
        assert!(e.retryable);
        // 一个字都没有 = 无输出
        let z = agg_from("chat", "");
        assert_eq!(z.unwrap_err().code, "no_output");
    }

    #[test]
    fn turn_err_json_is_machine_readable_for_the_frontend() {
        let e = TurnErr { code: "provider_error", msg: "带内错误".into(), retryable: true, shrink: false };
        let v: serde_json::Value = serde_json::from_str(&e.to_json()).unwrap();
        assert_eq!(v["agentError"], 1);
        assert_eq!(v["code"], "provider_error");
        assert_eq!(v["msg"], "带内错误");
        assert_eq!(v["retryable"], true);
        assert_eq!(v["shrink"], false);
        // P95-H1：普通错误不能被前端当成"输入太大"去收缩
        assert_eq!(v["shrinkInput"], false);
    }

    #[test]
    fn request_size_guard_reports_bytes_and_is_input_side() {
        // P95-H1：超限必须给得出实测体积（旧文案只说"超限"，谁都不知道差多少）
        assert!(assert_request_size(&serde_json::json!({"m": "x".repeat(1024)})).is_ok());
        let big = serde_json::json!({"m": "x".repeat(MAX_REQUEST_BYTES + 1024)});
        let e = assert_request_size(&big).unwrap_err();
        assert_eq!(e.code, "context_overflow");
        assert!(e.msg.contains("KB"), "文案要带实测字节数：{}", e.msg);
        let v: serde_json::Value = serde_json::from_str(&e.to_json()).unwrap();
        // 输入侧标志与 shrink（降输出预算）分开：降 max_tokens 修不了包体过大
        assert_eq!(v["shrinkInput"], true);
        assert_eq!(v["shrink"], false);
    }

    #[test]
    fn http_err_reuses_classify_error_and_marks_retry_policy() {
        // P91 A2：Agent 通道不再丢响应体（旧实现只报"HTTP 400"）
        let e = http_err(400, "{\"error\":{\"message\":\"max_tokens exceeds model limit\"}}");
        assert!(e.msg.contains("max_tokens exceeds model limit"));
        assert!(e.retryable && e.shrink);
        let e = http_err(401, "");
        assert_eq!(e.code, "config");
        assert!(!e.retryable, "Key 错了重试无意义");
        let e = http_err(429, "");
        assert!(e.retryable && !e.shrink);
        let e = http_err(503, "upstream busy");
        assert!(e.retryable);
    }

    #[test]
    fn in_band_and_dropped_stream_shrink_on_retry() {
        // P96-K4：这两类以前是 shrink:false ⇒ loop 原样重发同一份巨请求，于是**再撞一次同一个上游
        // 空闲超时**（真机表现：第 3、4 轮各失败一次、白等两遍）。降输出预算 + 关思考是我们这侧
        // 唯一有效的杠杆，所以必须标 true。
        let e = stop_err(Some("error"), 3);
        assert_eq!(e.code, "provider_error");
        assert!(e.retryable && e.shrink, "带内错误必须触发降预算重试");
        assert!(e.msg.contains("深度思考"), "文案要说清重试会做什么：{}", e.msg);
        let e = stop_err(None, 5);
        assert_eq!(e.code, "no_stop");
        assert!(e.shrink, "断流同属「本轮太大/太久」这一类");
        // 反面对照：内容审核不是体积问题，重试无意义
        let e = stop_err(Some("content_filter"), 1);
        assert!(!e.retryable);
    }
}
