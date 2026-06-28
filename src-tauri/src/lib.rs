pub mod ssh;
pub mod db;
pub mod mcp;
pub mod scan;
pub mod localterm;
pub mod vnc;
pub mod vncconn;
pub mod rdp;

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
        .manage(scan::ScanState::default())
        .manage(db::SqlFileState::default())
        .manage(localterm::LocalTermManager::default())
        .manage(vncconn::VncManager::default())
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
            scan::commands::scan_start,
            scan::commands::scan_cancel,
            scan::commands::scan_read_text_file
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
