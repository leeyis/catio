/**
 * AI 产出 SQL 的风险分级与执行决策。纯函数 + 单测覆盖。
 *
 * 参考 dbx-ref/apps/desktop/src/lib/aiSqlExecutionPolicy.ts，按 Catio 的 Connection
 * 模型适配:把 AI 生成的 SQL 分类为 read/write/schema_change/dangerous,并结合连接
 * 环境(production / non_production)给出 auto_execute / confirm / block 决策。
 * AIPanel 用它把原本「直通执行」的 catio-run 改为先经分级:危险/结构变更需确认,
 * 阻断类直接拦截。
 */
import type { Connection } from './types'

export type ConnectionEnvironment = 'production' | 'non_production' | 'unknown'
export type AiSqlExecutionAction = 'auto_execute' | 'confirm' | 'block'
export type AiSqlExecutionCategory =
  | 'read'
  | 'low_risk_write'
  | 'write'
  | 'schema_change'
  | 'dangerous'
  | 'unknown'

export interface AiSqlExecutionDecision {
  action: AiSqlExecutionAction
  environment: ConnectionEnvironment
  category: AiSqlExecutionCategory
  reasons: string[]
}

const READ_RE = /^(SELECT|WITH|SHOW|DESCRIBE|DESC)\b/i
const INSERT_RE = /^INSERT\b/i
const UPDATE_RE = /^UPDATE\b/i
const DELETE_RE = /^DELETE\b/i
const CONFIRM_WRITE_RE = /^(MERGE|REPLACE)\b/i
const BLOCK_RE = /^(DROP|TRUNCATE|ALTER|RENAME)\b/i
const SCHEMA_RE = /^(CREATE)\b/i

// WITH 开头但 CTE 体内含数据修改语句(可写 CTE),不能当只读处理。
const DATA_MODIFYING_RE = /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE)\b/i

const PRODUCTION_RE = /\b(prod|prd|production)\b|生产|正式/i
const NON_PRODUCTION_RE =
  /\b(local|localhost|dev|develop|development|test|testing|stage|staging|sandbox|demo)\b|本地|开发|测试|预发/i
const LOCAL_HOST_RE = /(^|\b)(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)(\b|$)/i

/**
 * 把字符串字面量(单引号 / 双引号 / 反引号)替换成一个不含任何关键字的占位字面量,
 * 使其中的关键字(如 WHERE)不会污染基于结构的关键字匹配,同时保留「此处是一个值」
 * 这一结构信息。仅用于结构判定,不改变实际执行的 SQL。
 */
function maskStringLiterals(statement: string): string {
  return statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, "'x'")
}

/**
 * 单遍词法扫描:同时识别字符串字面量与注释,按真实语法上下文处理两者。
 *
 * 不能简单地「先 mask 字面量再剥注释」或「先剥注释再 mask 字面量」——两者都会被
 * 对方的引号 / 注释符号污染:
 *  - 先 mask 再剥注释:注释里的未配对引号(如 `-- '`)会让 mask 的正则跨行吞掉后续
 *    语句(含 `;`),使危险语句逃逸分类(DROP TABLE 被误判为可直通执行)。
 *  - 先剥注释再 mask:字符串里的 `--` / `#` / `/* `会被误当注释剥掉,破坏字面量。
 * 因此从左到右逐字符扫描:遇到引号进入字面量(只在字面量内寻找配对的闭合引号,
 * 注释符号在其中无意义),遇到注释起始符且不在字面量内时跳过整段注释。字面量统一
 * 替换为占位 `'x'`,使其中关键字不污染结构判定;注释整体替换为空格。
 */
