//! P174-A4：扩展仓库的文件与存储命令（写 / 读 / 列 / 索引与信任账）。
//!
//! **这一层只服务宿主前端**，不直接暴露给插件——插件自己用 Node 的 fs（权限由
//! `--allow-fs-write` 内核拦）。所以这里的安全判据是"防前端被 XSS 后乱写"，
//! 而不是"防插件"：路径必须落在调用方给的 roots（=`<appDir>/extensions`）之内。
//!
//! 复用 `agent_tools::path_in_roots` 而不是另写一份：那份是逐条测过的（含 `..`、
//! 大小写、分隔符归一），抄一份就会漂——本仓 §8-36① 记过太多次这种账。
//!
//! 两条刻意的"不宽松"：
//! 1. **账本走原子写**（临时文件 + rename）。索引写一半断电，下次启动就是"所有插件都消失"，
//!    而用户看到的现象是"我的插件没了"，没人会想到是 JSON 截断。
//! 2. **store 名字是白名单**（`index` / `trust`），不是"相对路径"。
//!    给相对路径就等于给了"往 plugins 下任意位置写"的口子。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::agent_tools::path_in_roots;
use std::process::Command;
use tauri::Manager;

/// 单次写入上限。清单/账本/引导脚本都远小于这个数；真传大文件请走未来的 zip 通道。
const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;
/// 读文本的上限：超过就截断并标 `truncated`，不静默裁（与 shell 的 64KB 头尾预算同一条规矩）。
const MAX_READ_BYTES: u64 = 256 * 1024;
/// 追加型文件（目前只有插件宿主日志）的默认上限。为什么不是"无限追加"也不是 8 MB：
/// 一台机器上装了十几个插件、每个都跑长任务时，"日志不该把应用数据目录吃掉"是硬约束；
/// 而 2 MiB 足够把一次崩前的几百行留在盘上——这是这份文件存在的唯一理由。
const DEFAULT_APPEND_CAP: u64 = 2 * 1024 * 1024;
/// 前端可以把上限要小，不能要大（与 `market_fetch::clamp_max` 同一条形状）。
const MAX_APPEND_CAP: u64 = 4 * 1024 * 1024;
/// 允许的账本名。加一个就要同时想清楚"它的写入是不是也该原子"。
///
/// A8 加了 `settings`：扩展子系统自己的偏好（目前只有"工作区根"）。
/// **刻意不放进全局设置**：那里面已经有一个叫 `workspace` 的键（预设布局），
/// 再放一个"工作区根"进同一张表，两个 `workspace` 迟早有人看错。
///
/// B4 加了 `journal`：插件变更日志（只追加，用于"可从日志重建"的核对）。
/// B2 加了 `profiles`：工作场景（有序启用集 + 键级 patch）。
const STORE_NAMES: [&str; 5] = ["index", "trust", "settings", "journal", "profiles"];

/// 扩展仓库的根路径。前端要在启动宿主前把它们传给各条命令，
/// 而"应用数据目录在哪"只有 Rust 知道（Tauri 的 path resolver）。
#[tauri::command]
pub fn plugin_paths(app: tauri::AppHandle) -> Result<Value, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))?;
    let root = dir.join("plugins");
    let host = dir.join("plugin-host");
    Ok(json!({
        "appDir": dir.to_string_lossy(),
        "pluginsRoot": root.to_string_lossy(),
        "hostDir": host.to_string_lossy(),
        "bootstrapPath": host.join("bootstrap.mjs").to_string_lossy(),
    }))
}

/// 找 Node 运行时：**探测但不静默**。
///
/// 返回的是"我试了这些地方、这个能跑、版本是多少"，不是"我猜它在 PATH 里"。
/// 前端把路径与版本显示出来，用户能改——这比一个隐藏的自动探测诚实得多，
/// 也比"要求用户先自己装 node 再来"少一步。
#[tauri::command]
pub fn plugin_probe_node() -> Result<Value, String> {
    let mut tried: Vec<String> = Vec::new();
    let mut cands: Vec<String> = Vec::new();
    // 1) PATH 里的 node（最常见）
    cands.push("node".to_string());
    // 2) Windows 官方安装器的默认落点（PATH 没配好时也能找到）
    if let Ok(pf) = std::env::var("ProgramFiles") {
        cands.push(format!("{pf}\\nodejs\\node.exe"));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        cands.push(format!("{la}\\Programs\\nodejs\\node.exe"));
    }
    for c in cands {
        match Command::new(&c).arg("--version").output() {
            Ok(o) if o.status.success() => {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                return Ok(json!({
                    "found": true,
                    "path": c,
                    "version": v,
                    "tried": tried,
                }));
            }
            _ => tried.push(c),
        }
    }
    Ok(json!({ "found": false, "path": "", "version": "", "tried": tried }))
}

