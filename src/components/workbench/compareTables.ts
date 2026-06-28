/* Pure data-compare core: diff two tables by primary key and emit the sync SQL that
 * makes the TARGET match the SOURCE. Kept framework-free so it can be unit-tested.
 *
 * Correctness guarantees:
 *  - Target rows are realigned to the SOURCE column order BY NAME (SELECT * column order
 *    is not guaranteed identical across tables/connections).
 *  - Column-name sets must match; otherwise we refuse and report a mismatch rather than
 *    silently writing values into the wrong columns.
 *  - Composite-PK keys are JSON-encoded (unambiguous separation; NULL stays distinct from
 *    the literal string "NULL"); PK parts are stringified so a number 1 and string "1"
 *    from different engines still match.
 *  - Value comparison is type-aware (numbers numerically, objects by JSON) to avoid
 *    false UPDATEs / missed object-column diffs.
 *  - String/identifier quoting escapes both single quotes and (for MySQL-likes) backslash.
 *  - DELETE generation is opt-in (callers disable it when the row window was truncated, so
 *    a partial source set never deletes real target rows). */

export interface CompareInput {
  srcColumns: string[]
  srcRows: unknown[][]
  tgtColumns: string[]
  tgtRows: unknown[][]
  pkNames: string[]
}

export interface CompareDiff {
  /** Canonical column order = source column order. */
  colNames: string[]
  pkNames: string[]
  inserts: unknown[][]
  updates: { src: unknown[] }[]
  deletes: unknown[][]
  /** Set when the diff could not be computed safely. */
  error?: 'columns-mismatch' | 'pk-missing'
}

function rowKey(row: unknown[], pkIdx: number[]): string {
  // JSON array of stringified-or-null parts: unambiguous, NULL ≠ "NULL", and a number 1
  // matches a string "1" returned by another engine.
  return JSON.stringify(pkIdx.map(i => { const v = row[i]; return v == null ? null : String(v) }))
}

/** Type-aware equality so cross-engine representations of the same value don't read as a diff. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == null && b == null
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb
  }
  if (typeof a === 'object' || typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
  }
  return String(a) === String(b)
}

export function computeDiff(input: CompareInput): CompareDiff {
  const { srcColumns, srcRows, tgtColumns, tgtRows, pkNames } = input
  const colNames = srcColumns
  const empty = { colNames, pkNames, inserts: [] as unknown[][], updates: [] as { src: unknown[] }[], deletes: [] as unknown[][] }

  // Column-name sets must match (order may differ — we realign target by name).
  const tgtIdxByName = new Map(tgtColumns.map((c, i) => [c, i]))
  if (srcColumns.length !== tgtColumns.length || srcColumns.some(c => !tgtIdxByName.has(c))) {
    return { ...empty, error: 'columns-mismatch' }
  }
  const pkIdx = pkNames.map(pk => colNames.indexOf(pk))
  if (pkIdx.some(i => i < 0)) return { ...empty, error: 'pk-missing' }

  // Realign each target row to the canonical (source) column order.
  const tgtColIdx = colNames.map(c => tgtIdxByName.get(c)!)
  const tgtCanon = tgtRows.map(r => tgtColIdx.map(i => r[i]))

  const tgtMap = new Map<string, unknown[]>()
  for (const r of tgtCanon) tgtMap.set(rowKey(r, pkIdx), r)

  const srcKeys = new Set<string>()
  const inserts: unknown[][] = []
  const updates: { src: unknown[] }[] = []
  for (const sr of srcRows) {
    const k = rowKey(sr, pkIdx); srcKeys.add(k)
    const tr = tgtMap.get(k)
    if (!tr) inserts.push(sr)
    else if (colNames.some((_, i) => !valuesEqual(sr[i], tr[i]))) updates.push({ src: sr })
  }
  const deletes: unknown[][] = []
  for (const [k, tr] of tgtMap) if (!srcKeys.has(k)) deletes.push(tr)

  return { colNames, pkNames, inserts, updates, deletes }
}

export function isMysqlish(engine?: string): boolean {
  return /mysql|maria|tidb|oceanbase|goldendb/i.test(engine ?? '')
}
/** Engines whose boolean literal is the integer 1/0 (BIT/TINYINT), not TRUE/FALSE. */
function boolAsBit(engine?: string): boolean {
  return isMysqlish(engine) || /sqlserver|mssql|tiberius/i.test(engine ?? '')
}
export function qid(name: string, engine?: string): string {
  return isMysqlish(engine) ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`
}
export function qval(v: unknown, engine?: string): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL'
    const s = String(v)
    return /e/i.test(s) ? `'${s}'` : s // avoid scientific-notation literals some engines reject
  }
  if (typeof v === 'boolean') return boolAsBit(engine) ? (v ? '1' : '0') : (v ? 'TRUE' : 'FALSE')
  let s = String(v)
  if (isMysqlish(engine)) s = s.replace(/\\/g, '\\\\') // MySQL default mode treats \ as an escape char
  s = s.replace(/'/g, "''")
  return `'${s}'`
}
export function qtable(schema: string, table: string, engine?: string): string {
  return schema ? `${qid(schema, engine)}.${qid(table, engine)}` : qid(table, engine)
}

export interface SqlOptions {
  engine?: string
  allowDelete: boolean
}

/** Generate the sync SQL that makes target match source. */
export function genSyncSql(diff: CompareDiff, schema: string, table: string, opts: SqlOptions): string {
  const { colNames, pkNames, inserts, updates, deletes } = diff
  const { engine, allowDelete } = opts
  const ref = qtable(schema, table, engine)
  const pkIdx = pkNames.map(pk => colNames.indexOf(pk))
  const whereOf = (row: unknown[]) => pkNames.map((pk, n) => `${qid(pk, engine)} = ${qval(row[pkIdx[n]], engine)}`).join(' AND ')
  const lines: string[] = []
  for (const r of inserts) {
    lines.push(`INSERT INTO ${ref} (${colNames.map(c => qid(c, engine)).join(', ')}) VALUES (${r.map(v => qval(v, engine)).join(', ')});`)
  }
  for (const { src } of updates) {
    const sets = colNames.map((c, i) => (pkIdx.includes(i) ? null : `${qid(c, engine)} = ${qval(src[i], engine)}`)).filter(Boolean)
    lines.push(`UPDATE ${ref} SET ${sets.join(', ')} WHERE ${whereOf(src)};`)
  }
  if (allowDelete) {
    for (const r of deletes) lines.push(`DELETE FROM ${ref} WHERE ${whereOf(r)};`)
  }
  return lines.join('\n')
}
