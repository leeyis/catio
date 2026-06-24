// 服务端 WHERE / ORDER BY 输入框的轻量候选:列名 + 方言无关的常用关键字。
// 纯函数,便于单测;UI(DataGrid)据此渲染下拉并在选中时替换光标处 token。

export type ClauseMode = 'where' | 'order'

export interface ClauseItem {
  label: string
  /** 选中后插入到输入框的文本 */
  insert: string
  kind: 'column' | 'keyword'
}

export interface ClauseSuggest {
  /** 当前 token 在原串中的起止(用于替换) */
  start: number
  end: number
  items: ClauseItem[]
}

// WHERE 常用连接词/操作符;ORDER BY 只有方向。SQL 关键字按惯例保留英文大写。
const WHERE_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'BETWEEN']
const ORDER_KEYWORDS = ['ASC', 'DESC']

// token 字符集:标识符常见字符(字母/数字/下划线/$/.)。其余(空格、逗号、括号、操作符)为分隔。
const TOKEN_CHAR = /[A-Za-z0-9_$.]/

/** 计算光标处正在输入的 token 及匹配候选(列名优先,关键字其后)。 */
export function clauseSuggest(value: string, cursor: number, columns: string[], mode: ClauseMode): ClauseSuggest {
  const pos = Math.max(0, Math.min(cursor, value.length))
  let start = pos
  while (start > 0 && TOKEN_CHAR.test(value[start - 1])) start--
  const token = value.slice(start, pos)
  const lower = token.toLowerCase()

  const cols: ClauseItem[] = columns.map(c => ({ label: c, insert: c, kind: 'column' as const }))
  const kws: ClauseItem[] = (mode === 'where' ? WHERE_KEYWORDS : ORDER_KEYWORDS)
    .map(k => ({ label: k, insert: k, kind: 'keyword' as const }))
  const all = [...cols, ...kws]
  // 空 token → 全部候选(列在前);否则按前缀(大小写不敏感)过滤。
  const items = lower === '' ? all : all.filter(i => i.label.toLowerCase().startsWith(lower))
  return { start, end: pos, items }
}

/** 把选中候选插入到 token 位置,返回新值与新光标位置。 */
export function applyClauseItem(value: string, sug: ClauseSuggest, item: ClauseItem): { value: string; cursor: number } {
  const before = value.slice(0, sug.start)
  const after = value.slice(sug.end)
  return { value: before + item.insert + after, cursor: (before + item.insert).length }
}

/** 在光标处插入一段文本(用于「拖字段名到输入框」),返回新值与新光标位置。 */
export function insertAtCursor(value: string, cursor: number, text: string): { value: string; cursor: number } {
  const pos = Math.max(0, Math.min(cursor, value.length))
  const before = value.slice(0, pos)
  const after = value.slice(pos)
  return { value: before + text + after, cursor: before.length + text.length }
}