fn guard(path: &str, roots: &[String]) -> Result<(), String> {
    if !path_in_roots(path, roots) {
        return Err(format!("path_outside_roots: {path}"));
    }
    Ok(())
}

fn io_err(action: &str, e: std::io::Error) -> String {
    format!("{action}失败：{e}")
}

/// 写文本（自动建父目录）。**覆盖已有文件**——调用方负责先读旧值/做快照。
#[tauri::command]
pub fn plugin_fs_write(path: String, content: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&path, &roots)?;
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("content_too_large: {} > {MAX_WRITE_BYTES}", content.len()));
    }
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("建目录", e))?;
    }
    fs::write(&path, content.as_bytes()).map_err(|e| io_err("写文件", e))?;
    Ok(json!({ "ok": true, "bytes": content.len(), "path": path }))
}

/// 写**二进制**（base64 传入，自动建父目录）。
///
/// 为什么单独一条而不是把 `plugin_fs_write` 放宽：那条收的是 `String`，二进制经 JSON 走一趟
/// 会被 `from_utf8_lossy` 换掉字节——**安装时少几个字节的 png，运行时才发现图是黑的**。
/// 文本与字节各有各的入口，谁都不去猜对方。
#[tauri::command]
pub fn plugin_fs_write_b64(path: String, b64: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&path, &roots)?;
    // base64 比原文大 4/3：按解码后的上限折算，别让一个 8MB 的文件被 10.7MB 的串挡在门外
    let cap_b64 = MAX_WRITE_BYTES / 3 * 4 + 8;
    if b64.len() > cap_b64 {
        return Err(format!("content_too_large: {} > {cap_b64}", b64.len()));
    }
    let bytes = STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("base64 解不开：{e}"))?;
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("建目录", e))?;
    }
    fs::write(&path, &bytes).map_err(|e| io_err("写文件", e))?;
    Ok(json!({ "ok": true, "bytes": bytes.len(), "path": path }))
}

/// 追加文本，并把整体大小轮转在 `max_bytes` 之内（**从头部截，保尾巴**）。
///
/// 为什么不能拿 `plugin_fs_read` + `plugin_fs_write` 拼出来：读那一层有 256 KiB 的**头部**上限，
/// 超线那份被截掉的是**最新的几行**。于是"追加"的实现一旦走读-改-写，日志文件会在长到
/// 某个尺寸那天**永远丢掉最近发生的事**——而日志唯一值钱的就是最近那一段。
/// 追加与轮转放在这里，读的时候不需要知道自己在读日志。
///
/// 截断点落在**换行之后**：正好切在半个 UTF-8 序列或半行 JSON 上，这份文件就自带上一个
/// "日志坏了"，而那才是让人怀疑整个系统的症状。
#[tauri::command]
pub fn plugin_fs_append(
    path: String,
    content: String,
    roots: Vec<String>,
    max_bytes: u64,
) -> Result<Value, String> {
    guard(&path, &roots)?;
    if content.is_empty() {
        return Err("empty_content".to_string());
    }
    if content.len() > MAX_WRITE_BYTES {
        return Err(format!("content_too_large: {} > {MAX_WRITE_BYTES}", content.len()));
    }
    // 0 不是"不限"：让调用方漏传参数时得到一个默认上限，比让一个文件无限长大好。
    let cap = if max_bytes == 0 {
        DEFAULT_APPEND_CAP
    } else {
        max_bytes.min(MAX_APPEND_CAP)
    };
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("建目录", e))?;
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(p)
        .map_err(|e| io_err("打开追加", e))?;
    f.write_all(content.as_bytes())
        .map_err(|e| io_err("追加", e))?;
    drop(f);

    let bytes = fs::read(p).map_err(|e| io_err("读回", e))?;
    let mut trimmed = 0usize;
    if bytes.len() as u64 > cap {
        let skip = bytes.len() - cap as usize;
        // 找不到换行（一整行比上限还长）就照 cut 切：宁可丢一点，也不让文件无限长
        let cut = bytes[skip..]
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| skip + i + 1)
            .unwrap_or(skip);
        fs::write(p, &bytes[cut..]).map_err(|e| io_err("轮转写入", e))?;
        trimmed = cut;
    }
    Ok(json!({
        "ok": true,
        "bytes": bytes.len() - trimmed,
        "appended": content.len(),
        "trimmed": trimmed,
        "cap": cap,
        "path": path,
    }))
}

