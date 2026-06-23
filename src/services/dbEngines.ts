// Central catalog of selectable database engines.
//
// catio's backend `DatabaseType` is a *protocol family* (10 of them). Many real
// engines are wire-protocol-compatible variants of a family, distinguished by a
// `driverProfile` string (mirrors dbx `models/connection.rs` driver_profile).
// This catalog is the single source of truth the connection UI renders, mapping
// each user-visible engine → { dbType, driverProfile, defaultPort }.
//
// Profile→dialect behaviour (default db name, system-table filters, Oracle-mode
// SQL) lives in the Rust drivers (postgres.rs / mysql.rs already branch on it).
// Engine→family mapping adapted from dbx apps/desktop/src/lib/connectionUrl.ts
// (SCHEME_PROFILES), Apache-2.0.

import type { DbType } from './db'

/** UI grouping for the engine dropdown. */
export type EngineGroup =
  | 'relational'
  | 'distributed'
  | 'analytics'
  | 'domestic'
  | 'document'
  | 'jdbc'

export interface DbEngine {
  /** Unique catalog key (also the logo lookup key). */
  id: string
  /** Backend protocol-family DatabaseType. */
  dbType: DbType
  /** Protocol-family variant passed to the backend as `driverProfile`. */
  driverProfile?: string
  /** Display name. */
  label: string
  /** Monochrome fallback glyph (when no brand logo is bundled). */
  short: string
  /** Default TCP port; 0 = file-based / not applicable. */
  defaultPort: number
  group: EngineGroup
}

