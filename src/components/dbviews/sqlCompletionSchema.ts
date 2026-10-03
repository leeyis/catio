import type { SQLNamespace } from '@codemirror/lang-sql'
import { dialectFor } from './sqlDialect'

/** Escape literal dots for lang-sql's legacy dotted-key syntax; labels keep their original names. */
const keyFor = (name: string) => name.replace(/\./g, '\\.')
export function completionIdentifier(name: string, engine?: string): string {
  const open = dialectFor(engine).spec.identifierQuotes?.[0] ?? '"'
  const close = open === '[' ? ']' : open
  return open + name.split(close).join(close + close) + close
}

export interface CompletionNamespace {
  name: string
  tables: { name: string }[]
  views: { name: string }[]
}

/** Keep namespaces distinct. The editor's defaultSchema, never catalog order, resolves bare tables. */
export function completionSchema(namespaces: CompletionNamespace[], columns: (schema: string, table: string) => readonly string[], engine?: string): SQLNamespace {
  const top: Record<string, SQLNamespace> = Object.create(null)
  for (const ns of namespaces) {
    const tables: Record<string, SQLNamespace> = Object.create(null)
    for (const table of [...ns.tables, ...ns.views]) {
      tables[keyFor(table.name)] = {
        self: { label: table.name, type: 'type', apply: completionIdentifier(table.name, engine) },
        children: columns(ns.name, table.name).map(name => ({ label: name, type: 'property', apply: completionIdentifier(name, engine) })),
      }
    }
    top[keyFor(ns.name)] = {
      self: { label: ns.name, type: 'class', apply: completionIdentifier(ns.name, engine) }, children: tables,
    }
  }
  return top
}