/// 读文本。不存在返回 `{exists:false}`（不是错误——"还没装过"是正常状态）。
#[tauri::command]
pub fn plugin_fs_read(path: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&path, &roots)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(json!({ "exists": false, "text": "", "truncated": false }));
    }
    let meta = fs::metadata(p).map_err(|e| io_err("读元信息", e))?;
    let size = meta.len();
    let mut f = fs::File::open(p).map_err(|e| io_err("打开文件", e))?;
    let mut buf = Vec::new();
    let truncated = size > MAX_READ_BYTES;
    // 显式走 Read 的形状：这一层现在同时带着 `Write`（`plugin_fs_append` 要用），
    // `f.by_ref()` 在两个 trait 都存在时是歧义调用（E0034），写全了才不会哪天改一行就编不过。
    std::io::Read::by_ref(&mut f)
        .take(MAX_READ_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| io_err("读文件", e))?;
    let text = String::from_utf8_lossy(&buf).to_string();
    Ok(json!({
        "exists": true,
        "text": text,
        "truncated": truncated,
        "bytes": size,
    }))
}

/// 列一层。不递归——递归交给调用方按需展开，避免一次拉一个 `node_modules` 十万条。
#[tauri::command]
pub fn plugin_fs_list(dir: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&dir, &roots)?;
    let p = Path::new(&dir);
    if !p.exists() {
        return Ok(json!({ "exists": false, "items": [] }));
    }
    let mut items: Vec<Value> = Vec::new();
    for ent in fs::read_dir(p).map_err(|e| io_err("列目录", e))? {
        let ent = match ent {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = ent.file_name().to_string_lossy().to_string();
        let md = ent.metadata().ok();
        let is_dir = md.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        items.push(json!({
            "name": name,
            "dir": is_dir,
            "size": md.as_ref().map(|m| m.len()).unwrap_or(0),
        }));
        if items.len() >= 5000 {
            break; // 硬上限：一个目录五万条时，UI 也渲染不动
        }
    }
    items.sort_by(|a, b| {
        let ad = a["dir"].as_bool().unwrap_or(false);
        let bd = b["dir"].as_bool().unwrap_or(false);
        // 目录在前，然后按名字
        bd.cmp(&ad).then_with(|| {
            a["name"]
                .as_str()
                .unwrap_or("")
                .cmp(b["name"].as_str().unwrap_or(""))
        })
    });
    Ok(json!({ "exists": true, "items": items }))
}

/// 删一个文件或空目录。**不递归删目录**——递归删是"删错一次全没了"的形状，
/// 要删整包请走卸载流程（它会先跑 disposer 再删，且有日志留痕）。
#[tauri::command]
pub fn plugin_fs_remove(path: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&path, &roots)?;
    let p = Path::new(&path);
    if !p.exists() {
        return Ok(json!({ "ok": true, "existed": false }));
    }
    let md = fs::metadata(p).map_err(|e| io_err("读元信息", e))?;
    if md.is_dir() {
        fs::remove_dir(p).map_err(|e| io_err("删空目录", e))?;
    } else {
        fs::remove_file(p).map_err(|e| io_err("删文件", e))?;
    }
    Ok(json!({ "ok": true, "existed": true }))
}

