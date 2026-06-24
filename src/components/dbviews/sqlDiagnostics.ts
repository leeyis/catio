/**
 * SQL 语法/语义诊断(CodeMirror linter 的纯函数内核)。
 * 参考 dbx 的 sqlSemanticDiagnostics.ts / sqlDiagnostics.ts,但 catio 不依赖后端
 * SQL parser:这里只做可纯函数判定的诊断,产出 line:column,供编辑器内联标红。
 *
 * 覆盖:
 *  1) 未闭合 / 多余的括号(忽略字符串与注释中的括号)
 *  2) 未闭合的字符串字面量(单引号 ' / 双引号 ")
 *  3) 未知表名 —— 基于已加载 schema 的表名集合,对 FROM/JOIN 后紧跟的标识符比对
 *
 * 所有诊断的 message 用中文(与 redisDiagnostics 一致的既有约定),术语保留英文。
 * line/column 均为 1-based(便于直接映射 CodeMirror 偏移)。
 */

import type { Diagnostic } from '@codemirror/lint'
import type { EditorView } from '@codemirror/view'

export interface SqlDiagnostic {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
  severity: 'error' | 'warning'
  message: string
}

export interface SqlDiagnosticSchema {
  /** 已知表名(及视图名)。大小写不敏感比对;空数组表示 schema 未加载 → 跳过未知表诊断。 */
  tables: string[]
}

/** linterTableNames 所需的最小 schema 结构(取 tables/views 的 name)。 */
export interface NamedSchema {
  schemas: { tables: { name: string }[]; views: { name: string }[] }[]
}

/**
 * 计算未知表诊断的"已知表名"列表来源。
 *
 * 关键修复:当已连接(connId 存在)但真实 schema 仍未加载完成(liveSchema 为 null,
 * 处于首次抓取中或抓取失败)时,**必须返回空数组**,而不是退回到静态 demo schema。
 * 否则连接库里真实存在的表会被 demo 的硬编码表名(orders/customers/line_items…)判为
 * "未知的表"而误报红。未连接(mock 模式)下才允许用 demo schema 的表名做提示。
 */
export function linterTableNames(
  connId: string | undefined,
  liveSchema: NamedSchema | null,
  demoSchema: NamedSchema,
): string[] {
  if (connId && !liveSchema) return []
  const source = liveSchema ?? demoSchema
  const names: string[] = []
  for (const ns of source.schemas) {
    for (const t of ns.tables) names.push(t.name)
    for (const v of ns.views) names.push(v.name)
  }
  return names
}

interface Tok {
  /** 标识符 / 关键字(原文,未去引号),或单字符 '(' ')' 。 */
  value: string
  line: number // 1-based
  col: number // 1-based(token 起始列)
}

/**
 * 词法扫描:剥离注释/字符串后,产出标识符与括号 token,并就地检测未闭合字符串、
 * 未匹配括号。括号错误一旦出现即作为第一优先级返回(语法错误最该先暴露)。
 */
function scan(sql: string): { tokens: Tok[]; diagnostics: SqlDiagnostic[] } {
  const tokens: Tok[] = []
  const diagnostics: SqlDiagnostic[] = []
  // 括号栈,记录每个未匹配左括号的位置,便于报"未闭合的括号"。
  const parenStack: { line: number; col: number }[] = []

  let line = 1
  let col = 1
  let i = 0
  const n = sql.length

  const advance = (ch: string) => {
    if (ch === '\n') { line++; col = 1 } else { col++ }
    i++
  }

  while (i < n) {
    const ch = sql[i]

    // 行注释 -- … 到行尾
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') advance(sql[i])
      continue
    }
    // 块注释 /* … */
    if (ch === '/' && sql[i + 1] === '*') {
      const sLine = line
      const sCol = col
      advance(ch); advance(sql[i])
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) advance(sql[i])
      if (i < n) { advance(sql[i]); advance(sql[i]) }
      else {
        // 直到文档结束都没遇到 */ —— 块注释未闭合,后续 token 不可靠,立即报错返回。
        diagnostics.push({
          startLine: sLine, startColumn: sCol, endLine: line, endColumn: col,
          severity: 'error', message: '未闭合的块注释',
        })
        return { tokens, diagnostics }
      }
      continue
    }
    // 字符串字面量 ' … ' 或 " … "(连续两个引号为转义)
    if (ch === "'" || ch === '"') {
      const quote = ch
      const sLine = line
      const sCol = col
      advance(ch)
      let closed = false
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { advance(sql[i]); advance(sql[i]); continue }
          advance(sql[i]); closed = true; break
        }
        advance(sql[i])
      }
      if (!closed) {
        diagnostics.push({
          startLine: sLine, startColumn: sCol, endLine: line, endColumn: col,
          severity: 'error', message: '未闭合的字符串字面量',
        })
        return { tokens, diagnostics } // 字符串未闭合后续解析不可靠,直接返回
      }
      continue
    }
    // 括号
    if (ch === '(') {
      parenStack.push({ line, col })
      tokens.push({ value: '(', line, col })
      advance(ch); continue
    }
    if (ch === ')') {
      if (parenStack.length === 0) {
        diagnostics.push({
          startLine: line, startColumn: col, endLine: line, endColumn: col + 1,
          severity: 'error', message: '多余的右括号:没有与之匹配的左括号',
        })
        return { tokens, diagnostics }
      }
      parenStack.pop()
      tokens.push({ value: ')', line, col })
      advance(ch); continue
    }
    // 标识符 / 关键字(允许 . 以支持 schema.table 限定名)
    if (/[A-Za-z_$]/.test(ch)) {
      const sLine = line
      const sCol = col
      let value = ''
      while (i < n && /[A-Za-z0-9_$.]/.test(sql[i])) { value += sql[i]; advance(sql[i]) }
      tokens.push({ value, line: sLine, col: sCol })
      continue
    }
    advance(ch)
  }

  // 文档结束仍有未闭合的左括号
  if (parenStack.length > 0) {
    const top = parenStack[parenStack.length - 1]
    diagnostics.push({
      startLine: top.line, startColumn: top.col, endLine: top.line, endColumn: top.col + 1,
      severity: 'error', message: '未闭合的括号:缺少与之匹配的右括号',
    })
  }

  return { tokens, diagnostics }
}

