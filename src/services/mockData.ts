/* Catio — mock data. Unifies SSH hosts (Netcatty) + database connections (DBX). */
import type {
  CatioData,
  Group,
  Connection,
  EngineMeta,
  OsMeta,
  Recent,
  ChatMessage,
  Snippet,
  TermLine,
  Tunnel,
  JumpNode,
  MultiExecTarget,
  HistoryItem,
  Automation,
  StructColumn,
  TableStructure,
} from './types'

// ---- Connections: both hosts and databases live in one Vault ----
// kind: 'host' | 'db'
const groups: Group[] = [
  { id: 'prod', name: 'Production', color: 'var(--signal-rose)' },
  { id: 'staging', name: 'Staging', color: 'var(--signal-amber)' },
  { id: 'local', name: 'Local & Tools', color: 'var(--signal-cyan)' },
]

const connections: Connection[] = [
  // Production hosts
  { id: 'h-web1', group: 'prod', kind: 'host', proto: 'ssh', name: 'prod-web-01', sub: 'deploy@10.0.1.21', os: 'ubuntu', icon: 'server', status: 'up', tags: ['nginx', 'app'], lastUsed: '12m', stats: { cpu: 34, mem: 61, up: '142d' } },
  { id: 'h-web2', group: 'prod', kind: 'host', proto: 'ssh', name: 'prod-web-02', sub: 'deploy@10.0.1.22', os: 'ubuntu', icon: 'server', status: 'up', tags: ['nginx', 'app'], lastUsed: '1h', stats: { cpu: 28, mem: 57, up: '142d' } },
  { id: 'h-bastion', group: 'prod', kind: 'host', proto: 'ssh', name: 'db-bastion', sub: 'jump@bastion.catio.io', os: 'alpine', icon: 'shield', status: 'up', tags: ['jump', 'tunnel'], lastUsed: '3m', stats: { cpu: 4, mem: 22, up: '309d' } },
  // Production databases (reachable via bastion tunnel)
  { id: 'd-orders', group: 'prod', kind: 'db', engine: 'postgres', name: 'prod-orders', sub: 'postgres · via db-bastion', icon: 'database', status: 'up', tunnel: 'h-bastion', tags: ['16.2', 'primary'], lastUsed: '3m' },
  { id: 'd-analytics', group: 'prod', kind: 'db', engine: 'clickhouse', name: 'analytics', sub: 'clickhouse · 10.0.4.9:9000', icon: 'database', status: 'up', tags: ['olap'], lastUsed: '2h' },
  { id: 'd-cache', group: 'prod', kind: 'db', engine: 'redis', name: 'sessions-cache', sub: 'redis · 10.0.4.5:6379', icon: 'database', status: 'up', tunnel: 'h-bastion', tags: ['cache'], lastUsed: '5h' },
  { id: 'd-events', group: 'prod', kind: 'db', engine: 'mongo', name: 'events', sub: 'mongodb · 10.0.4.7:27017', icon: 'database', status: 'idle', tunnel: 'h-bastion', tags: ['7.0'], lastUsed: '1d' },
  // Staging
  { id: 'h-stg-api', group: 'staging', kind: 'host', proto: 'ssh', name: 'staging-api', sub: 'dev@10.0.2.31', os: 'debian', icon: 'server', status: 'up', tags: ['api'], lastUsed: '4h', stats: { cpu: 12, mem: 40, up: '23d' } },
  { id: 'd-catalog', group: 'staging', kind: 'db', engine: 'mysql', name: 'catalog-stg', sub: 'mysql · 10.0.2.40:3306', icon: 'database', status: 'up', tunnel: 'h-stg-api', tags: ['8.0'], lastUsed: '4h' },
  { id: 'h-edge', group: 'staging', kind: 'host', proto: 'telnet', name: 'edge-router', sub: 'telnet · 10.0.2.1', os: 'routeros', icon: 'network', status: 'down', tags: ['network'], lastUsed: '3d' },
  // Local & tools
  { id: 'd-local', group: 'local', kind: 'db', engine: 'sqlite', name: 'app.db', sub: 'sqlite · ~/projects/app', icon: 'hard-drive', status: 'up', tags: ['file'], lastUsed: '20m' },
  { id: 'd-duck', group: 'local', kind: 'db', engine: 'duckdb', name: 'events.parquet', sub: 'duckdb · drag-drop file', icon: 'box', status: 'up', tags: ['analytics'], lastUsed: '1d' },
  { id: 'h-local', group: 'local', kind: 'host', proto: 'local', name: 'localhost', sub: 'zsh · /Users/skyler', os: 'macos', icon: 'terminal', status: 'up', tags: ['shell'], lastUsed: 'now' },
]

