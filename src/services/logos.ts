// Brand LOGO resolution for connection glyphs.
//
// DB engine logos: full-colour SVG/PNG/WEBP brand marks reused from dbx
// (apps/desktop/public/icons/database, vendor brand assets) → public/logos/db/.
// Rendered directly via <img>, so they keep their real brand colours.
//
// OS logos: monochrome single-path marks from simple-icons (MIT) →
// public/logos/os/. Rendered via CSS mask + a brand colour so they tint to the
// theme (single colour, no embedded fill). Initial/unknown OS falls back to the
// generic host icon until the backend detects the real OS post-connect.

/** Engine id (DbType, plus mock aliases) → logo filename under public/logos/db/. */
const DB_LOGO: Record<string, string> = {
  postgres: 'postgres.svg',
  mysql: 'mysql.svg',
  mariadb: 'mariadb.svg',
  redis: 'redis.svg',
  mongodb: 'mongodb.svg',
  mongo: 'mongodb.svg', // mock alias
  clickhouse: 'clickhouse.svg',
  sqlite: 'sqlite.svg',
  duckdb: 'duckdb.svg',
  sqlserver: 'sqlserver.svg',
  elasticsearch: 'elasticsearch.svg',
  rqlite: 'rqlite.png',
  oracle: 'oracle.svg',
  db2: 'db2.svg',
  cassandra: 'cassandra.svg',
  snowflake: 'snowflake.svg',
  cockroachdb: 'cockroachdb.svg',
  tidb: 'tidb.svg',
  oceanbase: 'oceanbase.svg',
  h2: 'h2.svg',
  neo4j: 'neo4j.svg',
  redshift: 'redshift.svg',
  bigquery: 'bigquery.svg',
  hive: 'hive.svg',
  doris: 'doris.svg',
  starrocks: 'starrocks.svg',
  tdengine: 'tdengine.svg',
  presto: 'presto.svg',
}

/** OS id → monochrome logo file + brand colour (for the CSS-mask tint). */
const OS_LOGO: Record<string, { file: string; color: string }> = {
  ubuntu: { file: 'ubuntu.svg', color: '#E95420' },
  debian: { file: 'debian.svg', color: '#A81D33' },
  alpine: { file: 'alpinelinux.svg', color: '#0D597F' },
  centos: { file: 'centos.svg', color: '#262577' },
  fedora: { file: 'fedora.svg', color: '#51A2DA' },
  arch: { file: 'archlinux.svg', color: '#1793D1' },
  rhel: { file: 'redhat.svg', color: '#EE0000' },
  redhat: { file: 'redhat.svg', color: '#EE0000' },
  // Generic Linux (Tux) for distros we can't pin down — themed, not branded.
  linux: { file: 'linux.svg', color: 'var(--text-secondary)' },
  macos: { file: 'apple.svg', color: 'var(--text-secondary)' },
}

/** Resolve a DB engine to its brand logo URL, or null when none is bundled. */
export function dbLogo(engine?: string | null): string | null {
  if (!engine) return null
  const f = DB_LOGO[engine]
  return f ? `/logos/db/${f}` : null
}

/** Resolve an OS id to its logo URL + tint colour, or null when none is bundled. */
export function osLogo(os?: string | null): { url: string; color: string } | null {
  if (!os) return null
  const m = OS_LOGO[os]
  return m ? { url: `/logos/os/${m.file}`, color: m.color } : null
}
