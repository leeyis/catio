pub mod ssh;
pub mod db;
pub mod mcp;

use ssh::manager::SessionManager;
use db::manager::ConnManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(ConnManager::default())
        .manage(mcp::McpState::default())
        .invoke_handler(tauri::generate_handler![
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
            db::commands::db_preview_dml,
            db::commands::db_apply_edits,
            db::commands::db_query_page,
            db::commands::db_table_preview,
            db::commands::db_history,
            db::commands::db_clear_history,
            db::commands::db_delete_history,
            db::commands::db_snippets,
            db::commands::db_save_snippet,
            db::commands::export_file,
            db::commands::jdbc_driver_status,
            db::commands::jdbc_download_driver,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_sync_targets
        ])
        .setup(|app| {
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
