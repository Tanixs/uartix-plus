mod ai;
mod ble;
mod b64;
mod busevt;
mod demo;
mod files;
mod net;
mod parser;
mod pipeline;
mod ring;
mod serial;
mod session;
mod xfer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // panic 日志：崩溃排查用（写入系统临时目录，追加模式）
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join("uartix-plus-panic.log");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[ts={ts}ms] PANIC: {info}");
            let _ = writeln!(
                f,
                "[ts={ts}ms] thread={:?} loc={:?}",
                std::thread::current().name(),
                info.location()
            );
        }
    }));
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .unwrap_or_default()
        .is_empty()
    {
        // 注意：不再加 --disable-gpu-compositing（P6 为修白闪曾加）——它会把
        // WebView2 整页合成压到 CPU 上，长时间高频重绘时 CPU 打满、界面卡死。
        // 白闪改由窗口 backgroundColor（tauri.conf.json）缓解；若白闪复现再评估。
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebView2DragDropGlobalApiEnabled",
        );
    }
    let serial_mgr = serial::SerialManager::new();
    let net_mgr = net::NetManager::new(serial_mgr.ctx.clone());
    let ble_mgr = ble::BleManager::new(serial_mgr.ctx.clone());
    // 传输队列与 serial_mgr.ctx.xfer 同一实例（ingest tap / 发送任务共享）
    let xfer_mgr = serial_mgr.ctx.xfer.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(serial_mgr)
        .manage(net_mgr)
        .manage(ble_mgr)
        .manage(xfer_mgr)
        .manage(busevt::BinBus::default())
        .manage(ai::AiState::default())
        .manage(session::SessionState::default())
        .invoke_handler(tauri::generate_handler![
            busevt::ipc_subscribe,
            ai::ai_chat,
            ai::ai_abort,
            ai::ai_upload_report,
            serial::list_ports,
            serial::open_port,
            serial::close_port,
            serial::send_data,
            serial::start_record,
            serial::stop_record,
            net::open_net,
            net::close_net,
            ble::ble_scan_start,
            ble::ble_scan_stop,
            ble::ble_connect,
            ble::ble_disconnect,
            xfer::xfer_start,
            xfer::xfer_abort,
            pipeline::parser_set_rules,
            pipeline::hex_fetch,
            pipeline::hex_clear,
            demo::demo_start,
            demo::demo_stop,
            demo::demo_running,
            session::session_start_record,
            session::session_stop_record,
            session::session_save,
            session::session_open,
            session::session_discard,
            session::session_play,
            session::session_seek,
            session::session_pause,
            session::session_resume,
            session::session_stop,
            session::session_annotate,
            session::session_annotations,
            session::session_bridge_start,
            session::session_bridge_stop,
            session::session_status,
            files::save_text_file,
            files::read_text_file,
            files::read_binary_file,
            files::list_local_addrs,
            files::save_binary_file,
            files::hex_search
        ])
        .setup(|app| {
            serial::start_hotplug(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