const engineMeta: Record<string, EngineMeta> = {
  postgres:      { label: 'PostgreSQL',    short: 'PG',    color: 'var(--signal-blue)' },
  mysql:         { label: 'MySQL',          short: 'SQL',   color: 'var(--signal-amber)' },
  clickhouse:    { label: 'ClickHouse',     short: 'CH',    color: 'var(--signal-amber)' },
  redis:         { label: 'Redis',          short: 'RDS',   color: 'var(--signal-rose)' },
  // 'mongo' key kept for backward-compat with existing mock connections (engine: 'mongo')
  mongo:         { label: 'MongoDB',        short: 'MGO',   color: 'var(--signal-green)' },
  // 'mongodb' key matches DbType / DB_ENGINES id — required for dropdown color/short
  mongodb:       { label: 'MongoDB',        short: 'MGO',   color: 'var(--signal-green)' },
  sqlite:        { label: 'SQLite',         short: 'LITE',  color: 'var(--signal-cyan)' },
  duckdb:        { label: 'DuckDB',         short: 'DUCK',  color: 'var(--signal-amber)' },
  sqlserver:     { label: 'SQL Server',     short: 'MSSQL', color: 'var(--signal-blue)' },
  elasticsearch: { label: 'Elasticsearch',  short: 'ES',    color: 'var(--signal-amber)' },
  rqlite:        { label: 'rqlite',         short: 'RQL',   color: 'var(--signal-cyan)' },
}

const osMeta: Record<string, OsMeta> = {
  ubuntu: { label: 'Ubuntu', color: 'var(--signal-amber)' },
  debian: { label: 'Debian', color: 'var(--signal-rose)' },
  alpine: { label: 'Alpine', color: 'var(--signal-blue)' },
  routeros: { label: 'RouterOS', color: 'var(--text-tertiary)' },
  macos: { label: 'macOS', color: 'var(--text-secondary)' },
}

// ---- Schema for prod-orders (postgres) ----
const schema = {
  db: 'prod-orders',
  schemas: [
    {
      name: 'public', open: true,
      tables: [
        { name: 'orders', rows: '1.28M', cols: 9, pinned: true },
        { name: 'customers', rows: '184K', cols: 7 },
        { name: 'line_items', rows: '4.91M', cols: 6 },
        { name: 'payments', rows: '1.31M', cols: 8 },
        { name: 'refunds', rows: '22.4K', cols: 6 },
        { name: 'shipments', rows: '1.19M', cols: 7 },
        { name: 'products', rows: '12.8K', cols: 11 },
      ],
      views: [ { name: 'v_daily_revenue' }, { name: 'v_active_customers' } ],
      functions: [ { name: 'fn_order_total' }, { name: 'fn_refund_window' } ],
    },
  ],
}

const ordersColumns = [
  { name: 'id', type: 'bigint', pk: true, icon: 'hash' },
  { name: 'customer_id', type: 'bigint', fk: true, icon: 'link' },
  { name: 'status', type: 'order_status', icon: 'circle-dot' },
  { name: 'total_cents', type: 'integer', icon: 'dollar-sign' },
  { name: 'currency', type: 'char(3)', icon: 'type' },
  { name: 'items', type: 'smallint', icon: 'hash' },
  { name: 'channel', type: 'varchar', icon: 'type' },
  { name: 'created_at', type: 'timestamptz', icon: 'calendar' },
  { name: 'updated_at', type: 'timestamptz', icon: 'calendar' },
]

