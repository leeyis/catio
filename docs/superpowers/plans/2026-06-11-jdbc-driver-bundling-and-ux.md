# JDBC 插件打包与驱动管理体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 JDBC 在打包应用里真正可用（把 sidecar 插件 jar 打进安装包），并让用户能一键下载达梦/金仓驱动、手动导入驱动 JAR、看清驱动目录位置。

**Architecture:** Part 1 把 `catio-jdbc-plugin.jar` 通过 Tauri `bundle.resources` 打进安装包，启动时把其资源路径写入 `CATIO_JDBC_PLUGIN_JAR`（`plugin_jar_path()` 已优先读该 env）。Part 2 在 `download_spec`/`JDBC_DOWNLOADABLE` 注册达梦、金仓的 Maven 下载，并新增「打开驱动目录」「导入 JAR」两个 Tauri 命令 + 目录内 jar 列表，弹窗据此渲染。

**Tech Stack:** Rust / Tauri 2（`tauri-plugin-dialog` 已集成）、React + TypeScript、i18next、Maven（构建 sidecar jar）。

---

## File Structure

- `src-tauri/tauri.conf.json` — `beforeBuildCommand` 接入 `mvn package`；`bundle.resources` 声明 jar。
- `src-tauri/src/lib.rs` — 启动注入 `CATIO_JDBC_PLUGIN_JAR`；注册 2 个新命令。
- `src-tauri/src/db/drivers/jdbc.rs` — JVM 缺失报错文案。
- `src-tauri/src/db/drivers/jdbc_config.rs` — `download_spec` 增加 dameng/kingbase + 测试更新。
- `src-tauri/src/db/commands.rs` — `JdbcDriverStatus.jars`、`jdbc_status` 枚举 jar；新增 `jdbc_open_drivers_dir`、`jdbc_import_driver`。
- `src/services/jdbcDrivers.ts` — `JDBC_DOWNLOADABLE` 增项、`jars` 字段、`openJdbcDriversDir`、`importJdbcDriver` 封装。
- `src/components/modals/NewConnectionModal.tsx` — 驱动目录路径、打开目录、选择 JAR、jar 列表。
- `src/i18n/zh.json` / `src/i18n/en.json` — 新文案。
- `src/components/modals/NewConnectionModal.test.tsx` — 达梦改下载态、手动引擎改 Cassandra、导入交互。

---

## Task 1: 达梦/金仓加入一键下载（Rust）

**Files:**
- Modify: `src-tauri/src/db/drivers/jdbc_config.rs:101-125`（`download_spec`）
- Test: `src-tauri/src/db/drivers/jdbc_config.rs`（同文件 `#[cfg(test)] mod tests`）

- [ ] **Step 1: 更新失败测试**

把 `proprietary_engines_have_no_download` 里的 `dameng`、`kingbase`（注意：当前数组里没有 kingbase，但加了下载后需保证它有下载）调整，并新增达梦/金仓下载断言。替换 `jdbc_config.rs` 中 `proprietary_engines_have_no_download` 测试为：

```rust
    #[test]
    fn proprietary_engines_have_no_download() {
        // 仍无 Maven Central 自包含 jar 的引擎保持手动。
        for p in ["yashandb", "gbase8s", "xugu", "sundb", "bigquery", "access", "cassandra", "h2"] {
            assert!(download_spec(p).is_none(), "{p} should be manual");
        }
    }

    #[test]
    fn chinese_db_downloads_resolve_maven_central() {
        let dm = download_spec("dameng").unwrap();
        assert_eq!(dm.file_name, "DmJdbcDriver18-8.1.3.140.jar");
        assert_eq!(dm.url, "https://repo1.maven.org/maven2/com/dameng/DmJdbcDriver18/8.1.3.140/DmJdbcDriver18-8.1.3.140.jar");
        let kb = download_spec("kingbase").unwrap();
        assert_eq!(kb.file_name, "kingbase8-9.0.1.jar");
        assert_eq!(kb.url, "https://repo1.maven.org/maven2/cn/com/kingbase/kingbase8/9.0.1/kingbase8-9.0.1.jar");
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test --lib jdbc_config::tests::chinese_db_downloads_resolve_maven_central`
Expected: FAIL（`download_spec("dameng")` 返回 None → `unwrap` panic）

