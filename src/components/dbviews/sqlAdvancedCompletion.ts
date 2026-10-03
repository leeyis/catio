/**
 * 高级 SQL 补全的纯函数候选生成器(对标 dbx 的 sqlCompletion.ts:
 * getSqlFunctionSignatureHelp + 函数库、外键 JOIN 建议)。无 DB I/O、无 CodeMirror
 * 依赖,可被单测覆盖;由 SqlConsole 接线到 @codemirror/lang-sql 的补全扩展。
 *
 * 设计取舍(简单优先):聚焦本批两件事——(a) 函数签名/参数提示 + 函数名补全,
 * (b) 基于已加载 schema 外键关系的 JOIN 建议。表/列补全仍由现有 lang-sql +
 * editorSchema 负责,这里不重复实现,避免与之冲突。
 */
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { dialectFor } from './sqlDialect'
import { completionIdentifier } from './sqlCompletionSchema'
import type { EditorState } from '@codemirror/state'
import { sqlCallContext, sqlCallContextAt, type SqlCallContext } from './sqlSignatureContext'

// ---- 函数签名库(通用 + 按引擎方言扩充) ----
// 参数名仅用于展示与占位模板,不做类型校验。

const COMMON_FUNCTION_SIGNATURES: Record<string, string[]> = {
  // 聚合
  COUNT: ['expression'],
  SUM: ['expression'],
  AVG: ['expression'],
  MIN: ['expression'],
  MAX: ['expression'],
  GROUP_CONCAT: ['expression', 'separator'],
  STRING_AGG: ['expression', 'separator'],
  ARRAY_AGG: ['expression'],
  // 字符串
  CONCAT: ['value', '...values'],
  CONCAT_WS: ['separator', '...values'],
  SUBSTRING: ['string', 'start', 'length'],
  SUBSTR: ['string', 'start', 'length'],
  REPLACE: ['string', 'old', 'new'],
  TRIM: ['string'],
  LTRIM: ['string'],
  RTRIM: ['string'],
  UPPER: ['string'],
  LOWER: ['string'],
  LENGTH: ['string'],
  CHAR_LENGTH: ['string'],
  LPAD: ['string', 'length', 'pad'],
  RPAD: ['string', 'length', 'pad'],
  INSTR: ['string', 'substring'],
  LOCATE: ['substring', 'string'],
  REVERSE: ['string'],
  REPEAT: ['string', 'count'],
  FORMAT: ['number', 'decimals'],
  REGEXP_REPLACE: ['string', 'pattern', 'replacement'],
  // 日期 / 时间
  DATE_FORMAT: ['date', 'format'],
  DATEDIFF: ['date1', 'date2'],
  TIMESTAMPDIFF: ['unit', 'datetime1', 'datetime2'],
  DATE_ADD: ['date', 'interval'],
  DATE_SUB: ['date', 'interval'],
  EXTRACT: ['unit', 'date'],
  YEAR: ['date'],
  MONTH: ['date'],
  DAY: ['date'],
  HOUR: ['datetime'],
  MINUTE: ['datetime'],
  SECOND: ['datetime'],
  STR_TO_DATE: ['string', 'format'],
  NOW: [],
  CURDATE: [],
  CURTIME: [],
  // 数值
  ROUND: ['number', 'decimals'],
  FLOOR: ['number'],
  CEIL: ['number'],
  CEILING: ['number'],
  ABS: ['number'],
  MOD: ['dividend', 'divisor'],
  POWER: ['base', 'exponent'],
  SQRT: ['number'],
  SIGN: ['number'],
  // 条件
  COALESCE: ['value', '...values'],
  IFNULL: ['expression', 'fallback'],
  NULLIF: ['expression1', 'expression2'],
  CAST: ['expression', 'type'],
  CONVERT: ['expression', 'type'],
  GREATEST: ['...values'],
  LEAST: ['...values'],
  IIF: ['condition', 'true_value', 'false_value'],
  // 哈希
  MD5: ['string'],
  SHA1: ['string'],
  SHA2: ['string', 'bit_length'],
  UUID: [],
  // JSON
  JSON_EXTRACT: ['json', 'path'],
  JSON_VALUE: ['json', 'path'],
  JSON_QUERY: ['json', 'path'],
  JSON_OBJECT: ['key', 'value', '...pairs'],
  JSON_ARRAY: ['...values'],
  JSON_SET: ['json', 'path', 'value'],
  JSON_REMOVE: ['json', 'path'],
  JSON_CONTAINS: ['json', 'value'],
  JSON_LENGTH: ['json'],
  JSON_KEYS: ['json'],
  // 窗口
  ROW_NUMBER: [],
  RANK: [],
  DENSE_RANK: [],
  LAG: ['expression', 'offset'],
  LEAD: ['expression', 'offset'],
  NTILE: ['buckets'],
}