const statusTones = {
  paid: 'var(--signal-green)', pending: 'var(--signal-amber)',
  shipped: 'var(--signal-blue)', refunded: 'var(--danger-fg)',
  cancelled: 'var(--text-faint)',
}
const names = ['Mona Reyes','Theo Vance','Priya Nair','Liam Okafor','Sora Kimura','Eli Brandt','Noor Haddad','Jonas Felt','Ada Whitlock','Ravi Menon','Greta Lind','Caleb Ross','Ines Duval','Mika Solberg','Owen Pratt','Yara Saab']
const channels = ['web','ios','android','pos','partner']
const statuses = ['paid','pending','shipped','refunded','cancelled']
function makeRows(n: number) {
  const out = []
  let base = 184213
  for (let i = 0; i < n; i++) {
    const st = statuses[(i * 7 + 3) % statuses.length]
    const cust = 1000 + ((i * 137) % 184000)
    const total = (1200 + ((i * 9173) % 48000))
    const items = 1 + ((i * 3) % 6)
    const day = 1 + ((i * 11) % 27)
    const hr = (i * 7) % 24
    out.push({
      id: base + i,
      customer_id: cust,
      _customer: names[(i) % names.length],
      status: st,
      total_cents: total,
      currency: i % 9 === 0 ? 'EUR' : 'USD',
      items: items,
      channel: channels[(i * 5) % channels.length],
      created_at: `2026-05-${String(day).padStart(2,'0')} ${String(hr).padStart(2,'0')}:${String((i*13)%60).padStart(2,'0')}`,
      updated_at: `2026-05-${String(day).padStart(2,'0')} ${String((hr+2)%24).padStart(2,'0')}:${String((i*17)%60).padStart(2,'0')}`,
    })
  }
  return out
}
const ordersRows = makeRows(120)

const sampleSQL = `select
  o.id,
  o.customer_id,
  o.status,
  o.total_cents,
  o.currency,
  o.items,
  o.channel,
  o.created_at
from orders o
where o.status in ('pending', 'paid')
  and o.created_at >= now() - interval '7 days'
order by o.created_at desc
limit 120;`

