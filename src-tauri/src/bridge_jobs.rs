//! P88a process-local, bounded task authority. No device API and no WebView waits.
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const RETAIN: u64 = 30 * 60 * 1000;
const STOP_GRACE: u64 = 2000;
const MAX_JOBS: usize = 256;
const MAX_ACTIVE: usize = 16;
const RESULT_CAP: usize = 1024 * 1024;
const TOTAL_RESULTS: usize = 16 * RESULT_CAP;

pub fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}
fn unique() -> String {
    // RandomState obtains OS-seeded randomness without adding a dependency.
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(wall_ms());
    format!("{:016x}", h.finish())
}
pub fn error(code: &str) -> Value { json!({"accepted":false,"error":{"code":code}}) }
fn terminal(s: &str) -> bool { matches!(s, "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted") }

/// Explicit adapter admission. Future task families add their own policy here, not a run_action fallback.
fn prepare(task: &str, input: &Value) -> Result<Value, &'static str> {
    if !matches!(task, "sequence.validate" | "sequence.run") { return Err("validation_error"); }
    let mut suite = if let Some(raw) = input.get("json").and_then(Value::as_str) {
        serde_json::from_str::<Value>(raw).map_err(|_| "validation_error")?
    } else { input.get("suite").cloned().ok_or("validation_error")? };
    if let Some(a) = suite.as_array() {
        if a.len() != 1 { return Err("validation_error"); }
        suite = a[0].clone();
    }
    if suite.get("name").and_then(Value::as_str).map(str::trim).unwrap_or("").is_empty() {
        return Err("validation_error");
    }
    fn walk(steps: &Value, depth: usize, count: &mut usize, run: bool) -> Result<(), &'static str> {
        let list = steps.as_array().ok_or("validation_error")?;
        for s in list {
            *count += 1;
            if *count > 1000 || depth > 5 { return Err("validation_error"); }
            match s.get("kind").and_then(Value::as_str).unwrap_or("") {
                "group" => walk(s.get("children").ok_or("validation_error")?, depth + 1, count, run)?,
                "note" | "wait" | "waitForFrame" | "assertVar" => (),
                "send" if !run => (),
                _ => return Err("needs_manual_confirmation"),
            }
        }
        Ok(())
    }
    walk(suite.get("steps").ok_or("validation_error")?, 1, &mut 0, task == "sequence.run")?;
    // serde_json's sorted object maps provide deterministic canonical equality, with no hash collisions.
    Ok(json!({"suite":suite}))
}

/// Host-assigned origin (§6): callers cannot self-report as local. MCP socket
/// create_job is always "mcp"; the Tauri command path is always "local_agent".
struct Job {
    id: String, task: String, input: Value, key: String, canonical: String, auth: u64,
    state: String, version: u64, seq: u64, created: u64, updated: u64,
    deadline: u64, deadline_wall: u64, finished: Option<u64>, started: Option<u64>,
    expires: u64, phase: String, error: Option<String>, effect: String,
    bridge: u64, executor: String, nonce: String, dispatched: bool,
    stop_at: Option<u64>, stop_reason: Option<String>,
    events: VecDeque<Value>, result: Option<String>, availability: String, last_progress: u64,
    source: &'static str,
}
impl Job {
    fn snapshot(&self) -> Value {
        json!({"jobId":self.id,"taskType":self.task,"state":self.state,"stateVersion":self.version,
            "eventSeq":self.seq,"createdAt":self.created,"updatedAt":self.updated,
            "deadlineAt":self.deadline_wall,"startedAt":self.started,"finishedAt":self.finished,
            "expiresAt":self.expires,"phase":self.phase,"source":self.source,
            "cancelCapability":"cooperative","effectStatus":self.effect,
            "error":self.error.as_ref().map(|e| json!({"code":e})),"stopReason":self.stop_reason,
            "resultAvailability":self.availability,"targetSummary":"local / no device sends",
            "permissionCheck":"side_effect_free_only"})
    }
    fn envelope(&self) -> Value {
        json!({"protocolVersion":1,"bridgeEpoch":self.bridge,"executorEpoch":self.executor,
            "jobId":self.id,"dispatchNonce":self.nonce,"stateVersion":self.version})
    }
    fn event(&mut self, kind: &str, wall: u64) {
        self.seq += 1;
        self.events.push_back(json!({"seq":self.seq,"stateVersion":self.version,"ts":wall,"kind":kind,"state":self.state,"phase":self.phase}));
        while self.events.len() > 128 { self.events.pop_front(); }
    }
    fn transition(&mut self, state: &str, code: Option<&str>, now: u64, wall: u64) {
        if terminal(&self.state) { return; }
        self.state = state.into(); self.phase = state.into(); self.version += 1; self.updated = wall;
        self.error = code.map(str::to_owned);
        if state == "running" { self.started = Some(wall); }
        if terminal(state) {
            self.finished = Some(wall); self.expires = wall + RETAIN; self.input = Value::Null;
            if state == "interrupted" { self.effect = "unknown".into(); }
        }
        if state == "cancel_requested" { self.stop_at = Some(now + STOP_GRACE); }
        self.event("state", wall);
    }
    fn cancel(&mut self, reason: &str, now: u64, wall: u64) {
        if terminal(&self.state) || self.state == "cancel_requested" { return; }
        self.stop_reason = Some(reason.chars().take(120).collect());
        if self.state == "queued" {
            self.transition(if reason == "deadline" {"timed_out"} else {"cancelled"},
                if reason == "deadline" {Some("expired_before_start")} else {None}, now, wall);
        } else { self.transition("cancel_requested", None, now, wall); }
    }
}

