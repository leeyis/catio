import { ensureSyntaxTree } from '@codemirror/language'
import type { CompletionContext, CompletionSource } from '@codemirror/autocomplete'
import type { SyntaxNode } from '@lezer/common'
import { dialectFor } from './sqlDialect'

export interface WriteIdentifier { name: string; quoted: boolean }
export type SqlWriteContext = { kind: 'type'; from: number; to: number; prefix: string }
  | { kind: 'columns'; table: WriteIdentifier[]; used: WriteIdentifier[]; from: number; to: number; prefix: string }

/** Conservative CST slots: CREATE/ALTER column types, CAST AS, INSERT column lists,
 * and UPDATE SET assignment names. Not a validator; complex vendor syntax falls back. */
export function sqlWriteContext(context: CompletionContext): SqlWriteContext | null {
  const { state, pos } = context
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, pos + 20_000), 10)
  if (!tree) return null
  let leaf = tree.resolveInner(pos, -1)
  if (leaf.name === 'Script') {
    const previous = leaf.childBefore(pos)
    if (previous?.name === 'Statement' && previous.lastChild?.name !== ';' && pos - previous.to < 20_000 && /^\s*$/.test(state.sliceDoc(previous.to, pos))) leaf = previous
  }
  let statement: SyntaxNode | null = null
  for (let node: SyntaxNode | null = leaf; node; node = node.parent) {
    if (['String','LineComment','BlockComment'].includes(node.name)) return null
    if (node.name === 'Statement') statement = node
  }
  if (!statement || statement.to - statement.from > 100_000) return null
  let budget = 1500
  const text = (node: SyntaxNode) => state.sliceDoc(node.from, node.to)
  const word = (node?: SyntaxNode) => node && node.to - node.from < 64 ? text(node).toLowerCase() : ''
  const children = (parent: SyntaxNode) => {
    const nodes: SyntaxNode[] = []
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      if (--budget < 0) return []
      if (node.name === '⚠' && node.from === node.to) continue
      if (!['(',')',';','LineComment','BlockComment'].includes(node.name)) nodes.push(node)
    }
    return nodes
  }
  const identifier = (node?: SyntaxNode): WriteIdentifier | null => {
    if (!node || !['Identifier','QuotedIdentifier','Keyword','Type','Builtin'].includes(node.name)) return null
    const raw = text(node), quoted = node.name === 'QuotedIdentifier'
    const close = raw[0] === '[' ? ']' : raw[0]
    return { name: quoted ? (raw.endsWith(close) ? raw.slice(1,-1) : raw.slice(1)).split(close + close).join(close) : raw, quoted }
  }
  const path = (node?: SyntaxNode): WriteIdentifier[] => !node ? [] : node.name === 'CompositeIdentifier'
    ? children(node).flatMap(part => { const value = identifier(part); return value ? [value] : [] })
    : identifier(node) ? [identifier(node)!] : []
  const slot = (nodes: SyntaxNode[]) => {
    const current = nodes.find(node => node.from < pos && node.to >= pos)
    if (current && !identifier(current)) return null
    const raw = current ? state.sliceDoc(current.from, pos) : ''
    const quote = current?.name === 'QuotedIdentifier' ? raw[0] : ''
    return { from: current?.from ?? pos, to: current?.to ?? pos, prefix: quote ? raw.slice(1).replace(/["`\]]$/, '') : raw }
  }
  const typeAfter = (tokens: SyntaxNode[], count: number): SqlWriteContext | null => {
    const before = tokens.filter(node => node.from < pos)
    if (before.length < count || before.length > count + 1 || tokens[count - 1]?.to >= pos) return null
    if (before.length === count + 1 && before[count].to < pos) return null
    const current = slot(before.slice(count))
    return current && budget >= 0 ? { kind: 'type', ...current } : null
  }
  // CAST/TRY_CAST takes precedence over an enclosing DML expression.
  for (let node: SyntaxNode | null = leaf; node && node !== statement; node = node.parent) {
    if (node.name === 'Parens' && ['cast','try_cast'].includes(word(node.prevSibling ?? undefined))) {
      const tokens = children(node), as = tokens.findIndex(token => word(token) === 'as')
      if (as >= 0) return typeAfter(tokens, as + 1)
    }
  }
  const tokens = children(statement)
  if (budget < 0) return null
  const inside = (node?: SyntaxNode) => node?.name === 'Parens' && node.from < pos && (pos < node.to || node.lastChild?.name !== ')' && node.to <= pos && /^\s*$/.test(state.sliceDoc(node.to, pos)))
  const first = word(tokens[0])
  if (first === 'create' && tokens.some(node => word(node) === 'table')) {
    const list = tokens.find(node => inside(node))
    if (!list) return null
    const parts = children(list).filter(node => node.from < pos)
    const comma = parts.map(word).lastIndexOf(',')
    const column = parts.slice(comma + 1)
    if (!identifier(column[0]) || ['constraint','primary','foreign','unique','check','like'].includes(word(column[0]))) return null
    return typeAfter(column, 1)
  }
  if (first === 'alter' && word(tokens[1]) === 'table') {
    const command = tokens.findIndex((node, i) => i > 2 && ['add','modify','alter'].includes(word(node)))
    if (command < 0) return null
    let rest = tokens.slice(command + 1)
    if (word(rest[0]) === 'column') rest = rest.slice(1)
    if (!identifier(rest[0]) || ['constraint','primary','foreign','unique','check'].includes(word(rest[0]))) return null
    return typeAfter(rest, word(rest[1]) === 'type' ? 2 : 1)
  }
  if (first === 'insert' && word(tokens[1]) === 'into') {
    const table = path(tokens[2]), list = tokens[3]
    if (!table.length || !inside(list)) return null
    const parts = children(list), current = slot(parts)
    if (!current || parts.some(node => word(node) !== ',' && !identifier(node))) return null
    const used = parts.filter(node => node.to <= pos && node.from !== current.from).flatMap(node => identifier(node) ? [identifier(node)!] : [])
    return budget >= 0 ? { kind: 'columns', table, used, ...current } : null
  }
  if (first === 'update') {
    const table = path(tokens[1]), set = tokens.findIndex(node => word(node) === 'set')
    if (!table.length || set < 0 || tokens[set].to >= pos) return null
    const before = tokens.slice(set + 1).filter(node => node.from < pos)
    if (before.some(node => ['where','from','returning','output'].includes(word(node)))) return null
    const comma = before.map(word).lastIndexOf(','), assignment = before.slice(comma + 1)
    if (assignment.length > 1 || assignment[0] && assignment[0].to < pos) return null
    const current = slot(assignment)
    if (!current) return null
    const used: WriteIdentifier[] = []
    for (let i = 0; i < comma; i++) if ((i === 0 || word(before[i - 1]) === ',') && identifier(before[i]) && word(before[i + 1]) === '=') used.push(identifier(before[i])!)
    return { kind: 'columns', table, used, ...current }
  }
  return null
}
export function sqlDataTypeCompletion(engine?: string): CompletionSource {
  const dialect = dialectFor(engine)
  const common = 'SMALLINT INTEGER BIGINT DECIMAL NUMERIC REAL DOUBLE CHAR VARCHAR DATE TIME TIMESTAMP BOOLEAN'
  const types = dialect === dialectFor('oracle') ? 'NUMBER BINARY_FLOAT BINARY_DOUBLE CHAR NCHAR VARCHAR2 NVARCHAR2 DATE TIMESTAMP INTERVAL RAW LONG BLOB CLOB NCLOB'
    : common + (dialect === dialectFor('postgres') ? (engine === 'duckdb' ? ' HUGEINT UHUGEINT UBIGINT UINTEGER USMALLINT UTINYINT TINYINT VARCHAR BLOB UUID JSON LIST STRUCT MAP UNION' : ' TEXT UUID JSON JSONB BYTEA SERIAL BIGSERIAL TIMESTAMPTZ TIMETZ INTERVAL MONEY INET CIDR')
      : [dialectFor('mysql'),dialectFor('mariadb')].includes(dialect) ? ' INT TINYINT MEDIUMINT FLOAT DATETIME YEAR TEXT TINYTEXT MEDIUMTEXT LONGTEXT BLOB TINYBLOB MEDIUMBLOB LONGBLOB BINARY VARBINARY JSON ENUM SET'
      : dialect === dialectFor('sqlserver') ? ' INT TINYINT BIT FLOAT MONEY SMALLMONEY DATETIME DATETIME2 DATETIMEOFFSET SMALLDATETIME NVARCHAR NCHAR NTEXT TEXT IMAGE BINARY VARBINARY UNIQUEIDENTIFIER XML'
      : dialect === dialectFor('sqlite') ? ' INT TEXT BLOB' : '')
  const options = [...new Set(types.split(/\s+/))].filter(label => dialect !== dialectFor('sqlserver') || !['BOOLEAN','DOUBLE'].includes(label)).map(label => ({ label, type: 'type' }))
  return context => {
    const slot = sqlWriteContext(context)
    if (slot?.kind !== 'type') return null
    return { from: slot.from, to: slot.to, options: options.filter(item => item.label.toLowerCase().startsWith(slot.prefix.toLowerCase())), filter: false }
  }
}