// ---- Detailed table structures (DBX "Structure" tab) ----
// each column: name, type, nullable, default, key ('PK'|'FK'|'UNI'|''), extra
const tableStructures: Record<string, TableStructure> = {
  orders: {
    comment: '订单主表 · 每行一笔订单',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: "nextval('orders_id_seq')", key: 'PK', extra: 'identity' },
      { name: 'customer_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ customers.id' },
      { name: 'status', type: 'order_status', nullable: false, default: "'pending'", key: '', extra: 'enum' },
      { name: 'total_cents', type: 'integer', nullable: false, default: '0', key: '', extra: 'check ≥ 0' },
      { name: 'currency', type: 'char(3)', nullable: false, default: "'USD'", key: '', extra: '' },
      { name: 'items', type: 'smallint', nullable: false, default: '1', key: '', extra: '' },
      { name: 'channel', type: 'varchar(16)', nullable: true, default: null, key: '', extra: '' },
      { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', key: '', extra: '' },
      { name: 'updated_at', type: 'timestamptz', nullable: false, default: 'now()', key: '', extra: '' },
    ] as StructColumn[],
    indexes: [
      { name: 'orders_pkey', cols: 'id', unique: true, method: 'btree' },
      { name: 'idx_orders_customer', cols: 'customer_id', unique: false, method: 'btree' },
      { name: 'idx_orders_status_created', cols: 'status, created_at', unique: false, method: 'btree' },
    ],
    fks: [
      { col: 'customer_id', ref: 'customers.id', onDelete: 'restrict', onUpdate: 'cascade' },
    ],
  },
  customers: {
    comment: '客户表',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: "nextval('customers_id_seq')", key: 'PK', extra: 'identity' },
      { name: 'email', type: 'citext', nullable: false, default: null, key: 'UNI', extra: '' },
      { name: 'full_name', type: 'varchar(120)', nullable: false, default: null, key: '', extra: '' },
      { name: 'country', type: 'char(2)', nullable: true, default: null, key: '', extra: '' },
      { name: 'tier', type: 'varchar(12)', nullable: false, default: "'standard'", key: '', extra: '' },
      { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', key: '', extra: '' },
      { name: 'deleted_at', type: 'timestamptz', nullable: true, default: null, key: '', extra: 'soft-delete' },
    ] as StructColumn[],
    indexes: [
      { name: 'customers_pkey', cols: 'id', unique: true, method: 'btree' },
      { name: 'uq_customers_email', cols: 'email', unique: true, method: 'btree' },
    ],
    fks: [],
  },
  line_items: {
    comment: '订单明细行',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: 'identity', key: 'PK', extra: '' },
      { name: 'order_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ orders.id' },
      { name: 'product_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ products.id' },
      { name: 'qty', type: 'smallint', nullable: false, default: '1', key: '', extra: '' },
      { name: 'unit_cents', type: 'integer', nullable: false, default: '0', key: '', extra: '' },
      { name: 'discount_cents', type: 'integer', nullable: false, default: '0', key: '', extra: '' },
    ] as StructColumn[],
    indexes: [
      { name: 'line_items_pkey', cols: 'id', unique: true, method: 'btree' },
      { name: 'idx_li_order', cols: 'order_id', unique: false, method: 'btree' },
    ],
    fks: [
      { col: 'order_id', ref: 'orders.id', onDelete: 'cascade', onUpdate: 'cascade' },
      { col: 'product_id', ref: 'products.id', onDelete: 'restrict', onUpdate: 'cascade' },
    ],
  },
  payments: {
    comment: '支付记录',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: 'identity', key: 'PK', extra: '' },
      { name: 'order_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ orders.id' },
      { name: 'provider', type: 'varchar(20)', nullable: false, default: null, key: '', extra: '' },
      { name: 'amount_cents', type: 'integer', nullable: false, default: '0', key: '', extra: '' },
      { name: 'state', type: 'payment_state', nullable: false, default: "'init'", key: '', extra: 'enum' },
      { name: 'captured_at', type: 'timestamptz', nullable: true, default: null, key: '', extra: '' },
    ] as StructColumn[],
    indexes: [
      { name: 'payments_pkey', cols: 'id', unique: true, method: 'btree' },
      { name: 'idx_pay_order', cols: 'order_id', unique: false, method: 'btree' },
    ],
    fks: [ { col: 'order_id', ref: 'orders.id', onDelete: 'cascade', onUpdate: 'cascade' } ],
  },
  products: {
    comment: '商品目录',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: 'identity', key: 'PK', extra: '' },
      { name: 'sku', type: 'varchar(32)', nullable: false, default: null, key: 'UNI', extra: '' },
      { name: 'title', type: 'varchar(200)', nullable: false, default: null, key: '', extra: '' },
      { name: 'price_cents', type: 'integer', nullable: false, default: '0', key: '', extra: '' },
      { name: 'active', type: 'boolean', nullable: false, default: 'true', key: '', extra: '' },
    ] as StructColumn[],
    indexes: [
      { name: 'products_pkey', cols: 'id', unique: true, method: 'btree' },
      { name: 'uq_products_sku', cols: 'sku', unique: true, method: 'btree' },
    ],
    fks: [],
  },
  refunds: {
    comment: '退款记录',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: 'identity', key: 'PK', extra: '' },
      { name: 'payment_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ payments.id' },
      { name: 'amount_cents', type: 'integer', nullable: false, default: '0', key: '', extra: '' },
      { name: 'reason', type: 'varchar(120)', nullable: true, default: null, key: '', extra: '' },
      { name: 'created_at', type: 'timestamptz', nullable: false, default: 'now()', key: '', extra: '' },
    ] as StructColumn[],
    indexes: [ { name: 'refunds_pkey', cols: 'id', unique: true, method: 'btree' } ],
    fks: [ { col: 'payment_id', ref: 'payments.id', onDelete: 'restrict', onUpdate: 'cascade' } ],
  },
  shipments: {
    comment: '物流发货',
    columns: [
      { name: 'id', type: 'bigint', nullable: false, default: 'identity', key: 'PK', extra: '' },
      { name: 'order_id', type: 'bigint', nullable: false, default: null, key: 'FK', extra: '→ orders.id' },
      { name: 'carrier', type: 'varchar(24)', nullable: false, default: null, key: '', extra: '' },
      { name: 'tracking_no', type: 'varchar(40)', nullable: true, default: null, key: '', extra: '' },
      { name: 'shipped_at', type: 'timestamptz', nullable: true, default: null, key: '', extra: '' },
    ] as StructColumn[],
    indexes: [ { name: 'shipments_pkey', cols: 'id', unique: true, method: 'btree' } ],
    fks: [ { col: 'order_id', ref: 'orders.id', onDelete: 'cascade', onUpdate: 'cascade' } ],
  },
}

