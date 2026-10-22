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
//!    给相对路径就等于给了"往 extensions 下任意位置写"的口子。

use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::agent_tools::path_in_roots;

/// 单次写入上限。清单/账本/引导脚本都远小于这个数；真传大文件请走未来的 zip 通道。
const MAX_WRITE_BYTES: usize = 8 * 1024 * 1024;
/// 读文本的上限：超过就截断并标 `truncated`，不静默裁（与 shell 的 64KB 头尾预算同一条规矩）。
const MAX_READ_BYTES: u64 = 256 * 1024;
/// 允许的账本名。加一个就要同时想清楚"它的写入是不是也该原子"。
const STORE_NAMES: [&str; 2] = ["index", "trust"];

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
pub fn ext_fs_write(path: String, content: String, roots: Vec<String>) -> Result<Value, String> {
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

/// 读文本。不存在返回 `{exists:false}`（不是错误——"还没装过"是正常状态）。
#[tauri::command]
pub fn ext_fs_read(path: String, roots: Vec<String>) -> Result<Value, String> {
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
    f.by_ref()
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
pub fn ext_fs_list(dir: String, roots: Vec<String>) -> Result<Value, String> {
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
pub fn ext_fs_remove(path: String, roots: Vec<String>) -> Result<Value, String> {
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
        return Err(format!("unknown_store: {name}（只认 index / trust）"));
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
pub fn ext_store_read(name: String, roots: Vec<String>) -> Result<Value, String> {
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
pub fn ext_store_write(name: String, data: Value, roots: Vec<String>) -> Result<Value, String> {
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
        let p = store_path("index", &["C:\\app\\extensions".to_string()]).unwrap();
        assert_eq!(p.to_string_lossy(), "C:\\app\\extensions\\index.json");
    }
}
