import { describe, it, expect } from 'vitest'
import {
  supportsExplainPlan,
  parseExplainResult,
  flattenExplainPlanNodes,
  type ExplainPlanNode,
} from './explainPlan'
import type { QueryResult } from '../../services/types'

/** Helper: wrap a single JSON cell (string, as the backend returns it) in a QueryResult. */
function singleCell(value: unknown): QueryResult {
  return {
    columns: [{ name: 'QUERY PLAN', type: 'json' }],
    rows: [[typeof value === 'string' ? value : JSON.stringify(value)]],
  }
}

describe('supportsExplainPlan', () => {
  it('is true only for postgres and mysql', () => {
    expect(supportsExplainPlan('postgres')).toBe(true)
    expect(supportsExplainPlan('mysql')).toBe(true)
    expect(supportsExplainPlan('sqlite')).toBe(false)
    expect(supportsExplainPlan('mongodb')).toBe(false)
    expect(supportsExplainPlan('redis')).toBe(false)
    expect(supportsExplainPlan(undefined)).toBe(false)
  })
})

describe('parseExplainResult — postgres', () => {
  const pgPlan = [
    {
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'users',
        'Startup Cost': 0.0,
        'Total Cost': 25.5,
        'Plan Rows': 1200,
        'Plan Width': 36,
        Filter: '(id = 1)',
        Plans: [
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'orders',
            'Index Name': 'orders_pkey',
            'Total Cost': 8.3,
            'Plan Rows': 1,
            'Plan Width': 12,
          },
        ],
      },
    },
  ]

  it('parses the root node type, relation, cost, rows and filter detail', () => {
    const parsed = parseExplainResult('postgres', singleCell(pgPlan))
    expect(parsed.databaseType).toBe('postgres')
    expect(parsed.nodes).toHaveLength(1)
    const root = parsed.nodes[0]
    expect(root.nodeType).toBe('Seq Scan')
    expect(root.relation).toBe('users')
    expect(root.title).toBe('Seq Scan on users')
    expect(root.cost).toBe('0..25.5')
    expect(root.rows).toBe('1200')
    expect(root.details).toContain('Filter: (id = 1)')
  })

  it('parses nested child plans recursively with the index name', () => {
    const parsed = parseExplainResult('postgres', singleCell(pgPlan))
    const child = parsed.nodes[0].children[0]
    expect(child.nodeType).toBe('Index Scan')
    expect(child.relation).toBe('orders')
    expect(child.index).toBe('orders_pkey')
    expect(child.children).toHaveLength(0)
  })

  it('accepts an already-parsed object cell (not just a JSON string)', () => {
    const parsed = parseExplainResult('postgres', {
      columns: [{ name: 'QUERY PLAN', type: 'json' }],
      rows: [[pgPlan]],
    })
    expect(parsed.nodes[0].nodeType).toBe('Seq Scan')
  })
})

describe('parseExplainResult — mysql', () => {
  const mysqlPlan = {
    query_block: {
      select_id: 1,
      cost_info: { query_cost: '12.34' },
      table: {
        table_name: 'users',
        access_type: 'ref',
        key: 'idx_name',
        rows_examined_per_scan: 5,
        attached_condition: '(`db`.`users`.`name` = \'a\')',
        using_index: true,
      },
    },
  }

  it('parses the query_block and its table child', () => {
    const parsed = parseExplainResult('mysql', singleCell(mysqlPlan))
    expect(parsed.databaseType).toBe('mysql')
    expect(parsed.nodes).toHaveLength(1)
    const root = parsed.nodes[0]
    expect(root.nodeType).toBe('query_block')
    expect(root.cost).toBe('12.34')
    const table = root.children[0]
    expect(table.nodeType).toBe('ref')
    expect(table.relation).toBe('users')
    expect(table.index).toBe('idx_name')
    expect(table.rows).toBe('5')
    expect(table.details).toContain('Using index')
  })
})

describe('parseExplainResult — 空 / 意外结果', () => {
  // 服务端返回空结果(rows 为空数组)时,明确约定 nodes 为 []:
  // UI 会落到「暂无执行计划」空态,而不是抛错或崩溃。
  it('postgres 空结果 → nodes 为空数组、raw 为 undefined', () => {
    const parsed = parseExplainResult('postgres', { columns: [], rows: [] })
    expect(parsed.nodes).toEqual([])
    expect(parsed.raw).toBeUndefined()
  })

  it('mysql 空结果 → nodes 为空数组', () => {
    const parsed = parseExplainResult('mysql', { columns: [], rows: [] })
    expect(parsed.nodes).toEqual([])
  })
})

describe('flattenExplainPlanNodes', () => {
  it('flattens a tree depth-first into a flat array', () => {
    const tree: ExplainPlanNode[] = [
      {
        id: '0', title: 'a', nodeType: 'a', details: [],
        children: [
          { id: '0.0', title: 'b', nodeType: 'b', details: [], children: [] },
          { id: '0.1', title: 'c', nodeType: 'c', details: [], children: [] },
        ],
      },
    ]
    expect(flattenExplainPlanNodes(tree).map(n => n.id)).toEqual(['0', '0.0', '0.1'])
  })
})
