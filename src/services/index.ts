import { DATA } from './mockData'
import type {
  Connection,
  HistoryItem,
  Snippet,
} from './types'

export async function listConnections(): Promise<Connection[]> { return DATA.connections }

export async function getHistory(_connId: string): Promise<HistoryItem[]> { return DATA.history }

export async function getSnippets(): Promise<Snippet[]> { return DATA.snippets }

export { DATA }

export { fetchModels, testModel } from './models'
export type { ModelTestResult } from './models'

export { getTermBuffer, getSftp, getTunnels, getMonitor } from './ssh'

export { runQuery, getSchema, dbConnect, dbDisconnect } from './db'
export type { QueryResult } from './types'
export type { DbType, DbConnectArgs, DbConnectResult, DbCapabilities } from './db'
