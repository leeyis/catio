//! Installation-owned preferences, read once at startup from catio.conf.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationSettings {
    pub show_repository: bool,
}

impl InstallationSettings {
    pub fn from_installation() -> Self {
        Self::from_path(&installation_config_path())
    }

    fn from_path(path: &Path) -> Self {
        let config = std::fs::read_to_string(path).unwrap_or_default();
        Self { show_repository: config_flag(&config, "Show_repository") }
    }
}

#[tauri::command]
pub fn installation_settings(state: tauri::State<'_, InstallationSettings>) -> InstallationSettings {
    state.inner().clone()
}

// Missing, invalid or duplicate keys never opt an installation in.
pub(crate) fn config_flag(config: &str, name: &str) -> bool {
    if config.len() > 65536 { return false; }
    let mut value = None;
    for line in config.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
        let Some((key, setting)) = line.split_once('=') else { return false; };
        if key.trim() == name {
            if value.is_some() { return false; }
            value = Some(setting.trim() == "1");
        }
    }
    value == Some(true)
}

pub(crate) fn installation_config_path() -> PathBuf {
    // AppImage's executable lives in a temporary read-only mount.
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE") { return PathBuf::from(image).with_file_name("catio.conf"); }
    std::env::current_exe().map(config_for_executable).unwrap_or_default()
}

fn config_for_executable(executable: PathBuf) -> PathBuf {
    // Keep configuration outside signed macOS bundles.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = executable.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")) {
        return bundle.with_file_name("catio.conf");
    }
    executable.with_file_name("catio.conf")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repository_requires_explicit_valid_opt_in() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("catio.conf");
        assert!(!InstallationSettings::from_path(&path).show_repository);
        for config in ["", "Experiment_func=1", "Show_repository=0", "Show_repository=true",
            "Show_repository=1\nShow_repository=0", "Show_repository=1\nbroken"] {
            std::fs::write(&path, config).unwrap();
            assert!(!InstallationSettings::from_path(&path).show_repository, "{config}");
        }
        std::fs::write(&path, "\u{feff}# preferences\nExperiment_func=0\n Show_repository = 1 \n").unwrap();
        let settings = InstallationSettings::from_path(&path);
        assert!(settings.show_repository);
        assert_eq!(serde_json::to_value(&settings).unwrap()["showRepository"], true);
        std::fs::write(&path, "Show_repository=0").unwrap();
        assert!(settings.show_repository); // Existing startup snapshot is unchanged.
        assert!(!InstallationSettings::from_path(&path).show_repository);
        assert!(!InstallationSettings::from_path(tmp.path()).show_repository);
    }
}