const POSTGRES_FUNCTION_SIGNATURES: Record<string, string[]> = {
  JSONB_BUILD_OBJECT: ['key', 'value', '...pairs'],
  JSONB_AGG: ['expression'],
  TO_JSONB: ['value'],
  JSONB_SET: ['target', 'path', 'new_value'],
  GEN_RANDOM_UUID: [],
}

const MYSQL_FUNCTION_SIGNATURES: Record<string, string[]> = {
  JSON_UNQUOTE: ['json'],
  FIND_IN_SET: ['needle', 'set'],
}

const SQLITE_FUNCTION_SIGNATURES: Record<string, string[]> = {
  STRFTIME: ['format', 'time'],
}

const SQLSERVER_FUNCTION_SIGNATURES: Record<string, string[]> = {
  TRY_CAST: ['expression AS type'],
  TRY_CONVERT: ['type', 'expression'],
  NEWID: [],
  ISNULL: ['expression', 'fallback'],
}

/** Conservative built-in catalog, not a guarantee of server-version/extension availability. */
function functionSignatures(engine?: string): Record<string, string[]> {
  const id = engine?.toLowerCase() ?? 'postgres'
  const syntax = dialectFor(id)
  const family = id === 'duckdb' || id === 'h2' ? id
    : syntax === dialectFor('oracle') ? 'oracle'
    : syntax === dialectFor('postgres') ? 'postgres'
    : syntax === dialectFor('mysql') || syntax === dialectFor('mariadb') ? 'mysql'
    : syntax === dialectFor('sqlite') ? 'sqlite'
    : syntax === dialectFor('sqlserver') ? 'sqlserver' : 'standard'
  const core = 'COUNT SUM AVG MIN MAX COALESCE NULLIF ABS ROUND UPPER LOWER'
  const families: Record<string, string> = {
    postgres: 'STRING_AGG ARRAY_AGG CONCAT CONCAT_WS SUBSTRING SUBSTR REPLACE TRIM LTRIM RTRIM LENGTH CHAR_LENGTH LPAD RPAD REVERSE REPEAT REGEXP_REPLACE NOW FLOOR CEIL CEILING MOD POWER SQRT SIGN GREATEST LEAST MD5 ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    mysql: 'GROUP_CONCAT CONCAT CONCAT_WS SUBSTRING SUBSTR REPLACE TRIM LTRIM RTRIM LENGTH CHAR_LENGTH LPAD RPAD INSTR LOCATE REVERSE REPEAT FORMAT REGEXP_REPLACE DATE_FORMAT DATEDIFF TIMESTAMPDIFF YEAR MONTH DAY HOUR MINUTE SECOND STR_TO_DATE NOW CURDATE CURTIME FLOOR CEIL CEILING MOD POWER SQRT SIGN IFNULL GREATEST LEAST MD5 SHA1 SHA2 UUID JSON_EXTRACT JSON_OBJECT JSON_ARRAY JSON_SET JSON_REMOVE JSON_CONTAINS JSON_LENGTH JSON_KEYS ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    sqlite: 'GROUP_CONCAT SUBSTR SUBSTRING REPLACE TRIM LTRIM RTRIM LENGTH INSTR IFNULL IIF JSON_EXTRACT JSON_OBJECT JSON_ARRAY JSON_SET JSON_REMOVE ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    sqlserver: 'STRING_AGG CONCAT CONCAT_WS SUBSTRING REPLACE TRIM LTRIM RTRIM REVERSE FLOOR CEILING POWER SQRT SIGN IIF JSON_VALUE JSON_QUERY ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    oracle: 'SUBSTR REPLACE TRIM LTRIM RTRIM LENGTH LPAD RPAD INSTR REGEXP_REPLACE FLOOR CEIL MOD POWER SQRT SIGN GREATEST LEAST ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    duckdb: 'STRING_AGG ARRAY_AGG GROUP_CONCAT CONCAT CONCAT_WS SUBSTRING SUBSTR REPLACE TRIM LTRIM RTRIM LENGTH CHAR_LENGTH LPAD RPAD REVERSE REPEAT REGEXP_REPLACE NOW FLOOR CEIL CEILING MOD POWER SQRT SIGN GREATEST LEAST IFNULL MD5 JSON_EXTRACT JSON_OBJECT JSON_ARRAY ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
    h2: 'CONCAT CONCAT_WS SUBSTRING SUBSTR REPLACE TRIM LTRIM RTRIM LENGTH CHAR_LENGTH LPAD RPAD INSTR FLOOR CEIL CEILING MOD POWER SQRT SIGN GREATEST LEAST IFNULL ROW_NUMBER RANK DENSE_RANK LAG LEAD NTILE',
  }
  const extra: Record<string, Record<string, string[]>> = {
    postgres: {
      // Avoid advertising PG-only JSONB/UUID extensions on every wire-compatible vendor.
      ...(id === 'postgres' ? POSTGRES_FUNCTION_SIGNATURES : {}),
      DATE_TRUNC: ['field', 'source'], SPLIT_PART: ['string', 'delimiter', 'field'], ARRAY_LENGTH: ['array', 'dimension'],
    },
    mysql: { ...MYSQL_FUNCTION_SIGNATURES, DATE_ADD: ['date', 'INTERVAL value unit'], DATE_SUB: ['date', 'INTERVAL value unit'], CONVERT: ['expression', 'type'] },
    sqlite: { ...SQLITE_FUNCTION_SIGNATURES, JSON_ARRAY_LENGTH: ['json'], TYPEOF: ['value'], DATE: ['timevalue'], TIME: ['timevalue'], DATETIME: ['timevalue'], JULIANDAY: ['timevalue'] },
    sqlserver: {
      ...SQLSERVER_FUNCTION_SIGNATURES, LEN: ['string'], GETDATE: [], SYSDATETIME: [],
      DATEDIFF: ['datepart', 'startdate', 'enddate'], DATEADD: ['datepart', 'number', 'date'],
      CONVERT: ['type', 'expression'], FORMAT: ['value', 'format'],
    },
    oracle: { NVL: ['expression', 'fallback'], NVL2: ['expression', 'not_null', 'is_null'], CONCAT: ['left', 'right'], TO_CHAR: ['value', 'format'], TO_DATE: ['string', 'format'], TO_NUMBER: ['string'], SYS_GUID: [] },
    duckdb: { DATE_TRUNC: ['part', 'timestamp'], STRFTIME: ['timestamp', 'format'], LIST_VALUE: ['...values'], STRING_SPLIT: ['string', 'separator'], DATE_DIFF: ['part', 'startdate', 'enddate'] },
    h2: { RANDOM_UUID: [], CURRENT_SCHEMA: [], },
  }
  const names = (core + ' ' + (families[family] ?? '')).trim().split(/\s+/)
  const functions = Object.fromEntries(names.map(name => [name, COMMON_FUNCTION_SIGNATURES[name]]))
  return {
    ...functions, ...extra[family], CAST: ['expression AS type'],
    ...(['postgres','mysql','oracle','duckdb','h2'].includes(family) ? { EXTRACT: ['field FROM source'] } : {}),
  }
}

