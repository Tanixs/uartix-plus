use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use tauri::State;

use crate::serial::SerialManager;

#[derive(Deserialize)]
#[serde(untagged)]
pub enum XlsxCell {
    Num(f64),
    Str(String),
}

fn write_xlsx(path: &str, rows: &[Vec<XlsxCell>]) -> Result<(), String> {
    let mut wb = rust_xlsxwriter::Workbook::new();
    let mut ws = rust_xlsxwriter::Worksheet::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, cell) in row.iter().enumerate() {
            let col = u16::try_from(c).map_err(|_| "列数超出 Excel 上限".to_string())?;
            let res = match cell {
                XlsxCell::Num(v) => ws.write_number(r as u32, col, *v),
                XlsxCell::Str(s) => ws.write_string(r as u32, col, s),
            };
            res.map_err(|e| format!("写入单元格失败: {e}"))?;
        }
    }
    wb.push_worksheet(ws);
    wb.save(path).map_err(|e| format!("保存文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn export_xlsx(path: String, rows: Vec<Vec<XlsxCell>>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || write_xlsx(&path, &rows))
        .await
        .map_err(|e| format!("导出任务失败: {e}"))?
}

#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    let mut f = File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {e}"))
}

#[tauri::command]
pub fn read_binary_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))
}

#[derive(Serialize)]
pub struct LocalAddr {
    /// 网卡/接口名（如 以太网、WLAN、vEthernet (Default Switch)）
    pub name: String,
    /// IPv4 地址
    pub ip: String,
}

#[tauri::command]
pub fn list_local_addrs() -> Vec<LocalAddr> {
    let mut out: Vec<LocalAddr> = Vec::new();
    if let Ok(addrs) = if_addrs::get_if_addrs() {
        for a in addrs {
            if let if_addrs::IfAddr::V4(v4) = a.addr {
                let ip = v4.ip.to_string();
                if !out.iter().any(|x| x.ip == ip) {
                    out.push(LocalAddr { name: a.name, ip });
                }
            }
        }
    }
    out
}

#[tauri::command]
pub fn save_binary_file(path: String, content: Vec<u8>) -> Result<(), String> {
    let mut f = File::create(&path).map_err(|e| format!("创建文件失败: {e}"))?;
    f.write_all(&content)
        .map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(())
}

/// P87c 分析包安全写入（批准必要底座；不碰 save_text_file/parser/fs 插件权限）。
///
/// 语义约定：
/// - `directory` 必须是已存在的用户选定目录；在其下新建唯一随机/时间+counter
///   子目录（AlreadyExists 自动重试），不覆盖既有子目录与文件；
/// - `files[].name` 必须是单段安全 basename（ASCII；拒绝路径分隔符、`..`、
///   绝对路径、Windows 保留名、非法结尾字符）；同包重复名（含大小写折叠）
///   拒绝；
/// - `files` 必须恰含一个 `meta.json`，且必须是合法 JSON object；
/// - 上限：128 个文件、单文件 16 MiB、总字节 64 MiB；
/// - 写入顺序：先写数据文件（create_new），`meta.json` 最后写；开包即写
///   `incomplete.json`（计划清单），全部成功后仅删除自己创建的该文件——
///   失败路径下包目录/数据/`incomplete.json` 全部保留，供用户区分
///   complete/incomplete，不删除用户路径下任何内容；
/// - 返回最终包目录信息；无 `meta.json`/重复名/越限等校验失败在创建任何
///   文件前即报错。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFile {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResult {
    pub status: &'static str,
    /// 完整包目录路径（父目录 + 子目录名）。
    pub directory: String,
    /// 子目录名（不含父路径）。
    pub subdir: String,
    pub file_count: u32,
    pub total_bytes: u64,
}

const PKG_MAX_FILES: usize = 128;
const PKG_MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
const PKG_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

