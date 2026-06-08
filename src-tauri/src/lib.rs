pub mod ssh;
pub mod db;

use ssh::manager::SessionManager;
use db::manager::ConnManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SessionManager::default())
        .manage(ConnManager::default())
        .invoke_handler(tauri::generate_handler![
            ssh::conn::ssh_connect,
            ssh::conn::ssh_disconnect,
            ssh::conn::ssh_trust_host,
            ssh::conn::ssh_test,
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
            db::commands::db_snippets,
            db::commands::db_save_snippet
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