fn store_path(name: &str, roots: &[String]) -> Result<PathBuf, String> {
    if !STORE_NAMES.contains(&name) {
        return Err(format!("unknown_store: {name}（只认白名单里的账本名）"));
    }
    let root = roots
        .first()
        .ok_or_else(|| "roots 为空".to_string())?;
    // 用 `Path::join` 而不是字符串拼：拼出来的 `C://a//extensions/index.json` 在 Windows 上能用，
    // 但它会让日志和断言里出现两种分隔符，读的人第一反应是"路径搞错了吧"。
    // （这条是单测 `store_path_lands_inside_root` 抓出来的——第一版正是字符串拼接。）
    let p = Path::new(root).join(format!("{name}.json"));
    guard(p.to_string_lossy().as_ref(), roots)?;
    Ok(p)
}

/// 读账本。不存在返回 `{exists:false, data:null}`。
#[tauri::command]
pub fn plugin_store_read(name: String, roots: Vec<String>) -> Result<Value, String> {
    let p = store_path(&name, &roots)?;
    if !p.exists() {
        return Ok(json!({ "exists": false, "data": Value::Null }));
    }
    let text = fs::read_to_string(&p).map_err(|e| io_err("读账本", e))?;
    let data: Value = serde_json::from_str(&text).map_err(|e| format!("账本不是合法 JSON：{e}"))?;
    Ok(json!({ "exists": true, "data": data }))
}

/// 写账本：**原子写**。临时文件与目标同目录（同盘才保证 rename 是原子的）。
#[tauri::command]
pub fn plugin_store_write(name: String, data: Value, roots: Vec<String>) -> Result<Value, String> {
    let p = store_path(&name, &roots)?;
    let text = serde_json::to_string_pretty(&data).map_err(|e| format!("账本序列化失败：{e}"))?;
    if text.len() > MAX_WRITE_BYTES {
        return Err(format!("账本过大：{} 字节", text.len()));
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| io_err("建目录", e))?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, text.as_bytes()).map_err(|e| io_err("写临时账本", e))?;
    fs::rename(&tmp, &p).map_err(|e| io_err("替换账本", e))?;
    Ok(json!({ "ok": true, "bytes": text.len() }))
}

/* ============================ 安装：复制 / 提升 / 卸载 ============================ */

/// 一次安装最多搬多少个文件。扩展是"几百 KB 的脚本"，不是数据包；
/// 真需要搬大东西应该由插件自己去读工作区，而不是塞进 AppData。
const MAX_COPY_FILES: usize = 2000;
/// 单次安装的总字节上限。与 `MAX_COPY_FILES` 一起挡的是"选错目录"这种手滑：
/// 选到 `C:\` 时会先在文件数上撞墙，而不是先把几十 GB 复制进去再失败。
const MAX_COPY_BYTES: u64 = 32 * 1024 * 1024;
/// 目录层级上限。源包里放一条 `a/a/a/...` 的深链，靠这个止损。
const MAX_COPY_DEPTH: usize = 20;

#[derive(Default)]
struct CopyBudget {
    files: usize,
    bytes: u64,
    skipped_links: usize,
}

