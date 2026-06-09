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

  // ── Document / KV / Search / other ─────────────────────────────────
  { id: 'mongodb',       dbType: 'mongodb',       label: 'MongoDB',       short: 'MGO', defaultPort: 27017, group: 'document' },
  { id: 'redis',         dbType: 'redis',         label: 'Redis',         short: 'RDS', defaultPort: 6379,  group: 'document' },
  { id: 'elasticsearch', dbType: 'elasticsearch', label: 'Elasticsearch', short: 'ES',  defaultPort: 9200,  group: 'document' },
  { id: 'rqlite',        dbType: 'rqlite',        label: 'rqlite',        short: 'RQL', defaultPort: 4001,  group: 'document' },
]

/** i18n key suffix per group (resolved as `modals.engineGroup.<key>`). */
export const ENGINE_GROUP_ORDER: EngineGroup[] = [
  'relational', 'distributed', 'analytics', 'domestic', 'document',
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
