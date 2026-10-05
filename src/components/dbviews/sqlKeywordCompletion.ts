import { ensureSyntaxTree } from '@codemirror/language'
import { keywordCompletionSource, type SQLDialect } from '@codemirror/lang-sql'
import type { CompletionSource } from '@codemirror/autocomplete'
import type { SyntaxNode } from '@lezer/common'

/** Completion sources must not infer context from a lagging published tree. */
export function readySqlCompletion(source: CompletionSource, excluded: readonly string[] = []): CompletionSource {
  const blocked = new Set(['String', 'LineComment', 'BlockComment', ...excluded])
  return context => {
    const tree = ensureSyntaxTree(context.state, Math.min(context.state.doc.length, context.pos + 1), 10)
    if (!tree) return null
    for (let node: SyntaxNode | null = tree.resolveInner(context.pos, -1); node; node = node.parent) {
      if (blocked.has(node.name)) return null
    }
    return source(context)
  }
}

/** lang-sql reads LanguageState.tree, which can lag behind ParseContext.tree.
 * Keep its keyword list/casing/replacements, but guard that fallback with a fresh
 * bounded tree. Qualified identifiers are reserved for schema/field completion.
 */
export function guardedSqlKeywordCompletion(dialect: SQLDialect): CompletionSource {
  return readySqlCompletion(keywordCompletionSource(dialect, true), ['QuotedIdentifier', 'CompositeIdentifier', '.'])
}