// NOTE: order within each group is the dropdown order.
export const DB_ENGINES: DbEngine[] = [
  // ── Relational (core) ──────────────────────────────────────────────
  { id: 'postgres',  dbType: 'postgres',  label: 'PostgreSQL', short: 'PG',    defaultPort: 5432, group: 'relational' },
  { id: 'mysql',     dbType: 'mysql',     label: 'MySQL',      short: 'SQL',   defaultPort: 3306, group: 'relational' },
  { id: 'mariadb',   dbType: 'mysql',     driverProfile: 'mariadb',   label: 'MariaDB',    short: 'MAR',  defaultPort: 3306, group: 'relational' },
  { id: 'sqlserver', dbType: 'sqlserver', label: 'SQL Server', short: 'MSSQL', defaultPort: 1433, group: 'relational' },
  { id: 'sqlite',    dbType: 'sqlite',    label: 'SQLite',     short: 'LITE',  defaultPort: 0,    group: 'relational' },
  { id: 'duckdb',    dbType: 'duckdb',    label: 'DuckDB',     short: 'DUCK',  defaultPort: 0,    group: 'relational' },

  // ── Distributed / NewSQL (MySQL or PG wire) ────────────────────────
  { id: 'cockroachdb',      dbType: 'postgres', driverProfile: 'cockroachdb',      label: 'CockroachDB',       short: 'CRDB', defaultPort: 26257, group: 'distributed' },
  { id: 'tidb',             dbType: 'mysql',    driverProfile: 'tidb',             label: 'TiDB',              short: 'TIDB', defaultPort: 4000,  group: 'distributed' },
  { id: 'oceanbase',        dbType: 'mysql',    driverProfile: 'oceanbase',        label: 'OceanBase (MySQL)', short: 'OB',   defaultPort: 2881,  group: 'distributed' },
  { id: 'oceanbase-oracle', dbType: 'mysql',    driverProfile: 'oceanbase-oracle', label: 'OceanBase (Oracle)',short: 'OBO',  defaultPort: 2881,  group: 'distributed' },

  // ── Analytics / OLAP ───────────────────────────────────────────────
  { id: 'clickhouse', dbType: 'clickhouse', label: 'ClickHouse', short: 'CH',   defaultPort: 8123, group: 'analytics' },
  { id: 'doris',      dbType: 'mysql',      driverProfile: 'doris',     label: 'Apache Doris', short: 'DOR',  defaultPort: 9030, group: 'analytics' },
  { id: 'starrocks',  dbType: 'mysql',      driverProfile: 'starrocks', label: 'StarRocks',    short: 'SR',   defaultPort: 9030, group: 'analytics' },
  { id: 'selectdb',   dbType: 'mysql',      driverProfile: 'selectdb',  label: 'SelectDB',     short: 'SEL',  defaultPort: 9030, group: 'analytics' },
  { id: 'databend',   dbType: 'mysql',      driverProfile: 'databend',  label: 'Databend',     short: 'DBND', defaultPort: 3307, group: 'analytics' },
  { id: 'redshift',   dbType: 'postgres',   driverProfile: 'redshift',  label: 'Amazon Redshift', short: 'RS', defaultPort: 5439, group: 'analytics' },

  // ── Domestic (国产, PG-wire or MySQL-wire compatible) ───────────────
  { id: 'opengauss', dbType: 'postgres', driverProfile: 'opengauss', label: 'openGauss', short: 'OG',   defaultPort: 5432,  group: 'domestic' },
  { id: 'gaussdb',   dbType: 'postgres', driverProfile: 'gaussdb',   label: 'GaussDB',   short: 'GS',    defaultPort: 5432,  group: 'domestic' },
  { id: 'kingbase',  dbType: 'postgres', driverProfile: 'kingbase',  label: 'KingbaseES',short: 'KB',    defaultPort: 54321, group: 'domestic' },
  { id: 'vastbase',  dbType: 'postgres', driverProfile: 'vastbase',  label: 'Vastbase',  short: 'VB',    defaultPort: 5432,  group: 'domestic' },
  { id: 'highgo',    dbType: 'postgres', driverProfile: 'highgo',    label: 'HighGo DB', short: 'HG',    defaultPort: 5866,  group: 'domestic' },
  { id: 'kwdb',      dbType: 'postgres', driverProfile: 'kwdb',      label: 'KWDB',      short: 'KW',    defaultPort: 26257, group: 'domestic' },
  { id: 'goldendb',  dbType: 'mysql',    driverProfile: 'goldendb',  label: 'GoldenDB',  short: 'GD',    defaultPort: 3306,  group: 'domestic' },
  { id: 'gbase',     dbType: 'mysql',    driverProfile: 'gbase',     label: 'GBase 8a',  short: 'GB',    defaultPort: 5258,  group: 'domestic' },
  { id: 'greatsql',  dbType: 'mysql',    driverProfile: 'greatsql',  label: 'GreatSQL',  short: 'GSQL',  defaultPort: 3306,  group: 'domestic' },
  { id: 'polardb',   dbType: 'mysql',    driverProfile: 'polardb',   label: 'PolarDB (MySQL)', short: 'POL', defaultPort: 3306, group: 'domestic' },
  { id: 'tdsql',     dbType: 'mysql',    driverProfile: 'tdsql',     label: 'TDSQL',     short: 'TDS',   defaultPort: 3306,  group: 'domestic' },

  // ── Document / KV / Search / other ─────────────────────────────────
  { id: 'mongodb',       dbType: 'mongodb',       label: 'MongoDB',       short: 'MGO', defaultPort: 27017, group: 'document' },
  { id: 'redis',         dbType: 'redis',         label: 'Redis',         short: 'RDS', defaultPort: 6379,  group: 'document' },
  { id: 'elasticsearch', dbType: 'elasticsearch', label: 'Elasticsearch', short: 'ES',  defaultPort: 9200,  group: 'document' },
  { id: 'rqlite',        dbType: 'rqlite',        label: 'rqlite',        short: 'RQL', defaultPort: 4001,  group: 'document' },

  // ── JDBC sidecar (engines with no native Rust driver) ──────────────
  // dbType 'jdbc' routes through the Java plugin; driverProfile selects the
  // JDBC URL + driver class (see src-tauri/.../jdbc_config.rs). These need a
  // user-supplied driver JAR (dir: CATIO_JDBC_DRIVERS_DIR) — except H2, bundled.
  { id: 'oracle',     dbType: 'jdbc', driverProfile: 'oracle',     label: 'Oracle',        short: 'ORA',  defaultPort: 1521,  group: 'jdbc' },
  { id: 'db2',        dbType: 'jdbc', driverProfile: 'db2',        label: 'IBM Db2',       short: 'DB2',  defaultPort: 50000, group: 'jdbc' },
  { id: 'snowflake',  dbType: 'jdbc', driverProfile: 'snowflake',  label: 'Snowflake',     short: 'SNOW', defaultPort: 443,   group: 'jdbc' },
  { id: 'hive',       dbType: 'jdbc', driverProfile: 'hive',       label: 'Apache Hive',   short: 'HIVE', defaultPort: 10000, group: 'jdbc' },
  { id: 'trino',      dbType: 'jdbc', driverProfile: 'trino',      label: 'Trino',         short: 'TRINO',defaultPort: 8080,  group: 'jdbc' },
  { id: 'cassandra',  dbType: 'jdbc', driverProfile: 'cassandra',  label: 'Cassandra',     short: 'CASS', defaultPort: 9042,  group: 'jdbc' },
  { id: 'neo4j',      dbType: 'jdbc', driverProfile: 'neo4j',      label: 'Neo4j',         short: 'NEO',  defaultPort: 7687,  group: 'jdbc' },
  { id: 'saphana',    dbType: 'jdbc', driverProfile: 'saphana',    label: 'SAP HANA',      short: 'HANA', defaultPort: 30015, group: 'jdbc' },
  { id: 'teradata',   dbType: 'jdbc', driverProfile: 'teradata',   label: 'Teradata',      short: 'TD',   defaultPort: 1025,  group: 'jdbc' },
  { id: 'vertica',    dbType: 'jdbc', driverProfile: 'vertica',    label: 'Vertica',       short: 'VRT',  defaultPort: 5433,  group: 'jdbc' },
  { id: 'firebird',   dbType: 'jdbc', driverProfile: 'firebird',   label: 'Firebird',      short: 'FB',   defaultPort: 3050,  group: 'jdbc' },
  { id: 'exasol',     dbType: 'jdbc', driverProfile: 'exasol',     label: 'Exasol',        short: 'EXA',  defaultPort: 8563,  group: 'jdbc' },
  { id: 'informix',   dbType: 'jdbc', driverProfile: 'informix',   label: 'Informix',      short: 'IFX',  defaultPort: 9088,  group: 'jdbc' },
  { id: 'dameng',     dbType: 'jdbc', driverProfile: 'dameng',     label: '达梦 DM',        short: 'DM',   defaultPort: 5236,  group: 'jdbc' },
  { id: 'yashandb',   dbType: 'jdbc', driverProfile: 'yashandb',   label: 'YashanDB',      short: 'YAS',  defaultPort: 1688,  group: 'jdbc' },
  { id: 'gbase8s',    dbType: 'jdbc', driverProfile: 'gbase8s',    label: 'GBase 8s',      short: 'G8S',  defaultPort: 9088,  group: 'jdbc' },
  { id: 'xugu',       dbType: 'jdbc', driverProfile: 'xugu',       label: 'XuguDB',        short: 'XG',   defaultPort: 5138,  group: 'jdbc' },
  { id: 'kylin',      dbType: 'jdbc', driverProfile: 'kylin',      label: 'Apache Kylin',  short: 'KYL',  defaultPort: 7070,  group: 'jdbc' },
  { id: 'iotdb',      dbType: 'jdbc', driverProfile: 'iotdb',      label: 'Apache IoTDB',  short: 'IOT',  defaultPort: 6667,  group: 'jdbc' },
  { id: 'tdengine',   dbType: 'jdbc', driverProfile: 'tdengine',   label: 'TDengine',      short: 'TAOS', defaultPort: 6041,  group: 'jdbc' },
  { id: 'iris',       dbType: 'jdbc', driverProfile: 'iris',       label: 'InterSystems IRIS', short: 'IRIS', defaultPort: 1972, group: 'jdbc' },
  { id: 'databricks', dbType: 'jdbc', driverProfile: 'databricks', label: 'Databricks',    short: 'DBX',  defaultPort: 443,   group: 'jdbc' },
  { id: 'bigquery',   dbType: 'jdbc', driverProfile: 'bigquery',   label: 'Google BigQuery', short: 'BQ', defaultPort: 443,   group: 'jdbc' },
  { id: 'sundb',      dbType: 'jdbc', driverProfile: 'sundb',      label: 'SUNDB',         short: 'SUN',  defaultPort: 22581, group: 'jdbc' },
  { id: 'access',     dbType: 'jdbc', driverProfile: 'access',     label: 'MS Access',     short: 'ACC',  defaultPort: 0,     group: 'jdbc' },
  { id: 'h2',         dbType: 'jdbc', driverProfile: 'h2',         label: 'H2 Database',   short: 'H2',   defaultPort: 0,     group: 'jdbc' },
]