- [ ] **Step 3: 在 `download_spec` 增加两条 match 分支**

在 `jdbc_config.rs` 的 `download_spec` 的 `match profile` 中、`"kylin"` 行之后加入：

```rust
        "dameng"     => maven("com.dameng", "DmJdbcDriver18", "8.1.3.140", None),
        "kingbase"   => maven("cn.com.kingbase", "kingbase8", "9.0.1", None),
```

并把上方 doc 注释里 “dameng/yashandb/...” 一行的 `dameng` 去掉（达梦不再属于手动）：

```rust
        //   dameng/yashandb/gbase8s/xugu/sundb/bigquery/access (proprietary /
```
改为
```rust
        //   yashandb/gbase8s/xugu/sundb/bigquery/access (proprietary /
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib jdbc_config::tests`
Expected: PASS（含 `chinese_db_downloads_resolve_maven_central`、`proprietary_engines_have_no_download`、`download_spec_builds_maven_central_urls`）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/drivers/jdbc_config.rs
git commit -m "feat(db): 达梦/金仓 JDBC 驱动加入 Maven Central 一键下载"
```

---

## Task 2: 驱动状态增加目录内 jar 列表（Rust）

**Files:**
- Modify: `src-tauri/src/db/commands.rs:313-345`（`JdbcDriverStatus` 与 `jdbc_status`）
- Test: `src-tauri/src/db/commands.rs`（新增 `#[cfg(test)] mod` 或并入现有；本文件当前无测试模块，新增一个）

- [ ] **Step 1: 写失败测试**

在 `commands.rs` 末尾新增测试模块：

```rust
#[cfg(test)]
mod jdbc_status_tests {
    use super::{jdbc_status};
    use std::fs;

    #[test]
    fn lists_jars_present_in_dir() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("DmJdbcDriver18-8.1.3.62.jar"), b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        let s = jdbc_status("dameng", dir.path());
        assert_eq!(s.jars, vec!["DmJdbcDriver18-8.1.3.62.jar".to_string()]);
    }

    #[test]
    fn empty_dir_yields_no_jars() {
        let dir = tempfile::tempdir().unwrap();
        let s = jdbc_status("yashandb", dir.path());
        assert!(s.jars.is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test --lib jdbc_status_tests`
Expected: FAIL（`JdbcDriverStatus` 无 `jars` 字段 → 编译错误）

- [ ] **Step 3: 给 `JdbcDriverStatus` 加 `jars` 字段并在 `jdbc_status` 填充**

在 `commands.rs` 的 `JdbcDriverStatus` 结构末尾（`drivers_dir` 之后）加：

```rust
    /// 驱动目录下现有的全部 `*.jar` 文件名（让用户确认 jar 是否放对位置）。
    pub jars: Vec<String>,
```

在 `jdbc_status` 函数里，构造返回值前枚举 jar，并在返回结构里带上 `jars`：

