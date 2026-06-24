/**
 * 数据网格「列级结构化筛选」的纯函数求值层。把一棵规则列表(8 种操作符 + AND/OR)
 * 在客户端对当前行集做过滤,与 React 组件解耦,便于单测。
 *
 * 参考 dbx-ref apps/desktop/src/components/grid/DataGrid.vue L506-549 的 StructuredFilterRule
 * 与 lib/dataGridColumnFilter.ts 的 filterModeNeedsValue / parseFilterValue 语义。区别在于
 * dbx 把规则编译成 SQL WHERE 回服务端执行,而 Catio 这里在已加载的行上做本地求值
 * (与现有全局文本搜索一致的客户端路径,保留它并在其上叠加按列筛选)。
 */

/** 8 种操作符,命名与 dbx FilterMode 对齐。 */
export type FilterMode =
  | 'equals'
  | 'not-equals'
  | 'like'
  | 'not-like'
  | 'greater-than'
  | 'less-than'
  | 'is-null'
  | 'is-not-null'

/** 一条结构化筛选规则。conjunction 决定它与「左侧累计结果」如何连接(从左到右)。 */
export interface FilterRule {
  id: string
  columnName: string
  mode: FilterMode
  rawValue: string
  /** 与前一条规则结果的连接方式;第一条规则的 conjunction 被忽略。 */
  conjunction: 'AND' | 'OR'
}

/** is-null / is-not-null 不需要输入值,其余操作符都需要。 */
export function filterModeNeedsValue(mode: FilterMode): boolean {
  return mode !== 'is-null' && mode !== 'is-not-null'
}

/** 一条规则是否「完整可用」:有列名,且需值的操作符填了非空值。 */
export function isRuleComplete(rule: FilterRule): boolean {
  if (!rule.columnName) return false
  if (filterModeNeedsValue(rule.mode) && rule.rawValue.trim().length === 0) return false
  return true
}

/** 同 dbx parseFilterValue 的数值判定:严格的数值字面量(无前后空白)才当数字比较。 */
function isNumericLiteral(text: string): boolean {
  if (!text || text.trim() !== text) return false
  return Number.isFinite(Number(text)) && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)
}

/**
 * 对单行求值一条规则。columnLookup 把列名映射到列下标(找不到返回 < 0)。
 * - 列不存在 → 视为 no-op(返回 true),不误杀行,与「不完整规则被跳过」一致。
 * - equals/not-equals:双方都是数值字面量时按数值比较,否则按字符串严格比较(区分大小写)。
 * - like/not-like:大小写不敏感的子串包含。
 * - greater-than/less-than:双方都是数值时按数值比较,否则按字符串字典序。
 * - is-null/is-not-null:仅 null/undefined 视为空(空字符串不算空)。
 */
export function evalRule(row: unknown[], rule: FilterRule, columnLookup: (name: string) => number): boolean {
  const ci = columnLookup(rule.columnName)
  if (ci < 0) return true // 未知列:忽略该规则
  const cell = row[ci]

  if (rule.mode === 'is-null') return cell == null
  if (rule.mode === 'is-not-null') return cell != null

  const raw = rule.rawValue
  const cellStr = cell == null ? '' : String(cell)

  switch (rule.mode) {
    case 'equals':
    case 'not-equals': {
      const eq = numericOrString(cellStr, raw, (a, b) => a === b, (a, b) => a === b)
      return rule.mode === 'equals' ? eq : !eq
    }
    case 'like':
    case 'not-like': {
      const has = cellStr.toLowerCase().includes(raw.toLowerCase())
      return rule.mode === 'like' ? has : !has
    }
    case 'greater-than':
      return numericOrString(cellStr, raw, (a, b) => a > b, (a, b) => a > b)
    case 'less-than':
      return numericOrString(cellStr, raw, (a, b) => a < b, (a, b) => a < b)
  }
}

/** 双方都是数值字面量时用 numCmp,否则用 strCmp。 */
function numericOrString(
  cellStr: string,
  raw: string,
  numCmp: (a: number, b: number) => boolean,
  strCmp: (a: string, b: string) => boolean,
): boolean {
  if (isNumericLiteral(cellStr) && isNumericLiteral(raw)) {
    return numCmp(Number(cellStr), Number(raw))
  }
  return strCmp(cellStr, raw)
}

/**
 * 用规则列表过滤行集。从左到右折叠:第一条完整规则建立初值,其后每条按自己的
 * conjunction(AND/OR)与累计结果结合。不完整的规则被跳过(不影响链)。无任何
 * 完整规则 → 全部保留。
 */
export function filterRows(rows: unknown[][], rules: FilterRule[], columnLookup: (name: string) => number): unknown[][] {
  const active = rules.filter(isRuleComplete)
  if (active.length === 0) return rows
  return rows.filter(row => {
    let acc = evalRule(row, active[0], columnLookup)
    for (let i = 1; i < active.length; i++) {
      const r = evalRule(row, active[i], columnLookup)
      acc = active[i].conjunction === 'OR' ? acc || r : acc && r
    }
    return acc
  })
}