/// 归一成"小写 + 正斜杠"的可比字符串。只用于**同一台机器上的自己和自己比**
/// （`roots` 与目标都来自同一处调用），不用于展示，所以不做盘符规范化的完整处理。
fn norm_path(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

/// `child` 是否就是 `parent` 或在其之下。
fn path_within(child: &Path, parent: &Path) -> bool {
    let c = norm_path(child);
    let p = norm_path(parent);
    c == p || c.starts_with(&format!("{p}/"))
}

/// 这个路径是否**正好是**某个根。`path_in_roots` 对"根自己"也算在内，
/// 而复制/删除这两种动作对"根自己"必须是拒绝的：往 plugins 根上复制一次、
/// 或者在根上按一次删除，整个仓库就没了。
fn is_root_itself(p: &Path, roots: &[String]) -> bool {
    let n = norm_path(p);
    roots.iter().any(|r| norm_path(Path::new(r)) == n)
}

fn copy_tree(src: &Path, dst: &Path, budget: &mut CopyBudget, depth: usize) -> Result<(), String> {    if depth > MAX_COPY_DEPTH {
        return Err(format!("目录层级过深（> {MAX_COPY_DEPTH}）：{}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| io_err("建目录", e))?;
    for ent in fs::read_dir(src).map_err(|e| io_err("列目录", e))? {
        let ent = ent.map_err(|e| io_err("列目录", e))?;
        // `file_type()` 不跟随链接，所以这里能看出"它是个链接"。
        // 源包里放一条指向 `C:\` 的 junction，递归复制就会把整块盘搬进 AppData——
        // 跳过它不算失败，但要计数并报给用户（静默跳过会让人以为"文件都在"）。
        let ft = ent.file_type().map_err(|e| io_err("读文件类型", e))?;
        if ft.is_symlink() {
            budget.skipped_links += 1;
            continue;
        }
        let s = ent.path();
        let d = dst.join(ent.file_name());
        if ft.is_dir() {
            copy_tree(&s, &d, budget, depth + 1)?;
        } else if ft.is_file() {
            let len = ent.metadata().map(|m| m.len()).unwrap_or(0);
            budget.files += 1;
            budget.bytes = budget.bytes.saturating_add(len);
            if budget.files > MAX_COPY_FILES {
                return Err(format!("包内文件过多（> {MAX_COPY_FILES} 个）：{src:?}"));
            }
            if budget.bytes > MAX_COPY_BYTES {
                return Err(format!("包过大（> {} MB）", MAX_COPY_BYTES / 1024 / 1024));
            }
            fs::copy(&s, &d).map_err(|e| io_err("复制文件", e))?;
        }
    }
    Ok(())
}

/// 把 `src` 整个目录复制到 `dst`（`dst` 必须尚不存在）。
///
/// 为什么复制而不是就地跑：**跑的东西必须是校验过的那一份**。就地跑等于"校验 A、运行 B"，
/// 中间任何一次改动（用户自己改的、别的程序改的）都不在批准范围内。
/// 复制到 `plugins/staging/<draft>` 之后再校验一次，校验对象就是将要被提升的那份副本。
#[tauri::command]
pub fn plugin_copy_dir(src: String, dst: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&dst, &roots)?;
    let s = PathBuf::from(&src);
    let d = PathBuf::from(&dst);
    if is_root_itself(&d, &roots) {
        return Err(format!("目标不能是插件根目录：{dst}"));
    }
    // 复制进自己（或从自己里面复制到自己）会无限增长，且第一次就写坏源
    if path_within(&d, &s) || path_within(&s, &d) {
        return Err(format!("源与目标互相包含：{src} → {dst}"));
    }
    if !s.is_dir() {
        return Err(format!("源不是目录（或者说它不存在）：{src}"));
    }
    if d.exists() {
        return Err(format!("目标已存在：{dst}"));
    }
    let mut budget = CopyBudget::default();
    copy_tree(&s, &d, &mut budget, 0)?;
    Ok(json!({
        "ok": true,
        "files": budget.files,
        "bytes": budget.bytes,
        "skippedLinks": budget.skipped_links,
        "dst": dst,
    }))
}

/// 把 `staging/<draft>` 提升成 `plugins/<id>`。
///
/// 用 `rename` 而不是"复制 + 删"：同一卷上 rename 是原子的，而"复制到一半断电"
/// 会留下一个**看起来装好了、其实缺文件**的目录——那种状态最难解释。
/// 跨卷/被占用时才退回复制（reparse 或不常见布局下 rename 会失败）。
#[tauri::command]
pub fn plugin_promote(draft_id: String, id: String, roots: Vec<String>) -> Result<Value, String> {
    let root = roots.first().ok_or_else(|| "roots 为空".to_string())?;
    let id = id.trim().to_string();
    let bad_id = id.is_empty()
        || id == "."
        || id == ".."
        || id.contains('/')
        || id.contains('\\')
        || id.eq_ignore_ascii_case("staging");
    if bad_id {
        return Err(format!("「{id}」不能用作安装目录名"));
    }
    let draft = draft_id.trim().to_string();
    if draft.is_empty() || draft.contains('/') || draft.contains('\\') || draft == "." || draft == ".." {
        return Err(format!("「{draft_id}」不能用作暂存目录名"));
    }

    let staging = Path::new(root).join("staging").join(&draft);
    let final_dir = Path::new(root).join(&id);
    guard(staging.to_string_lossy().as_ref(), &roots)?;
    guard(final_dir.to_string_lossy().as_ref(), &roots)?;

    if !staging.is_dir() {
        return Err(format!("没有这个暂存目录（可能是上一次安装被中断了）：{}", staging.display()));
    }
    if final_dir.exists() {
        return Err(format!("已经有一个叫 {id} 的插件：请先在插件管理里卸载再装（卸载会清掉批准记录，重装需要重新批准）"));
    }

    let mut via_copy = false;
    if fs::rename(&staging, &final_dir).is_err() {
        // 退路：复制过去再删暂存。失败了就把半成品清掉，不留一个吊着的目录
        via_copy = true;
        let mut budget = CopyBudget::default();
        if let Err(e) = copy_tree(&staging, &final_dir, &mut budget, 0) {
            let _ = fs::remove_dir_all(&final_dir);
            return Err(e);
        }
        let _ = fs::remove_dir_all(&staging);
    }
    Ok(json!({
        "ok": true,
        "id": id,
        "dir": final_dir.to_string_lossy(),
        "viaCopy": via_copy,
    }))
}

/// 递归删一个目录（卸载用）。**与 `plugin_fs_remove` 分开**：那条刻意不递归，
/// 因为"删一个文件"和"删一整棵树"混在一个入口里，迟早有人在错的入口上按了确认。
#[tauri::command]
pub fn plugin_remove_tree(path: String, roots: Vec<String>) -> Result<Value, String> {
    guard(&path, &roots)?;
    let p = PathBuf::from(&path);
    if is_root_itself(&p, &roots) {
        return Err(format!("拒绝删除插件根目录：{path}"));
    }
    if !p.exists() {
        return Ok(json!({ "ok": true, "existed": false }));
    }
    if !p.is_dir() {
        return Err(format!("不是目录（删文件请用 plugin_fs_remove）：{path}"));
    }
    fs::remove_dir_all(&p).map_err(|e| io_err("删目录", e))?;
    Ok(json!({ "ok": true, "existed": true }))
}

/// 追加与轮转。**真读写临时目录**：这条命令存在的全部理由是"文件长起来之后丢的是头部而不是尾巴"，
/// 而那件事只在真的把文件读回来时才暴露——用假 fs 测它等于没测。
#[cfg(test)]
mod append_tests {
    use super::plugin_fs_append;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 每个用例一个独立目录：并行跑测试时共用一处会互相截文件。
    fn scratch(tag: &str) -> (PathBuf, Vec<String>) {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("uartix-append-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        let root = p.to_string_lossy().to_string();
        (p, vec![root])
    }

    #[test]
    fn append_creates_missing_dirs_and_keeps_order() {
        let (root, rs) = scratch("order");
        let f = root.join("a").join("b").join("host.log");
        let fp = f.to_string_lossy().to_string();
        plugin_fs_append(fp.clone(), "L1\n".into(), rs.clone(), 0).unwrap();
        plugin_fs_append(fp.clone(), "L2\n".into(), rs.clone(), 0).unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "L1\nL2\n");
    }

    #[test]
    fn rotation_keeps_the_newest_and_only_breaks_on_newlines() {
        let (root, rs) = scratch("rotate");
        let fp = root.join("host.log").to_string_lossy().to_string();
        for i in 0..50 {
            plugin_fs_append(fp.clone(), format!("line-{i:03}\n"), rs.clone(), 200).unwrap();
        }
        let s = fs::read_to_string(&root.join("host.log")).unwrap();
        // ① 最新那行必须在。这条是整个函数存在的理由：读-改-写的写法在这里就会丢它。
        assert!(s.ends_with("line-049\n"), "{s}");
        assert!(!s.contains("line-000"));
        // ② 不越过上限，也不因为"要贴上限"而留半行
        assert!(s.len() <= 200);
        for l in s.lines() {
            assert!(l.starts_with("line-"), "半行：{l}");
            assert_eq!(l.chars().count(), 8, "被截断的行：{l}");
        }
    }

    #[test]
    fn empty_append_is_refused_not_a_silent_touch() {
        // 静默收下空串的表现是"文件时间戳一直在变、内容一行没多"，谁都不会怀疑到调用方漏了参数
        let (root, rs) = scratch("empty");
        let fp = root.join("host.log").to_string_lossy().to_string();
        assert!(plugin_fs_append(fp.clone(), String::new(), rs.clone(), 0).is_err());
        assert!(!root.join("host.log").exists(), "被拒的追加不该顺手把文件建出来");
    }

    #[test]
    fn path_outside_the_roots_is_rejected() {
        let (root, rs) = scratch("guard");
        let out = root.join("..").join("evil.log").to_string_lossy().to_string();
        assert!(plugin_fs_append(out, "hi\n".into(), rs, 0).is_err());
    }

    #[test]
    fn requested_cap_can_shrink_but_never_grow() {
        let (root, rs) = scratch("cap");
        let fp = root.join("host.log").to_string_lossy().to_string();
        // 要一个比硬上限大的：按硬上限办，不是按用户给的办
        let big = plugin_fs_append(fp.clone(), "x".repeat(1000) + "\n", rs.clone(), u64::MAX).unwrap();
        assert_eq!(big["cap"], serde_json::json!(4 * 1024 * 1024));
        let small = plugin_fs_append(fp.clone(), "y".repeat(300) + "\n", rs.clone(), 128).unwrap();
        assert_eq!(small["cap"], serde_json::json!(128));
        assert!(fs::read_to_string(&root.join("host.log")).unwrap().len() <= 128);
    }
}

#[cfg(test)]
mod tests {
    use super::{store_path, STORE_NAMES};

    #[test]
    fn store_name_whitelist() {
        for n in STORE_NAMES {
            assert!(store_path(n, &["C:\\app\\extensions".to_string()]).is_ok(), "{n}");
        }
        assert!(store_path("../evil", &["C:\\app\\extensions".to_string()]).is_err());
        assert!(store_path("index.bak", &["C:\\app\\extensions".to_string()]).is_err());
        assert!(store_path("index", &[]).is_err());
    }

    #[test]
    fn store_path_lands_inside_root() {
        // 断言不能用写死的 `C:\app\extensions\index.json`：Linux 上反斜杠只是普通字符，
        // PathBuf::join 补的是 `/`，CI 会红成"真机 BUG"的样子，其实只是测试没跨平台。
        let root = "C:\\app\\extensions";
        let p = store_path("index", &[root.to_string()]).unwrap();
        assert_eq!(p, std::path::Path::new(root).join("index.json"));
    }
}

/// 安装三步（复制 / 提升 / 卸载）的判据。**真读写临时目录**——
/// 这三条命令的全部价值就是"盘上发生了什么"，只测参数校验等于没测。
#[cfg(test)]
mod install_tests {
    use super::{plugin_copy_dir, plugin_promote, plugin_remove_tree};
    use serde_json::Value;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 每个用例一个独立目录：并行跑测试时共用一处会互相删文件。
    fn scratch(tag: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("uartix-ext-it-{tag}-{}-{n}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn roots(p: &Path) -> Vec<String> {
        vec![p.to_string_lossy().to_string()]
    }

    /// 造一个"包"：`extension.json` + `main.mjs` + 一层子目录里的文件。
    fn make_pkg(dir: &Path) {
        fs::create_dir_all(dir.join("lib")).unwrap();
        fs::write(dir.join("extension.json"), r#"{"id":"a.b"}"#).unwrap();
        fs::write(dir.join("main.mjs"), "export function activate(){}").unwrap();
        fs::write(dir.join("lib").join("util.mjs"), "export const n = 1;").unwrap();
    }

    #[test]
    fn copy_dir_copies_whole_tree_and_counts() {
        let root = scratch("copy");
        let src = root.join("src");
        make_pkg(&src);
        let dst = root.join("plugins").join("staging").join("draft-1");

        let v = plugin_copy_dir(
            src.to_string_lossy().to_string(),
            dst.to_string_lossy().to_string(),
            roots(&root.join("plugins")),
        )
        .expect("应当复制成功");

        assert_eq!(v["files"], 3); // json 数字与 usize 比较走 Value 的 PartialEq
        assert!(dst.join("main.mjs").is_file());
        assert!(dst.join("lib").join("util.mjs").is_file());
        // 内容必须真的搬过来了（只建目录不写文件是最容易"看起来成功"的错）
        assert_eq!(
            fs::read_to_string(dst.join("main.mjs")).unwrap(),
            "export function activate(){}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_dir_refuses_target_outside_root() {
        let root = scratch("outside");
        let src = root.join("src");
        make_pkg(&src);
        let outside = std::env::temp_dir().join("uartix-not-in-roots");
        let e = plugin_copy_dir(
            src.to_string_lossy().to_string(),
            outside.to_string_lossy().to_string(),
            roots(&root.join("plugins")),
        );
        assert!(e.is_err(), "写到 roots 外面必须被拒");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_dir_refuses_into_itself() {
        let root = scratch("self");
        let ext_root = root.join("plugins");
        let src = ext_root.join("pkg");
        make_pkg(&src);
        // 目标在源里面：一次复制就会把 src 越搬越大，第二次复制再翻一倍
        let e = plugin_copy_dir(
            src.to_string_lossy().to_string(),
            src.join("inner").to_string_lossy().to_string(),
            roots(&ext_root),
        );
        assert!(e.is_err(), "复制进自己必须被拒");
        // 反向也一样：从子目录往父目录复制，会把父目录里正在写的文件读进来
        let e2 = plugin_copy_dir(
            src.join("lib").to_string_lossy().to_string(),
            src.to_string_lossy().to_string(),
            roots(&ext_root),
        );
        assert!(e2.is_err(), "覆盖源目录必须被拒（目标已存在）");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_dir_refuses_existing_target_and_root_itself() {
        let root = scratch("exists");
        let ext_root = root.join("plugins");
        let src = root.join("src");
        make_pkg(&src);
        let dst = ext_root.join("dup");
        fs::create_dir_all(&dst).unwrap();
        assert!(
            plugin_copy_dir(
                src.to_string_lossy().to_string(),
                dst.to_string_lossy().to_string(),
                roots(&ext_root)
            )
            .is_err(),
            "目标已存在时不许覆盖（半装状态比没装更难解释）"
        );
        assert!(
            plugin_copy_dir(
                src.to_string_lossy().to_string(),
                ext_root.to_string_lossy().to_string(),
                roots(&ext_root)
            )
            .is_err(),
            "不许往插件根上复制（那样整个仓库都变成这个包）"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn promote_moves_staging_to_final_and_clears_staging() {
        let root = scratch("promote");
        let ext_root = root.join("plugins");
        let staging = ext_root.join("staging").join("draft-9");
        make_pkg(&staging);

        let v = plugin_promote(
            "draft-9".to_string(),
            "a.b".to_string(),
            roots(&ext_root),
        )
        .expect("提升应当成功");

        let final_dir = ext_root.join("a.b");
        assert_eq!(v["dir"], Value::String(final_dir.to_string_lossy().to_string()));
        assert!(final_dir.join("main.mjs").is_file());
        assert!(!staging.exists(), "暂存目录必须被清掉（留着会被下次安装当成半成品）");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn promote_refuses_bad_id_and_existing_target() {
        let root = scratch("promote-bad");
        let ext_root = root.join("plugins");
        fs::create_dir_all(ext_root.join("staging").join("d1")).unwrap();

        for bad in ["", ".", "..", "a/b", "a\\b", "staging"] {
            assert!(
                plugin_promote("d1".to_string(), bad.to_string(), roots(&ext_root)).is_err(),
                "「{bad}」不该被当成安装目录名"
            );
        }
        // 目标已存在：更新安装必须先卸载，不许悄悄覆盖（避免"装到一半两个版本混着"）
        fs::create_dir_all(ext_root.join("a.b")).unwrap();
        assert!(plugin_promote("d1".to_string(), "a.b".to_string(), roots(&ext_root)).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_tree_deletes_only_below_root() {
        let root = scratch("rm");
        let ext_root = root.join("plugins");
        let pkg = ext_root.join("a.b");
        make_pkg(&pkg);

        assert!(plugin_remove_tree(ext_root.to_string_lossy().to_string(), roots(&ext_root)).is_err());
        assert!(plugin_remove_tree(
            PathBuf::from(&pkg).join("main.mjs").to_string_lossy().to_string(),
            roots(&ext_root)
        )
        .is_err(), "删文件走 plugin_fs_remove，这条只删目录");

        plugin_remove_tree(pkg.to_string_lossy().to_string(), roots(&ext_root)).expect("包目录应被删掉");
        assert!(!pkg.exists());
        assert!(ext_root.exists(), "删包不能把根一起带走");
        let _ = fs::remove_dir_all(&root);
    }
}
