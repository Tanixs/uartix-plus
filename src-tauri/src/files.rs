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
}
