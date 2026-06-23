/**
 * 整库导出对话框的前端纯逻辑:表过滤、选择归约、就绪校验、选中表 payload。
 *
 * 对齐 dbx apps/desktop/src/lib/databaseExportSelection.ts 与 DatabaseExportDialog.vue
 * 的「过滤 + 多选 + 全选/清空(仅作用于当前过滤结果)」交互约束。真实导出与脚本生成在
 * Rust 后端(export.rs / db_export_database,T13 已实现并单测),这里只做对话框的可测约束。
 */

/** 大小写不敏感的子串过滤;空查询返回全部表(保持规范顺序)。 */
export function filterTables(allTables: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return allTables
  return allTables.filter((name) => name.toLowerCase().includes(q))
}

/** 选中集按 allTables 的规范顺序重排,使 UI/payload 顺序稳定。 */
function inCanonicalOrder(allTables: string[], selected: Set<string>): string[] {
  return allTables.filter((name) => selected.has(name))
}

/** 切换单个表的选中态;结果按规范顺序返回。 */
export function toggleSelected(allTables: string[], selectedTables: string[], table: string): string[] {
  const selected = new Set(selectedTables)
  if (selected.has(table)) selected.delete(table)
  else selected.add(table)
  return inCanonicalOrder(allTables, selected)
}

/** 把当前过滤结果里的全部表并入选中集(union),其余选中项保留。 */
export function selectAllFiltered(allTables: string[], selectedTables: string[], filtered: string[]): string[] {
  const selected = new Set(selectedTables)
  for (const name of filtered) selected.add(name)
  return inCanonicalOrder(allTables, selected)
}

/** 仅从选中集移除当前过滤结果里的表,其余选中项保留。 */
export function clearFiltered(selectedTables: string[], filtered: string[]): string[] {
  const removing = new Set(filtered)
  return selectedTables.filter((name) => !removing.has(name))
}

/**
 * 传给后端的 selectedTables:
 * - 全选(选中数 === 总数)或无表 → undefined,语义为「导出全部」(后端 wanted 为空时取全部);
 * - 严格子集 → 按规范顺序的显式列表。
 * 对齐 dbx buildSelectedTablesPayload。
 */
export function buildSelectedTablesPayload(allTables: string[], selectedTables: string[]): string[] | undefined {
  if (allTables.length === 0) return undefined
  if (selectedTables.length === allTables.length) return undefined
  const selected = new Set(selectedTables)
  return allTables.filter((name) => selected.has(name))
}

/**
 * 导出是否就绪(决定「导出」按钮可点):
 * - 至少选中一张表;
 * - 至少包含结构或数据其一(两者都不含则脚本为空,无意义)。
 */
export function exportReady(args: { selectedCount: number; includeStructure: boolean; includeData: boolean }): boolean {
  if (args.selectedCount === 0) return false
  if (!args.includeStructure && !args.includeData) return false
  return true
}
