/**
 * Redis command autocompletion for the plain-mode query editor.
 *
 * Backed by the full official command table (`redisCommands.generated.ts`, 370
 * commands incl. subcommands, generated from Redis commands.json). Goes beyond
 * dbx's arity-only completion: each item carries the official summary, parameter
 * signature, complexity, version and safety. Three modes — command / subcommand
 * / argument (key names) — plus key-name completion sampled from the live DB.
 *
 * The planner is pure (text-before-cursor → options) so it unit-tests without a
 * CodeMirror state; `redisCompletion()` wraps it as a CompletionSource.
 */
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { REDIS_COMMANDS, type RedisCommandDoc } from './redisCommands.generated'

export interface RedisOption {
  label: string
  apply?: string
  detail?: string
  info?: string
  type?: string
  boost?: number
}

export interface RedisPlan {
  replaceLen: number
  options: RedisOption[]
}

// ---- Indexes derived once from the generated table ----
interface MainEntry { name: string; doc: RedisCommandDoc }
interface SubEntry { sub: string; doc: RedisCommandDoc }

const MAIN_COMMANDS: MainEntry[] = []
const SUBS_BY_CONTAINER = new Map<string, SubEntry[]>()
const SUB_CONTAINERS = new Set<string>()

for (const [name, doc] of Object.entries(REDIS_COMMANDS)) {
  if (doc.container && doc.sub) {
    const list = SUBS_BY_CONTAINER.get(doc.container) ?? []
    list.push({ sub: doc.sub, doc })
    SUBS_BY_CONTAINER.set(doc.container, list)
    SUB_CONTAINERS.add(doc.container)
  } else {
    MAIN_COMMANDS.push({ name, doc })
  }
}
// Container commands (CONFIG/XINFO/ACL…) that have no standalone entry still need
// a main-name option so the user can type the container token first.
for (const cont of SUB_CONTAINERS) {
  if (!REDIS_COMMANDS[cont]) {
    const subs = SUBS_BY_CONTAINER.get(cont) ?? []
    MAIN_COMMANDS.push({
      name: cont,
      doc: {
        arity: -2,
        group: subs[0]?.doc.group ?? 'server',
        summary: `${cont} 容器命令(含 ${subs.length} 个子命令)`,
        safety: subs.every(s => s.doc.safety === 'blocked') ? 'blocked' : 'allowed',
        takesKey: false,
        multiKey: false,
      },
    })
  }
}
MAIN_COMMANDS.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

// Surface common groups higher in the menu.
const GROUP_BOOST: Record<string, number> = { string: 12, generic: 11, hash: 9, list: 9, set: 9, 'sorted-set': 9, connection: 6, server: 4 }

function describeArity(arity: number): string {
  if (arity > 0) { const n = arity - 1; return `精确 ${n} 个参数` }
  const n = -arity - 1
  return `至少 ${n} 个参数`
}

function buildInfo(label: string, doc: RedisCommandDoc): string {
  const head = doc.syntax ? `${label} ${doc.syntax}` : label
  const meta: string[] = []
  if (doc.complexity) meta.push(`复杂度 ${doc.complexity}`)
  if (doc.since) meta.push(`since ${doc.since}`)
  meta.push(`group ${doc.group}`)
  meta.push(describeArity(doc.arity))
  if (doc.safety === 'blocked') meta.push('⛔ 控制台已禁用')
  else if (doc.safety === 'confirm') meta.push('⚠ 写命令(会修改数据)')
  return [head, doc.summary, meta.join(' · ')].filter(Boolean).join('\n')
}

function safetyDetail(doc: RedisCommandDoc): string {
  if (doc.safety === 'blocked') return `${doc.group} · ⛔`
  if (doc.safety === 'confirm') return `${doc.group} · 写`
  return doc.group
}

function optFor(label: string, doc: RedisCommandDoc, applyExtra = ' '): RedisOption {
  return {
    label,
    apply: `${label}${applyExtra}`,
    detail: safetyDetail(doc),
    info: buildInfo(label, doc),
    type: 'keyword',
    boost: (GROUP_BOOST[doc.group] ?? 0) - (doc.safety === 'blocked' ? 30 : 0),
  }
}