```rust
fn jdbc_status(profile: &str, dir: &std::path::Path) -> JdbcDriverStatus {
    use crate::db::drivers::jdbc_config;
    let spec = jdbc_config::download_spec(profile);
    let (installed, file_name) = match &spec {
        Some(s) => (dir.join(&s.file_name).exists(), Some(s.file_name.clone())),
        None => (false, None),
    };
    let mut jars: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("jar")) == Some(true))
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    jars.sort();
    JdbcDriverStatus {
        profile: profile.to_string(),
        installed,
        file_name,
        downloadable: spec.is_some(),
        driver_class: jdbc_config::driver_class(profile),
        drivers_dir: dir.to_string_lossy().into_owned(),
        jars,
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib jdbc_status_tests`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/commands.rs
git commit -m "feat(db): JdbcDriverStatus 增加驱动目录内 jar 列表"
```

---

## Task 3: 导入 JAR 与打开目录命令（Rust）

**Files:**
- Modify: `src-tauri/src/db/commands.rs`（新增 `jdbc_import_driver`、`jdbc_open_drivers_dir`，及核心 `import_driver_to_dir`）
- Test: `src-tauri/src/db/commands.rs`（`jdbc_status_tests` 模块内补测试）

- [ ] **Step 1: 写失败测试**

在 `jdbc_status_tests` 模块内追加（用核心、AppHandle-free 的 `import_driver_to_dir`）：

```rust
    #[test]
    fn import_copies_jar_into_dir() {
        let src = tempfile::tempdir().unwrap();
        let jar = src.path().join("DmJdbcDriver18-8.1.3.62.jar");
        fs::write(&jar, b"JARBYTES").unwrap();
        let dst = tempfile::tempdir().unwrap();

        let status = super::import_driver_to_dir("dameng", &jar, dst.path()).unwrap();
        assert!(dst.path().join("DmJdbcDriver18-8.1.3.62.jar").exists());
        assert!(status.jars.contains(&"DmJdbcDriver18-8.1.3.62.jar".to_string()));
    }

    #[test]
    fn import_rejects_non_jar() {
        let src = tempfile::tempdir().unwrap();
        let txt = src.path().join("driver.txt");
        fs::write(&txt, b"x").unwrap();
        let dst = tempfile::tempdir().unwrap();
        assert!(super::import_driver_to_dir("dameng", &txt, dst.path()).is_err());
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test --lib jdbc_status_tests::import_copies_jar_into_dir`
Expected: FAIL（`import_driver_to_dir` 未定义 → 编译错误）

- [ ] **Step 3: 实现核心与命令**

在 `commands.rs` 的 `download_driver_to_dir` 函数之后加入：

```rust
/// 核心（AppHandle-free）驱动导入：把用户选中的 `src` jar 复制进驱动目录。
/// 非 `.jar` 后缀直接拒绝；同名覆盖（用户主动选择即视为意图替换）。
pub fn import_driver_to_dir(profile: &str, src: &std::path::Path, dir: &std::path::Path)
    -> Result<JdbcDriverStatus, DbError> {
    let is_jar = src.extension().and_then(|x| x.to_str())
        .map(|x| x.eq_ignore_ascii_case("jar")) == Some(true);
    if !is_jar {
        return Err(DbError::Unsupported("只能导入 .jar 驱动文件".into()));
    }
    let file_name = src.file_name()
        .ok_or_else(|| DbError::Io("无效的文件名".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| DbError::Io(e.to_string()))?;
    std::fs::copy(src, dir.join(file_name)).map_err(|e| DbError::Io(e.to_string()))?;
    Ok(jdbc_status(profile, dir))
}

/// 把用户选中的驱动 jar 复制进驱动目录，返回刷新后的状态。
#[tauri::command]
pub async fn jdbc_import_driver(profile: String, path: String, app: tauri::AppHandle)
    -> Result<JdbcDriverStatus, DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    import_driver_to_dir(&profile, std::path::Path::new(&path), &dir)
}

/// 在系统文件管理器中打开驱动目录（Windows explorer / macOS open / Linux xdg-open）。
#[tauri::command]
pub async fn jdbc_open_drivers_dir(app: tauri::AppHandle) -> Result<(), DbError> {
    let dir = jdbc_drivers_dir(&app)?;
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map_err(|e| DbError::Io(format!("打开驱动目录失败: {e}")))?;
    Ok(())
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test --lib jdbc_status_tests`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/db/commands.rs
git commit -m "feat(db): 新增 JDBC 驱动手动导入与打开驱动目录命令"
```

---

## Task 4: 注册新命令（Rust）

**Files:**
- Modify: `src-tauri/src/lib.rs:63-64`（`invoke_handler` 列表）

- [ ] **Step 1: 在 invoke_handler 注册两个命令**

把 `lib.rs` 中：

```rust
            db::commands::jdbc_driver_status,
            db::commands::jdbc_download_driver,
```

改为：

```rust
            db::commands::jdbc_driver_status,
            db::commands::jdbc_download_driver,
            db::commands::jdbc_import_driver,
            db::commands::jdbc_open_drivers_dir,
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo check`
Expected: 编译通过，无未注册命令告警。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(db): 注册 jdbc_import_driver / jdbc_open_drivers_dir 命令"
```

---

## Task 5: 打包 sidecar 插件 jar + 启动注入（Rust/构建）

**Files:**
- Modify: `src-tauri/tauri.conf.json:6-19`
- Modify: `src-tauri/src/lib.rs:70-84`（`.setup()`）

- [ ] **Step 1: 构建一次 jar，确认产物存在**

Run: `cd src-tauri/jdbc-plugin && mvn -q -DskipTests package`
Expected: 生成 `src-tauri/jdbc-plugin/target/catio-jdbc-plugin.jar`。

- [ ] **Step 2: tauri.conf.json 接入构建与资源**

把 `build.beforeBuildCommand`：

```json
    "beforeBuildCommand": "npm run build"
```

改为：

```json
    "beforeBuildCommand": "npm run build && mvn -q -DskipTests -f src-tauri/jdbc-plugin/pom.xml package"
```

把 `bundle` 行：

```json
  "bundle": { "active": true, "targets": "all", "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"] }
```

改为（新增 `resources`，把 jar 拍平到资源根）：

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "resources": { "jdbc-plugin/target/catio-jdbc-plugin.jar": "catio-jdbc-plugin.jar" }
  }
```

- [ ] **Step 3: lib.rs 启动注入 CATIO_JDBC_PLUGIN_JAR**

在 `lib.rs` 的 `.setup(|app| { ... })` 内，现有 drivers-dir 块之后、`Ok(())` 之前加入：

```rust
            // 把打包进资源目录的 sidecar 插件 jar 暴露给 plugin_jar_path()
            // （它优先读取 CATIO_JDBC_PLUGIN_JAR）。开发态该资源不存在时无副作用，
            // 仍走 CARGO_MANIFEST_DIR 下的构建产物回退。
            if std::env::var_os("CATIO_JDBC_PLUGIN_JAR").is_none() {
                use tauri::{Manager, path::BaseDirectory};
                if let Ok(jar) = app.path().resolve("catio-jdbc-plugin.jar", BaseDirectory::Resource) {
                    if jar.exists() {
                        std::env::set_var("CATIO_JDBC_PLUGIN_JAR", jar);
                    }
                }
            }
```

> 注：现有 drivers-dir 块已 `use tauri::Manager;`。若编译报 `Manager` 重复导入，删掉本块内的 `Manager`，仅保留 `path::BaseDirectory`。

- [ ] **Step 4: 编译验证**

Run: `cd src-tauri && cargo check`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/lib.rs
git commit -m "feat(build): 打包 JDBC sidecar jar 为 Tauri 资源并在启动时注入路径"
```

---

## Task 6: JVM 缺失报错文案（Rust）

**Files:**
- Modify: `src-tauri/src/db/drivers/jdbc.rs:113-115`（spawn 错误映射）

- [ ] **Step 1: 改进 spawn 失败文案**

把 `jdbc.rs` 中：

```rust
        let mut child = cmd.spawn().map_err(|e| {
            DbError::ConnectFailed(format!("failed to spawn Java JDBC sidecar ({}): {e}", java_bin()))
        })?;
```

改为：

```rust
        let mut child = cmd.spawn().map_err(|e| {
            DbError::ConnectFailed(format!(
                "无法启动 Java JDBC sidecar（{}）：{e}。请确认已安装 JDK/JRE 17+ 并在 PATH 中，\
                 或设置 JAVA_HOME / CATIO_JAVA_BIN。", java_bin()))
        })?;
```

- [ ] **Step 2: 编译验证**

Run: `cd src-tauri && cargo check`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add src-tauri/src/db/drivers/jdbc.rs
git commit -m "fix(db): JVM 缺失时给出可操作的 JDBC sidecar 启动报错"
```

---

## Task 7: 前端服务封装（TypeScript）

**Files:**
- Modify: `src/services/jdbcDrivers.ts`

- [ ] **Step 1: 扩展 `JDBC_DOWNLOADABLE`、`JdbcDriverStatus`、新增封装**

在 `jdbcDrivers.ts` 中，把 `JDBC_DOWNLOADABLE` 集合改为包含达梦/金仓：

```ts
export const JDBC_DOWNLOADABLE = new Set<string>([
  'oracle', 'db2', 'snowflake', 'trino', 'hive', 'neo4j', 'saphana', 'teradata',
  'vertica', 'firebird', 'exasol', 'informix', 'iris', 'databricks', 'tdengine', 'kylin',
  'dameng', 'kingbase',
])
```

给 `JdbcDriverStatus` 接口加 `jars` 字段（紧随 `driversDir`）：

```ts
  driversDir: string
  /** 驱动目录下现有的全部 jar 文件名。 */
  jars: string[]
```

更新非 Tauri 分支的兜底返回，补 `jars: []`：

```ts
    return {
      profile, installed: false, fileName: null,
      downloadable: JDBC_DOWNLOADABLE.has(profile), driverClass: null, driversDir: '', jars: [],
    }
```

在文件末尾新增两个封装：

```ts
/** 在系统文件管理器中打开驱动目录。Throws outside Tauri. */
export async function openJdbcDriversDir(): Promise<void> {
  if (!isTauri()) throw new Error('打开驱动目录需要 Tauri 运行时')
  return tauriInvoke<void>('jdbc_open_drivers_dir')
}

/** 让用户选取一个本地 jar 并导入驱动目录，返回刷新后的状态。Throws outside Tauri. */
export async function importJdbcDriver(profile: string): Promise<JdbcDriverStatus> {
  if (!isTauri()) throw new Error('导入驱动需要 Tauri 运行时')
  const { open } = await import('@tauri-apps/plugin-dialog')
  const path = await open({
    multiple: false,
    filters: [{ name: 'JDBC Driver', extensions: ['jar'] }],
  })
  if (typeof path !== 'string') return jdbcDriverStatus(profile) // 用户取消
  return tauriInvoke<JdbcDriverStatus>('jdbc_import_driver', { profile, path })
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 通过（`jars` 字段在测试 mock 里补齐前可能报错——下一 Task 修测试；此处仅看本文件无新错误）。

- [ ] **Step 3: 提交**

```bash
git add src/services/jdbcDrivers.ts
git commit -m "feat(db): 前端封装打开驱动目录与导入驱动 JAR"
```

---

## Task 8: 弹窗 UI — 目录路径 / 打开目录 / 选择 JAR / jar 列表（TypeScript）

**Files:**
- Modify: `src/components/modals/NewConnectionModal.tsx:11`（import）、`233-243`（handler）、`539-569`（驱动行 JSX）
- Modify: `src/i18n/zh.json:407-412`、`src/i18n/en.json:407-412`

- [ ] **Step 1: 新增 i18n 文案**

在 `zh.json` 的 `jdbcDriverDownloading` 之后加：

```json
    "jdbcDriverDownloading": "下载中…",
    "jdbcDriverDir": "驱动目录",
    "jdbcOpenDir": "打开目录",
    "jdbcImportJar": "选择 JAR…",
    "jdbcImporting": "导入中…",
    "jdbcDriverJarsEmpty": "驱动目录为空",
```

在 `en.json` 对应位置加：

```json
    "jdbcDriverDownloading": "Downloading…",
    "jdbcDriverDir": "Drivers folder",
    "jdbcOpenDir": "Open folder",
    "jdbcImportJar": "Choose JAR…",
    "jdbcImporting": "Importing…",
    "jdbcDriverJarsEmpty": "Drivers folder is empty",
```

- [ ] **Step 2: 更新 import 与新增 handler**

把 `NewConnectionModal.tsx:11` 的 import 改为：

```tsx
import { jdbcDriverStatus, downloadJdbcDriver, openJdbcDriversDir, importJdbcDriver, JDBC_DOWNLOADABLE, type JdbcDriverStatus } from '../../services/jdbcDrivers'
```

在 `handleDownloadDriver`（约 233-243 行）之后新增：

```tsx
  const handleImportDriver = async () => {
    if (!jdbcProfile) return
    setDriverBusy(true); setDriverErr(null)
    try {
      setDriverStatus(await importJdbcDriver(jdbcProfile))
    } catch (e) {
      setDriverErr(dbErrMsg(e))
    } finally {
      setDriverBusy(false)
    }
  }

  const handleOpenDriversDir = async () => {
    try { await openJdbcDriversDir() } catch (e) { setDriverErr(dbErrMsg(e)) }
  }
```

- [ ] **Step 3: 扩充驱动行 JSX（目录路径 + 操作按钮 + jar 列表）**

把 `NewConnectionModal.tsx` 驱动行（`539-569`）整块替换为：

```tsx
          {/* JDBC driver row — install-status + one-click download / manual import */}
          {kind === 'db' && isJdbc && (
            <div className="col" style={{ gap: 8, marginBottom: 16, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border-hairline)', background: 'var(--surface-subtle)' }}>
              <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                <Icon name={driverStatus?.installed ? 'circle-check' : 'hard-drive'} size={16}
                  style={{ color: driverStatus?.installed ? 'var(--signal-green)' : 'var(--text-tertiary)', flex: 'none' }} />
                <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                    {driverStatus?.installed
                      ? t('modals.jdbcDriverReady')
                      : driverStatus?.downloadable ?? JDBC_DOWNLOADABLE.has(jdbcProfile ?? '')
                        ? t('modals.jdbcDriverMissing')
                        : t('modals.jdbcDriverManual')}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {driverStatus?.installed
                      ? driverStatus.fileName
                      : driverStatus && !driverStatus.downloadable
                        ? t('modals.jdbcDriverManualHint', { cls: driverStatus.driverClass ?? '' })
                        : (driverStatus?.driverClass ?? currentEngine?.label)}
                  </span>
                  {driverErr && <span style={{ fontSize: 11, color: 'var(--danger-fg)' }}>{driverErr}</span>}
                </div>
                {!driverStatus?.installed && (driverStatus?.downloadable ?? JDBC_DOWNLOADABLE.has(jdbcProfile ?? '')) && (
                  <button className="btn btn-secondary" onClick={handleDownloadDriver} disabled={driverBusy} style={{ flex: 'none' }}>
                    {driverBusy
                      ? <><Icon name="refresh-cw" size={14} className="spin" /> {t('modals.jdbcDriverDownloading')}</>
                      : <><Icon name="arrow-down" size={14} /> {t('modals.jdbcDriverDownload')}</>}
                  </button>
                )}
              </div>
              {/* 驱动目录路径 + 手动导入/打开目录 */}
              {driverStatus?.driversDir && (
                <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flex: 'none' }}>{t('modals.jdbcDriverDir')}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all' }} title={driverStatus.driversDir}>
                    {driverStatus.driversDir}
                  </span>
                  <button className="btn btn-ghost" onClick={handleOpenDriversDir} style={{ flex: 'none' }}>
                    <Icon name="folder-open" size={13} /> {t('modals.jdbcOpenDir')}
                  </button>
                  <button className="btn btn-ghost" onClick={handleImportDriver} disabled={driverBusy} style={{ flex: 'none' }}>
                    {driverBusy
                      ? <><Icon name="refresh-cw" size={13} className="spin" /> {t('modals.jdbcImporting')}</>
                      : <><Icon name="file-plus" size={13} /> {t('modals.jdbcImportJar')}</>}
                  </button>
                </div>
              )}
              {/* 目录内已有的 jar */}
              {driverStatus && !driverStatus.installed && (
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {driverStatus.jars.length > 0 ? driverStatus.jars.join('  ·  ') : t('modals.jdbcDriverJarsEmpty')}
                </span>
              )}
            </div>
          )}
