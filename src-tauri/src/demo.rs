use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, State};

use crate::parser::crc16_modbus;
use crate::pipeline::ingest;
use crate::serial::SerialManager;
use crate::pipeline::IngestCtx;

pub fn start_demo(
    app: AppHandle,
    ctx: Arc<IngestCtx>,
    flag: Arc<AtomicBool>,
) -> bool {
    if flag.swap(true, Ordering::SeqCst) {
        return false;
    }
    thread::spawn(move || demo_loop(app, ctx, flag));
    true
}

pub fn stop_demo(flag: &AtomicBool) {
    flag.store(false, Ordering::SeqCst);
}

fn sumadd(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, &b| acc.wrapping_add(b))
}

fn build_v7(fid: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(payload.len() + 6);
    f.push(0xAA);
    f.push(0xFF);
    f.push(fid);
    f.push(payload.len() as u8);
    f.extend_from_slice(payload);
    let sc = sumadd(&f);
    f.push(sc);
    f.push(sc.wrapping_add(0xAA));
    f
}

fn build_wit(ty: u8, data: &[u8; 8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(11);
    f.push(0x55);
    f.push(ty);
    f.extend_from_slice(data);
    f.push(sumadd(&f));
    f
}

fn v7_euler(tick: u64) -> Vec<u8> {
    let rol = (3000.0f32 * (tick as f32 * 0.05).sin()) as i16;
    let pit = (3000.0f32 * (tick as f32 * 0.083).cos()) as i16;
    let yaw = (18000.0f32 * (tick as f32 * 0.031).sin()) as i16;
    let mut payload = Vec::with_capacity(7);
    payload.extend_from_slice(&rol.to_le_bytes());
    payload.extend_from_slice(&pit.to_le_bytes());
    payload.extend_from_slice(&yaw.to_le_bytes());
    payload.push(((tick / 5) % 4) as u8);
    build_v7(0x03, &payload)
}

fn v7_gps(tick: u64) -> Vec<u8> {
    let mut payload = Vec::with_capacity(23);
    payload.push(1);
    payload.push(12 + ((tick / 8) % 6) as u8);
    let lng = 116391280i32 + 300 * (tick as f32 * 0.01).sin() as i32;
    let lat = 399112340i32 + 200 * (tick as f32 * 0.013).cos() as i32;
    let alt = 5200i32 + 30 * (tick as f32 * 0.05).sin() as i32;
    let nsp = (120.0f32 * (tick as f32 * 0.07).sin()) as i16;
    let esp = (90.0f32 * (tick as f32 * 0.06).cos()) as i16;
    payload.extend_from_slice(&lng.to_le_bytes());
    payload.extend_from_slice(&lat.to_le_bytes());
    payload.extend_from_slice(&alt.to_le_bytes());
    payload.extend_from_slice(&nsp.to_le_bytes());
    payload.extend_from_slice(&esp.to_le_bytes());
    payload.extend_from_slice(&0i16.to_le_bytes());
    payload.push(12);
    payload.push(30);
    payload.push(25);
    build_v7(0x30, &payload)
}

fn v7_inertial(tick: u64) -> Vec<u8> {
    let mut payload = Vec::with_capacity(13);
    let ax = (300.0f32 * (tick as f32 * 0.09).sin()) as i16;
    let ay = (300.0f32 * (tick as f32 * 0.07).cos()) as i16;
    let az = 16384i16 + (250.0f32 * (tick as f32 * 0.11).sin()) as i16;
    let gx = (2000.0f32 * (tick as f32 * 0.13).sin()) as i16;
    let gy = (2000.0f32 * (tick as f32 * 0.08).cos()) as i16;
    let gz = (2000.0f32 * (tick as f32 * 0.05).sin()) as i16;
    payload.extend_from_slice(&ax.to_le_bytes());
    payload.extend_from_slice(&ay.to_le_bytes());
    payload.extend_from_slice(&az.to_le_bytes());
    payload.extend_from_slice(&gx.to_le_bytes());
    payload.extend_from_slice(&gy.to_le_bytes());
    payload.extend_from_slice(&gz.to_le_bytes());
    payload.push(((tick / 10) % 4) as u8);
    build_v7(0x01, &payload)
}

fn wit_acc(tick: u64) -> Vec<u8> {
    let ax = (1638.0f32 * (tick as f32 * 0.06).sin()) as i16;
    let ay = (1638.0f32 * (tick as f32 * 0.045).cos()) as i16;
    let az = 16384i16 + (800.0f32 * (tick as f32 * 0.09).sin()) as i16;
    let t = 2600i16 + (150.0f32 * (tick as f32 * 0.01).sin()) as i16;
    let mut data = [0u8; 8];
    data[0..2].copy_from_slice(&ax.to_le_bytes());
    data[2..4].copy_from_slice(&ay.to_le_bytes());
    data[4..6].copy_from_slice(&az.to_le_bytes());
    data[6..8].copy_from_slice(&t.to_le_bytes());
    build_wit(0x51, &data)
}

fn wit_gyro(tick: u64) -> Vec<u8> {
    let wx = (3277.0f32 * (tick as f32 * 0.04).sin()) as i16;
    let wy = (3277.0f32 * (tick as f32 * 0.06).cos()) as i16;
    let wz = (3277.0f32 * (tick as f32 * 0.03).sin()) as i16;
    let v = 740i16 + (20.0f32 * (tick as f32 * 0.02).sin()) as i16;
    let mut data = [0u8; 8];
    data[0..2].copy_from_slice(&wx.to_le_bytes());
    data[2..4].copy_from_slice(&wy.to_le_bytes());
    data[4..6].copy_from_slice(&wz.to_le_bytes());
    data[6..8].copy_from_slice(&v.to_le_bytes());
    build_wit(0x52, &data)
}

fn wit_angle(tick: u64) -> Vec<u8> {
    let roll = (6000.0f32 * (tick as f32 * 0.05).sin()) as i16;
    let pitch = (6000.0f32 * (tick as f32 * 0.083).cos()) as i16;
    let yaw = (29127.0f32 * (tick as f32 * 0.031).sin()) as i16;
    let mut data = [0u8; 8];
    data[0..2].copy_from_slice(&roll.to_le_bytes());
    data[2..4].copy_from_slice(&pitch.to_le_bytes());
    data[4..6].copy_from_slice(&yaw.to_le_bytes());
    data[6..8].copy_from_slice(&0x0100u16.to_le_bytes());
    build_wit(0x53, &data)
}

fn csv_line(tick: u64) -> Vec<u8> {
    let a = 10.0f32 * (tick as f32 * 0.09).sin();
    let b = -5.0f32 + 2.0 * (tick as f32 * 0.04).cos();
    let txt = if tick % 3 == 2 {
        format!("{a:.2},{b:.2},7.25\n")
    } else {
        format!("{a:.2},{b:.2}\n")
    };
    txt.into_bytes()
}

fn corrupt(buf: &mut [u8], idx: usize, mask: u8) {
    if let Some(b) = buf.get_mut(idx) {
        *b ^= mask;
    }
}

/// Modbus RTU 封装：地址 + PDU + CRC16-Modbus（小端，附在帧尾）
fn mb_rtu(addr: u8, pdu: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(pdu.len() + 3);
    f.push(addr);
    f.extend_from_slice(pdu);
    let crc = crc16_modbus(&f);
    f.extend_from_slice(&crc.to_le_bytes());
    f
}

/// 一路 Modbus RTU 主从对话（主站轮询 → 从站应答），供无硬件用户体验工业协议解码：
/// 1 号从站读保持寄存器（温度/光照/32 位计数），2 号从站读线圈（长度域是位数），
/// 并周期性插入异常响应与坏 CRC，用来验证解码器的异常识别与错位自愈。
fn modbus_poll(tick: u64) -> Vec<u8> {
    let mut out = Vec::new();

    // —— 1 号从站：读保持寄存器 4 个（温度 0.1℃、光照 lux、计数低 16 位、计数高 16 位）——
    out.extend(mb_rtu(0x01, &[0x03, 0x00, 0x00, 0x00, 0x04])); // 主站请求（定长 8）
    let temp = (250.0 + 80.0 * (tick as f32 * 0.08).sin()) as i16;
    let lux = 300u16 + (tick as u16 * 7) % 900;
    let cnt = tick as u32;
    if tick % 23 == 7 {
        // 异常响应：FC|0x80 + 异常码 02（非法数据地址）
        out.extend(mb_rtu(0x01, &[0x83, 0x02]));
    } else {
        let mut body = vec![0x03u8, 8u8];
        body.extend_from_slice(&temp.to_be_bytes());
        body.extend_from_slice(&lux.to_be_bytes());
        body.extend_from_slice(&((cnt & 0xffff) as u16).to_be_bytes());
        body.extend_from_slice(&((cnt >> 16) as u16).to_be_bytes());
        let mut resp = mb_rtu(0x01, &body);
        if tick % 29 == 3 {
            let n = resp.len();
            corrupt(&mut resp, n - 1, 0x5A); // 尾字节受创 → 应记为校验失败的坏帧
        }
        out.extend(resp);
    }

    // —— 2 号从站：读线圈 16 位（响应长度域是"位数"，需按位换算字节数）——
    out.extend(mb_rtu(0x02, &[0x01, 0x00, 0x00, 0x00, 0x10]));
    let bits = ((tick as u16) << 3) ^ 0x00AA;
    out.extend(mb_rtu(
        0x02,
        &[0x01, 16, (bits & 0xff) as u8, (bits >> 8) as u8],
    ));

    out
}

fn demo_loop(app: AppHandle, ctx: Arc<IngestCtx>, flag: Arc<AtomicBool>) {
    let mut tick: u64 = 0;
    while flag.load(Ordering::SeqCst) {
        let mut out: Vec<u8> = Vec::with_capacity(128);

        let mut euler = v7_euler(tick);
        if tick % 29 == 3 {
            corrupt(&mut euler, 4 + (tick % 6) as usize, 0x77);
        }
        out.extend_from_slice(&euler);

        if tick % 4 == 1 {
            let mut gps = v7_gps(tick);
            if tick % 31 == 5 {
                corrupt(&mut gps, 6 + (tick % 8) as usize, 0x81);
            }
            out.extend_from_slice(&gps);
        }

        if tick % 8 == 3 {
            out.extend_from_slice(&v7_inertial(tick));
        }

        if tick % 3 == 0 {
            let which = (tick / 3) % 3;
            let mut w = match which {
                0 => wit_acc(tick),
                1 => wit_gyro(tick),
                _ => wit_angle(tick),
            };
            if tick % 19 == 7 {
                corrupt(&mut w, 2 + (tick % 8) as usize, 0x55);
            }
            out.extend_from_slice(&w);
        }

        if tick % 5 == 2 {
            out.extend_from_slice(&csv_line(tick));
        }

        // 一路 Modbus RTU 主从对话：导入「Modbus RTU」预设即可看到曲线、
        // 线圈位计数换算与异常帧识别（每 400ms 一轮轮询）
        if tick % 4 == 0 {
            out.extend(modbus_poll(tick));
        }

        ingest(&ctx, &app, &out);
        tick += 1;
        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub fn demo_start(app: AppHandle, state: State<SerialManager>) -> Result<(), String> {
    // 回放与真实数据源互斥：回放进行中禁止启动演示源（避免双源混淆）
    if crate::session::is_playing() {
        return Err("回放进行中，请先停止回放再启动演示数据源".into());
    }
    if !crate::demo::start_demo(app, state.ctx.clone(), state.demo_flag.clone()) {
        return Err("演示数据源已在运行".into());
    }
    Ok(())
}

#[tauri::command]
pub fn demo_stop(state: State<SerialManager>) {
    stop_demo(&state.demo_flag);
}

#[tauri::command]
pub fn demo_running(state: State<SerialManager>) -> bool {
    state.demo_flag.load(Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::{Boundary, ChecksumCfg, FieldDef, FrameTemplate, ParseRules, ParserEngine};

    fn fld(id: &str, name: &str, role: &str, offset: i64, ty: &str, endian: &str) -> FieldDef {
        serde_json::from_value::<FieldDef>(serde_json::json!({
            "id": id, "name": name, "role": role, "offset": offset,
            "type": ty, "endian": endian, "color": "#888"
        }))
        .unwrap()
    }

    /// 与「Modbus RTU」预设同构的一小组规则，用来端到端验证演示源产出的字节流
    fn rtu_rules() -> ParseRules {
        let crc = || Some(ChecksumCfg {
            algo: "crc16_modbus".into(),
            coverage_start: 0,
            coverage_end: -2,
            endian: "little".into(),
        });
        let tpl = |id: &str, name: &str, boundary: Boundary, checksum: Option<ChecksumCfg>, fields: Vec<FieldDef>| FrameTemplate {
            id: id.into(),
            name: name.into(),
            color: "#888".into(),
            enabled: true,
            boundary,
            checksum,
            fields,
        };
        let resp_boundary = |fc: u8, scale: Option<f64>| Boundary {
            mode: "lengthField".into(),
            header_bytes: vec![0x00, fc],
            header_mask: Some(vec![0x00, 0xff]),
            length_offset: Some(2),
            length_size: Some(1),
            length_endian: Some("big".into()),
            length_adjust: Some(5),
            length_scale: scale,
            max_length: Some(280),
            ..Default::default()
        };
        let req_boundary = |fc: u8| Boundary {
            mode: "fixedLength".into(),
            header_bytes: vec![0x00, fc],
            header_mask: Some(vec![0x00, 0xff]),
            fixed_length: Some(8),
            max_length: Some(64),
            ..Default::default()
        };
        ParseRules {
            templates: vec![
                tpl(
                    "resp3",
                    "读保持寄存器响应",
                    resp_boundary(0x03, None),
                    crc(),
                    vec![fld("r0", "温度", "data", 3, "int16", "big")],
                ),
                tpl(
                    "resp1",
                    "读线圈响应",
                    resp_boundary(0x01, Some(0.125)),
                    crc(),
                    vec![fld("c0", "线圈字节", "data", 3, "uint8", "little")],
                ),
                tpl("req3", "读请求3", req_boundary(0x03), crc(), vec![]),
                tpl("req1", "读请求1", req_boundary(0x01), crc(), vec![]),
                tpl(
                    "ex",
                    "异常响应",
                    Boundary {
                        mode: "fixedLength".into(),
                        header_bytes: vec![0x00, 0x80],
                        header_mask: Some(vec![0x00, 0x80]),
                        fixed_length: Some(5),
                        max_length: Some(64),
                        ..Default::default()
                    },
                    crc(),
                    vec![fld("e0", "异常码", "data", 2, "uint8", "big")],
                ),
            ],
        }
    }

    #[test]
    fn modbus_demo_stream_decodes() {
        // 复刻主循环的节律：tick % 4 == 0 的那一拍才发一轮轮询
        let rounds = 50usize;
        let mut stream = Vec::new();
        for i in 0..rounds {
            stream.extend(modbus_poll((i * 4) as u64));
        }

        let mut eng = ParserEngine::new();
        eng.set_rules(rtu_rules()).unwrap();
        let rows = eng.feed(&stream, 0, 100);
        let count = |id: &str, valid: bool| {
            rows.iter()
                .filter(|r| r.tpl_id == id && r.valid == valid)
                .count()
        };

        // 每轮一发一答：请求各 50；响应扣掉 2 个异常轮与 2 个坏 CRC 轮
        assert_eq!(count("req3", true), rounds, "每轮都应解出读请求");
        assert_eq!(count("req1", true), rounds, "每轮都应解出线圈读请求");
        assert_eq!(count("resp1", true), rounds, "线圈响应应按位数换算字节数全部解出");
        assert_eq!(count("ex", true), 2, "每 23 拍一次的异常响应应被 bit7 掩码识别");
        let resp_bad = count("resp3", false);
        assert!(
            (1..=3).contains(&resp_bad),
            "被篡改 CRC 的响应应记为坏帧（实测 {resp_bad} 条）"
        );
        assert_eq!(
            count("resp3", true),
            rounds - 2 - resp_bad,
            "其余读响应都应正常解出"
        );

        // 数值合理性：温度在 250±80（0.1℃ 原始值 170..330），且不得出现错帧串值
        for r in rows.iter().filter(|r| r.tpl_id == "resp3" && r.valid) {
            let t = r.fields.iter().find(|f| f.id == "r0").unwrap().raw;
            assert!((169.0..=331.0).contains(&t), "温度原始值应在正弦包络内: {t}");
        }
    }

    #[test]
    fn modbus_frames_carry_valid_crc_by_construction() {
        // 兜住生成器本身的回归：除刻意破坏的那一拍，所有帧 CRC 都必须自洽
        for i in 0..30u64 {
            let tick = i * 4;
            let bytes = modbus_poll(tick);
            let skip_corrupt = tick % 29 == 3;
            let mut pos = 0usize;
            let mut frames = 0usize;
            while pos < bytes.len() {
                let addr = bytes[pos];
                let fc = bytes[pos + 1];
                let len = match fc {
                    0x03 if bytes[pos + 2] == 8 => 13,
                    0x03 => 8,
                    0x01 if bytes[pos + 2] == 0 => 8,
                    0x01 => 7,
                    0x83 => 5,
                    other => panic!("未知功能码 {other:02X} @ {pos}"),
                };
                let frame = &bytes[pos..pos + len];
                assert_eq!(frame[0], addr);
                let crc = crc16_modbus(&frame[..len - 2]).to_le_bytes();
                if skip_corrupt && fc == 0x03 && len == 13 {
                    assert_ne!(
                        &frame[len - 2..],
                        &crc,
                        "破坏帧应确实失去校验（否则测不到坏帧路径）"
                    );
                } else {
                    assert_eq!(&frame[len - 2..], &crc, "帧 {frames} @tick {tick} CRC 应自洽");
                }
                pos += len;
                frames += 1;
            }
            assert_eq!(pos, bytes.len(), "帧长划分应恰好覆盖整段");
        }
    }
}