export interface SqlFunctionSignatureHelp {
  name: string
  /** 形如 `SUBSTRING(string, start, length)`。 */
  signature: string
  /** 当前光标所在参数下标(0-based),封顶在 parameters.length-1。 */
  activeParameter: number
  parameters: string[]
  separator: string
  from: number
}

function signatureFor(call: SqlCallContext | null, engine?: string): SqlFunctionSignatureHelp | null {
  if (!call) return null
  const raw = functionSignatures(engine)[call.name]
  if (!raw) return null
  const separator = /^(?:TRY_)?CAST$/.test(call.name) ? ' AS ' : call.name === 'EXTRACT' ? ' FROM ' : ', '
  const parameters = separator === ', ' ? raw : raw[0].split(separator)
  return { name: call.name, signature: call.name + '(' + raw.join(', ') + ')', parameters, separator, from: call.from,
    activeParameter: Math.min(separator === ', ' ? call.argument : call.namedArgument, Math.max(0, parameters.length - 1)) }
}

export function sqlFunctionSignatureHelp(sql: string, cursor: number, engine?: string): SqlFunctionSignatureHelp | null {
  return signatureFor(sqlCallContext(sql, cursor, engine), engine)
}

export function sqlFunctionSignatureHelpAt(state: EditorState, engine?: string): SqlFunctionSignatureHelp | null {
  return signatureFor(sqlCallContextAt(state), engine)
}

