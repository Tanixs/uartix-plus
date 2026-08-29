use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, State};

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

        ingest(&ctx, &app, &out);
        tick += 1;
        thread::sleep(Duration::from_millis(100));
    }
}

#[tauri::command]
pub fn demo_start(app: AppHandle, state: State<SerialManager>) -> Result<(), String> {
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
