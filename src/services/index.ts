import { DATA } from './mockData'
import type {
  Connection,
  TableCol,
  OrderRow,
  Schema,
  TermLine,
  Sftp,
  Tunnel,
  HistoryItem,
  Snippet,
  Monitor,
} from './types'

export interface QueryResult { columns: TableCol[]; rows: OrderRow[] }

export async function listConnections(): Promise<Connection[]> { return DATA.connections }

export async function runQuery(_connId: string, _sql: string): Promise<QueryResult> {
  return { columns: DATA.ordersColumns, rows: DATA.ordersRows }
}

export async function getSchema(_connId: string): Promise<Schema> { return DATA.schema }

export async function getTermBuffer(_connId: string): Promise<TermLine[]> { return DATA.termLines }

export async function getSftp(_connId: string): Promise<Sftp> { return DATA.sftp }

export async function getTunnels(_connId: string): Promise<Tunnel[]> { return DATA.tunnels }

export async function getMonitor(_connId: string): Promise<Monitor> { return DATA.monitor }

export async function getHistory(_connId: string): Promise<HistoryItem[]> { return DATA.history }

export async function getSnippets(): Promise<Snippet[]> { return DATA.snippets }

export { DATA }

export { fetchModels } from './models'