// ---- ER model (positions on a 980×680 canvas) ----
const erModel = {
  tables: [
    { name: 'customers', x: 40, y: 40 },
    { name: 'orders', x: 380, y: 40 },
    { name: 'payments', x: 730, y: 40 },
    { name: 'products', x: 40, y: 340 },
    { name: 'line_items', x: 380, y: 320 },
    { name: 'refunds', x: 730, y: 340 },
    { name: 'shipments', x: 380, y: 560 },
  ],
  // relations reference fks already in tableStructures; declared explicitly for drawing
  relations: [
    { from: 'orders', fromCol: 'customer_id', to: 'customers', toCol: 'id' },
    { from: 'line_items', fromCol: 'order_id', to: 'orders', toCol: 'id' },
    { from: 'line_items', fromCol: 'product_id', to: 'products', toCol: 'id' },
    { from: 'payments', fromCol: 'order_id', to: 'orders', toCol: 'id' },
    { from: 'refunds', fromCol: 'payment_id', to: 'payments', toCol: 'id' },
    { from: 'shipments', fromCol: 'order_id', to: 'orders', toCol: 'id' },
  ],
}

// ---- Recent sessions (home) ----
const recent: Recent[] = [
  { id: 'r1', kind: 'db', ref: 'd-orders', title: 'prod-orders', detail: 'orders · 120 rows', when: '3m ago', icon: 'database', accent: 'var(--signal-blue)' },
  { id: 'r2', kind: 'host', ref: 'h-bastion', title: 'db-bastion', detail: 'tunnel + shell', when: '3m ago', icon: 'shield', accent: 'var(--signal-blue)' },
  { id: 'r3', kind: 'host', ref: 'h-web1', title: 'prod-web-01', detail: 'tail -f access.log', when: '12m ago', icon: 'server', accent: 'var(--signal-amber)' },
  { id: 'r4', kind: 'db', ref: 'd-analytics', title: 'analytics', detail: 'funnel_events query', when: '2h ago', icon: 'database', accent: 'var(--signal-amber)' },
  { id: 'r5', kind: 'db', ref: 'd-local', title: 'app.db', detail: 'migrations table', when: '20m ago', icon: 'hard-drive', accent: 'var(--signal-cyan)' },
  { id: 'r6', kind: 'host', ref: 'h-stg-api', title: 'staging-api', detail: 'pm2 restart api', when: '4h ago', icon: 'server', accent: 'var(--signal-rose)' },
]

// ---- AI agent conversation (spans shell + SQL) ----
const aiThread: ChatMessage[] = [
  { role: 'user', text: 'orders 表里过去 7 天有多少笔 pending 订单卡住没付款？顺便看下 web-01 的负载。' },
  { role: 'agent', text: '我先在 prod-orders 上跑一条聚合，再去 prod-web-01 看负载。', steps: [
    { kind: 'sql', target: 'prod-orders', label: 'SELECT 聚合', code: "select count(*) as stuck, sum(total_cents)/100.0 as usd\nfrom orders\nwhere status = 'pending'\n  and created_at < now() - interval '24 hours';", result: 'stuck = 1,284 · usd = 312,940.00', tone: 'var(--signal-blue)' },
    { kind: 'shell', target: 'prod-web-01', label: 'uptime', code: 'uptime && free -m | awk \'/Mem/{print $3"/"$2" MB"}\'', result: 'load 0.34 0.41 0.39 · 9.6/16 GB', tone: 'var(--signal-amber)' },
  ], text2: '有 **1,284** 笔 pending 订单超过 24h 未付款，合计约 **$312,940**。web-01 负载正常（0.34），不是性能问题——更像支付回调堆积。要我把这批订单导出成 CSV，或在 bastion 上查支付队列吗？' },
  { role: 'user', text: '在 bastion 上看下支付队列长度。' },
  { role: 'agent', text: '', steps: [
    { kind: 'shell', target: 'db-bastion', label: 'redis-cli', code: 'redis-cli -h 10.0.4.5 LLEN payment:callbacks', result: '(integer) 1291', tone: 'var(--signal-blue)' },
  ], text2: '队列里积压 **1,291** 条回调，和卡住的订单数几乎一致 ✅。问题定位为支付回调消费者停摆。建议：重启 staging-api 上的 callback worker，或我帮你生成补偿脚本。' },
]