```

> 图标名 `folder-open` / `file-plus` 须存在于项目 Icon 集；若缺失，改用已用过的 `hard-drive` / `arrow-down` 同族图标。实现时在 `src/components/...Icon` 里确认可用图标名。

- [ ] **Step 4: 类型检查 + 构建**

Run: `npx tsc --noEmit && npm run build`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add src/components/modals/NewConnectionModal.tsx src/i18n/zh.json src/i18n/en.json
git commit -m "feat(dbviews): 连接弹窗展示驱动目录并支持选择 JAR/打开目录"
```

---

## Task 9: 更新前端测试（TypeScript）

**Files:**
- Modify: `src/components/modals/NewConnectionModal.test.tsx:157-173`

- [ ] **Step 1: 调整达梦为下载态、手动态改用 Cassandra**

把测试 `shows a manual hint (no download button) for a proprietary engine`（166-173 行）改为：

```tsx
  it('shows a download button for 达梦 (now on Maven Central)', async () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('达梦 DM'))
    // 达梦驱动已在 Maven Central → 显示下载按钮。
    await waitFor(() => expect(screen.getByText('下载驱动')).toBeTruthy())
  })

  it('shows a manual hint (no download button) for a proprietary engine', async () => {
    wrap(<NewConnectionModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('PostgreSQL'))
    fireEvent.click(screen.getByText('Cassandra'))
    // Cassandra 无自包含 Maven jar → 手动提示，无下载按钮。
    await waitFor(() => expect(screen.getByText('需手动提供驱动 JAR')).toBeTruthy())
    expect(screen.queryByText('下载驱动')).toBeNull()
  })
```

