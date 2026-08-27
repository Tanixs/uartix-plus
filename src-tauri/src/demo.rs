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

fn build_v7_euler(tick: u64) -> Vec<u8> {
    let rol = ((3000.0f32) * ((tick as f32) * 0.05).sin()) as i16;
    let pit = ((3000.0f32) * ((tick as f32) * 0.083).cos()) as i16;
    let yaw = ((18000.0f32) * ((tick as f32) * 0.031).sin()) as i16;
    let mut f: Vec<u8> = vec![0xAA, 0xFF, 0x03, 0x07];
    f.extend_from_slice(&rol.to_le_bytes());
    f.extend_from_slice(&pit.to_le_bytes());
    f.extend_from_slice(&yaw.to_le_bytes());
    f.push(((tick / 5) % 4) as u8);
    let sc = sumadd(&f);
    f.push(sc);
    f.push(sc.wrapping_add(0xAA));
    f
}

fn build_v7_gps(tick: u64) -> Vec<u8> {
    let lng = (116391280i32 + 300 * ((tick as f32) * 0.01).sin() as i32).to_le_bytes();
    let lat = (399112340i32 + 200 * ((tick as f32) * 0.013).cos() as i32).to_le_bytes();
    let alt = (5200i32 + 30 * ((tick as f32) * 0.05).sin() as i32).to_le_bytes();
    let nsp = ((120.0f32 * (tick as f32 * 0.07).sin()) as i16).to_le_bytes();
    let esp = ((90.0f32 * (tick as f32 * 0.06).cos()) as i16).to_le_bytes();
    let mut f: Vec<u8> = vec![0xAA, 0xFF, 0x30, 0x17, 2, 18];
    f.extend_from_slice(&lng);
    f.extend_from_slice(&lat);
    f.extend_from_slice(&alt);
    f.extend_from_slice(&nsp);
    f.extend_from_slice(&esp);
    f.extend_from_slice(&0i16.to_le_bytes());
    f.push(12);
    f.push(30);
    f.push(25);
    let sc = sumadd(&f);
    f.push(sc);
    f.push(sc.wrapping_add(0xAA));
    f
}

fn demo_loop(app: AppHandle, ctx: Arc<IngestCtx>, flag: Arc<AtomicBool>) {
    let mut seq_a: u16 = 0;
    let mut seq_b: u16 = 0;
    let mut tick: u64 = 0;
    while flag.load(Ordering::SeqCst) {
        let mut out: Vec<u8> = Vec::with_capacity(96);

        let temp = 25.0f32 + 5.0 * ((tick as f32) * 0.1).sin();
        let hum = 40.0f32 + 10.0 * ((tick as f32) * 0.05).cos();
        let mut a: Vec<u8> = vec![0xAA, 0x55, 11];
        a.extend_from_slice(&seq_a.to_le_bytes());
        a.extend_from_slice(&temp.to_le_bytes());
        a.extend_from_slice(&hum.to_le_bytes());
        let sum = a.iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
        a.push(sum);
        if tick % 19 == 7 {
            let idx = 4 + (tick % 5) as usize;
            a[idx] ^= 0xFF;
        }
        out.extend_from_slice(&a);
        seq_a = seq_a.wrapping_add(1);

        if tick % 2 == 1 {
            let mut b: Vec<u8> = vec![0xBB, 0x66];
            b.extend_from_slice(&seq_b.to_be_bytes());
            let roll = (300.0f32 * ((tick as f32) * 0.07).sin()) as i16;
            let pitch = (300.0f32 * ((tick as f32) * 0.11).cos()) as i16;
            let yaw = (1800.0f32 * ((tick as f32) * 0.03).sin()) as i16;
            b.extend_from_slice(&roll.to_be_bytes());
            b.extend_from_slice(&pitch.to_be_bytes());
            b.extend_from_slice(&yaw.to_be_bytes());
            let crc = crc16_modbus(&b);
            b.extend_from_slice(&crc.to_le_bytes());
            if tick % 23 == 11 {
                let idx = 2 + (tick % 3) as usize;
                b[idx] ^= 0x55;
            }
            out.extend_from_slice(&b);
            seq_b = seq_b.wrapping_add(1);
        }

        if tick % 2 == 0 {
            let mut v = build_v7_euler(tick);
            if tick % 29 == 3 {
                let idx = 2 + (tick % 4) as usize;
                v[idx] ^= 0x77;
            }
            out.extend_from_slice(&v);
        } else {
            let mut g = build_v7_gps(tick);
            if tick % 31 == 5 {
                let idx = 4 + (tick % 6) as usize;
                g[idx] ^= 0x81;
            }
            out.extend_from_slice(&g);
        }

        if tick % 5 == 2 {
            let a = 10.0f32 * (tick as f32 * 0.09).sin();
            let b = -5.0f32 + 2.0 * (tick as f32 * 0.04).cos();
            let txt = if tick % 3 == 2 {
                format!("{a:.2},{b:.2},7.25\n")
            } else {
                format!("{a:.2},{b:.2}\n")
            };
            out.extend_from_slice(txt.as_bytes());
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