export interface FunctionCompletionItem {
  label: string
  /** 插入文本,携带占位参数(无参函数只带空括号)。 */
  apply: string
  /** 悬浮明细:函数签名。 */
  detail: string
}

function matchesPrefix(name: string, prefix: string): boolean {
  if (!prefix) return true
  return name.toUpperCase().startsWith(prefix.toUpperCase())
}

/**
 * 函数名补全候选:按前缀(大小写不敏感)给出函数,apply 携带占位参数模板。
 * 占位参数是裸名(非 CodeMirror snippet 占位),保证插入后仍是可编辑的可见模板。
 */
export function functionCompletions(prefix: string, engine?: string): FunctionCompletionItem[] {
  const sigs = functionSignatures(engine)
  const items: FunctionCompletionItem[] = []
  for (const name of Object.keys(sigs)) {
    if (!matchesPrefix(name, prefix)) continue
    const params = sigs[name]
    const signature = `${name}(${params.join(', ')})`
    items.push({ label: name, apply: signature, detail: signature })
  }
  // 稳定排序:与前缀完全匹配/更短者优先,其余按字母序。
  items.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label))
  return items
}

// ---- 外键 JOIN 建议 ----

export interface JoinForeignKey {
  column: string
  refTable: string
  refColumn: string
}

export interface JoinTable {
  name: string
  columns: string[]
  foreignKeys: JoinForeignKey[]
}

export interface JoinSuggestionItem {
  /** 形如 `JOIN users ON orders.user_id = users.id`。 */
  label: string
  /** 插入文本(标识符按方言加引用)。 */
  apply: string
  detail: string
}

/** Use the same profile-aware quoting as editor identifier completion. */
const quoteIdent = completionIdentifier

