pub mod ssh;
pub mod db;

use ssh::manager::SessionManager;
use db::manager::ConnManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(SessionManager::default())
        .manage(ConnManager::default())
        .invoke_handler(tauri::generate_handler![
            ssh::conn::ssh_connect,
            ssh::conn::ssh_disconnect,
            ssh::conn::ssh_trust_host,
            ssh::term::term_open,
            ssh::term::term_write,
            ssh::term::term_resize,
            ssh::term::term_close,
            ssh::sftp::sftp_list,
            db::commands::db_connect,
            db::commands::db_disconnect,
            db::commands::db_query,
            db::commands::db_schema,
            db::commands::db_table_structure,
            db::commands::db_er_model
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
