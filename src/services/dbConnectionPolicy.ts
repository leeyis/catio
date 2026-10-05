/** Match the actual native driver family, never a display label or JDBC profile. */
export function isNativeFileDatabase(dbType: string | undefined): boolean {
  return dbType === 'sqlite' || dbType === 'duckdb'
}
