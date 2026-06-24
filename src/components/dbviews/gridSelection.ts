/**
 * 数据网格的「选择状态归约」纯函数。把「当前选择 + 点击事件」映射成新的选择集，
 * 与 React 组件解耦，便于单测。参考 dbx-ref 的 lib/gridSelection.ts + useDataGridSelection。
 *
 * 选择模型（在原有单选 `sel:{r,c}` 之上叠加，不替换）：
 * - 单元格矩形：由 anchor + focus 两端点确定，normalizeRange 归一为 r0/r1/c0/c1。
 * - 行多选：rows 是「原始行下标 origIdx」集合（与单元格选择互斥，谁后操作清空另一方）。
 */

/** 单元格坐标：r=显示行下标（pageRows 内），c=列下标。 */
export interface CellPos { r: number; c: number }

/** 归一化后的选择矩形（含两端，inclusive）。 */
export interface CellRange { r0: number; r1: number; c0: number; c1: number }

/** 网格选择状态：单元格矩形（anchor/focus）+ 行多选集合（origIdx）。 */
export interface GridSelection {
  anchor: CellPos | null
  focus: CellPos | null
  rows: Set<number>
}

/** 鼠标修饰键。shift=范围扩选，ctrl/meta=离散增减。 */
export interface ClickMods { shift?: boolean; ctrl?: boolean }

/** 把任意拖动方向的 anchor/focus 归一成最小/最大边界的矩形。 */
export function normalizeRange(anchor: CellPos, focus: CellPos): CellRange {
  return {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  }
}

/** 单元格 (r,c) 是否落在矩形内（含边界）。range 为 null 时恒 false。 */
export function isCellInRange(r: number, c: number, range: CellRange | null): boolean {
  if (!range) return false
  return r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
}

/**
 * 单元格点击 → 新选择。
 * - shift：保留 anchor，把 focus 移到点击处（范围扩选）；无 anchor 时退化为单选。
 * - 其它（含 ctrl）：折叠为单格选择（本网格不支持多个离散矩形，与 dbx 折叠行为一致）。
 * 任意单元格选择都会清空行多选。
 */
export function reduceCellSelection(prev: GridSelection, r: number, c: number, mods: ClickMods): GridSelection {
  if (mods.shift && prev.anchor) {
    return { anchor: prev.anchor, focus: { r, c }, rows: new Set() }
  }
  return { anchor: { r, c }, focus: { r, c }, rows: new Set() }
}

/**
 * 行表头点击 → 新选择（行下标用 origIdx）。
 * - ctrl/meta：在集合里切换该行（增/删），保留其余已选行。
 * - shift：从 lastRow 到点击行的闭区间整体加入（在原集合上并集）。
 * - 其它：仅选中该行。
 * 任意行选择都会清空单元格矩形。
 */
export function reduceRowSelection(
  prev: GridSelection,
  row: number,
  ctx: { lastRow: number | null },
  mods: ClickMods,
): GridSelection {
  if (mods.ctrl) {
    const rows = new Set(prev.rows)
    if (rows.has(row)) rows.delete(row); else rows.add(row)
    return { anchor: null, focus: null, rows }
  }
  if (mods.shift && ctx.lastRow != null) {
    const rows = new Set(prev.rows)
    const lo = Math.min(ctx.lastRow, row)
    const hi = Math.max(ctx.lastRow, row)
    for (let i = lo; i <= hi; i++) rows.add(i)
    return { anchor: null, focus: null, rows }
  }
  return { anchor: null, focus: null, rows: new Set([row]) }
}

/** 枚举当前单元格矩形里的所有 (r,c) 坐标（按行优先顺序）。无矩形时返回空数组。 */
export function cellsInRange(sel: GridSelection): CellPos[] {
  if (!sel.anchor || !sel.focus) return []
  const { r0, r1, c0, c1 } = normalizeRange(sel.anchor, sel.focus)
  const out: CellPos[] = []
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) out.push({ r, c })
  }
  return out
}