/** 去引号 + 取限定名末段(public.orders → orders),小写归一化。 */
function normalizeTable(value: string): string {
  let v = value
  // 去包裹引号 / 反引号 / 方括号
  while (v && `"'\`[]`.includes(v[0])) v = v.slice(1)
  while (v && `"'\`[]`.includes(v[v.length - 1])) v = v.slice(0, -1)
  const dot = v.lastIndexOf('.')
  if (dot >= 0) v = v.slice(dot + 1)
  return v.toLowerCase()
}

// FROM / JOIN 之后紧跟的标识符即为表名引用。
const FROM_JOIN = new Set(['from', 'join'])

/**
 * 预扫描 WITH … AS 链,收集 CTE 别名(归一化后的小写名)。
 * CTE 名是紧跟在 WITH(或 WITH 链中逗号)之后、AS 之前的那个标识符:
 *   WITH recent AS (…), other AS (…) SELECT * FROM recent
 * 这些别名是有效的"表"引用,不应被未知表诊断误报。
 */
function collectCTEs(tokens: Tok[]): Set<string> {
  const ctes = new Set<string>()
  let seenWith = false
  let depth = 0 // 括号深度;CTE 别名只在顶层(depth 0)的 WITH 链头出现
  for (let k = 0; k < tokens.length - 1; k++) {
    const tv = tokens[k].value
    if (tv === '(') { depth++; continue }
    if (tv === ')') { depth--; continue }
    const v = tv.toLowerCase()
    if (v === 'with') { seenWith = true; continue }
    // 顶层 SELECT(非 CTE 体内,depth 0)出现,说明 WITH 头部已结束,进入主查询。
    if (seenWith && depth === 0 && v === 'select') { seenWith = false; continue }
    // 仅在 WITH 链头(顶层、AS 之前)且后跟 AS 时,认定为 CTE 别名。
    if (seenWith && depth === 0 && tokens[k + 1] && tokens[k + 1].value.toLowerCase() === 'as') {
      const norm = normalizeTable(tv)
      if (norm) ctes.add(norm)
    }
  }
  return ctes
}

/**
 * 主入口:对 SQL 文本做诊断。先做括号/字符串语法检查(任一致命错误立即返回,
 * 不再叠加未知表噪音);语法通过后,基于已知表集合检查 FROM/JOIN 表名。
 */
export function sqlDiagnostics(sql: string, schema: SqlDiagnosticSchema): SqlDiagnostic[] {
  const { tokens, diagnostics } = scan(sql)
  if (diagnostics.length > 0) return diagnostics

  // schema 未加载(无任何表名)时,跳过未知表诊断,避免对真实但未抓取到的表误报。
  const known = new Set(schema.tables.map(normalizeTable).filter(Boolean))
  if (known.size === 0) return diagnostics

  // WITH 定义的 CTE 别名是合法的"表"引用,先收集以免在 FROM/JOIN 检查时误报。
  const knownCTEs = collectCTEs(tokens)

  for (let k = 0; k < tokens.length - 1; k++) {
    const kw = tokens[k]
    if (kw.value === '(' || kw.value === ')') continue
    if (!FROM_JOIN.has(kw.value.toLowerCase())) continue
    const ref = tokens[k + 1]
    if (!ref || ref.value === '(' || ref.value === ')') continue // 子查询 FROM (… 不是表名
    const norm = normalizeTable(ref.value)
    if (!norm || known.has(norm) || knownCTEs.has(norm)) continue
    diagnostics.push({
      startLine: ref.line, startColumn: ref.col,
      endLine: ref.line, endColumn: ref.col + ref.value.length,
      severity: 'warning', message: `未知的表 '${ref.value}'`,
    })
  }

  return diagnostics
}

/**
 * CodeMirror linter 源工厂。`getTables` 在每次 lint 时读取最新已知表名(由
 * SqlConsole 用 ref 提供,避免随 schema 加载重建编辑器扩展)。把纯诊断的
 * 1-based line/column 映射为文档绝对偏移;光标所在行的"未闭合括号/字符串"
 * 错误被抑制(用户正在输入,避免闪红),其余诊断照常显示。
 */
export function sqlLinter(getTables: () => string[]): (view: EditorView) => Diagnostic[] {
  return (view: EditorView): Diagnostic[] => {
    const doc = view.state.doc
    const sql = doc.toString()
    const cursorLineNo = doc.lineAt(view.state.selection.main.head).number
    const out: Diagnostic[] = []
    for (const d of sqlDiagnostics(sql, { tables: getTables() })) {
      // 光标行上的"未闭合"语法错误正在输入中,先不报(与 redis linter 的 lenient 一致)。
      if (d.severity === 'error' && d.startLine === cursorLineNo && /未闭合/.test(d.message)) continue
      const fromLine = doc.line(Math.min(Math.max(d.startLine, 1), doc.lines))
      const toLine = doc.line(Math.min(Math.max(d.endLine, 1), doc.lines))
      const from = Math.min(fromLine.from + d.startColumn - 1, fromLine.to)
      const to = Math.min(Math.max(toLine.from + d.endColumn - 1, from + 1), toLine.to + 1)
      out.push({ from, to, severity: d.severity, message: d.message })
    }
    return out
  }
}
