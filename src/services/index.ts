import { DATA } from './mockData'
import type {
  Connection,
  TableCol,
  OrderRow,
  Schema,
  HistoryItem,
  Snippet,
} from './types'

export interface QueryResult { columns: TableCol[]; rows: OrderRow[] }

export async function listConnections(): Promise<Connection[]> { return DATA.connections }

export async function runQuery(_connId: string, _sql: string): Promise<QueryResult> {
  return { columns: DATA.ordersColumns, rows: DATA.ordersRows }
}

export async function getSchema(_connId: string): Promise<Schema> { return DATA.schema }

export async function getHistory(_connId: string): Promise<HistoryItem[]> { return DATA.history }

export async function getSnippets(): Promise<Snippet[]> { return DATA.snippets }

export { DATA }

export { fetchModels, testModel } from './models'
export type { ModelTestResult } from './models'

export { getTermBuffer, sftpList, sftpRealpath, getTunnels, getMonitor } from './ssh'
