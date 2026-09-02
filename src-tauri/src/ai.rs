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

#[derive(serde::Serialize, Deserialize)]
pub struct AiMessage {
    pub role: String,
    pub content: String,
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

fn build_client(
    proxy: Option<&str>,
    no_proxy: Option<&str>,
    timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().connect_timeout(Duration::from_secs(15));
    b = match timeout {
        Some(t) => b.read_timeout(t).timeout(t),
        None => b.read_timeout(Duration::from_secs(60)),
    };
    if let Some(p) = proxy.map(str::trim).filter(|s| !s.is_empty()) {
        let mut px = reqwest::Proxy::all(p).map_err(|e| format!("代理地址无效：{}", e))?;
        if let Some(np) = no_proxy.map(str::trim).filter(|s| !s.is_empty()) {
            px = px.no_proxy(reqwest::NoProxy::from_string(np));
        }
        b = b.proxy(px);
    }
    b.build().map_err(|e| format!("网络客户端初始化失败：{}", e))
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
            system = Some(m.content.clone());
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
) -> Result<(), String> {
    let fmt = format.as_str();
    let url = endpoint_url(&base_url, fmt);
    let body = match fmt {
        "anthropic" => {
            let (system, rest) = split_system(&messages);
            let mut b = serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "temperature": temperature,
                "stream": true,
                "messages": rest,
            });
            if let Some(s) = system {
                b["system"] = serde_json::Value::String(s);
            }
            b
        }
        "responses" => {
            let (system, rest) = split_system(&messages);
            let mut b = serde_json::json!({
                "model": model,
                "temperature": temperature,
                "stream": true,
                "input": rest,
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
            "messages": messages,
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
                let _ = app.emit("ai:done", serde_json::json!({ "reqId": req_id, "aborted": true }));
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
                            serde_json::json!({ "reqId": req_id, "aborted": false }),
                        );
                        return Ok(());
                    }
                    let v: serde_json::Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
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
                            serde_json::json!({ "reqId": req_id, "aborted": false }),
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
        serde_json::json!({ "reqId": req_id, "aborted": flag.load(Ordering::Relaxed) }),
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