// ---- Context-scoped AI assistant threads ----
// SQL mode — only SQL: NL→SQL, optimize, explain, comment. Snippets insert/exec into SQL editor.
const aiSql: ChatMessage[] = [
  { role: 'user', text: '帮我查过去 7 天每天的 pending 订单数和金额' },
  { role: 'agent', text: '按天聚合 `orders`，统计 pending 订单数与金额（美元）：',
    snippet: { kind: 'sql', action: '生成', target: 'prod-orders',
      code: "select\n  date_trunc('day', created_at) as day,\n  count(*) as pending_orders,\n  sum(total_cents) / 100.0 as usd\nfrom orders\nwhere status = 'pending'\n  and created_at >= now() - interval '7 days'\ngroup by 1\norder by 1 desc;",
      result: '7 rows · 峰值 05-30 = 214 单 / $48,902' } },
  { role: 'user', text: '这条有点慢，能优化吗？' },
  { role: 'agent', text: '`date_trunc(created_at)` 让查询无法命中 `idx_orders_status_created`。改用半开区间，让 planner 走索引扫描：',
    snippet: { kind: 'sql', action: '优化', target: 'prod-orders',
      code: "-- 用范围条件替代 date_trunc，命中 (status, created_at) 复合索引\nselect created_at::date as day,\n       count(*) as pending_orders,\n       sum(total_cents) / 100.0 as usd\nfrom orders\nwhere status = 'pending'\n  and created_at >= date_trunc('day', now()) - interval '6 days'\ngroup by 1\norder by 1 desc;",
      result: 'EXPLAIN: Index Scan · 估算成本 ↓ 73%' },
    text2: '需要的话我可以继续帮你**加注释**或**解释执行计划**。' },
]

// Shell mode — only shell command generation. Snippets insert/exec into terminal.
const aiShell: ChatMessage[] = [
  { role: 'user', text: '找出 /var 下占用最大的 20 个目录' },
  { role: 'agent', text: '按磁盘占用倒序，取前 20：',
    snippet: { kind: 'shell', action: '生成', target: 'prod-web-01',
      code: "du -h --max-depth=2 /var 2>/dev/null | sort -rh | head -n 20",
      result: '4.1G /var/lib/docker · 2.8G /var/log · 1.2G /var/cache/apt' } },
  { role: 'user', text: 'nginx 最近的 5xx 错误？' },
  { role: 'agent', text: '从 access.log 末尾过滤状态码为 5xx 的请求，显示最近 20 条：',
    snippet: { kind: 'shell', action: '生成', target: 'prod-web-01',
      code: "tail -n 5000 /var/log/nginx/access.log \\\n  | awk '$9 ~ /^5/ {print $4, $7, $9}' \\\n  | tail -n 20",
      result: '18:42 /api/checkout 502 · 18:41 /api/pay 500 · …' },
    text2: '要我把它**做成一键脚本**或加上时间过滤吗？' },
]

const aiQuickActions = {
  sql: [
    { icon: 'wand', label: '生成 SQL' },
    { icon: 'zap', label: '优化' },
    { icon: 'message-square-code', label: '解释' },
    { icon: 'hash', label: '加注释' },
  ],
  shell: [
    { icon: 'wand', label: '生成命令' },
    { icon: 'message-square-code', label: '解释' },
    { icon: 'wrench', label: '排错' },
    { icon: 'file-code', label: '一键脚本' },
  ],
}

// ---- Snippets ----
const snippets: Snippet[] = [
  { id: 's1', scope: 'PostgreSQL', desc: '当前运行 >1s 的查询', icon: 'database', code: "select pid, now()-query_start as dur, query\nfrom pg_stat_activity\nwhere state='active' and now()-query_start > interval '1 second'\norder by dur desc;" },
  { id: 's2', scope: 'PostgreSQL', desc: '各表磁盘占用排行', icon: 'database', code: "select relname, pg_size_pretty(pg_total_relation_size(relid)) as size\nfrom pg_catalog.pg_statio_user_tables\norder by pg_total_relation_size(relid) desc limit 20;" },
  { id: 's3', scope: 'Shell', desc: 'du -sh 占用前 20 目录', icon: 'terminal', code: 'du -sh ./* 2>/dev/null | sort -rh | head -20' },
  { id: 's4', scope: 'Shell', desc: '跟踪 nginx access.log', icon: 'terminal', code: 'tail -f /var/log/nginx/access.log' },
  { id: 's5', scope: 'Redis', desc: '扫描大 key', icon: 'database', code: 'redis-cli --bigkeys -i 0.01' },
  { id: 's6', scope: 'MySQL', desc: '查看行锁等待', icon: 'database', code: 'select * from performance_schema.data_lock_waits\\G' },
]