/** 抽取当前语句中已被 FROM/JOIN 引用的表名(小写)。 */
function referencedTableNames(before: string): string[] {
  const cleaned = before.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  const names: string[] = []
  const re = /\b(?:from|join)\s+([A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    const raw = m[1]
    const bare = raw.includes('.') ? raw.split('.').pop()! : raw
    names.push(bare.toLowerCase())
  }
  return names
}

// 子句关键字:出现在已有 FROM/JOIN 之后则离开了表名上下文(进入 WHERE/SELECT 等)。
const CLAUSE_AFTER_TABLE = /\b(?:where|group\s+by|order\s+by|having|limit|offset|union|intersect|except|set|values|returning)\b/i

/**
 * 是否处于 FROM/JOIN 表名上下文(可给 JOIN 建议)。
 *
 * 命中条件:语句已出现 FROM(进入了表区),且在最后一个 FROM/JOIN 之后没有出现
 * WHERE/GROUP BY 等离开表区的子句关键字。这样 `FROM orders `、`FROM orders JOIN `、
 * `LEFT JOIN ` 都算表上下文,而 `FROM orders WHERE ` 不算。
 */
function inFromOrJoinContext(before: string): boolean {
  const cleaned = before.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')
  const lastFromOrJoin = Math.max(
    cleaned.toLowerCase().lastIndexOf(' from '),
    cleaned.toLowerCase().lastIndexOf(' join '),
  )
  // 也接受句首 "FROM "(无前导空格,实际罕见,语句多以 SELECT 开头)。
  const fromIdx = lastFromOrJoin >= 0 ? lastFromOrJoin : (/^\s*from\b/i.test(cleaned) ? 0 : -1)
  if (fromIdx < 0) return false
  // 最后一个 from/join 之后若出现离开表区的子句关键字,则不在表上下文。
  const after = cleaned.slice(fromIdx)
  return !CLAUSE_AFTER_TABLE.test(after)
}

/**
 * 外键 JOIN 建议:基于已加载 schema 的外键关系,在 FROM/JOIN 上下文给出
 * `JOIN b ON a.fk = b.pk` 候选。以语句中已引用的表为锚,找与之有外键关系
 * (任一方向)且尚未被引用的表,生成 JOIN 候选。对标 dbx 的 buildJoinConditionItems
 * 中的外键路径(此处只取确切外键,不做列名启发式,避免误报)。
 */
export function joinSuggestions(before: string, tables: JoinTable[], engine?: string): JoinSuggestionItem[] {
  if (!inFromOrJoinContext(before)) return []
  const referenced = referencedTableNames(before)
  if (referenced.length === 0) return []
  const referencedSet = new Set(referenced)

  const byName = new Map<string, JoinTable>()
  for (const t of tables) byName.set(t.name.toLowerCase(), t)

  const items: JoinSuggestionItem[] = []
  const seen = new Set<string>()

  const push = (joinTable: string, ownerTable: string, ownerCol: string, refTable: string, refCol: string) => {
    // owner.col = ref.col,其中 joinTable 是被 JOIN 进来的新表。
    const label = `JOIN ${joinTable} ON ${ownerTable}.${ownerCol} = ${refTable}.${refCol}`
    if (seen.has(label)) return
    seen.add(label)
    const apply = `JOIN ${quoteIdent(joinTable, engine)} ON ${quoteIdent(ownerTable, engine)}.${quoteIdent(ownerCol, engine)} = ${quoteIdent(refTable, engine)}.${quoteIdent(refCol, engine)}`
    items.push({ label, apply, detail: 'FK JOIN' })
  }

  for (const anchorName of referencedSet) {
    const anchor = byName.get(anchorName)
    if (!anchor) continue

    // 方向 1:锚表的外键指向另一张表 → JOIN 被指向的表。
    for (const fk of anchor.foreignKeys) {
      const target = fk.refTable.toLowerCase()
      if (referencedSet.has(target)) continue
      if (!byName.has(target)) continue
      push(byName.get(target)!.name, anchor.name, fk.column, byName.get(target)!.name, fk.refColumn)
    }

    // 方向 2:其它表的外键指向锚表 → JOIN 那张持有外键的表。
    for (const other of tables) {
      const otherName = other.name.toLowerCase()
      if (otherName === anchorName || referencedSet.has(otherName)) continue
      for (const fk of other.foreignKeys) {
        if (fk.refTable.toLowerCase() !== anchorName) continue
        push(other.name, other.name, fk.column, anchor.name, fk.refColumn)
      }
    }
  }

  return items
}

// ---- CodeMirror 接线 ----

/**
 * 构建一个 CodeMirror CompletionSource,在 lang-sql 内置补全之外追加:
 *   - 函数名补全(apply 携带占位参数,detail 显示签名)
 *   - 外键 JOIN 建议(FROM/JOIN 上下文,基于 getJoinTables() 的外键关系)
 *
 * `engine` 与 `getJoinTables` 惰性读取,使补全源标识稳定(schema/FK 加载不重建编辑器)。
 * 与内置补全合并显示——这里只追加候选,不接管表/列/关键字补全(不退化)。
 */
export function sqlAdvancedCompletion(
  getEngine: () => string | undefined,
  getJoinTables: () => JoinTable[],
) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos)
    const engine = getEngine()

    // 末尾的裸标识符(函数前缀)。`word` 为 null 且非显式触发时不弹窗。
    const word = context.matchBefore(/[A-Za-z_][\w$]*/)
    const options: Completion[] = []

    // 外键 JOIN 建议(在 FROM/JOIN 上下文)。from 取当前已输入的 word 起点(若有),
    // 否则取光标处——JOIN 候选整体替换从词首到光标的文本。
    const joins = joinSuggestions(before, getJoinTables(), engine)
    for (const j of joins) {
      options.push({ label: j.label, apply: j.apply, detail: j.detail, type: 'snippet', boost: 50 })
    }

    // 函数名补全:仅当正在输入一个裸标识符(有前缀)时给,避免空白处刷出整库函数。
    if (word && word.text) {
      for (const f of functionCompletions(word.text, engine)) {
        options.push({ label: f.label, apply: f.apply, detail: f.detail, type: 'function' })
      }
    }

    if (options.length === 0) return null
    return {
      from: word ? word.from : context.pos,
      options,
      validFor: /[\w$]*/,
    }
  }
}
