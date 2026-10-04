/**
 * EXPLAIN 执行计划解析(纯函数,易 TDD)。
 * 参考 dbx apps/desktop/src/lib/explainPlan.ts:把 PG 的 `EXPLAIN (FORMAT JSON)` /
 * MySQL 的 `EXPLAIN FORMAT=JSON` 原始结果(单行单列 JSON)解析成统一的可读树结构,
 * 供 ExplainPlanViewer 渲染(树 / 表 / JSON 三视图)。
 * SQL 拼装与执行在后端(db_explain 命令);此处只做解析。
 */
import type { DbType } from '../../services/db'
import type { QueryResult } from '../../services/types'

/** 计划树中的一个节点(操作符)。 */
export interface ExplainPlanNode {
  id: string
  title: string
  nodeType: string
  relation?: string
  index?: string
  cost?: string
  rows?: string
  width?: string
  details: string[]
  children: ExplainPlanNode[]
}

/** 解析后的执行计划:引擎 + 原始 JSON + 节点树。 */
export type ExplainDatabaseType = 'mysql' | 'postgres' | 'sqlite' | 'duckdb' | 'rqlite'
export interface ParsedExplainPlan {
  databaseType: ExplainDatabaseType
  /** Missing/unrecognized rows, truncation or a parser budget must not look complete. */
  incomplete?: boolean
  raw: unknown
  nodes: ExplainPlanNode[]
}

/** 已实现的非执行式计划格式，与后端 supports_explain_plan 对齐。 */
export function supportsExplainPlan(databaseType?: DbType): databaseType is ExplainDatabaseType {
  return databaseType === 'postgres' || databaseType === 'mysql' || databaseType === 'sqlite' || databaseType === 'duckdb' || databaseType === 'rqlite'
}

/** 把后端 db_explain 返回的单行单列 JSON 结果解析成节点树。 */
export function parseExplainResult(databaseType: ExplainDatabaseType, result: QueryResult): ParsedExplainPlan {
  const budget = { remaining: 1000, incomplete: !!result.truncated }
  if (databaseType === 'sqlite' || databaseType === 'rqlite') {
    const nodes = parseSqliteExplain(result, budget)
    return { databaseType, raw: { columns: result.columns.map(c => c.name), rows: result.rows }, nodes, incomplete: budget.incomplete || !nodes.length }
  }
  const valueColumn = databaseType === 'duckdb' ? result.columns.findIndex(column => column.name.toLowerCase() === 'explain_value') : 0
  const raw = parseExplainCell(result.rows[0]?.[Math.max(0, valueColumn)])
  const nodes = databaseType === 'postgres' ? parsePostgresExplain(raw) : databaseType === 'mysql' ? parseMysqlExplain(raw)
    : (Array.isArray(raw) ? raw : [raw]).map((node, index) => parseDuckdbNode(objectValue(node), String(index), budget, 0)).filter((node): node is ExplainPlanNode => !!node)
  return { databaseType, raw, nodes, incomplete: budget.incomplete || !nodes.length }
}