pub struct Registry {
    pub instance: String, pub bridge: u64, enabled: bool, executor: String,
    heartbeat: u64, clock: Instant, jobs: VecDeque<Job>,
}
impl Registry {
    pub fn new() -> Self {
        Self { instance: unique(), bridge: 0, enabled: false, executor: String::new(), heartbeat: 0,
            clock: Instant::now(), jobs: VecDeque::new() }
    }
    pub fn now(&self) -> u64 { self.clock.elapsed().as_millis() as u64 }
    pub fn capabilities(&self) -> Value {
        json!({"jobs":{"version":1,"taskTypes":["sequence.validate","sequence.run"],
            "instanceId":self.instance,"waitMaxMs":1000,"resultPageMax":16384,
            "retentionMs":RETAIN,"idempotencyScope":"instance+authenticationEpoch",
            "maxActive":MAX_ACTIVE,"maxJobs":MAX_JOBS,"executionSlots":2,
            "deviceSendSupported":false,"approvalSupported":false}})
    }
    pub fn start(&mut self) { self.bridge += 1; self.enabled = true; }
    pub fn quiesce(&mut self, reason: &str) {
        self.enabled = false;
        let now = self.now(); let wall = wall_ms();
        let all = reason == "app_exit";
        for j in &mut self.jobs {
            // §6: stopping the MCP bridge only stops external jobs, never the local agent.
            if all || j.source == "mcp" { j.cancel(reason, now, wall); }
        }
    }
    pub fn register(&mut self) -> String {
        let now = self.now(); let wall = wall_ms();
        for j in &mut self.jobs {
            if !terminal(&j.state) {
                let s = if j.state == "queued" { "cancelled" } else { "interrupted" };
                j.transition(s, Some("executor_lost"), now, wall);
            }
        }
        self.executor = unique(); self.heartbeat = now; self.executor.clone()
    }
    pub fn tick(&mut self, now: u64, wall: u64) {
        self.jobs.retain(|j| !terminal(&j.state) || j.expires > wall);
        for j in &mut self.jobs {
            if terminal(&j.state) { continue; }
            if now.saturating_sub(self.heartbeat) > 3000 && j.dispatched {
                j.transition("interrupted", Some("executor_lost"), now, wall); continue;
            }
            if now >= j.deadline || wall >= j.deadline_wall { j.cancel("deadline", now, wall); }
            if j.stop_at.is_some_and(|t| now >= t) {
                j.transition("interrupted", Some("stop_unconfirmed"), now, wall);
            }
        }
    }
    pub fn create(&mut self, source: &'static str, args: &Value, now: u64, wall: u64) -> Value {
        let task = args["taskType"].as_str().unwrap_or("");
        let key = args["idempotencyKey"].as_str().unwrap_or("");
        if key.is_empty() || key.len() > 128 || !key.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c)) { return error("validation_error"); }
        let deadline = match args.get("deadlineMs") {
            None => 120000,
            Some(v) => match v.as_u64() { Some(n @ 1000..=600000) => n, _ => return error("validation_error") },
        };
        if args["input"].to_string().len() > 64 * 1024 { return error("capacity_exceeded"); }
        let input = match prepare(task, &args["input"]) { Ok(v) => v, Err(e) => return error(e) };
        let canonical = json!([task, input, deadline]).to_string();
        if let Some(j) = self.jobs.iter().find(|j| j.key == key && j.auth == self.bridge) {
            if j.canonical != canonical { return error("idempotency_conflict"); }
            return json!({"accepted":true,"duplicate":true,"instanceId":self.instance,"jobId":j.id,
                "state":j.state,"stateVersion":j.version,"eventSeq":j.seq,"expiresAt":j.expires});
        }
        // §6: local agent tasks do not require the MCP bridge to be enabled.
        if source == "mcp" && !self.enabled { return error("permission_denied"); }
        if self.executor.is_empty() || now.saturating_sub(self.heartbeat) > 3000 { return error("executor_lost"); }
        if self.jobs.len() >= MAX_JOBS { return error("capacity_exceeded"); }
        if self.jobs.iter().filter(|j| !terminal(&j.state)).count() >= MAX_ACTIVE { return error("busy"); }
        let mut j = Job { id: format!("{}:{}", self.instance, unique()), task: task.into(), input,
            key: key.into(), canonical, auth: self.bridge, state: "queued".into(), version: 1, seq: 0,
            created: wall, updated: wall, deadline: now + deadline, deadline_wall: wall + deadline,
            finished: None, started: None, expires: wall + deadline + STOP_GRACE + RETAIN,
            phase: "queued".into(), error: None, effect: "none".into(), bridge: self.bridge,
            executor: self.executor.clone(), nonce: unique(), dispatched: false, stop_at: None,
            stop_reason: None, events: VecDeque::new(), result: None, availability: "pending".into(), last_progress: 0,
            source };
        j.event("accepted", wall);
        let receipt = json!({"accepted":true,"duplicate":false,"instanceId":self.instance,"jobId":j.id,
            "state":j.state,"stateVersion":j.version,"eventSeq":j.seq,"expiresAt":j.expires});
        self.jobs.push_back(j); receipt
    }
    pub fn query(&self, args: &Value, events: bool) -> Value {
        let id = args["jobId"].as_str().unwrap_or("");
        if !id.starts_with(&format!("{}:", self.instance)) { return error("instance_changed"); }
        let Some(j) = self.jobs.iter().find(|j| j.id == id) else { return error("not_found_or_expired"); };
        let mut out = j.snapshot();
        if events {
            let after = args["afterSeq"].as_u64().unwrap_or(0);
            let oldest = j.events.front().and_then(|e| e["seq"].as_u64()).unwrap_or(j.seq);
            out["gap"] = json!(after.saturating_add(1) < oldest);
            out["oldestSeq"] = json!(oldest);
            out["events"] = json!(j.events.iter().filter(|e| e["seq"].as_u64().unwrap_or(0) > after).collect::<Vec<_>>());
        }
        if args["includeResult"].as_bool() == Some(true) {
            if let Some(text) = &j.result {
                // UTF-8 byte offsets with boundary-safe pages. Decode JSON only after concatenating all pages.
                let mut offset = (args["offset"].as_u64().unwrap_or(0) as usize).min(text.len());
                while !text.is_char_boundary(offset) { offset -= 1; }
                let limit = args["limit"].as_u64().unwrap_or(16384).clamp(4, 16384) as usize;
                let mut end = (offset + limit).min(text.len());
                while !text.is_char_boundary(end) { end -= 1; }
                out["result"] = json!({"encoding":"json-utf8","offset":offset,"text":&text[offset..end],
                    "nextOffset": if end < text.len() {Some(end)} else {None},"totalBytes":text.len()});
            }
        }
        out
    }
    pub fn cancel(&mut self, args: &Value) -> Value {
        let now = self.now(); let wall = wall_ms();
        if let Some(j) = self.jobs.iter_mut().find(|j| Some(j.id.as_str()) == args["jobId"].as_str()) {
            let was = terminal(&j.state);
            j.cancel(args["reason"].as_str().unwrap_or("user"), now, wall);
            let mut out = j.snapshot(); out["alreadyTerminal"] = json!(was); return out;
        }
        self.query(args, false)
    }
    pub fn list(&self) -> Value { json!(self.jobs.iter().rev().map(Job::snapshot).collect::<Vec<_>>()) }
    pub fn poll(&mut self, epoch: &str) -> Value {
        if epoch != self.executor { return error("executor_lost"); }
        let now = self.now(); self.heartbeat = now; self.tick(now, wall_ms());
        let mut used = self.jobs.iter().filter(|j| j.dispatched && !terminal(&j.state)).count();
        let mut sequence_busy = self.jobs.iter().any(|j| j.dispatched && !terminal(&j.state) && j.task == "sequence.run");
        let mut dispatches = vec![]; let mut cancels = vec![];
        for j in &mut self.jobs {
            if j.state == "cancel_requested" { cancels.push(j.envelope()); }
            // Local jobs bypass the MCP bridge epoch/switch coupling (§6); receipts stay fenced by executor+nonce+version.
            if (j.source == "local_agent" || (self.enabled && j.bridge == self.bridge)) && used < 2 && j.state == "queued" && !j.dispatched && !(j.task == "sequence.run" && sequence_busy) {
                j.dispatched = true; used += 1;
                if j.task == "sequence.run" { sequence_busy = true; }
                dispatches.push(json!({"envelope":j.envelope(),"taskType":j.task,"input":j.input,"deadlineAt":j.deadline_wall,"source":j.source}));
            }
        }
        json!({"dispatches":dispatches,"cancels":cancels})
    }
    pub fn report(&mut self, report: &Value) -> Value {
        let now = self.now(); let wall = wall_ms(); self.tick(now, wall);
        let e = &report["envelope"];
        let Some(j) = self.jobs.iter_mut().find(|j| Some(j.id.as_str()) == e["jobId"].as_str()) else { return json!({"applied":false}); };
        if e["protocolVersion"] != 1 || e["bridgeEpoch"] != j.bridge || e["executorEpoch"] != j.executor || e["dispatchNonce"] != j.nonce || j.executor != self.executor {
            return json!({"applied":false});
        }
        if terminal(&j.state) { j.event("late_receipt_ignored", wall); return json!({"applied":false,"terminal":true}); }
        if e["stateVersion"] != j.version { return json!({"applied":false,"envelope":j.envelope()}); }
        let kind = report["kind"].as_str().unwrap_or("");
        match kind {
            "started" if j.state == "queued" && j.dispatched && (j.source == "local_agent" || (self.enabled && j.bridge == self.bridge)) => j.transition("running", None, now, wall),
            "progress" if j.state == "running" => {
                if now.saturating_sub(j.last_progress) >= 200 {
                    j.last_progress = now; j.phase = report["phase"].as_str().unwrap_or("running").chars().take(120).collect();
                    j.updated = wall; j.event("progress", wall);
                }
            }
            "succeeded" | "failed" | "cancelled" if matches!(j.state.as_str(), "running" | "cancel_requested") => {
                let state = if kind == "cancelled" && j.stop_reason.as_deref() == Some("deadline") { "timed_out" } else { kind };
                let code = if kind == "failed" {Some("execution_failed")} else {None};
                j.transition(state, code, now, wall);
                let text = report["result"].to_string();
                if text.len() <= RESULT_CAP { j.result = Some(text); j.availability = "available".into(); }
                else { j.availability = "result_evicted".into(); }
            }
            "rejected" if j.state == "queued" => j.transition("failed", Some("validation_error"), now, wall),
            _ => return json!({"applied":false,"terminal":terminal(&j.state)}),
        }
        let out = json!({"applied":true,"envelope":j.envelope()});
        let mut bytes: usize = self.jobs.iter().filter_map(|j| j.result.as_ref().map(String::len)).sum();
        for j in &mut self.jobs {
            if bytes <= TOTAL_RESULTS { break; }
            if let Some(s) = j.result.take() { bytes -= s.len(); j.availability = "result_evicted".into(); }
        }
        out
    }
}

