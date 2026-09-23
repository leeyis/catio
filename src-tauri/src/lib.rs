pub mod ssh;
pub mod agent;
pub mod db;
pub mod server;
pub mod server_mcp;
pub mod server_ws;
pub mod auth;
pub mod secrets;
pub mod events;
pub mod mcp;
pub mod netmatch;
pub mod scan;
pub mod localterm;
pub mod vnc;
pub mod vncconn;
pub mod rdp;
pub mod diagnostics;
pub mod runtime_diagnostics;
pub mod optical;
pub mod installation;

use ssh::manager::SessionManager;
use db::manager::ConnManager;

#[cfg(desktop)]
const TRAY_SHOW_WINDOW_ID: &str = "show-window";
#[cfg(desktop)]
const TRAY_QUIT_ID: &str = "quit";
#[cfg(desktop)]
const TRAY_LOGS_ID: &str = "diagnostic-logs";
#[cfg(desktop)]
const TRAY_RELOAD_ID: &str = "reload-window";
#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(desktop)]
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        runtime_diagnostics::record("window-restore-request", serde_json::json!({
            "visible": window.is_visible().ok(), "minimized": window.is_minimized().ok()
        }));
        runtime_diagnostics::record_result("window-show", &window.show());
        runtime_diagnostics::record_result("window-unminimize", &window.unminimize());
        runtime_diagnostics::record_result("window-focus", &window.set_focus());
        runtime_diagnostics::record("window-restore-complete", serde_json::json!({
            "visible": window.is_visible().ok(), "minimized": window.is_minimized().ok(),
            "position": window.outer_position().ok().map(|p| (p.x, p.y)),
            "size": window.outer_size().ok().map(|s| (s.width, s.height))
        }));
    } else {
        runtime_diagnostics::record("window-missing", serde_json::json!({}));
    }
}

