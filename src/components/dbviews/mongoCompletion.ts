/**
 * Lightweight mongo-shell autocompletion for the plain-mode query editor.
 * Modeled on dbx's mongo completion but aligned to catio's actually-supported
 * command set (no findOne/distinct — the backend rejects them). The core is a
 * pure planner over the text-before-cursor so it can be unit-tested without a
 * CodeMirror state; `mongoCompletion()` wraps it as a CompletionSource.
 */
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'

export interface MongoOption {
  label: string
  apply?: string
  detail?: string
  type?: string
}

export interface MongoPlan {
  /** Number of chars before the cursor that the inserted text replaces. */
  replaceLen: number
  options: MongoOption[]
}

/** Collection methods — apply templates carry the call parens / sample args. */
const METHODS: MongoOption[] = [
  { label: 'find', apply: 'find({})', type: 'method' },
  { label: 'countDocuments', apply: 'countDocuments({})', type: 'method' },
  { label: 'count', apply: 'count({})', type: 'method' },
  { label: 'aggregate', apply: 'aggregate([])', type: 'method' },
  { label: 'getIndexes', apply: 'getIndexes()', type: 'method' },
  { label: 'insertOne', apply: 'insertOne({})', type: 'method' },
  { label: 'insertMany', apply: 'insertMany([])', type: 'method' },
  { label: 'updateOne', apply: 'updateOne({}, { $set: {} })', type: 'method' },
  { label: 'updateMany', apply: 'updateMany({}, { $set: {} })', type: 'method' },
  { label: 'deleteOne', apply: 'deleteOne({})', type: 'method' },
  { label: 'deleteMany', apply: 'deleteMany({})', type: 'method' },
]

/** Chain methods valid after find(...) — i.e. after a ")". */
const CHAIN: MongoOption[] = [
  { label: 'sort', apply: 'sort({ _id: -1 })', type: 'method' },
  { label: 'skip', apply: 'skip(0)', type: 'method' },
  { label: 'limit', apply: 'limit(20)', type: 'method' },
]

function byPrefix(options: MongoOption[], partial: string): MongoOption[] {
  if (!partial) return options
  const p = partial.toLowerCase()
  return options.filter(o => o.label.toLowerCase().startsWith(p))
}

/**
 * Plan a completion from the text before the cursor on the current line.
 * Returns null when no mongo context applies (or no candidate matches).
 */
export function mongoCompletionPlan(before: string, collections: string[]): MongoPlan | null {
  // 1) chain methods after a ")" — e.g. db.users.find({}).<here>
  let m = /\)\s*\.(\w*)$/.exec(before)
  if (m) {
    const opts = byPrefix(CHAIN, m[1])
    return opts.length ? { replaceLen: m[1].length, options: opts } : null
  }
  // 2) collection methods — db.<coll>.<partial>, only when <coll> is a real collection
  m = /(?:^|[^\w.])db\.(.+)\.(\w*)$/.exec(before)
  if (m && collections.includes(m[1])) {
    const opts = byPrefix(METHODS, m[2])
    return opts.length ? { replaceLen: m[2].length, options: opts } : null
  }
  // 3) collection names — db.<partial> (partial may contain dots: system.users)
  m = /(?:^|[^\w.])db\.([\w.]*)$/.exec(before)
  if (m) {
    const partial = m[1].toLowerCase()
    const opts: MongoOption[] = collections
      .filter(c => c.toLowerCase().includes(partial))
      .map(c => ({ label: c, apply: c, type: 'class', detail: 'collection' }))
    return opts.length ? { replaceLen: m[1].length, options: opts } : null
  }
  return null
}

/**
 * Build a CodeMirror CompletionSource. `getCollections` is read lazily so the
 * source identity stays stable while the live collection list updates.
 */
export function mongoCompletion(getCollections: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const plan = mongoCompletionPlan(before, getCollections())
    if (!plan) return null
    return {
      from: context.pos - plan.replaceLen,
      options: plan.options.map(o => ({ label: o.label, apply: o.apply, detail: o.detail, type: o.type } as Completion)),
      validFor: /[\w.]*$/,
    }
  }
}