pub struct JobsState {
    pub registry: std::sync::Mutex<Registry>,
    monitor_started: std::sync::atomic::AtomicBool,
}
impl JobsState {
    pub fn new() -> Self { Self { registry: std::sync::Mutex::new(Registry::new()), monitor_started: std::sync::atomic::AtomicBool::new(false) } }
}

#[tauri::command]
pub fn bridge_jobs_register(app: tauri::AppHandle, state: tauri::State<'_, JobsState>) -> Result<String, String> {
    use tauri::Manager;
    use std::sync::atomic::Ordering;
    let epoch = state.registry.lock().map_err(|_| "registry unavailable")?.register();
    if !state.monitor_started.swap(true, Ordering::SeqCst) {
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let state = app.state::<JobsState>();
            if let Ok(mut r) = state.registry.lock() { let now = r.now(); r.tick(now, wall_ms()); };
        });
    }
    Ok(epoch)
}
#[tauri::command]
pub fn bridge_jobs_poll(executor_epoch: String, state: tauri::State<'_, JobsState>) -> Result<Value, String> {
    Ok(state.registry.lock().map_err(|_| "registry unavailable")?.poll(&executor_epoch))
}
#[tauri::command]
pub fn bridge_jobs_report(report: Value, state: tauri::State<'_, JobsState>) -> Result<Value, String> {
    if report.to_string().len() > RESULT_CAP + 4096 { return Ok(json!({"applied":false,"error":{"code":"capacity_exceeded"}})); }
    Ok(state.registry.lock().map_err(|_| "registry unavailable")?.report(&report))
}
#[tauri::command]
pub fn bridge_jobs_control(kind: String, args: Value, state: tauri::State<'_, JobsState>) -> Result<Value, String> {
    let mut r = state.registry.lock().map_err(|_| "registry unavailable")?;
    let now = r.now(); r.tick(now, wall_ms());
    Ok(match kind.as_str() {
        "list" => r.list(), "get_job" => r.query(&args, false), "wait_event" => r.query(&args, true),
        "cancel_job" => r.cancel(&args),
        // §6: Tauri command path is host-forced to local_agent; MCP socket create_job stays "mcp".
        "create" => r.create("local_agent", &args, now, wall_ms()),
        "quiesce" => { r.quiesce(args["reason"].as_str().unwrap_or("bridge_stopped")); json!({"ok":true}) },
        _ => error("validation_error"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registry() -> Registry { let mut r = Registry::new(); r.register(); r.start(); r }
    fn args(key: &str) -> Value { json!({"taskType":"sequence.run","input":{"suite":{"name":"test","steps":[{"kind":"wait","ms":5000}]}},"idempotencyKey":key}) }
    fn started(r: &mut Registry, key: &str) -> (Value, Value) {
        let a = r.create("mcp", &args(key), 0, wall_ms());
        let p = r.poll(&r.executor.clone()); let e = p["dispatches"][0]["envelope"].clone();
        let out = r.report(&json!({"envelope":e,"kind":"started"}));
        assert_eq!(out["applied"], true); (a, out["envelope"].clone())
    }
    #[test] fn job_plane_never_admits_plugin_installs() {
        // P99c-C1c / Q7：`create_job` 是 MCP 工具清单里的名字（模型直接够得到），所以这个
        // 任务面**永远不许**出现"取回外部代码"的类型。装包走 `cli.` 那条模型进不来的路。
        // 谁要把 plugin.* 加进 prepare()，这条先红，然后去重读一遍 Q7。
        // 注意 input 故意用**序列那副形状**：换成 `{entryId}` 的话，光是"suite 缺失"就会
        // 回 validation_error，探针看着红不了——那等于没测（同 §8-39② 那条"正则也是探针"）。
        let mut r = registry();
        for task in ["plugin.stage", "plugin.install", "plugin.update", "market.fetch"] {
            let mut a = args("no-plugin-tasks");
            a["taskType"] = json!(task);
            assert_eq!(r.create("mcp", &a, 0, wall_ms())["error"]["code"], "validation_error", "{task} 不该被准入");
        }
        assert_eq!(r.jobs.len(), 0, "有一条被收下了");
        // 对照：同一副 input 换个合法类型就该被收下（证明上面那条不是因为夹具坏了才全红）
        assert_eq!(r.create("mcp", &args("baseline-ok"), 0, wall_ms())["accepted"], true);
        let types = r.capabilities()["jobs"]["taskTypes"].as_array().unwrap().clone();
        for t in types {
            let s = t.as_str().unwrap_or("");
            assert!(!s.starts_with("plugin.") && !s.starts_with("market."), "能力清单里漏出了 {s}");
        }
    }
    #[test] fn admission_idempotency_and_policy() {
        let mut r = registry(); let a = r.create("mcp", &args("one"), 0, wall_ms());
        assert_eq!(a["accepted"], true);
        assert_eq!(r.create("mcp", &args("one"), 0, wall_ms())["jobId"], a["jobId"]);
        let mut b = args("one"); b["deadlineMs"] = json!(2000);
        assert_eq!(r.create("mcp", &b, 0, wall_ms())["error"]["code"], "idempotency_conflict");
        b = args("unsafe"); b["input"]["suite"]["steps"] = json!([{"kind":"group","children":[{"kind":"send","enabled":false}]}]);
        b["confirmed"] = json!(true); b["highPriv"] = json!(true);
        assert_eq!(r.create("mcp", &b, 0, wall_ms())["error"]["code"], "needs_manual_confirmation");
        assert_eq!(r.jobs.len(), 1);
    }
    #[test] fn local_source_works_without_bridge_and_mcp_does_not() {
        // §6：本地 Agent 任务不依赖 MCP 桥开关；调用者不能自报来源。
        let mut r = Registry::new(); r.register(); // 未 start()：MCP 未启用
        assert_eq!(r.create("mcp", &args("ext"), 0, wall_ms())["error"]["code"], "permission_denied");
        let a = r.create("local_agent", &args("loc"), 0, wall_ms());
        assert_eq!(a["accepted"], true);
        let p = r.poll(&r.executor.clone());
        assert_eq!(p["dispatches"].as_array().unwrap().len(), 1);
        assert_eq!(p["dispatches"][0]["source"], "local_agent");
        assert_eq!(r.query(&a, false)["source"], "local_agent");
    }
    #[test] fn bridge_quiesce_keeps_local_jobs() {
        // §6：关闭 MCP 仅停止外部来源任务，不关闭本地 Agent；app_exit 才全部终止。
        let mut r = registry();
        let m = r.create("mcp", &args("m1"), 0, wall_ms());
        let l = r.create("local_agent", &args("l1"), 0, wall_ms());
        r.quiesce("bridge_stopped");
        assert_eq!(r.query(&m, false)["state"], "cancelled");
        assert_eq!(r.query(&l, false)["state"], "queued");
        r.start();
        let p = r.poll(&r.executor.clone());
        assert_eq!(p["dispatches"].as_array().unwrap().len(), 1); // 本地任务仍可派发
        r.quiesce("app_exit");
        assert_eq!(r.query(&l, false)["state"], "cancelled");
    }
    #[test] fn queued_cancel_never_dispatches() {
        let mut r = registry(); let a = r.create("mcp", &args("q"), 0, wall_ms()); r.cancel(&a);
        assert_eq!(r.poll(&r.executor.clone())["dispatches"].as_array().unwrap().len(), 0);
        assert_eq!(r.query(&a, false)["state"], "cancelled");
    }
    #[test] fn cancellation_confirmed_and_late_success_fenced() {
        let mut r = registry(); let (a, e) = started(&mut r, "run");
        assert_eq!(r.cancel(&a)["state"], "cancel_requested");
        let stale = r.report(&json!({"envelope":e,"kind":"cancelled"}));
        assert_eq!(stale["applied"], false);
        let e = stale["envelope"].clone();
        assert_eq!(r.report(&json!({"envelope":e,"kind":"cancelled"}))["applied"], true);
        r.report(&json!({"envelope":e,"kind":"succeeded"}));
        assert_eq!(r.query(&a, false)["state"], "cancelled");
    }
    #[test] fn deadline_is_not_stop_proof() {
        let mut r = registry(); let (a, _) = started(&mut r, "deadline");
        r.heartbeat = 120000; r.tick(120000, wall_ms());
        assert_eq!(r.query(&a, false)["state"], "cancel_requested");
        r.tick(122000, wall_ms());
        let q = r.query(&a, false); assert_eq!(q["state"], "interrupted"); assert_eq!(q["error"]["code"], "stop_unconfirmed"); assert_eq!(q["effectStatus"], "unknown");
    }
    #[test] fn executor_reload_and_nonce() {
        let mut r = registry(); let (a, mut e) = started(&mut r, "reload");
        e["dispatchNonce"] = json!("forged");
        assert_eq!(r.report(&json!({"envelope":e,"kind":"succeeded"}))["applied"], false);
        r.register(); assert_eq!(r.query(&a, false)["state"], "interrupted");
        assert_eq!(r.query(&json!({"jobId":"old:job"}), false)["error"]["code"], "instance_changed");
    }
    #[test] fn results_and_event_gap_bounded() {
        let mut r = registry(); let (a, e) = started(&mut r, "result");
        r.report(&json!({"envelope":e,"kind":"succeeded","result":{"status":"done"}}));
        for _ in 0..150 { r.report(&json!({"envelope":e,"kind":"succeeded"})); }
        let mut a = a; a["includeResult"] = json!(true);
        let q = r.query(&a, true); assert_eq!(q["gap"], true); assert_eq!(q["events"].as_array().unwrap().len(), 128);
        assert!(q["result"]["text"].as_str().unwrap().contains("done"));
    }
    #[test] fn queued_expiry_success_race_and_auth_rotation() {
        let mut r = registry(); let mut b = args("expired"); b["deadlineMs"] = json!(1000);
        let a = r.create("mcp", &b, 0, wall_ms()); r.tick(1001, wall_ms());
        assert_eq!(r.query(&a, false)["state"], "timed_out");
        assert!(r.poll(&r.executor.clone())["dispatches"].as_array().unwrap().is_empty());
        let (a, e) = started(&mut r, "success-first");
        r.report(&json!({"envelope":e,"kind":"succeeded","result":{"status":"done"}}));
        assert_eq!(r.cancel(&a)["alreadyTerminal"], true);
        assert_eq!(r.query(&a, false)["state"], "succeeded");
        let (a, e) = started(&mut r, "rotation");
        r.quiesce("token_rotated"); r.start();
        let reply = r.report(&json!({"envelope":e,"kind":"cancelled"}));
        assert_eq!(reply["applied"], false);
        r.report(&json!({"envelope":reply["envelope"],"kind":"cancelled"}));
        assert_eq!(r.query(&a, false)["state"], "cancelled");
    }
    #[test] fn concurrent_duplicates_register_exactly_once() {
        let r = std::sync::Arc::new(std::sync::Mutex::new(registry()));
        let threads: Vec<_> = (0..12).map(|_| {
            let r = r.clone(); std::thread::spawn(move || r.lock().unwrap().create("mcp", &args("concurrent"), 0, wall_ms())["jobId"].clone())
        }).collect();
        let ids: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert!(ids.iter().all(|id| id == &ids[0])); assert_eq!(r.lock().unwrap().jobs.len(), 1);
    }
    #[test] fn active_capacity_preserves_queries() {
        let mut r = registry(); for n in 0..16 { assert_eq!(r.create("mcp", &args(&n.to_string()), 0, wall_ms())["accepted"], true); }
        assert_eq!(r.create("mcp", &args("full"), 0, wall_ms())["error"]["code"], "busy");
        assert_eq!(r.list().as_array().unwrap().len(), 16);
    }
}
