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
            if thinking.unwrap_or(false) {
                b["thinking"] = serde_json::json!({ "type": "enabled", "budget_tokens": 4096 });
                // anthropic 约束：thinking 开启时 temperature 必须为 1
                b["temperature"] = serde_json::Value::from(1.0);
            }
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
}
#[derive(Deserialize)]
pub struct AgentTool { name: String, description: String, parameters: serde_json::Value }

fn agent_body(format: &str, model: &str, messages: &[AgentMessage], tools: &[AgentTool]) -> serde_json::Value {
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
                    for c in &m.calls { content.push(json!({"type":"tool_use", "id":c.call_id, "name":c.name, "input":serde_json::from_str::<serde_json::Value>(&c.arguments).unwrap_or(json!({}))})); }
                }
                converted.push(json!({"role":if m.role == "tool" {"user"} else {&m.role}, "content":content}));
            }
            "responses" => {
                if m.role == "tool" { converted.push(json!({"type":"function_call_output", "call_id":m.call_id, "output":m.content})); }
                else {
                    if !m.content.is_empty() { converted.push(json!({"role":m.role, "content":m.content})); }
                    for c in &m.calls { converted.push(json!({"type":"function_call", "call_id":c.call_id, "name":c.name, "arguments":c.arguments})); }
                }
            }
            _ => {
                let mut msg = json!({"role":m.role, "content":m.content});
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
    // max_tokens 给足：推理型模型思维链占用输出预算，4096 会被吃光导致
    // finish_reason=length → 误判"回复未完整结束"→ Agent 任务必败（P88d 根因）。
    match format {
        "anthropic" => json!({"model":model,"system":system,"messages":converted,"tools":definitions,"max_tokens":16384,"stream":false}),
        "responses" => json!({"model":model,"instructions":system,"input":converted,"tools":definitions,"max_output_tokens":16384,"stream":false,"store":false}),
        _ => json!({"model":model,"messages":converted,"tools":definitions,"max_tokens":16384,"stream":false}),
    }
}

fn agent_result(format: &str, value: &serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::json;
    // 截断细分：finish_reason=length 类错误单独报因（推理模型思维链吃光输出预算），
    // 用户才能区分"模型没说完"与"网络/协议错误"（P88d 失败原因可见性）。
    let trunc = |r: &str| format!("模型输出达长度上限被截断（{r}）；未执行工具");
    let mut text = String::new();
    let mut calls = Vec::new();
    match format {
        "anthropic" => {
            match value["stop_reason"].as_str() {
                Some("end_turn") | Some("tool_use") => {}
                Some("max_tokens") => return Err(trunc("max_tokens")),
                other => return Err(format!("模型回复未完整结束（{other:?}）；未执行工具")),
            }
            for block in value["content"].as_array().ok_or("无模型输出")? {
                if block["type"] == "text" { text.push_str(block["text"].as_str().unwrap_or("")); }
                if block["type"] == "tool_use" { calls.push(json!({"callId":block["id"],"name":block["name"],"arguments":block["input"].to_string()})); }
            }
        }
        "responses" => {
            match value["status"].as_str() {
                Some("completed") => {}
                Some("incomplete") => return Err(trunc("incomplete")),
                other => return Err(format!("模型回复未完整结束（{other:?}）；未执行工具")),
            }
            for item in value["output"].as_array().ok_or("无模型输出")? {
                if item["type"] == "function_call" { calls.push(json!({"callId":item["call_id"],"name":item["name"],"arguments":item["arguments"]})); }
                if let Some(content) = item["content"].as_array() { for block in content { if block["type"] == "output_text" { text.push_str(block["text"].as_str().unwrap_or("")); } } }
            }
        }
        _ => {
            let choice = &value["choices"][0];
            match choice["finish_reason"].as_str() {
                Some("stop") | Some("tool_calls") => {}
                Some("length") => return Err(trunc("length")),
                other => return Err(format!("模型回复未完整结束（{other:?}）；未执行工具")),
            }
            let msg = &choice["message"];
            text.push_str(msg["content"].as_str().unwrap_or(""));
            if let Some(items) = msg["tool_calls"].as_array() { for c in items { calls.push(json!({"callId":c["id"],"name":c["function"]["name"],"arguments":c["function"]["arguments"]})); } }
        }
    }
    if calls.len() > 64 { return Err("工具调用超限".into()); }
    for call in &calls {
        if call["callId"].as_str().filter(|s| !s.is_empty() && s.len() <= 256).is_none()
            || call["name"].as_str().filter(|s| !s.is_empty() && s.len() <= 128).is_none()
            || call["arguments"].as_str().and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok()).filter(|v| v.is_object()).is_none() { return Err("工具参数无效；未执行".into()); }
    }
    Ok(json!({"content":text,"calls":calls}))
}