export function stripAiSqlComments(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    // 字符串字面量:单引号 / 双引号 / 反引号。引号可由翻倍('')转义。
    if (ch === "'" || ch === '"' || ch === '`') {
      i++
      while (i < n) {
        if (sql[i] === ch) {
          // 翻倍引号是转义,不闭合字面量。
          if (sql[i + 1] === ch) {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += "'x'"
      continue
    }
    // 块注释 /* ... */(不在字面量内才生效)。
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    // 行注释 -- ... 与 # ...(到行尾)。
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    out += ch
    i++
  }
  return out
}

function sqlStatements(sql: string): string[] {
  // 注释剥离与拆分均在 mask 后的副本上进行,确保字符串内的 ; / -- 不破坏语句边界;
  // 分类只看结构关键字,mask 后的占位字面量不影响 read/write/dangerous 判定。
  return stripAiSqlComments(sql)
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean)
}

// EXPLAIN [ANALYZE] [VERBOSE] [( ... )] 前缀。PG 等引擎 EXPLAIN ANALYZE 会真实执行被
// 包裹的语句,因此需剥掉 EXPLAIN 前缀后按内层语句的真实风险分类。
const EXPLAIN_PREFIX_RE = /^EXPLAIN\b\s*(?:\([\s\S]*?\)\s*|(?:ANALYZE|VERBOSE|ANALYSE)\b\s*)*/i

function isScopedUpdate(statement: string): boolean {
  // 先剥离字符串字面量,避免把字符串里的 WHERE 误判为真实条件。
  const masked = maskStringLiterals(statement)
  const whereMatch = masked.match(/\bWHERE\b([\s\S]*)$/i)
  if (!whereMatch) return false
  const where = whereMatch[1]
  if (/\b1\s*=\s*1\b|\btrue\b/i.test(where)) return false
  return /\b[\w"`.[\]]*(?:id|_id|uuid|key)[\w"`.[\]]*\s*=\s*(?:'[^']+'|"[^"]+"|`[^`]+`|[\w.-]+)/i.test(where)
}

function classifyStatement(statement: string): AiSqlExecutionCategory {
  // EXPLAIN [ANALYZE ...] <inner>:按内层语句的真实风险分类。纯 EXPLAIN <SELECT...>
  // 内层仍是 read;EXPLAIN ANALYZE UPDATE/DELETE/DROP 则按其内层(write/dangerous)处理。
  if (EXPLAIN_PREFIX_RE.test(statement)) {
    const inner = statement.replace(EXPLAIN_PREFIX_RE, '').trim()
    // 内层为空(仅 EXPLAIN 关键字,不应出现)按 read 兜底,保持既有「EXPLAIN → read」行为。
    return inner ? classifyStatement(inner) : 'read'
  }
  if (READ_RE.test(statement)) {
    // WITH 可写 CTE(CTE 体内含 INSERT/UPDATE/DELETE/MERGE/REPLACE)不是只读;
    // 剥离字符串字面量后再判定,避免字符串里的关键字误伤。
    if (/^WITH\b/i.test(statement) && DATA_MODIFYING_RE.test(maskStringLiterals(statement))) {
      return 'dangerous'
    }
    return 'read'
  }
  if (BLOCK_RE.test(statement)) return 'dangerous'
  if (SCHEMA_RE.test(statement)) return 'schema_change'
  if (INSERT_RE.test(statement)) return 'low_risk_write'
  if (UPDATE_RE.test(statement)) return isScopedUpdate(statement) ? 'low_risk_write' : 'dangerous'
  if (DELETE_RE.test(statement) || CONFIRM_WRITE_RE.test(statement)) return 'write'
  return 'unknown'
}

/**
 * 从连接的可见信号(名称、子标题、engine)推断环境。Catio 的 Connection 没有独立
 * host/database 字段,可识别的环境线索都在 name / sub 上。
 */
export function classifyConnectionEnvironment(connection?: Connection): ConnectionEnvironment {
  if (!connection) return 'unknown'
  const signal = [connection.name, connection.sub, connection.engine].filter(Boolean).join(' ')
  if (PRODUCTION_RE.test(signal)) return 'production'
  if (LOCAL_HOST_RE.test(signal) || NON_PRODUCTION_RE.test(signal)) return 'non_production'
  return 'unknown'
}

export function classifyAiSqlExecution(sql: string, connection?: Connection): AiSqlExecutionDecision {
  const environment = classifyConnectionEnvironment(connection)
  const statements = sqlStatements(sql)
  const reasons: string[] = []

  if (!statements.length) {
    return { action: 'block', environment, category: 'unknown', reasons: ['empty_sql'] }
  }

  const categories = statements.map(classifyStatement)
  const hasMultipleStatements = statements.length > 1
  if (hasMultipleStatements) reasons.push('multi_statement')

  if (categories.includes('dangerous')) {
    return { action: 'block', environment, category: 'dangerous', reasons }
  }

  if (categories.includes('unknown')) {
    return { action: 'confirm', environment, category: 'unknown', reasons }
  }

  if (categories.every((category) => category === 'read')) {
    return { action: 'auto_execute', environment, category: 'read', reasons }
  }

  if (categories.includes('schema_change')) {
    return { action: 'confirm', environment, category: 'schema_change', reasons }
  }

  if (hasMultipleStatements) {
    return { action: 'confirm', environment, category: 'write', reasons }
  }

  const [category] = categories
  if (category === 'low_risk_write') {
    return {
      action: environment === 'non_production' ? 'auto_execute' : 'confirm',
      environment,
      category,
      reasons,
    }
  }

  return { action: 'confirm', environment, category, reasons }
}
