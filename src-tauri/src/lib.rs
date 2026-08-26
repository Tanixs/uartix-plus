mod demo;
mod files;
mod parser;
mod pipeline;
mod ring;
mod serial;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(serial::SerialManager::new())
        .invoke_handler(tauri::generate_handler![
            serial::list_ports,
            serial::open_port,
            serial::close_port,
            serial::send_data,
            serial::start_record,
            serial::stop_record,
            pipeline::parser_set_rules,
            pipeline::hex_fetch,
            demo::demo_start,
            demo::demo_stop,
            demo::demo_running,
            files::save_text_file,
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
