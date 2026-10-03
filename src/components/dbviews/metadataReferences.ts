import { dialectFor } from './sqlDialect'

/** Completion loading only: not a SQL authorization/classification boundary. */
export function referencedNamespaces(sql: string, names: string[], current?: string, engine?: string): string[] {
  const known = new Map(names.map(name => [name.toLowerCase(), name]))
  const selected = new Set<string>()
  if (current && known.has(current.toLowerCase())) selected.add(known.get(current.toLowerCase())!)
  if (!sql) return [...selected]

  // The actual editor dialect recognizes dollar strings, Oracle q-quotes, MySQL
  // escapes/# comments and nested comments. Do not fetch metadata mentioned only
  // in examples or data literals. Keep identifiers (including quoted ones) intact.
  const parts: string[] = []
  let last = 0
  dialectFor(engine).language.parser.parse(sql).iterate({ enter(node) {
    if (!['String', 'LineComment', 'BlockComment'].includes(node.name)) return
    parts.push(sql.slice(last, node.from), ' ')
    last = node.to
    return false
  } })
  parts.push(sql.slice(last))
  const code = parts.join('')
  const qualifier = /"((?:[^"]|"")*)"\s*\.|`((?:[^`]|``)*)`\s*\.|\[((?:[^\]]|\]\])*)\]\s*\.|([\p{L}_][\p{L}\p{N}_$]*)\s*\./gu
  for (const match of code.matchAll(qualifier)) {
    const name = (match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/``/g, '`') ?? match[3]?.replace(/\]\]/g, ']') ?? match[4]).toLowerCase()
    const actual = known.get(name)
    if (actual) selected.add(actual)
  }
  return [...selected]
}
