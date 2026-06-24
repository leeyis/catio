/**
 * 把网格选中行渲染成可复制的 SQL INSERT / UPDATE 语句(右键菜单「复制为 SQL」)。
 *
 * 值转义与语句结构语义参照后端 src-tauri/src/db/dml.rs 的 value_to_sql/build_insert/
 * build_update;标识符引用沿用本目录 structureDdl 的 dialectFor/quoteIdent/qualifiedTable,
 * 避免重复实现一套方言逻辑。纯函数,不触碰剪贴板/DOM,便于单测。
 */

import { type StructDialect, quoteIdent, qualifiedTable } from './structureDdl'

export type { StructDialect }

/**
 * 单元格值 → SQL 字面量。对齐 dml.rs::value_to_sql:
 *   null/undefined → NULL;布尔 → TRUE/FALSE;数字原样;字符串单引号 + 内嵌单引号加倍。
 *   对象/数组先 JSON 序列化再作为字符串字面量(覆盖 MongoDB 子文档 / JSON 列)。
 */
export function sqlValue(v: unknown): string {
  if (v == null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'string') return quoteString(v)
  if (typeof v === 'object') {
    try { return quoteString(JSON.stringify(v)) } catch { return quoteString(String(v)) }
  }
  return quoteString(String(v))
}

/** 单引号字符串字面量,内嵌单引号加倍转义。 */
function quoteString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 生成 INSERT:每行一条 `INSERT INTO <tbl> (<cols>) VALUES (<vals>);`,多行以换行分隔。
 * 行内值按列顺序对齐 columns。
 */
export function buildInsertSql(
  rows: unknown[][], table: string, columns: string[], dialect: StructDialect, schema?: string,
): string {
  const tbl = qualifiedTable(dialect, schema, table)
  const colList = columns.map(c => quoteIdent(dialect, c)).join(', ')
  return rows.map(row => {
    const vals = columns.map((_, i) => sqlValue(row[i])).join(', ')
    return `INSERT INTO ${tbl} (${colList}) VALUES (${vals});`
  }).join('\n')
}

/**
 * 无真实主键时(PK-less 表,如 Postgres ctid 路径)的伪主键定位:`column` 是伪主键
 * 列名,`values` 与 rows 等长一一对应每行的 key 值(该值不在行数据里,由调用方从
 * activeRowKeys 取得)。
 */
export type KeyOverride = { column: string; values: unknown[] }

/**
 * 生成 UPDATE:每行一条。`pk` 给出主键列名;SET 写非主键列,WHERE 用主键列定位。
 * 当 pk 为空时:
 *   - 若提供 `keyOverride` 且当前行有可用 key 值,SET 全列、WHERE 用伪主键 (ctid) 定位;
 *   - 否则退化为 SET 全列、无 WHERE(复制后由用户自行补 WHERE)。
 * 真实 PK 始终优先于 keyOverride。
 */
export function buildUpdateSql(
  rows: unknown[][], table: string, columns: string[], dialect: StructDialect,
  schema: string | undefined, pk: string[], keyOverride?: KeyOverride,
): string {
  const tbl = qualifiedTable(dialect, schema, table)
  const pkSet = new Set(pk)
  return rows.map((row, i) => {
    const setCols = pk.length > 0 ? columns.filter(c => !pkSet.has(c)) : columns
    const set = setCols
      .map(c => `${quoteIdent(dialect, c)} = ${sqlValue(row[columns.indexOf(c)])}`)
      .join(', ')
    if (pk.length > 0) {
      const where = pk
        .map(c => `${quoteIdent(dialect, c)} = ${sqlValue(row[columns.indexOf(c)])}`)
        .join(' AND ')
      return `UPDATE ${tbl} SET ${set} WHERE ${where};`
    }
    const keyVal = keyOverride?.values[i]
    if (keyOverride && keyVal != null) {
      return `UPDATE ${tbl} SET ${set} WHERE ${quoteIdent(dialect, keyOverride.column)} = ${sqlValue(keyVal)};`
    }
    return `UPDATE ${tbl} SET ${set};`
  }).join('\n')
}