// ---- Terminal buffer (for db-bastion) ----
const termLines: TermLine[] = [
  { t: 'sys', s: 'Connected to db-bastion (bastion.catio.io) · alpine 3.19 · ssh-ed25519' },
  { t: 'prompt', host: 'jump@db-bastion', path: '~', cmd: 'ssh -L 5432:10.0.4.2:5432 -N pg-primary &' },
  { t: 'out', s: '[1] 4821  tunnel up → localhost:5432 ↔ 10.0.4.2:5432' },
  { t: 'prompt', host: 'jump@db-bastion', path: '~', cmd: 'redis-cli -h 10.0.4.5 LLEN payment:callbacks' },
  { t: 'out', s: '(integer) 1291' },
  { t: 'prompt', host: 'jump@db-bastion', path: '~', cmd: 'systemctl status callback-worker --no-pager | head -3' },
  { t: 'out', s: '● callback-worker.service - Payment callback consumer' },
  { t: 'out', s: '     Loaded: loaded (/etc/systemd/system/callback-worker.service; enabled)' },
  { t: 'err', s: '     Active: failed (Result: exit-code) since Thu 2026-05-28 02:14:07 UTC' },
  { t: 'prompt', host: 'jump@db-bastion', path: '~', cmd: '', cursor: true },
]

// ---- Port forwards / tunnels (Reach) — the bridge to the databases ----
const tunnels: Tunnel[] = [
  { id: 't1', type: 'L', label: 'prod-orders', via: 'db-bastion', local: 'localhost:5432', remote: '10.0.4.2:5432', status: 'up', bytes: '4.2 MB', engine: 'postgres' },
  { id: 't2', type: 'L', label: 'sessions-cache', via: 'db-bastion', local: 'localhost:6379', remote: '10.0.4.5:6379', status: 'up', bytes: '812 KB', engine: 'redis' },
  { id: 't3', type: 'D', label: 'SOCKS proxy', via: 'db-bastion', local: 'localhost:1080', remote: 'dynamic', status: 'up', bytes: '38 MB' },
  { id: 't4', type: 'R', label: 'webhook relay', via: 'prod-web-01', local: '10.0.1.21:9000', remote: 'localhost:9000', status: 'idle', bytes: '0 B' },
]

// jump chain for prod-orders
const jumpChain: JumpNode[] = [
  { name: 'localhost', kind: 'local' },
  { name: 'db-bastion', kind: 'jump', detail: 'bastion.catio.io' },
  { name: 'pg-primary', kind: 'target', detail: '10.0.4.2:5432' },
]

// ---- Monitoring (prod-web-01) ----
function series(base: number, amp: number, n: number): number[] { return Array.from({ length: n }, (_, i) => Math.max(2, Math.round(base + amp * Math.sin(i / 2.4) + ((i * 37) % 11) - 5))) }
const monitor = {
  host: 'prod-web-01',
  cpu: series(34, 16, 40),
  mem: series(61, 8, 40),
  net: series(48, 30, 40),
  disk: 72,
  cores: 16, memTotal: '16 GB', memUsed: '9.6 GB',
  // multi-GPU telemetry
  gpus: [
    { idx: 0, name: 'NVIDIA A100 80GB', util: series(78, 18, 40), utilNow: 86, memUsed: 71.4, memTotal: 80, temp: 67, power: 312, powerCap: 400, fan: 48, procs: 'python train.py' },
    { idx: 1, name: 'NVIDIA A100 80GB', util: series(64, 22, 40), utilNow: 73, memUsed: 58.2, memTotal: 80, temp: 61, power: 268, powerCap: 400, fan: 42, procs: 'python train.py' },
    { idx: 2, name: 'NVIDIA A100 80GB', util: series(12, 10, 40), utilNow: 9, memUsed: 4.1, memTotal: 80, temp: 38, power: 74, powerCap: 400, fan: 30, procs: 'idle' },
  ],
  procs: [
    { pid: 2841, cmd: 'node /var/www/app', cpu: 18.4, mem: 6.2 },
    { pid: 1190, cmd: 'nginx: worker', cpu: 7.1, mem: 1.1 },
    { pid: 884, cmd: 'postgres: writer', cpu: 4.9, mem: 3.8 },
    { pid: 3320, cmd: 'redis-server', cpu: 2.3, mem: 0.9 },
    { pid: 77, cmd: 'systemd-journald', cpu: 0.6, mem: 0.4 },
  ],
}

