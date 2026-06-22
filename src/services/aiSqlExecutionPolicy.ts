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

const READ_RE = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i
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

export function stripAiSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/#.*$/gm, ' ')
}

function sqlStatements(sql: string): string[] {
  return stripAiSqlComments(sql)
    .split(';')
    .map((stmt) => stmt.trim())
    .filter(Boolean)
}

/**
 * 把字符串字面量(单引号 / 双引号 / 反引号)替换成一个不含任何关键字的占位字面量,
 * 使其中的关键字(如 WHERE)不会污染基于结构的关键字匹配,同时保留「此处是一个值」
 * 这一结构信息。仅用于结构判定,不改变实际执行的 SQL。
 */
function maskStringLiterals(statement: string): string {
  return statement.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`/g, "'x'")
}

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