/// 校验单段安全文件名：仅允许 ASCII 白名单 [a-zA-Z0-9_.-]，且不得含 `..`、
/// 不得以点开头/结尾、不得为 Windows 保留名。返回 Err 文案即拒绝。
fn validate_package_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("文件名为空".into());
    }
    if name.len() > 255 {
        return Err("文件名过长".into());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(format!(
            "文件名仅允许 ASCII 字母/数字/下划线/点/连字符: {name:?}"
        ));
    }
    if name.starts_with('.') {
        return Err(format!("文件名以点开头: {name:?}"));
    }
    if name.contains("..") {
        return Err(format!("文件名含 \"..\": {name:?}"));
    }
    let lower = name.to_ascii_lowercase();
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
        "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = lower.split('.').next().unwrap_or("");
    if RESERVED.contains(&stem) {
        return Err(format!("Windows 保留文件名: {name:?}"));
    }
    if name.ends_with('.') {
        return Err(format!("文件名以点结尾: {name:?}"));
    }
    Ok(())
}

/// 校验整个文件清单：恰一个 meta.json（合法 JSON object）、无重复名、数量与
/// 字节上限。校验失败时绝不创建任何文件。
fn validate_package_files(files: &[PackageFile]) -> Result<(usize, usize), String> {
    if files.is_empty() {
        return Err("文件清单为空".into());
    }
    if files.len() > PKG_MAX_FILES {
        return Err(format!("文件数超上限 {PKG_MAX_FILES}"));
    }
    let mut names = std::collections::HashSet::new();
    let mut metas = 0usize;
    let mut total = 0usize;
    for f in files {
        validate_package_file_name(&f.name)?;
        if f.name.eq_ignore_ascii_case("meta.json") {
            metas += 1;
            let v: serde_json::Value = serde_json::from_str(&f.content)
                .map_err(|e| format!("meta.json 不是合法 JSON: {e}"))?;
            if !v.is_object() {
                return Err("meta.json 必须是 JSON object".into());
            }
        }
        if !names.insert(f.name.to_ascii_lowercase()) {
            return Err(format!("重复文件名: {:?}", f.name));
        }
        if f.name.eq_ignore_ascii_case("incomplete.json") {
            return Err("incomplete.json 为内部标记，不可作为数据文件名".into());
        }
        let bytes = f.content.len();
        if bytes > PKG_MAX_FILE_BYTES {
            return Err(format!("单文件超上限 {} 字节: {:?}", PKG_MAX_FILE_BYTES, f.name));
        }
        total += bytes;
    }
    if metas != 1 {
        return Err("文件清单必须且只能包含一个 meta.json".into());
    }
    if total > PKG_MAX_TOTAL_BYTES {
        return Err(format!("总字节超上限 {PKG_MAX_TOTAL_BYTES}"));
    }
    Ok((files.len(), total))
}

/// 生成唯一子目录名：UTC 时间戳 + 进程号 + 递增 counter（每次调用从 0 起步，
/// 已存在即 AlreadyExists 重试），同进程内唯一，跨进程由 create_dir
/// AlreadyExists 重试兜底。
fn package_subdir_name(now: std::time::SystemTime, counter: u64) -> String {
    let secs = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("analysis_{}_{:x}_{:04}", secs, std::process::id(), counter & 0xffff)
}

/// 核心（可单测，可注入 writer）：校验清单 → 建唯一子目录 → incomplete.json →
/// 数据文件 → meta.json 最后 → 删除 incomplete.json。任何失败不删除已写内容。
/// 生产走 `real_file_writer`（真实落盘）；测试可注入记录次序/注入失败的闭包。
type PackageFileWriter<'a> = dyn FnMut(&std::path::Path, &str) -> Result<(), String> + 'a;

