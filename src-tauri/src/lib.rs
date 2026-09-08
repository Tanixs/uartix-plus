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

#[cfg(debug_assertions)]
fn glog(msg: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("uartix-dev-guide.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

/// HTTP 判据：TCP 握手可被本地代理假建立，vite 的 HTTP 响应无法伪造
#[cfg(debug_assertions)]
fn dev_server_alive(host: &str, port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;
    let Some(addr) = (host, port).to_socket_addrs().ok().and_then(|mut i| i.next()) else {
        return false;
    };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(1200)) else {
        return false;
    };
    let _ = s.set_write_timeout(Some(Duration::from_millis(1200)));
    let _ = s.set_read_timeout(Some(Duration::from_millis(1800)));
    let req = format!("GET / HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    match s.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/"),
        Err(_) => false,
    }
}

#[cfg(debug_assertions)]
fn guide_html(host: &str, port: u16) -> String {
    format!(
        "<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>Uartix+ 开发模式</title>\
         <style>body{{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;\
         font-family:system-ui;background:#f5f6f8;color:#24292f}}.c{{max-width:520px;padding:32px;\
         background:#fff;border:1px solid #d0d7de;border-radius:10px}}h1{{font-size:18px;margin:0 0 12px}}\
         p{{font-size:13px;line-height:1.7;margin:8px 0}}code{{background:#eff2f5;border-radius:4px;\
         padding:2px 6px;font-family:Cascadia Mono,Consolas,monospace;font-size:12.5px}}\
         .tip{{font-size:12px;color:#57606a;border-top:1px solid #d0d7de;margin-top:16px;padding-top:12px}}\
         .x{{position:fixed;top:12px;right:12px;width:34px;height:34px;border-radius:8px;border:1px solid #d0d7de;\
         background:#fff;color:#24292f;font-size:18px;line-height:1;cursor:pointer}}\
         .x:hover{{background:#f0f1f3;border-color:#b6bec6}}</style></head>\
         <body><button class=x title=关闭窗口 \
         onclick=\"window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke('plugin:window|close')\">×</button>\
         <div class=c><h1>Uartix+ 开发模式：前端未就绪</h1>\
         <p>本窗口是 <b>debug 构建</b>，页面来自开发服务器 <code>{host}:{port}</code>，当前它没有运行——\
         <b>这不是程序卡死</b>。</p>\
         <p>请在项目目录运行：<code>npm run tauri dev</code></p>\
         <p class=tip>若需要可双击运行的版本，请执行 npm run tauri build 后到 target\\release 获取。</p>\
         </div></body></html>"
    )
}

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
            files::export_xlsx,
            files::hex_search
        ])
        .setup(|app| {
            serial::start_hotplug(app.handle().clone());
            #[cfg(debug_assertions)]
            {
                // debug 版页面来自 devUrl——vite 未启动时白屏极易被误判为"卡死"，
                // 后台探测一次端口，不通则把主窗口导航到内嵌引导页（release 编译期整段剔除）
                let handle = app.handle().clone();
                let dev_url = app.config().build.dev_url.clone();
                std::thread::spawn(move || {
                    use std::time::Duration;
                    let Some(url) = dev_url else {
                        glog("dev_url 为空，跳过");
                        return;
                    };
                    let host = url.host_str().unwrap_or("127.0.0.1");
                    let host = if host == "localhost" { "127.0.0.1" } else { host };
                    let port = url.port_or_known_default().unwrap_or(1420);
                    glog(&format!("探测 {host}:{port} …"));
                    if dev_server_alive(host, port) {
                        glog("dev server 存活，无需引导");
                        return;
                    }
                    glog("dev server 未响应 HTTP，进入引导流程");
                    let html_path = std::env::temp_dir().join("uartix-dev-guide.html");
                    if let Err(e) = std::fs::write(&html_path, guide_html(host, port)) {
                        glog(&format!("写引导页失败: {e}"));
                        return;
                    }
                    let Some(guide) = tauri::Url::from_file_path(&html_path).ok() else {
                        glog(&format!("file url 构造失败: {html_path:?}"));
                        return;
                    };
                    use tauri::Manager;
                    for delay_ms in [0u64, 1500] {
                        std::thread::sleep(Duration::from_millis(delay_ms));
                        let Some(w) = handle.get_webview_window("main") else {
                            glog("找不到 main 窗口");
                            return;
                        };
                        match w.navigate(guide.clone()) {
                            Ok(()) => glog(&format!("navigate #{delay_ms}ms ok, url={}", w.url().map(|u| u.to_string()).unwrap_or_default())),
                            Err(e) => glog(&format!("navigate #{delay_ms}ms 失败: {e}")),
                        }
                    }
                    let h2 = handle.clone();
                    let u2 = guide.clone();
                    let _ = handle.run_on_main_thread(move || {
                        use tauri::WebviewWindowBuilder;
                        let r = WebviewWindowBuilder::new(
                            &h2,
                            "dev-guide",
                            tauri::WebviewUrl::External(u2),
                        )
                        .title("Uartix+ 开发模式：前端未就绪")
                        .inner_size(580.0, 400.0)
                        .resizable(false)
                        .always_on_top(true)
                        .center()
                        .build();
                        glog(&match r {
                            Ok(_) => "引导小窗已创建".into(),
                            Err(e) => format!("引导小窗创建失败: {e}"),
                        });
                    });
                    use tauri_plugin_dialog::DialogExt;
                    handle
                        .dialog()
                        .message(format!(
                            "开发模式：前端 dev server ({host}:{port}) 未启动，页面无法加载。\n\
                             请在项目目录运行 npm run tauri dev 后再使用本窗口。"
                        ))
                        .show(|_| {});
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