#[tauri::command]
pub async fn ai_agent_turn(
    state: State<'_, AiState>, req_id: String, base_url: String, api_key: String,
    model: String, format: String, proxy: Option<String>, no_proxy: Option<String>,
    messages: Vec<AgentMessage>, tools: Vec<AgentTool>,
) -> Result<serde_json::Value, String> {
    if !["chat", "anthropic", "responses"].contains(&format.as_str()) { return Err("不支持执行模式协议".into()); }
    let body = agent_body(&format, &model, &messages, &tools);
    if body.to_string().len() > 2 * 1024 * 1024 { return Err("任务上下文超限".into()); }
    // P88e：120s→300s——推理模型单轮生成（max_tokens 16384）常超 2 分钟，120s 必撞超时报"模型响应中断"。
    // 仅 Agent 通道放宽；ai_chat 流式有心跳不受影响。与前端 loop 总预算 10min 的关系：单轮 300s × ≥2 轮。
    let client = build_client(proxy.as_deref(), no_proxy.as_deref(), Some(Duration::from_secs(300)))?;
    let mut req = client.post(endpoint_url(&base_url, &format)).json(&body);
    if format == "anthropic" { req = req.header("x-api-key", api_key).header("anthropic-version", "2023-06-01"); }
    else if !api_key.is_empty() { req = req.bearer_auth(api_key); }
    let flag = Arc::new(AtomicBool::new(false));
    state.aborts.lock().map_err(|_| "取消服务不可用")?.insert(req_id.clone(), flag.clone());
    let operation = async {
        // P88e：超时与连接失败分类——超时给用户可行动的建议（降档位/换模型），不再笼统"中断"
        let response = req.send().await.map_err(|e| {
            if e.is_timeout() { "模型推理超时（300s）；可在设置降低思考档位或更换更快的模型后重试".to_string() }
            else { "模型连接失败；请检查本机 AI 服务设置".to_string() }
        })?;
        if !response.status().is_success() { return Err(format!("模型服务 HTTP {}；未执行工具", response.status().as_u16())); }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| if e.is_timeout() {
                "模型推理超时（300s）；可在设置降低思考档位或更换更快的模型后重试".to_string()
            } else { "模型响应中断".to_string() })?;
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err("模型响应超限".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let value = serde_json::from_slice(&bytes).map_err(|_| "模型未返回有效 JSON")?;
        agent_result(&format, &value)
    };
    let cancelled = async {
        loop { if flag.load(Ordering::Relaxed) { break; } tokio::time::sleep(Duration::from_millis(25)).await; }
        Err("已停止；未派发后续工具".to_string())
    };
    let result = match futures_util::future::select(Box::pin(operation), Box::pin(cancelled)).await {
        futures_util::future::Either::Left((r, _)) | futures_util::future::Either::Right((r, _)) => r,
    };
    if let Ok(mut map) = state.aborts.lock() { map.remove(&req_id); }
    result
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
        AgentMessage { role: role.into(), content: content.into(), calls: vec![], call_id: None }
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
            },
            AgentMessage {
                role: "tool".into(),
                content: "{\"ok\":true}".into(),
                calls: vec![],
                call_id: Some("c1".into()),
            },
        ]
    }

    #[test]
    fn agent_body_chat_keeps_system_message_and_tool_calls_shape() {
        let body = agent_body("chat", "m1", &agent_turn_messages(), &atool());
        assert_eq!(body["model"], "m1");
        assert_eq!(body["stream"], false);
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
        let body = agent_body("anthropic", "m2", &agent_turn_messages(), &atool());
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
        }];
        let body = agent_body("anthropic", "m", &messages, &[]);
        assert_eq!(body["messages"][0]["content"][0]["input"], serde_json::json!({}));
    }

    #[test]
    fn agent_body_responses_maps_items_and_instructions() {
        let body = agent_body("responses", "m3", &agent_turn_messages(), &atool());
        assert_eq!(body["instructions"], "sys");
        assert_eq!(body["stream"], false);
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
        let body = agent_body("chat", "m", &messages, &[]);
        assert!(body.to_string().len() > 2 * 1024 * 1024);
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
        assert_eq!(agent_result("chat", &trunc).unwrap_err(), "模型输出达长度上限被截断（length）；未执行工具");
        // 其他非 stop/tool_calls → 通用未完整结束
        let cf = serde_json::json!({"choices":[{"finish_reason":"content_filter","message":{"content":"x"}}]});
        assert!(agent_result("chat", &cf).unwrap_err().starts_with("模型回复未完整结束"));
        // 无 choices
        assert!(agent_result("chat", &serde_json::json!({})).is_err());
        // 参数 JSON 未闭合 → 拒绝（分片/半截参数不允许执行）
        let bad = serde_json::json!({"choices":[{"finish_reason":"tool_calls","message":{"content":"","tool_calls":[
            {"id":"c1","function":{"name":"n","arguments":"{\"zoom\":1"}}]}}]});
        assert_eq!(agent_result("chat", &bad).unwrap_err(), "工具参数无效；未执行");
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
        // stop_reason 合法但缺 content 数组 → 无模型输出
        let empty = serde_json::json!({"stop_reason":"tool_use"});
        assert_eq!(agent_result("anthropic", &empty).unwrap_err(), "无模型输出");
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
        assert_eq!(agent_result("chat", &v).unwrap_err(), "工具调用超限");
    }
}
