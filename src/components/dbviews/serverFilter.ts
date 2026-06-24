/**
 * 服务端 WHERE / ORDER BY 取数(对齐 dbx 网格的 whereFilterInput/orderByInput)的引擎门控。
 *
 * 后端 db_table_query 对非 SQL 引擎(MongoDB/Redis/Elasticsearch)显式返回 DbError::Unsupported
 * —— 它们不能执行任意 SQL 片段。前端据此隐藏 WHERE/ORDER BY 输入条,避免用户输入后触发一个
 * 误导性的后端报错(codex 阻断项[P2])。判定与后端 db_table_query 的拒绝集合保持一致。
 */
import type { DbType } from '../../services/db'

/** 不支持任意 SQL 片段的非 SQL 引擎,与后端 db_table_query 的拒绝集合一致。 */
const NON_SQL_ENGINES: readonly DbType[] = ['mongodb', 'redis', 'elasticsearch']

/** 该引擎是否支持服务端 WHERE/ORDER BY 取数。非 SQL 引擎返回 false;未知/缺省按 SQL 引擎放行。 */
export function supportsServerFilter(engine?: string): boolean {
  return !NON_SQL_ENGINES.includes(engine as DbType)
}