#[cfg(desktop)]
fn setup_system_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };

    let show_window = MenuItem::with_id(app, TRAY_SHOW_WINDOW_ID, "显示窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT_ID, "退出", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, TRAY_LOGS_ID, "打开诊断日志 / Diagnostic logs", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, TRAY_RELOAD_ID, "重新加载界面 / Reload UI", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_window, &reload, &logs, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Catio")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_SHOW_WINDOW_ID => show_main_window(app),
            TRAY_LOGS_ID => {
                let result = runtime_diagnostics::diagnostics_open_dir(app.clone());
                runtime_diagnostics::record_result("open-diagnostic-directory", &result);
            }
            TRAY_RELOAD_ID => {
                use tauri::Manager;
                show_main_window(app);
                if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                    runtime_diagnostics::record_result("window-reload", &window.reload());
                }
            }
            TRAY_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }) {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    runtime_diagnostics::init(&context.config().identifier);
    match tauri::webview_version() {
        Ok(version) => runtime_diagnostics::record("webview-runtime", serde_json::json!({"version": version})),
        Err(error) => runtime_diagnostics::record_result("webview-runtime", &Err::<(), _>(error)),
    }
    // WebKitGTK's DMABUF renderer can produce a blank WebView on some Linux
    // setups, notably NVIDIA proprietary drivers and virtual displays.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let local_workspaces = std::sync::Arc::new(agent::local_files::LocalWorkspaces::default());
    let app = tauri::Builder::default()
        .append_invoke_initialization_script(include_str!("diagnostics-bootstrap.js"))
        .on_page_load(|_webview, payload| {
            // Do not record URLs: navigation can contain credentials/query data.
            runtime_diagnostics::record("page-load", serde_json::json!({"phase": format!("{:?}", payload.event())}));
        })
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(SessionManager::default())
        .manage(ConnManager::default())
        .manage(agent::AgentRuntime::production().with_local_workspaces(local_workspaces.clone()))
        .manage(local_workspaces)
        .manage(mcp::McpState::default())
        .manage(scan::ScanState::default())
        .manage(db::SqlFileState::default())
        .manage(localterm::LocalTermManager::default())
        .manage(vncconn::VncManager::default())
        .invoke_handler(tauri::generate_handler![
            agent::local_files::agent_set_workspace,
            optical::optical_status,
            installation::installation_settings,
            optical::optical_unlock,
            optical::optical_lock,
            optical::optical_check,
            optical::optical_cancel,
            optical::optical_read,
            ssh::conn::ssh_connect,
            ssh::conn::ssh_disconnect,
            ssh::conn::ssh_trust_host,
            ssh::conn::ssh_test,
            ssh::import::import_ssh_config,
            ssh::term::term_open,
            ssh::term::term_write,
            ssh::term::term_resize,
            ssh::term::term_close,
            ssh::sftp::sftp_list,
            ssh::sftp::sftp_realpath,
            ssh::sftp::sftp_download,
            ssh::sftp::sftp_upload,
            ssh::sftp::sftp_transfer_cancel,
            ssh::sftp::sftp_mkdir,
            ssh::sftp::sftp_rename,
            ssh::sftp::sftp_delete,
            ssh::sftp::sftp_touch,
            ssh::sftp::sftp_read_file,
            ssh::sftp::sftp_write_file,
            localterm::term_open_local,
            localterm::term_open_mosh,
            localterm::term_open_serial,
            localterm::term_open_telnet,
            localterm::serial_list_ports,
            localterm::term_local_ready,
            localterm::term_local_write,
            localterm::term_local_resize,
            localterm::term_local_close,
            vncconn::vnc_connect,
            vncconn::vnc_pointer,
            vncconn::vnc_key,
            vncconn::vnc_close,
            rdp::rdp_launch,
            ssh::tunnel::tunnel_defaults,
            ssh::tunnel::tunnel_open,
            ssh::tunnel::tunnel_close,
            ssh::tunnel::tunnel_list,
            ssh::monitor::monitor_start,
            ssh::monitor::monitor_stop,
            ssh::monitor::ssh_sysinfo,
            ssh::monitor::ssh_detect_os,
            ssh::multiexec::multiexec_run,
            db::commands::db_connect,
            db::commands::db_test_connection,
            db::commands::db_disconnect,
            db::commands::db_query,
            db::commands::db_schema,
            db::commands::db_schema_columns,
            db::commands::db_schema_functions,
            db::commands::db_table_structure,
            db::commands::db_object_source,
            db::commands::db_er_model,
            db::commands::db_keyspace_info,
            db::commands::db_redis_edit,
            db::commands::db_preview_dml,
            db::commands::db_apply_edits,
            db::commands::db_exec_batch,
            db::commands::db_drop_object,
            db::commands::db_drop_table_child_object,
            db::commands::db_rename_object,
            db::commands::db_truncate_table,
            db::commands::db_duplicate_table_structure,
            db::commands::db_save_object_source,
            db::commands::db_query_page,
            db::commands::db_table_preview,
            db::commands::db_table_query,
            db::commands::db_explain,
            db::commands::db_history,
            db::commands::db_clear_history,
            db::commands::db_delete_history,
            db::commands::db_delete_history_for_profile,
            db::commands::db_snippets,
            db::commands::db_save_snippet,
            db::commands::export_file,
            db::commands::db_export_xlsx,
            db::commands::db_export_database,
            db::commands::db_import_preview,
            db::commands::db_import_table,
            db::commands::db_transfer_table,
            db::commands::db_sql_file_preview,
            db::commands::db_run_sql_file,
            db::commands::db_cancel_sql_file,
            db::commands::jdbc_driver_status,
            db::commands::jdbc_download_driver,
            db::commands::jdbc_import_driver,
            db::commands::jdbc_open_drivers_dir,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_sync_targets,
            mcp::mcp_set_whitelist,
            mcp::mcp_recent_logs,
            mcp::mcp_live_log_subscribe,
            mcp::mcp_live_log_unsubscribe,
            mcp::mcp_token_refresh,
            scan::commands::scan_start,
            scan::commands::scan_cancel,
            scan::commands::scan_read_text_file,
            diagnostics::diagnostics_log,
            diagnostics::diagnostics_log_dir,
            runtime_diagnostics::diagnostics_runtime_log,
            runtime_diagnostics::diagnostics_open_dir,
            agent::commands::agent_start_turn,
            agent::commands::agent_respond,
            agent::commands::agent_cancel
        ])
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if window.label() == MAIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    runtime_diagnostics::record("window-close-to-tray", serde_json::json!({}));
                    api.prevent_close();
                    runtime_diagnostics::record_result("window-hide", &window.hide());
                } else if matches!(event, tauri::WindowEvent::Destroyed) {
                    runtime_diagnostics::record("window-destroyed", serde_json::json!({}));
                }
            }
        })
        .setup(|app| {
            use tauri::Manager;
            runtime_diagnostics::record("setup-start", serde_json::json!({}));
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                runtime_diagnostics::attach_webview_diagnostics(&window);
            }
            app.manage(optical::OpticalState::from_installation(app.path().app_data_dir()?.join("optical.hash")));
            app.manage(installation::InstallationSettings::from_installation());
            // Default the JDBC sidecar's driver-JAR directory to
            // <app_data>/jdbc/drivers (created if missing) unless the user
            // overrode CATIO_JDBC_DRIVERS_DIR. JDBC engines load their
            // user-supplied driver JARs from here; this realises the documented
            // default so packaged installs work without manual env setup.
            if std::env::var_os("CATIO_JDBC_DRIVERS_DIR").is_none() {
                use tauri::Manager;
                if let Ok(dir) = app.path().app_data_dir() {
                    let drivers = dir.join("jdbc").join("drivers");
                    let _ = std::fs::create_dir_all(&drivers);
                    std::env::set_var("CATIO_JDBC_DRIVERS_DIR", drivers);
                }
            }
            // 把打包进资源目录的 sidecar 插件 jar 暴露给 plugin_jar_path()
            // （它优先读取 CATIO_JDBC_PLUGIN_JAR）。开发态该资源不存在时无副作用，
            // 仍走 CARGO_MANIFEST_DIR 下的构建产物回退。
            if std::env::var_os("CATIO_JDBC_PLUGIN_JAR").is_none() {
                use tauri::Manager;
                use tauri::path::BaseDirectory;
                if let Ok(jar) = app.path().resolve("catio-jdbc-plugin.jar", BaseDirectory::Resource) {
                    // 仅当资源 jar 存在且非空才注入——避免 0 字节占位/损坏 jar 让运行时
                    // 报模糊的 Java 错误，而不是清晰的"jar not found"。
                    let usable = std::fs::metadata(&jar).map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
                    if usable {
                        std::env::set_var("CATIO_JDBC_PLUGIN_JAR", jar);
                    }
                }
            }
            #[cfg(desktop)]
            setup_system_tray(app)?;
            runtime_diagnostics::record("setup-complete", serde_json::json!({}));
            Ok(())
        })
        .build(context);

    let app = match app {
        Ok(app) => app,
        Err(error) => {
            runtime_diagnostics::record_result("application-build-failed", &Err::<(), _>(error));
            std::process::exit(1);
        }
    };

    app.run(|_app, _event| {
        match &_event {
            tauri::RunEvent::Ready => {
                runtime_diagnostics::record("application-ready", serde_json::json!({}));
                let handle = _app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                    if !runtime_diagnostics::frontend_ready() {
                        use tauri::Manager;
                        let window = handle.get_webview_window("main");
                        runtime_diagnostics::record("frontend-ready-timeout", serde_json::json!({
                            "windowExists": window.is_some(),
                            "visible": window.as_ref().and_then(|w| w.is_visible().ok()),
                            "minimized": window.as_ref().and_then(|w| w.is_minimized().ok())
                        }));
                    }
                });
            }
            tauri::RunEvent::ExitRequested { code, .. } => runtime_diagnostics::record("exit-requested", serde_json::json!({"code": code})),
            tauri::RunEvent::Exit => runtime_diagnostics::record("process-exit", serde_json::json!({})),
            _ => {}
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = _event
        {
            show_main_window(_app);
        }
    });
}