/** 深度优先把树压平成一维数组(供表格视图 / 计数)。 */
export function flattenExplainPlanNodes(nodes: ExplainPlanNode[]): ExplainPlanNode[] {
  const rows: ExplainPlanNode[] = []
  const visit = (node: ExplainPlanNode) => {
    rows.push(node)
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return rows
}

/** 单元格可能是 JSON 字符串(后端常见)或已解析对象/数组,统一成对象。 */
function parseExplainCell(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

interface ParseBudget { remaining: number; incomplete: boolean }
function parseSqliteExplain(result: QueryResult, budget: ParseBudget): ExplainPlanNode[] {
  const position = (name: string) => result.columns.findIndex(column => column.name.toLowerCase() === name)
  const idColumn = position('id'), parentColumn = position('parent'), detailColumn = position('detail')
  if ([idColumn, parentColumn, detailColumn].some(index => index < 0)) { budget.incomplete = true; return [] }
  const nodes = new Map<string, { node: ExplainPlanNode; parent: string }>()
  for (const row of result.rows) {
    if (--budget.remaining < 0) { budget.incomplete = true; break }
    const rawId = row[idColumn], rawParent = row[parentColumn], detail = row[detailColumn]
    if (!Number.isSafeInteger(Number(rawId)) || rawId == null || rawParent == null || !Number.isSafeInteger(Number(rawParent)) || typeof detail !== 'string' || nodes.has(String(rawId))) { budget.incomplete = true; continue }
    const id = String(rawId)
    nodes.set(id, { parent: String(rawParent), node: { id, title: detail, nodeType: detail.split(/\s/)[0], index: /USING(?: COVERING)? INDEX (\S+)/i.exec(detail)?.[1], details: [], children: [] } })
  }
  const roots: ExplainPlanNode[] = []
  for (const [id, item] of nodes) {
    const seen = new Set<string>([id]); let parent = item.parent; let invalid = false
    while (nodes.has(parent) && !(parent === '0' && nodes.get(parent)!.parent === '0')) {
      if (seen.has(parent) || seen.size > 64) { invalid = true; break }
      seen.add(parent); parent = nodes.get(parent)!.parent
    }
    if (invalid) { budget.incomplete = true; continue }
    const owner = nodes.get(item.parent)
    if (owner && item.parent !== id) owner.node.children.push(item.node)
    else roots.push(item.node)
  }
  return roots
}
function parseDuckdbNode(plan: Record<string, unknown> | null, id: string, budget: ParseBudget, depth: number): ExplainPlanNode | null {
  if (!plan || typeof plan.name !== 'string' || --budget.remaining < 0 || depth > 64) { budget.incomplete = true; return null }
  const extra = objectValue(plan.extra_info), relation = stringValue(extra?.Table)
  return { id, nodeType: plan.name, title: relation ? `${plan.name} on ${relation}` : plan.name, relation,
    rows: numberLike(extra?.['Estimated Cardinality']),
    details: extra ? Object.entries(extra).filter(([key]) => !['Table', 'Estimated Cardinality'].includes(key)).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`) : [],
    children: (arrayValue(plan.children) ?? []).map((child, index) => parseDuckdbNode(objectValue(child), `${id}.${index}`, budget, depth + 1)).filter((node): node is ExplainPlanNode => !!node),
  }
}

// ---- Postgres ----

function parsePostgresExplain(raw: unknown): ExplainPlanNode[] {
  const plans = Array.isArray(raw) ? raw : [raw]
  return plans
    .map((item, index) => {
      const root = objectValue(item)
      if (!root) return null
      const plan = objectValue(root.Plan) || root
      return parsePostgresNode(plan, String(index))
    })
    .filter((node): node is ExplainPlanNode => !!node)
}

function parsePostgresNode(plan: Record<string, unknown> | null, id: string): ExplainPlanNode | null {
  if (!plan || typeof plan['Node Type'] !== 'string') return null
  const nodeType = plan['Node Type']
  const relation = stringValue(plan['Relation Name'])
  const index = stringValue(plan['Index Name'])
  const startupCost = numberLike(plan['Startup Cost'])
  const totalCost = numberLike(plan['Total Cost'])
  const rows = numberLike(plan['Plan Rows'])
  const width = numberLike(plan['Plan Width'])
  const filter = stringValue(plan.Filter)
  const joinType = stringValue(plan['Join Type'])
  const sortKey = arrayValue(plan['Sort Key'])?.map(String).join(', ')

  const children =
    arrayValue(plan.Plans)
      ?.map((child, childIndex) => parsePostgresNode(objectValue(child), `${id}.${childIndex}`))
      .filter((node): node is ExplainPlanNode => !!node) ?? []

  return {
    id,
    title: relation ? `${nodeType} on ${relation}` : nodeType,
    nodeType,
    relation,
    index,
    cost: startupCost && totalCost ? `${startupCost}..${totalCost}` : totalCost,
    rows,
    width,
    details: [
      joinType ? `Join: ${joinType}` : '',
      filter ? `Filter: ${filter}` : '',
      sortKey ? `Sort: ${sortKey}` : '',
    ].filter(Boolean),
    children,
  }
}

// ---- MySQL ----

function parseMysqlExplain(raw: unknown): ExplainPlanNode[] {
  const root = objectValue(raw)
  if (!root) return []
  const block = objectValue(root.query_block)
  return block ? [parseMysqlBlock(block, '0', 'query_block')] : []
}

function parseMysqlBlock(block: Record<string, unknown>, id: string, nodeType: string): ExplainPlanNode {
  const costInfo = objectValue(block.cost_info)
  const children: ExplainPlanNode[] = []

  const table = objectValue(block.table)
  if (table) children.push(parseMysqlTable(table, `${id}.0`))

  const nestedLoop = arrayValue(block.nested_loop)
  if (nestedLoop) {
    nestedLoop.forEach(item => {
      const itemObject = objectValue(item)
      if (!itemObject) return
      const nestedTable = objectValue(itemObject.table)
      if (nestedTable) {
        children.push(parseMysqlTable(nestedTable, `${id}.${children.length}`))
        return
      }
      children.push(parseMysqlBlock(itemObject, `${id}.${children.length}`, 'operation'))
    })
  }

  ;['ordering_operation', 'grouping_operation', 'duplicates_removal', 'union_result', 'materialized_from_subquery'].forEach(key => {
    const child = objectValue(block[key])
    if (child) children.push(parseMysqlBlock(child, `${id}.${children.length}`, key))
  })

  return {
    id,
    title: nodeType,
    nodeType,
    cost: stringValue(costInfo?.query_cost),
    // select_id identifies a query block; it is not a row estimate.
    rows: undefined,
    details: [stringValue(block.message)].filter(nonEmptyString),
    children,
  }
}

function parseMysqlTable(table: Record<string, unknown>, id: string): ExplainPlanNode {
  const relation = stringValue(table.table_name)
  const accessType = stringValue(table.access_type) || 'table'
  const costInfo = objectValue(table.cost_info)
  const rows = numberLike(table.rows_examined_per_scan) || numberLike(table.rows_produced_per_join)
  const cost = stringValue(costInfo?.query_cost) || stringValue(costInfo?.read_cost) || stringValue(costInfo?.eval_cost)
  const condition = stringValue(table.attached_condition)
  const usedColumns = arrayValue(table.used_columns)
  const details = [
    condition ? `Condition: ${condition}` : '',
    usedColumns?.length ? `Columns: ${usedColumns.map(String).join(', ')}` : '',
    table.using_index === true ? 'Using index' : '',
  ].filter(Boolean)

  return {
    id,
    title: relation ? `${accessType} on ${relation}` : accessType,
    nodeType: accessType,
    relation,
    index: stringValue(table.key),
    cost,
    rows,
    details,
    children: [],
  }
}

// ---- value coercion helpers ----

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function nonEmptyString(value: string | undefined): value is string {
  return !!value
}

function numberLike(value: unknown): string | undefined {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string' && value.trim()) return value
  return undefined
}
