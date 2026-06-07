import { DATA } from './mockData'
import type {
  Connection,
} from './types'

export async function listConnections(): Promise<Connection[]> { return DATA.connections }

export { DATA }

export { fetchModels, testModel } from './models'
export type { ModelTestResult } from './models'

export { getTermBuffer, getSftp, getTunnels, getMonitor } from './ssh'

export { runQuery, getSchema, dbConnect, dbDisconnect, getHistory, getSnippets, saveSnippet } from './db'
export type { QueryResult } from './types'
export type { DbType, DbConnectArgs, DbConnectResult, DbCapabilities } from './db'
