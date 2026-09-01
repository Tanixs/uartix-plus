//! IPC 字节数组的 base64 序列化。
//! Vec<u8> 默认按 JSON 数字数组序列化：16KB 块膨胀为 ~80KB 文本，
//! 前端还要解析回 number[]（每个数字一个 JS Number）。
//! 改为 base64 字符串后事件体积降 ~4 倍，前端 atob 一步还原 Uint8Array。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serializer;

pub fn serialize<S: Serializer>(bytes: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&STANDARD.encode(bytes))
}