> 若非 Tauri 环境下 `jdbcDriverStatus` 返回的 `driversDir` 为 `''`，则目录行不渲染、`jars` 为空——不影响上述断言。`JdbcDriverStatus` mock 若有显式构造处，记得补 `jars: []`。

- [ ] **Step 2: 运行前端测试**

Run: `npx vitest run src/components/modals/NewConnectionModal.test.tsx`
Expected: PASS（含新增达梦下载态、Cassandra 手动态）。

- [ ] **Step 3: 提交**

```bash
git add src/components/modals/NewConnectionModal.test.tsx
git commit -m "test(dbviews): 达梦改为下载态、手动态改用 Cassandra"
```

---

## Task 10: 全量回归与手动验证

**Files:** 无（验证）

- [ ] **Step 1: Rust 全量测试**

Run: `cd src-tauri && cargo test --lib`
Expected: 全过。

- [ ] **Step 2: 前端全量测试 + 构建**

Run: `npx vitest run && npm run build`
Expected: 全过。

- [ ] **Step 3: 手动验证（打包态，需 Java 环境）**

- `cd src-tauri/jdbc-plugin && mvn -q -DskipTests package` 后 `npm run tauri build`。
- 安装/运行产物，新建连接 → 数据库 → 达梦：应出现「下载驱动」按钮，点击后驱动目录出现 `DmJdbcDriver18-*.jar`，jar 列表更新。
- 选 Cassandra：显示驱动目录路径、「打开目录」可弹出文件管理器、「选择 JAR…」可导入并在 jar 列表显示。
- 填好达梦连接信息测试连接：不再出现 `JDBC plugin jar not found`（若未装 Java，则应出现新的「请确认已安装 JDK/JRE 17+」提示）。

- [ ] **Step 4: 最终提交（如有验证期微调）**

```bash
git add -A
git commit -m "chore(db): JDBC 驱动打包与管理体验回归校验"
```

---

## Self-Review 记录

- **Spec 覆盖**：Part1.1 打包 jar → Task 5；Part1.2 JVM 文案 → Task 6；Part2.1 达梦/金仓下载 → Task 1 + Task 7；Part2.2 目录路径/打开目录/导入/ jar 列表 → Task 2、3、7、8；Part2.3 i18n → Task 8。全部有对应任务。
- **类型一致**：`jdbc_status`/`import_driver_to_dir` 均返回 `JdbcDriverStatus`（含 `jars`）；TS `JdbcDriverStatus.jars: string[]` 与 Rust `jars: Vec<String>`（serde camelCase 下仍为 `jars`）一致；命令名 `jdbc_import_driver`/`jdbc_open_drivers_dir` 在 Rust 定义、TS 调用、lib.rs 注册三处一致。
- **占位符**：无 TBD/TODO，所有代码步骤含完整代码。
- **风险点**：Icon 名 `folder-open`/`file-plus` 在 Task 8 Step 3 标注了回退方案；`Manager` 重复导入在 Task 5 Step 3 标注了处理方式。