// ---- Multi-Exec (Reach broadcast) ----
const multiExecTargets: MultiExecTarget[] = [
  { id: 'h-web1', name: 'prod-web-01', state: 'done', out: 'active' },
  { id: 'h-web2', name: 'prod-web-02', state: 'done', out: 'active' },
  { id: 'h-stg-api', name: 'staging-api', state: 'running', out: '…' },
  { id: 'h-bastion', name: 'db-bastion', state: 'queued', out: '' },
]

const multiExec = {
  cmd: 'systemctl restart callback-worker && systemctl is-active callback-worker',
  targets: multiExecTargets,
}

// ---- Unified history (commands + queries) ----
const history: HistoryItem[] = [
  { id: 'hi1', kind: 'sql', target: 'prod-orders', text: "select count(*) from orders where status='pending'", when: '3m', dur: '42ms' },
  { id: 'hi2', kind: 'shell', target: 'db-bastion', text: 'redis-cli -h 10.0.4.5 LLEN payment:callbacks', when: '4m', dur: '11ms' },
  { id: 'hi3', kind: 'shell', target: 'prod-web-01', text: 'tail -f /var/www/app/current/access.log', when: '12m', dur: 'live' },
  { id: 'hi7', kind: 'sql', target: 'prod-orders', text: "select date_trunc('day',created_at) d, count(*) from orders group by 1", when: '18m', dur: '88ms' },
  { id: 'hi8', kind: 'sql', target: 'prod-orders', text: 'explain analyze select * from orders where customer_id = 184213', when: '22m', dur: '6ms' },
  { id: 'hi4', kind: 'sql', target: 'analytics', text: 'select day, count(*) from funnel_events group by 1', when: '2h', dur: '188ms' },
  { id: 'hi9', kind: 'shell', target: 'prod-web-01', text: 'systemctl restart nginx && nginx -t', when: '2h', dur: '0.8s' },
  { id: 'hi10', kind: 'shell', target: 'db-bastion', text: 'ssh -L 5432:10.0.4.2:5432 -N pg-primary &', when: '3h', dur: 'live' },
  { id: 'hi5', kind: 'shell', target: 'staging-api', text: 'pm2 restart api && pm2 logs api --lines 20', when: '4h', dur: '1.2s' },
  { id: 'hi6', kind: 'sql', target: 'catalog-stg', text: "update products set active=true where sku like 'SS26-%'", when: '5h', dur: '63ms' },
  { id: 'hi11', kind: 'sql', target: 'analytics', text: 'select countIf(event=\'purchase\') from funnel_events', when: '6h', dur: '142ms' },
  { id: 'hi12', kind: 'shell', target: 'prod-web-02', text: 'du -sh /var/log/* | sort -rh | head', when: '8h', dur: '0.3s' },
]

// automation playbooks (Ansible / OpenTofu)
const automation: Automation[] = [
  { id: 'a1', name: 'deploy-app.yml', kind: 'ansible', desc: 'rolling deploy → web fleet', hosts: 2 },
  { id: 'a2', name: 'db-backup.yml', kind: 'ansible', desc: 'pg_dump + offsite sync', hosts: 1 },
  { id: 'a3', name: 'infra/staging', kind: 'opentofu', desc: 'plan: +3 ~1 -0', hosts: 0 },
]

const byId: Record<string, Connection> = Object.fromEntries(connections.map(c => [c.id, c]))

export const DATA: CatioData = {
  groups, connections, engineMeta, osMeta, schema, ordersColumns, ordersRows,
  statusTones, sampleSQL, recent, aiThread, snippets, termLines,
  tunnels, jumpChain, monitor, multiExec, history, automation,
  tableStructures, erModel, aiSql, aiShell, aiQuickActions,
  byId,
}
