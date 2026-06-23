/**
 * 数据网格的「列可见性」纯函数。把「列集 + 行数据 + 隐藏偏好」映射为可见列集，
 * 与 React 组件解耦便于单测。参考 dbx-ref 的 lib/dataGridColumnVisibility.ts，
 * 但本仓库各处(列宽/排序)均以列名为键，故这里也用列名而非列下标。
 *
 * 不变量：永远至少保留一列可见 —— 若隐藏偏好会清空全部列，则回退为显示全部。
 */

/** 给定列集与隐藏列名集合，返回按原顺序排列的可见列名。 */
export function visibleColumnNames(columns: string[], hidden: ReadonlySet<string>): string[] {
  const visible = columns.filter((name) => !hidden.has(name))
  return visible.length > 0 ? visible : columns
}

/** 在当前行数据中整列均为空值(null/undefined)的列名(按列顺序)。空结果集返回 []。 */
export function allNullColumnNames(columns: string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string[] {
  if (rows.length === 0) return []
  return columns.filter((_, ci) => rows.every((row) => row[ci] == null))
}

/**
 * 切换某列的隐藏态：未隐藏→加入隐藏集；已隐藏→移出。
 * 防御：当切换会使可见列归零(隐藏最后一列可见列)时拒绝，原集合不变。
 */
export function toggleColumnVisibility(
  columns: string[],
  hidden: ReadonlySet<string>,
  name: string,
): Set<string> {
  const next = new Set(hidden)
  if (next.has(name)) {
    next.delete(name)
    return next
  }
  // columns - hidden 当前可见数；若隐藏后只剩 0 列可见则拒绝。
  const visibleCount = columns.filter((c) => !next.has(c)).length
  if (visibleCount <= 1) return next
  next.add(name)
  return next
}

/** 一键显示全部列：返回空隐藏集。 */
export function showAllColumns(): Set<string> {
  return new Set()
}
