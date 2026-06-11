// JDBC driver management: DBeaver-style one-click download of a driver JAR from
// Maven Central, plus install-status. Wraps the Rust `jdbc_driver_status` /
// `jdbc_download_driver` commands. JDBC engines need a driver JAR to connect;
// proprietary ones (达梦/YashanDB/…) must be supplied manually.

const isTauri = (): boolean =>
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

/** Mirrors Rust `JdbcDriverStatus` (camelCase via serde). */
export interface JdbcDriverStatus {
  profile: string
  installed: boolean
  fileName: string | null
  downloadable: boolean
  driverClass: string | null
  driversDir: string
  /** 驱动目录下现有的全部 jar 文件名。 */
  jars: string[]
}

/** Engine profiles with a one-click Maven download — mirrors the Rust
 *  `jdbc_config::download_spec` registry so the UI can render the download
 *  affordance even outside the Tauri runtime (dev/test). */
export const JDBC_DOWNLOADABLE = new Set<string>([
  'oracle', 'db2', 'snowflake', 'trino', 'hive', 'neo4j', 'saphana', 'teradata',
  'vertica', 'firebird', 'exasol', 'informix', 'iris', 'databricks', 'tdengine', 'kylin',
  'dameng', 'kingbase',
])

/** Current install/download status for an engine's JDBC driver. */
export async function jdbcDriverStatus(profile: string): Promise<JdbcDriverStatus> {
  if (!isTauri()) {
    return {
      profile, installed: false, fileName: null,
      downloadable: JDBC_DOWNLOADABLE.has(profile), driverClass: null, driversDir: '', jars: [],
    }
  }
  return tauriInvoke<JdbcDriverStatus>('jdbc_driver_status', { profile })
}

/** Download the driver JAR for `profile` into the drivers dir. Throws outside Tauri. */
export async function downloadJdbcDriver(profile: string): Promise<JdbcDriverStatus> {
  if (!isTauri()) throw new Error('下载驱动需要 Tauri 运行时')
  return tauriInvoke<JdbcDriverStatus>('jdbc_download_driver', { profile })
}

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
