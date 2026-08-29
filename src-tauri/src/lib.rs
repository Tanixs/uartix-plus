mod demo;
mod files;
mod net;
mod parser;
mod pipeline;
mod ring;
mod serial;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .unwrap_or_default()
        .is_empty()
    {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=msWebView2DragDropGlobalApiEnabled --disable-gpu-compositing",
        );
    }
    let serial_mgr = serial::SerialManager::new();
    let net_mgr = net::NetManager::new(serial_mgr.ctx.clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(serial_mgr)
        .manage(net_mgr)
        .invoke_handler(tauri::generate_handler![
            serial::list_ports,
            serial::open_port,
            serial::close_port,
            serial::send_data,
            serial::start_record,
            serial::stop_record,
            net::open_net,
            net::close_net,
            pipeline::parser_set_rules,
            pipeline::hex_fetch,
            pipeline::hex_clear,
            demo::demo_start,
            demo::demo_stop,
            demo::demo_running,
            files::save_text_file,
            files::read_text_file,
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