function commandOptions(prefix: string): RedisOption[] {
  const p = prefix.toLowerCase()
  return MAIN_COMMANDS
    .filter(e => !p || e.name.toLowerCase().startsWith(p))
    .map(e => optFor(e.name, e.doc))
}

function subcommandOptions(container: string, prefix: string): RedisOption[] {
  const p = prefix.toLowerCase()
  return (SUBS_BY_CONTAINER.get(container) ?? [])
    .filter(e => !p || e.sub.toLowerCase().startsWith(p))
    .map(e => optFor(e.sub, e.doc))
}

function keyOptions(prefix: string, keys: string[]): RedisOption[] {
  const p = prefix.toLowerCase()
  const matched = p ? keys.filter(k => k.toLowerCase().includes(p)) : keys
  return matched.slice(0, 100).map(k => ({
    label: k,
    apply: k,
    detail: 'key',
    type: 'variable',
    boost: p && k.toLowerCase().startsWith(p) ? 5 : 0,
  }))
}

/** Resolve the command doc for a tokenized line (prefers "MAIN SUB" over "MAIN"). */
export function resolveRedisDoc(upperTokens: string[]): RedisCommandDoc | null {
  if (upperTokens.length === 0) return null
  if (upperTokens.length >= 2) {
    const two = REDIS_COMMANDS[`${upperTokens[0]} ${upperTokens[1]}`]
    if (two) return two
  }
  return REDIS_COMMANDS[upperTokens[0]] ?? null
}

/** True if the first typed token is a container that has subcommands. */
export function isRedisContainer(token: string): boolean {
  return SUB_CONTAINERS.has(token.toUpperCase())
}

/**
 * Plan a completion from the text before the cursor on the current line.
 */
export function redisCompletionPlan(before: string, keys: string[]): RedisPlan | null {
  const endsWithSpace = before.length > 0 && /\s$/.test(before)
  const tokens = before.trim().length === 0 ? [] : before.trim().split(/\s+/)
  const currentWord = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '')
  const typed = endsWithSpace ? tokens : tokens.slice(0, -1)

  // Command position — first token of the line.
  if (typed.length === 0) {
    const opts = commandOptions(currentWord)
    return opts.length ? { replaceLen: currentWord.length, options: opts } : null
  }

  const main = typed[0].toUpperCase()

  // Subcommand position — `CONFIG <here>`, `XINFO <here>`, etc.
  if (typed.length === 1 && SUB_CONTAINERS.has(main)) {
    const opts = subcommandOptions(main, currentWord)
    if (opts.length) return { replaceLen: currentWord.length, options: opts }
    // fall through to argument handling if no subcommand matches
  }

  // Argument position — offer key names at the key slot of a key command.
  const headLen = typed.length >= 2 && REDIS_COMMANDS[`${main} ${typed[1].toUpperCase()}`] ? 2 : 1
  const doc = resolveRedisDoc(typed.map(t => t.toUpperCase()))
  if (!doc || !doc.takesKey) return null
  const argIndex = typed.length - headLen // 0-based after the command head
  const suggestKey = doc.multiKey || argIndex === 0
  if (!suggestKey) return null
  const opts = keyOptions(currentWord, keys)
  return opts.length ? { replaceLen: currentWord.length, options: opts } : null
}

/**
 * Build a CodeMirror CompletionSource. `getKeys` is read lazily so the source
 * identity stays stable while the live key sample updates.
 */
export function redisCompletion(getKeys: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos)
    const before = context.state.sliceDoc(line.from, context.pos)
    const plan = redisCompletionPlan(before, getKeys())
    if (!plan) return null
    return {
      from: context.pos - plan.replaceLen,
      options: plan.options.map(o => ({
        label: o.label, apply: o.apply, detail: o.detail, info: o.info, type: o.type, boost: o.boost,
      } as Completion)),
      validFor: /[\w:*.\-]*$/,
    }
  }
}
