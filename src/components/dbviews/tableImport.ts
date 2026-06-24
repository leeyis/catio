/**
 * 表数据导入的前端纯逻辑：源列 → 目标列的自动映射。
 *
 * 对齐 dbx apps/desktop/src/lib/tableImport.ts 的 autoMapImportColumns /
 * normalizeImportColumnName。解析与 INSERT 生成在 Rust 后端（table_import.rs，已单测），
 * 这里只负责把文件列名启发式地匹配到目标表列名，给对话框一个合理的初始映射。
 */

/** 目标列为空串表示「跳过该源列，不导入」。 */
export const IMPORT_SKIP_TARGET = ''

/**
 * 不支持事务的引擎（与后端 capabilities.transactions 一致）：truncate 模式下后端
 * 无法把「清表 + 批量 INSERT」包进事务,中途失败将无法回滚。前端据此在 truncate
 * 模式额外提示「无回滚」风险。未知/缺省引擎按支持事务处理（不弹吓人的告警）。
 */
const NON_TRANSACTIONAL_ENGINES = new Set([
  'clickhouse', 'rqlite', 'redis', 'mongodb', 'elasticsearch', 'jdbc',
])

/** 引擎是否支持导入事务（truncate 原子化）。大小写不敏感;未知引擎默认 true。 */
export function engineSupportsImportTransaction(engine?: string): boolean {
  if (!engine) return true
  return !NON_TRANSACTIONAL_ENGINES.has(engine.toLowerCase())
}

/** 归一化列名以做模糊匹配：去首尾空白、转小写、分隔符（_ -）折叠为单个空格。 */
export function normalizeImportColumnName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * 为每个源列推断一个目标列：优先精确同名，其次归一化后同名，都没有则置为跳过。
 * 返回 source → target 的映射对象。
 */
export function autoMapImportColumns(
  sourceColumns: string[],
  targetColumns: string[],
): Record<string, string> {
  const exactTargets = new Map(targetColumns.map((c) => [c, c]))
  const normalizedTargets = new Map(targetColumns.map((c) => [normalizeImportColumnName(c), c]))

  const out: Record<string, string> = {}
  for (const source of sourceColumns) {
    out[source] =
      exactTargets.get(source) ??
      normalizedTargets.get(normalizeImportColumnName(source)) ??
      IMPORT_SKIP_TARGET
  }
  return out
}