/// 真实落盘 writer（生产实现）：create_new 独占创建 + write_all + sync_all，
/// 错误信息含完整文件路径。已存在文件绝不覆盖（AlreadyExists 即失败）。
fn real_file_writer(path: &std::path::Path, content: &str) -> Result<(), String> {
    let mut f = File::create_new(path)
        .map_err(|e| format!("创建文件失败（{}）: {e}", path.display()))?;
    f.write_all(content.as_bytes())
        .map_err(|e| format!("写入文件失败（{}）: {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("刷盘失败（{}）: {e}", path.display()))?;
    Ok(())
}

fn write_analysis_package_impl(
    directory: &std::path::Path,
    files: &[PackageFile],
    write_file: &mut PackageFileWriter,
) -> Result<PackageResult, String> {
    let (file_count, total_bytes) = validate_package_files(files)?;
    let dir_meta = std::fs::metadata(directory)
        .map_err(|e| format!("目标目录不可用（{}）: {e}", directory.display()))?;
    if !dir_meta.is_dir() {
        return Err(format!("目标不是目录（{}）", directory.display()));
    }

    // 唯一子目录：AlreadyExists 重试若干次。
    let mut subdir_path = None;
    let start = std::time::SystemTime::now();
    for counter in 0u64..1024 {
        let candidate = directory.join(package_subdir_name(start, counter));
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                subdir_path = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => {
                return Err(format!("创建子目录失败: {e}"));
            }
        }
    }
    let subdir_path = subdir_path.ok_or_else(|| "子目录命名冲突，重试耗尽".to_string())?;
    let subdir_name = subdir_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    let written = |name: &str| subdir_path.join(name);

    // 前置 incomplete 标记（含计划清单）；全部成功后仅删除该文件。
    let planned: Vec<&String> = files.iter().map(|f| &f.name).collect();
    let incomplete = serde_json::json!({
        "schema": "vs-analysis-package-incomplete/v1",
        "plannedFiles": planned,
    });
    let incomplete_path = written("incomplete.json");
    write_file(&incomplete_path, &incomplete.to_string())?;

    // 数据文件先写；失败立即返回（保留 incomplete.json 与已写数据，不删除
    // 用户路径内容，包呈 incomplete 状态）。
    for f in files {
        if f.name.eq_ignore_ascii_case("meta.json") {
            continue; // meta.json 最后写
        }
        write_file(&written(&f.name), &f.content)?;
    }

    // meta.json 最后写（create_new：包内唯一性已由清单校验保证）。
    let meta = files
        .iter()
        .find(|f| f.name.eq_ignore_ascii_case("meta.json"))
        .expect("validate_package_files 已保证恰一个 meta.json");
    if let Err(e) = write_file(&written("meta.json"), &meta.content) {
        return Err(e); // 保留 incomplete.json，包呈 incomplete 状态
    }

    // 全部成功：移除前置 incomplete 标记（只删自己创建的该文件）。
    if let Err(e) = std::fs::remove_file(&incomplete_path) {
        return Err(format!("移除 incomplete.json 失败（包内容已完整）: {e}"));
    }

    Ok(PackageResult {
        status: "complete",
        directory: subdir_path.display().to_string(),
        subdir: subdir_name,
        file_count: file_count as u32,
        total_bytes: total_bytes as u64,
    })
}

#[tauri::command]
pub fn save_analysis_package(
    directory: String,
    files: Vec<PackageFile>,
) -> Result<PackageResult, String> {
    write_analysis_package_impl(std::path::Path::new(&directory), &files, &mut real_file_writer)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub seq: u64,
}

#[tauri::command]
pub fn hex_search(
    pattern: Vec<u8>,
    state: State<SerialManager>,
) -> Result<Vec<SearchHit>, String> {
    if pattern.is_empty() {
        return Err("搜索内容为空".into());
    }
    let ring = state
        .ctx
        .pipeline
        .ring
        .lock()
        .map_err(|_| "缓冲锁中毒".to_string())?;
    let (start, bytes) = ring.fetch(0, u64::MAX);
    let mut hits = Vec::new();
    let plen = pattern.len();
    if bytes.len() >= plen {
        let n = bytes.len() - plen;
        for i in 0..=n {
            if &bytes[i..i + plen] == pattern.as_slice() {
                hits.push(SearchHit {
                    seq: start + i as u64,
                });
                if hits.len() >= 500 {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xlsx_writes_zip_container() {
        let path = std::env::temp_dir().join("uartix_xlsx_test.xlsx");
        let _ = std::fs::remove_file(&path);
        let rows = vec![
            vec![XlsxCell::Str("时间".into()), XlsxCell::Str("值".into())],
            vec![XlsxCell::Str("0:01.5".into()), XlsxCell::Num(23.5)],
            vec![XlsxCell::Str("".into()), XlsxCell::Num(-0.000001)],
        ];
        write_xlsx(path.to_str().unwrap(), &rows).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..2], b"PK");
        let _ = std::fs::remove_file(&path);
    }

    fn pkg_file(name: &str, content: &str) -> PackageFile {
        PackageFile {
            name: name.to_string(),
            content: content.to_string(),
        }
    }

    fn meta(name: &str) -> PackageFile {
        pkg_file("meta.json", &format!(r#"{{"title":"{name}"}}"#))
    }

    /// 原子创建测试专用基目录：不预删任何固定名目录（避免并行/误删），
    /// create_dir 独占创建，失败重试换名；仅测试自身创建的目录会被清理。
    struct TempBase(std::path::PathBuf);
    impl TempBase {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir();
            for i in 0..1024u64 {
                let candidate = base.join(format!(
                    "uartix_{tag}_{}_{:x}_{:04}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0),
                    i
                ));
                match std::fs::create_dir(&candidate) {
                    Ok(()) => return TempBase(candidate),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => panic!("创建测试临时目录失败: {e}"),
                }
            }
            panic!("测试临时目录命名冲突，重试耗尽");
        }
    }
    impl Drop for TempBase {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn package_name_validation_rejects_traversal_and_reserved() {
        for bad in [
            "../evil.json",
            "a/b.json",
            "a\\b.json",
            "..",
            ".",
            "..hidden.json",
            ".hidden.json",
            "C:temp.json",
            "aux.json",
            "COM1",
            " spaced.json",
            "dot.",
            "表.json",
        ] {
            assert!(validate_package_file_name(bad).is_err(), "{bad} 应被拒绝");
        }
        for good in ["meta.json", "waveform_0.csv", "ai-prompt.txt", "a.b.c.json"] {
            assert!(validate_package_file_name(good).is_ok(), "{good} 应通过");
        }
    }

    #[test]
    fn package_manifest_validation_requires_single_meta_json() {
        assert!(validate_package_files(&[]).is_err());
        // 恰一个 meta.json
        assert!(validate_package_files(&[meta("m"), pkg_file("a.csv", "1")]).is_ok());
        assert!(validate_package_files(&[pkg_file("a.csv", "1")]).is_err());
        assert!(validate_package_files(&[meta("m"), meta("m2")]).is_err());
        // meta 必须是 JSON object
        assert!(validate_package_files(&[pkg_file("meta.json", "[1]")]).is_err());
        assert!(validate_package_files(&[pkg_file("meta.json", "not json")]).is_err());
        // 重复名（大小写折叠）
        assert!(validate_package_files(&[meta("m"), pkg_file("A.csv", "1"), pkg_file("a.CSV", "2")]).is_err());
        // 上限
        let many: Vec<PackageFile> = (0..=PKG_MAX_FILES)
            .map(|i| pkg_file(&format!("f{i}.txt"), "x"))
            .chain(std::iter::once(meta("m")))
            .collect();
        assert!(validate_package_files(&many).is_err());
        let big = " ".repeat(PKG_MAX_FILE_BYTES + 1);
        assert!(validate_package_files(&[meta("m"), pkg_file("big.csv", &big)]).is_err());
    }

    #[test]
    fn subdir_name_unique_per_counter() {
        let now = std::time::SystemTime::now();
        let a = package_subdir_name(now, 0);
        let b = package_subdir_name(now, 1);
        assert_ne!(a, b);
        assert!(a.starts_with("analysis_"));
    }

    #[test]
    fn save_analysis_package_writes_complete_layout_and_last_meta() {
        let base = TempBase::new("pkg_test");
        let files = vec![
            meta("包元信息"),
            pkg_file("waveform_0.csv", "t_ms,v\r\n1000,1\r\n"),
            pkg_file("trajectory_0.csv", "t_ms,x,y,z\r\n"),
        ];
        let res = write_analysis_package_impl(&base.0, &files, &mut real_file_writer).unwrap();
        let pkg = base.0.join(&res.subdir);
        assert_eq!(res.file_count, 3);
        let expected: usize = files.iter().map(|f| f.content.len()).sum();
        assert_eq!(res.total_bytes as usize, expected);
        assert!(pkg.join("meta.json").is_file());
        assert!(pkg.join("waveform_0.csv").is_file());
        assert!(pkg.join("trajectory_0.csv").is_file());
        assert!(!pkg.join("incomplete.json").exists(), "complete 包不得残留 incomplete.json");
        // 再次导出到同一基目录：新子目录，互不覆盖
        let res2 = write_analysis_package_impl(&base.0, &files, &mut real_file_writer).unwrap();
        assert_ne!(res.subdir, res2.subdir);
        assert!(base.0.join(&res2.subdir).join("meta.json").is_file());
        // TempBase Drop 只清理自己创建的目录
    }

    #[test]
    fn package_failure_keeps_incomplete_and_user_files() {
        let base = TempBase::new("pkg_fail");
        // 用户既有文件不得被动
        std::fs::write(base.0.join("user_note.txt"), "keep").unwrap();
        // 文件名冲突：重复同名不同内容 → 清单校验（重复名）在建包前即失败
        let files = vec![
            meta("m"),
            pkg_file("waveform_0.csv", "t_ms,v\r\n1000,1\r\n"),
            pkg_file("waveform_0.csv", "dup"),
        ];
        assert!(write_analysis_package_impl(&base.0, &files, &mut real_file_writer).is_err());
        assert!(std::fs::read_dir(&base.0).unwrap().count() == 1, "校验失败不得建包目录");
        // 第二种失败：目标父目录不存在 → 建包前失败，用户既有文件不受影响
        let err = write_analysis_package_impl(
            std::path::Path::new(&base.0.join("missing_dir")),
            &[meta("m")],
            &mut real_file_writer,
        );
        assert!(err.is_err());
        assert!(std::fs::read_to_string(base.0.join("user_note.txt")).unwrap() == "keep");
    }

    #[test]
    fn package_complete_meta_content_and_internal_name_rejected() {
        let base = TempBase::new("pkg_inc");
        // incomplete.json 作为数据文件名 → 建包前校验失败
        let files = vec![meta("m"), pkg_file("a.csv", "1"), pkg_file("incomplete.json", "x")];
        assert!(write_analysis_package_impl(&base.0, &files, &mut real_file_writer).is_err());
        assert!(std::fs::read_dir(&base.0).unwrap().count() == 0, "校验失败不得建包目录");
        let ok = vec![meta("m"), pkg_file("a.csv", "1")];
        let res = write_analysis_package_impl(&base.0, &ok, &mut real_file_writer).unwrap();
        let pkg = base.0.join(&res.subdir);
        // complete 包：incomplete 已删、meta 内容即用户 JSON（调用方 schema）
        let meta_text = std::fs::read_to_string(pkg.join("meta.json")).unwrap();
        assert_eq!(meta_text, ok[0].content);
        // receipt.directory 是完整包路径
        assert_eq!(std::path::Path::new(&res.directory), pkg.as_path());
        assert!(!pkg.join("incomplete.json").exists());
    }

    /// 生产同款真实写盘（create_new + write_all + sync_all），并记录调用次序。
    fn recording_writer(order: &mut Vec<String>) -> impl FnMut(&std::path::Path, &str) -> Result<(), String> + '_ {
        move |path: &std::path::Path, content: &str| {
            order.push(path.file_name().unwrap().to_string_lossy().into_owned());
            real_file_writer(path, content)
        }
    }

    #[test]
    fn real_write_order_meta_last_and_directory_is_full_pkg_path() {
        let base = TempBase::new("pkg_order");
        let files = vec![
            meta("m"),
            pkg_file("b.csv", "bbb"),
            pkg_file("a.csv", "aaa"),
        ];
        let mut order = Vec::new();
        let res = write_analysis_package_impl(&base.0, &files, &mut recording_writer(&mut order)).unwrap();
        // 次序：incomplete.json → 数据文件（清单序）→ meta.json 最后
        assert_eq!(
            order,
            vec!["incomplete.json", "b.csv", "a.csv", "meta.json"]
        );
        // receipt.directory 是完整包路径（父目录 + 子目录名）
        let pkg = base.0.join(&res.subdir);
        assert_eq!(std::path::Path::new(&res.directory), pkg.as_path());
        assert!(pkg.join("meta.json").is_file());
        assert!(!pkg.join("incomplete.json").exists());
    }

    #[test]
    fn create_new_never_overwrites_existing_conflict_file() {
        let base = TempBase::new("pkg_conflict");
        let files = vec![meta("m"), pkg_file("a.csv", "new-content")];
        // 先成功建一次包
        let res = write_analysis_package_impl(&base.0, &files, &mut real_file_writer).unwrap();
        let pkg = base.0.join(&res.subdir);
        // 手动在包内放置同名冲突文件（create_new 场景）
        let conflict = pkg.join("a.csv");
        std::fs::write(&conflict, "original-content").unwrap();
        // 同清单再写同一目录不可达（目录名唯一），改为直接验证 writer 语义：
        let err = real_file_writer(&conflict, "should-not-overwrite");
        assert!(err.is_err(), "create_new 对已存在文件必须失败");
        assert_eq!(std::fs::read_to_string(&conflict).unwrap(), "original-content");
        assert!(err.unwrap_err().contains("a.csv"), "错误信息须含文件路径");
    }

    #[test]
    fn meta_stage_failure_via_real_create_new_keeps_incomplete() {
        let base = TempBase::new("pkg_metafail");
        let files = vec![meta("m"), pkg_file("a.csv", "aaa")];
        // 注入 writer：incomplete/数据文件真实写盘，meta.json 阶段注入
        // create_new 真实失败（预放置同名文件使 create_new 返回 AlreadyExists）
        let pkg_holder: std::sync::Mutex<Option<std::path::PathBuf>> =
            std::sync::Mutex::new(None);
        let mut writer = |path: &std::path::Path, content: &str| -> Result<(), String> {
            if path.file_name().and_then(|n| n.to_str()) == Some("meta.json") {
                // 记下包目录后注入真实 create_new 失败
                let mut holder = pkg_holder.lock().unwrap();
                if holder.is_none() {
                    *holder = Some(path.parent().unwrap().to_path_buf());
                    std::fs::write(path, "pre-existing").unwrap(); // 使 create_new 失败
                }
            }
            real_file_writer(path, content)
        };
        let err = write_analysis_package_impl(&base.0, &files, &mut writer);
        assert!(err.is_err(), "meta 阶段 create_new 失败必须报错");
        assert!(err.unwrap_err().contains("meta.json"), "错误须含 meta.json 路径");
        let pkg = pkg_holder.lock().unwrap().clone().unwrap();
        // 失败路径：incomplete.json 与已写数据保留，包呈 incomplete 状态
        assert!(pkg.join("incomplete.json").is_file());
        assert_eq!(std::fs::read_to_string(pkg.join("a.csv")).unwrap(), "aaa");
        // 注入的 meta 占位内容不被覆盖（create_new 失败语义）
        assert_eq!(std::fs::read_to_string(pkg.join("meta.json")).unwrap(), "pre-existing");
        // 用户基目录内除新包子目录外无其他变化
        assert_eq!(std::fs::read_dir(&base.0).unwrap().count(), 1);
    }
}
