/* Catio data model types — derived from ref-ui/_extract/blob10.txt (window.DATA) */

// ---- Connection / Vault ----

export type ConnKind = 'host' | 'db'
export type ConnStatus = 'up' | 'idle' | 'down'

export interface Group {
  id: string
  name: string
  color: string
}

export interface ConnStats {
  cpu: number
  mem: number
  up: string
}

export interface Connection {
  id: string
  group: string
  kind: ConnKind
  name: string
  sub: string
  icon: string
  status: ConnStatus
  tags?: string[]
  lastUsed?: string
  proto?: 'ssh' | 'telnet' | 'local'
  os?: string
  /** Protocol family (DbType) — drives DDL dialect / quoting. Keep this the
   *  family (e.g. "mysql"), not a catalog variant id, so dialect selection stays
   *  correct for MySQL-wire engines (TiDB, GoldenDB, …). */
  engine?: string
  /** Engine-catalog id (e.g. "cockroachdb") — drives the brand logo/glyph only.
   *  Falls back to `engine` when absent. */
  engineId?: string
  tunnel?: string
  stats?: ConnStats
}

// ---- Engine / OS metadata ----

export interface EngineMeta {
  label: string
  short: string
  color: string
}

export interface OsMeta {
  label: string
  color: string
}

// ---- Schema browser ----

export interface SchemaTable {
  name: string
  rows: string
  cols: number
  pinned?: boolean
}

export interface SchemaView {
  name: string
}

export interface SchemaFunction {
  name: string
}

export interface SchemaNamespace {
  name: string
  open?: boolean
  tables: SchemaTable[]
  views: SchemaView[]
  functions: SchemaFunction[]
}

export interface Schema {
  db: string
  schemas: SchemaNamespace[]
}

// ---- Orders columns and rows ----

export interface TableCol {
  name: string
  type: string
  pk?: boolean
  fk?: boolean
  icon: string
}

// ---- 查询结果（通用行）----
export interface ResultColumn {
  name: string
  type: string
  pk?: boolean
  fk?: boolean
  /** Explicit icon name; overrides type-derived icon in DataGrid. Set from mock data; absent for real DB columns. */
  icon?: string
}
export interface QueryResult {
  columns: ResultColumn[]
  rows: unknown[][]
  rowsAffected?: number
  truncated?: boolean
}

export interface OrderRow {
  id: number
  customer_id: number
  _customer: string
  status: string
  total_cents: number
  currency: string
  items: number
  channel: string
  created_at: string
  updated_at: string
}

// ---- Table structures (DBX Structure tab) ----

export interface StructColumn {
  name: string
  type: string
  nullable: boolean
  default: string | null
  key: 'PK' | 'FK' | 'UNI' | ''
  extra: string
}

export interface StructIndex {
  name: string
  cols: string
  unique: boolean
  method: string
}

export interface StructFk {
  col: string
  ref: string
  onDelete: string
  onUpdate: string
}

export interface TableStructure {
  comment: string
  columns: StructColumn[]
  indexes: StructIndex[]
  fks: StructFk[]
}

// ---- ER model ----

export interface ErTable {
  name: string
  x: number
  y: number
}

export interface ErRelation {
  from: string
  fromCol: string
  to: string
  toCol: string
}

export interface ErModel {
  tables: ErTable[]
  relations: ErRelation[]
}

// ---- Recent sessions ----

export interface Recent {
  id: string
  kind: ConnKind
  ref: string
  title: string
  detail: string
  when: string
  icon: string
  accent: string
}

// ---- AI agent threads ----

export interface AgentStep {
  kind: 'sql' | 'shell'
  target: string
  label: string
  code: string
  result: string
  tone: string
}

export interface AgentSnippet {
  kind: 'sql' | 'shell'
  action: string
  target: string
  code: string
  result: string
}

/** Covers both aiThread messages (steps + text2) and aiSql/aiShell messages (snippet + text2) */
export interface ChatMessage {
  role: 'user' | 'agent'
  text: string
  /** Multi-step execution blocks (aiThread agent messages) */
  steps?: AgentStep[]
  /** Follow-up text after steps or snippet */
  text2?: string
  /** Single generated/optimised snippet (aiSql / aiShell agent messages) */
  snippet?: AgentSnippet
}

