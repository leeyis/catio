import { DATA } from './mockData'
import type {
  Connection,
  Schema,
  HistoryItem,
  Snippet,
  QueryResult,
  ResultColumn,
} from './types'

function mockQueryResult(): QueryResult {
  const columns: ResultColumn[] = DATA.ordersColumns.map(c => ({
    name: c.name, type: c.type, pk: c.pk, fk: c.fk, icon: c.icon,
  }))
  const keys = DATA.ordersColumns.map(c => c.name)
  const rows: unknown[][] = DATA.ordersRows.map(
    r => keys.map(k => (r as unknown as Record<string, unknown>)[k]),
  )
  return { columns, rows }
}

export async function listConnections(): Promise<Connection[]> { return DATA.connections }

export async function runQuery(_connId: string, _sql: string): Promise<QueryResult> {
  return mockQueryResult()
}

export type { QueryResult } from './types'

export async function getSchema(_connId: string): Promise<Schema> { return DATA.schema }

export async function getHistory(_connId: string): Promise<HistoryItem[]> { return DATA.history }

export async function getSnippets(): Promise<Snippet[]> { return DATA.snippets }

export { DATA }

export { fetchModels, testModel } from './models'
export type { ModelTestResult } from './models'

export { getTermBuffer, getSftp, getTunnels, getMonitor } from './ssh'