/** i18n key suffix per group (resolved as `modals.engineGroup.<key>`). */
export const ENGINE_GROUP_ORDER: EngineGroup[] = [
  'relational', 'distributed', 'analytics', 'domestic', 'document', 'jdbc',
]

/** Look up a catalog entry by its id. */
export function findEngine(id: string): DbEngine | undefined {
  return DB_ENGINES.find(e => e.id === id)
}

/**
 * Best-effort reverse lookup: given a saved `dbType` (+ optional `driverProfile`),
 * return the matching catalog engine id. Used for edit-mode pre-selection of
 * legacy profiles saved before `engineId` was persisted. Returns undefined when
 * no entry matches (caller falls back to the bare dbType / postgres).
 */
export function matchEngineId(dbType?: string, driverProfile?: string): string | undefined {
  if (!dbType) return undefined
  const profile = driverProfile || undefined
  return DB_ENGINES.find(e => e.dbType === dbType && (e.driverProfile || undefined) === profile)?.id
}

/** Group the catalog for rendering: ordered groups, each with its engines. */
export function enginesByGroup(): { group: EngineGroup; engines: DbEngine[] }[] {
  return ENGINE_GROUP_ORDER.map(group => ({
    group,
    engines: DB_ENGINES.filter(e => e.group === group),
  })).filter(g => g.engines.length > 0)
}