// ---- AI quick actions ----

export interface QuickAction {
  icon: string
  label: string
}

export interface AiQuickActions {
  sql: QuickAction[]
  shell: QuickAction[]
}

// ---- Snippets ----

export interface Snippet {
  id: string
  scope: string
  desc: string
  icon: string
  code: string
}

// ---- SFTP ----

export interface SftpItem {
  name: string
  /** Absolute remote path of this entry. */
  path: string
  type: 'dir' | 'file' | 'link'
  /** Size in bytes (0 for directories). */
  size: number
  /** Modified time, unix epoch seconds (0 if unknown). */
  modified: number
  /** Permission string, e.g. "drwxr-xr-x". */
  permissions: string
  owner: string
  group: string
}

export interface Sftp {
  path: string
  items: SftpItem[]
}

/** Progress payload for a `transfer-progress-{id}` event. */
export interface TransferProgress {
  id: string
  filename: string
  bytesTransferred: number
  totalBytes: number
  percent: number
}

// ---- Terminal buffer ----

export interface TermLine {
  t: 'sys' | 'prompt' | 'out' | 'err'
  s?: string
  host?: string
  path?: string
  cmd?: string
  cursor?: boolean
}

// ---- Tunnels ----

export interface Tunnel {
  id: string
  type: 'L' | 'R' | 'D'
  label: string
  via: string
  local: string
  remote: string
  status: ConnStatus
  bytes: string
  engine?: string
}

// ---- Jump chain ----

export type JumpNodeKind = 'local' | 'jump' | 'target'

export interface JumpNode {
  name: string
  kind: JumpNodeKind
  detail?: string
}

// ---- Monitoring ----

export interface Gpu {
  idx: number
  name: string
  util: number[]
  utilNow: number
  memUsed: number
  memTotal: number
  temp: number
  power: number
  powerCap: number
  fan: number
  procs: string
}

export interface Proc {
  pid: number
  cmd: string
  cpu: number
  mem: number
}

export interface Monitor {
  host: string
  cpu: number[]
  mem: number[]
  net: number[]
  disk: number
  /** Total / used root-filesystem size, human-readable (e.g. "500 GB"). */
  diskTotal: string
  diskUsed: string
  cores: number
  memTotal: string
  memUsed: string
  gpus: Gpu[]
  procs: Proc[]
}

// ---- Multi-Exec ----

export type MultiExecState = 'done' | 'running' | 'queued' | 'error'

export interface MultiExecTarget {
  id: string
  name: string
  state: MultiExecState
  out: string
}

export interface MultiExec {
  cmd: string
  targets: MultiExecTarget[]
}

// ---- History ----

export interface HistoryItem {
  id: string
  kind: 'sql' | 'shell'
  target: string
  text: string
  when: string
  dur: string
  exitCode?: number
  /** Absolute epoch seconds — used to interleave SSH + DB history into one timeline. */
  ts?: number
}

// ---- Automation ----

export interface Automation {
  id: string
  name: string
  kind: 'ansible' | 'opentofu'
  desc: string
  hosts: number
}

// ---- Tabs ----

export interface Tab {
  id: string
  kind: 'terminal' | 'sql'
  connId: string
  title: string
  /** Live SSH session id (ORCH). Omitted for demo/mock tabs. */
  sessionId?: string
}

// ---- Top-level DATA shape ----

export interface CatioData {
  groups: Group[]
  connections: Connection[]
  engineMeta: Record<string, EngineMeta>
  osMeta: Record<string, OsMeta>
  schema: Schema
  ordersColumns: TableCol[]
  ordersRows: OrderRow[]
  statusTones: Record<string, string>
  sampleSQL: string
  recent: Recent[]
  aiThread: ChatMessage[]
  aiSql: ChatMessage[]
  aiShell: ChatMessage[]
  aiQuickActions: AiQuickActions
  snippets: Snippet[]
  termLines: TermLine[]
  tunnels: Tunnel[]
  jumpChain: JumpNode[]
  monitor: Monitor
  multiExec: MultiExec
  history: HistoryItem[]
  automation: Automation[]
  tableStructures: Record<string, TableStructure>
  erModel: ErModel
  byId: Record<string, Connection>
}
