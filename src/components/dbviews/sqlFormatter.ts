/* SQL 控制台格式化纯函数。参考 dbx-ref 的 sqlFormatter.ts 多方言用法,
 * 按当前连接引擎选 sql-formatter 方言。非 SQL 引擎(mongo/es/redis)不在此路径,
 * 由 SqlConsole 的 plain 模式拦截;此处的缺省回落到通用 sql 方言保证健壮。 */
import { format, type FormatOptionsWithLanguage } from 'sql-formatter'

type SqlLanguage = FormatOptionsWithLanguage['language']

/** 把 Catio 引擎名(conn.engine = DbType)映射到 sql-formatter 的 language。
 * sql-formatter 原生支持 duckdb/clickhouse,无对应时回落到通用 'sql'。 */
export function formatterLanguage(engine?: string): SqlLanguage {
  switch (engine) {
    case 'mysql': return 'mysql'
    case 'postgres': return 'postgresql'
    case 'sqlite': return 'sqlite'
    case 'duckdb': return 'duckdb'
    case 'clickhouse': return 'clickhouse'
    case 'sqlserver': return 'transactsql'
    default: return 'sql'
  }
}

/**
 * 按引擎方言格式化 SQL。空/纯空白原样返回;格式化失败(语法非法)时原样返回输入,
 * 绝不抛错——格式化是辅助操作,不能因坏 SQL 阻断用户继续编辑。
 */
export function formatSql(sql: string, engine?: string): string {
  if (!sql.trim()) return sql
  try {
    return format(sql, { language: formatterLanguage(engine), keywordCase: 'upper' })
  } catch {
    return sql
  }
}
