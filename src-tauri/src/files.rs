use serde::Serialize;
use std::fs::File;
use std::io::Write;
use tauri::State;

use crate::serial::SerialManager;

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
