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
export interface ParsedExplainPlan {
  databaseType: 'mysql' | 'postgres'
  raw: unknown
  nodes: ExplainPlanNode[]
}

/** 该引擎是否支持 JSON 执行计划(目前 PG / MySQL)。与后端 supports_explain_plan 对齐。 */
export function supportsExplainPlan(databaseType?: DbType): databaseType is 'mysql' | 'postgres' {
  return databaseType === 'postgres' || databaseType === 'mysql'
}

/** 把后端 db_explain 返回的单行单列 JSON 结果解析成节点树。 */
export function parseExplainResult(databaseType: 'mysql' | 'postgres', result: QueryResult): ParsedExplainPlan {
  const raw = parseExplainCell(result.rows[0]?.[0])
  const nodes = databaseType === 'postgres' ? parsePostgresExplain(raw) : parseMysqlExplain(raw)
  return { databaseType, raw, nodes }
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
  if (!plan) return null
  const nodeType = stringValue(plan['Node Type']) || 'Plan'
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
  const block = objectValue(root.query_block) || root
  return [parseMysqlBlock(block, '0', 'query_block')]
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
    rows: numberLike(block.select_id),
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
